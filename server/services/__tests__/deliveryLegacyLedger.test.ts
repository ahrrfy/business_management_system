import { readFileSync } from "node:fs";
import { eq, inArray, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { effectiveDeliveryLedgerEntrySql } from "../delivery/legacyLedger";
import { getDeliveryFinancialSummary } from "../delivery/lifecycle";
import { invoiceDeliveryAmendmentTx } from "../delivery/invoiceAmendment";
import { loadRefundCaps, loadRefundCapsByInvoiceIds } from "../returns/refundCaps";
import { withTx } from "../tx";

const db = () => getDb()!;
const nativeAt = new Date("2026-09-21T12:14:00Z");
const snapshotAt = new Date("2026-09-21T12:20:00Z");

beforeEach(async () => {
  await db().insert(s.branches).values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await db().insert(s.users).values({ id: 1, openId: "legacy-ledger-admin", role: "admin", branchId: 1 });
  await db().insert(s.customers).values({ id: 1, name: "عميل", currentBalance: "0" });
  await db().insert(s.deliveryParties).values({ id: 1, name: "شركة", partyType: "COMPANY", branchId: 1, currentBalance: "0" });
  await db().insert(s.invoices).values({ id: 1, invoiceNumber: "LEGACY-1", sourceType: "POS", sourceId: "legacy-1", branchId: 1, customerId: 1, subtotal: "52000", total: "52000", paidAmount: "52000", status: "PAID" });
  await db().insert(s.shifts).values({ id: 1, branchId: 1, userId: 1, shiftType: "RECEPTION", status: "OPEN", openingBalance: "0", openGuard: "1:1" });
  await db().insert(s.receipts).values({ id: 1, branchId: 1, shiftId: 1, direction: "IN", amount: "52000", paymentMethod: "CASH", cashBucket: "DRAWER", status: "COMPLETED", approvalStatus: "APPROVED", partyType: "OTHER", createdBy: 1 });
  await db().insert(s.deliveryRemittances).values({ id: 1, remittanceNumber: "LEGACY-RM-1", branchId: 1, partyId: 1, shiftId: 1, collectedTotal: "52000", netRemitted: "52000", status: "BALANCED", receiptInId: 1, receivedBy: 1 });
  await db().insert(s.deliveryConsignments).values({ id: 1, consignmentNumber: "LEGACY-CN-1", branchId: 1, partyId: 1, invoiceId: 1, sourceId: 1, codAmount: "52000", collectedAmount: "52000", deliveryFee: "5000", feeCollection: "COURIER", parcelStatus: "DELIVERED", moneyStatus: "SETTLED", status: "DELIVERED", remittanceId: 1, courierDeliveredAt: nativeAt, feeSettledAt: nativeAt, settledAt: nativeAt });
  await db().insert(s.deliveryRemittanceLines).values({ remittanceId: 1, consignmentId: 1, grossApplied: "52000", cashReceived: "52000", legacySnapshot: false });
});

type EntryType = typeof s.deliveryLedgerEntries.$inferInsert.entryType;
async function entry(eventKey: string, entryType: EntryType, amount: string, opts: { createdAt?: Date; remittanceId?: number | null } = {}) {
  await db().insert(s.deliveryLedgerEntries).values({ eventKey, partyId: 1, branchId: 1, consignmentId: 1, entryType, amount, remittanceId: opts.remittanceId ?? null, occurredAt: opts.createdAt ?? nativeAt, createdAt: opts.createdAt ?? nativeAt });
}
async function effectiveRows() {
  return db().select().from(s.deliveryLedgerEntries)
    .where(effectiveDeliveryLedgerEntrySql()).orderBy(s.deliveryLedgerEntries.id);
}
async function nativeLifecycle(collectedAmount = "52000") {
  for (const [type, amount, suffix] of [
    ["COD_ASSIGNED", "52000", "COD_ASSIGNED"],
    ["COD_COLLECTED", collectedAmount, "COD_COLLECTED"],
    ["COD_REMITTED", "52000", "REMIT:1"],
    ["FEE_EARNED", "5000", "FEE_EARNED"],
    ["FEE_PAID", "5000", "FEE_PAID_DIRECT"],
  ] as const) await entry(`CN:1:${suffix}`, type, amount, { remittanceId: type === "COD_REMITTED" ? 1 : null });
}
async function runActualBackfillSql() {
  const source = readFileSync("drizzle/migrations/extras/0178_delivery_phase2_state_and_ledgers.sql", "utf8");
  const statements = source.split(/-->\s*statement-breakpoint/g)
    .filter((statement) => statement.includes("INSERT IGNORE INTO `deliveryLedgerEntries`") && statement.includes("BACKFILL:CN:"));
  expect(statements).toHaveLength(5);
  for (const statement of statements) await db().execute(sql.raw(statement));
}
async function addRemittance(id: number, amount: string, at: Date) {
  await db().insert(s.receipts).values({ id, branchId: 1, shiftId: 1, direction: "IN", amount, paymentMethod: "CASH", cashBucket: "DRAWER", status: "COMPLETED", approvalStatus: "APPROVED", partyType: "OTHER", createdBy: 1, createdAt: at });
  await db().insert(s.deliveryRemittances).values({ id, remittanceNumber: `LEGACY-RM-${id}`, branchId: 1, partyId: 1, shiftId: 1, collectedTotal: amount, netRemitted: amount, status: "BALANCED", receiptInId: id, receivedBy: 1, createdAt: at });
  await db().insert(s.deliveryRemittanceLines).values({ remittanceId: id, consignmentId: 1, grossApplied: amount, cashReceived: amount, legacySnapshot: false, createdAt: at });
  await entry(`CN:1:REMIT:${id}`, "COD_REMITTED", amount, { remittanceId: id, createdAt: at });
}
async function cumulativeRemittances() {
  await db().update(s.invoices).set({ subtotal: "42000", total: "42000", paidAmount: "42000" });
  await db().update(s.deliveryConsignments).set({ codAmount: "42000", collectedAmount: "7500" });
  await db().update(s.receipts).set({ amount: "2500" });
  await db().update(s.deliveryRemittances).set({ collectedTotal: "2500", netRemitted: "2500" });
  await db().update(s.deliveryRemittanceLines).set({ grossApplied: "2500", cashReceived: "2500" });
  await entry("CN:1:COD_ASSIGNED", "COD_ASSIGNED", "42000");
  await entry("CN:1:COD_COLLECTED", "COD_COLLECTED", "42000");
  await entry("CN:1:REMIT:1", "COD_REMITTED", "2500", { remittanceId: 1 });
  await addRemittance(2, "5000", nativeAt);
  await db().update(s.deliveryConsignments).set({ remittanceId: 2 });
}
const snapshotKeys = ["BACKFILL:CN:1:COD_COLLECTED", "BACKFILL:CN:1:COD_REMITTED"];
async function cumulativeSnapshots(remittanceId = 2) {
  for (const type of ["COD_COLLECTED", "COD_REMITTED"] as const)
    await entry(`BACKFILL:CN:1:${type}`, type, "7500", { remittanceId, createdAt: snapshotAt });
}
async function effectiveSnapshotKeys() {
  return (await effectiveRows()).filter(row => snapshotKeys.includes(row.eventKey)).map(row => row.eventKey);
}

describe("effective delivery legacy ledger on MySQL", () => {
  it("counts exact native/snapshot pairs once in refund caps, amendment and financial totals, retaining raw evidence", async () => {
    await nativeLifecycle();
    for (const [type, amount] of [["COD_ASSIGNED", "52000"], ["COD_COLLECTED", "52000"], ["COD_REMITTED", "52000"], ["FEE_EARNED", "5000"], ["FEE_PAID", "5000"]] as const) {
      await entry(`BACKFILL:CN:1:${type}`, type, amount, { createdAt: snapshotAt, remittanceId: ["COD_COLLECTED", "COD_REMITTED"].includes(type) ? 1 : null });
    }
    const before = await db().select().from(s.deliveryLedgerEntries).orderBy(s.deliveryLedgerEntries.id);
    expect(before).toHaveLength(10);
    expect(await effectiveRows()).toHaveLength(5);
    const single = await loadRefundCaps(db(), 1);
    const batch = (await loadRefundCapsByInvoiceIds(db(), [1])).get(1)!;
    for (const caps of [single, batch]) {
      expect(caps.grossIn.toFixed(2)).toBe("52000.00");
      expect(caps.pool.toFixed(2)).toBe("52000.00");
      expect(caps.unremittedDeliveryCustody.toFixed(2)).toBe("0.00");
      expect(caps.cashNetByShift.get(1)?.toFixed(2)).toBe("52000.00");
    }
    const amendment = await withTx(tx => invoiceDeliveryAmendmentTx(tx, 1));
    expect(amendment!.grossSettled.toFixed(2)).toBe("52000.00");
    expect(amendment!.custody.toFixed(2)).toBe("0.00");
    expect(await getDeliveryFinancialSummary(1)).toMatchObject({ codAssigned: "52000.00", codCollected: "52000.00", codRemitted: "52000.00", cashInCustody: "0.00", feeEarned: "5000.00", feePaid: "5000.00" });
    expect(await db().select().from(s.deliveryLedgerEntries).orderBy(s.deliveryLedgerEntries.id)).toEqual(before);
  });

  it("keeps sole legacy, partial native mismatch, and a native movement after the snapshot cutoff", async () => {
    await entry("BACKFILL:CN:1:COD_ASSIGNED", "COD_ASSIGNED", "52000", { createdAt: snapshotAt });
    expect(await effectiveRows()).toHaveLength(1);
    await entry("CN:1:COD_ASSIGNED", "COD_ASSIGNED", "40000");
    expect(await effectiveRows()).toHaveLength(2);
    await entry("BACKFILL:CN:1:COD_COLLECTED", "COD_COLLECTED", "52000", { createdAt: snapshotAt });
    await entry("CN:1:COD_COLLECTED", "COD_COLLECTED", "52000", { createdAt: new Date("2026-09-21T12:30:00Z") });
    expect(await effectiveRows()).toHaveLength(4);
    await db().insert(s.deliveryLedgerEntries).values({ eventKey: "BACKFILL:PARTY:1:CASH_CUSTODY", partyId: 1, branchId: 1, entryType: "COD_COLLECTED", amount: "52000", createdAt: snapshotAt });
    expect(await effectiveRows()).toHaveLength(5);
  });

  it("requires the same real remittance and nonlegacy allocation line before suppressing remitted snapshots", async () => {
    await entry("CN:1:REMIT:1", "COD_REMITTED", "52000", { remittanceId: 1 });
    await entry("BACKFILL:CN:1:COD_REMITTED", "COD_REMITTED", "52000", { remittanceId: 1, createdAt: snapshotAt });
    expect(await effectiveRows()).toHaveLength(1);
    await db().update(s.deliveryRemittanceLines).set({ legacySnapshot: true });
    expect(await effectiveRows()).toHaveLength(2);
    await db().update(s.deliveryRemittanceLines).set({ legacySnapshot: false, grossApplied: "51000" });
    expect(await effectiveRows()).toHaveLength(2);
    await db().update(s.deliveryRemittanceLines).set({ grossApplied: "52000" });
    await db().update(s.deliveryLedgerEntries).set({ remittanceId: null })
      .where(eq(s.deliveryLedgerEntries.eventKey, "BACKFILL:CN:1:COD_REMITTED"));
    expect(await effectiveRows()).toHaveLength(2);
  });

  it.each(["52000", "40000"])("actual repeatable SQL preserves only uncovered legacy amounts with native collection %s", async (collectedAmount) => {
    await nativeLifecycle(collectedAmount);
    await runActualBackfillSql();
    await runActualBackfillSql();
    expect(await db().select().from(s.deliveryLedgerEntries)).toHaveLength(collectedAmount === "52000" ? 5 : 6);
    const snapshots = await db().select().from(s.deliveryLedgerEntries)
      .where(eq(s.deliveryLedgerEntries.eventKey, "BACKFILL:CN:1:COD_COLLECTED"));
    expect(snapshots.map(row => row.amount)).toEqual(collectedAmount === "52000" ? [] : ["52000.00"]);
    expect((await effectiveRows()).filter(row => row.entryType === "COD_COLLECTED").map(row => row.amount)).toEqual(collectedAmount === "52000" ? ["52000.00"] : ["40000.00", "52000.00"]);
  });

  it("the actual SQL still backfills a consignment having no native history", async () => {
    await runActualBackfillSql();
    expect(await db().select().from(s.deliveryLedgerEntries)).toHaveLength(5);
    expect(await effectiveRows()).toHaveLength(5);
    expect((await loadRefundCaps(db(), 1)).pool.toFixed(2)).toBe("52000.00");
  });

  it("counts cumulative 2500+5000 snapshots once and retains a later 34500 remittance", async () => {
    await cumulativeRemittances();
    await cumulativeSnapshots();
    await addRemittance(3, "34500", new Date("2026-09-21T12:30:00Z"));
    await db().update(s.deliveryConsignments).set({ collectedAmount: "42000", remittanceId: 3 });
    const before = await db().select().from(s.deliveryLedgerEntries).orderBy(s.deliveryLedgerEntries.id);
    expect(before).toHaveLength(7);
    expect(await effectiveSnapshotKeys()).toEqual([]);
    expect(await effectiveRows()).toHaveLength(5);
    for (const caps of [await loadRefundCaps(db(), 1), (await loadRefundCapsByInvoiceIds(db(), [1])).get(1)!]) {
      expect(caps.grossIn.toFixed(2)).toBe("42000.00");
      expect(caps.pool.toFixed(2)).toBe("42000.00");
      expect(caps.unremittedDeliveryCustody.toFixed(2)).toBe("0.00");
      expect(caps.cashNetByShift.get(1)?.toFixed(2)).toBe("42000.00");
    }
    const amendment = await withTx(tx => invoiceDeliveryAmendmentTx(tx, 1));
    expect(amendment!.grossSettled.toFixed(2)).toBe("42000.00");
    expect(amendment!.custody.toFixed(2)).toBe("0.00");
    expect(await getDeliveryFinancialSummary(1)).toMatchObject({ codCollected: "42000.00", codRemitted: "42000.00", cashInCustody: "0.00" });
    expect(await db().select().from(s.deliveryLedgerEntries).orderBy(s.deliveryLedgerEntries.id)).toEqual(before);
  });

  it("keeps cumulative snapshots when their marker, original line or collection cutoff is unproven", async () => {
    await cumulativeRemittances();
    await addRemittance(3, "34500", new Date("2026-09-21T12:30:00Z"));
    await cumulativeSnapshots(3);
    expect(await effectiveSnapshotKeys()).toEqual(snapshotKeys);
    await db().update(s.deliveryLedgerEntries).set({ remittanceId: 2 }).where(inArray(s.deliveryLedgerEntries.eventKey, snapshotKeys));
    expect(await effectiveSnapshotKeys()).toEqual([]);
    await db().update(s.deliveryRemittanceLines).set({ legacySnapshot: true }).where(eq(s.deliveryRemittanceLines.remittanceId, 2));
    expect(await effectiveSnapshotKeys()).toEqual(snapshotKeys);
    await db().update(s.deliveryRemittanceLines).set({ legacySnapshot: false, grossApplied: "4999" }).where(eq(s.deliveryRemittanceLines.remittanceId, 2));
    expect(await effectiveSnapshotKeys()).toEqual(snapshotKeys);
    await db().update(s.deliveryRemittanceLines).set({ grossApplied: "5000" }).where(eq(s.deliveryRemittanceLines.remittanceId, 2));
    await db().update(s.deliveryLedgerEntries).set({ createdAt: new Date("2026-09-21T12:30:00Z") }).where(eq(s.deliveryLedgerEntries.eventKey, "CN:1:COD_COLLECTED"));
    expect(await effectiveSnapshotKeys()).toEqual([snapshotKeys[0]]);
    expect((await effectiveRows()).some(row => row.eventKey === "CN:1:COD_COLLECTED")).toBe(true);
  });

  it("actual repeatable SQL skips proven cumulative snapshots but preserves amounts with an unproven line", async () => {
    await cumulativeRemittances();
    await runActualBackfillSql();
    await runActualBackfillSql();
    expect(await db().select().from(s.deliveryLedgerEntries).where(inArray(s.deliveryLedgerEntries.eventKey, snapshotKeys))).toEqual([]);
    await db().update(s.deliveryRemittanceLines).set({ legacySnapshot: true }).where(eq(s.deliveryRemittanceLines.remittanceId, 2));
    await runActualBackfillSql();
    await runActualBackfillSql();
    expect(await effectiveSnapshotKeys()).toEqual(snapshotKeys);
  });
});
