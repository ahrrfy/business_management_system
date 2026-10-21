import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import {
  previewCustomerReceiptHistory,
  adoptCustomerReceiptHistory,
} from "../customerReceiptHistory";
import { getCustomerStatement } from "../reports/arAging";
import { loadRefundCaps } from "../returns/refundCaps";
import { cancelVoucher } from "../voucherService";
const db = () => getDb()!;
const owner = { userId: 2, branchId: 1, role: "manager" as const };
const createdAt = new Date("2026-10-01T10:00:00Z");
beforeEach(async () => {
  await db()
    .insert(s.branches)
    .values([
      { id: 1, name: "MAIN", code: "MAIN", type: "MAIN" },
      { id: 2, name: "OTHER", code: "OTHER", type: "SALES" },
    ]);
  await db()
    .insert(s.users)
    .values([
      {
        id: 1,
        openId: "history-maker",
        name: "Maker",
        role: "admin",
        branchId: 1,
        isOwner: false,
      },
      {
        id: 2,
        openId: "history-owner",
        name: "Owner",
        role: "manager",
        branchId: 1,
        isOwner: true,
      },
    ]);
  await db().insert(s.customers).values({
    id: 1,
    name: "History customer",
    currentBalance: "0",
    creditLimit: "99999999",
  });
});
async function entry(
  entryType: "SALE" | "OPENING" | "PAYMENT_IN" | "PAYMENT_OUT",
  amount: string,
  extra: Partial<typeof s.accountingEntries.$inferInsert> = {},
) {
  await db()
    .insert(s.accountingEntries)
    .values({
      entryType,
      amount,
      branchId: 1,
      customerId: 1,
      entryDate: createdAt,
      createdAt,
      ...extra,
    });
}
async function invoice(id: number, total: string, paid: string, branchId = 1) {
  await db()
    .insert(s.invoices)
    .values({
      id,
      invoiceNumber: `HISTORY-${id}`,
      branchId,
      customerId: 1,
      invoiceDate: new Date(`2026-09-${String(id).padStart(2, "0")}T00:00:00Z`),
      subtotal: total,
      total,
      paidAmount: paid,
      status:
        paid === total ? "PAID" : paid === "0" ? "PENDING" : "PARTIALLY_PAID",
      sourceType: "ORDER",
      sourceId: `history-${id}`,
    });
  await entry("SALE", total, { invoiceId: id, branchId });
}
async function receive(id: number, amount: string) {
  await db()
    .insert(s.receipts)
    .values({
      id,
      branchId: 1,
      direction: "IN",
      amount,
      paymentMethod: "CASH",
      cashBucket: "TREASURY",
      partyType: "CUSTOMER",
      partyId: 1,
      voucherNumber: `RV-1-HISTORY-${id}`,
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      createdBy: 1,
      createdAt,
    });
  await entry("PAYMENT_IN", amount, { receiptId: id });
}
const balance = (amount: string) =>
  db()
    .update(s.customers)
    .set({ currentBalance: amount })
    .where(eq(s.customers.id, 1));
const request = (receiptIds = [1001]) => ({
  receiptIds,
  cutoffUtc: "2026-10-21T09:26:51.000Z",
});
async function apply(receiptIds = [1001], batchKey = "history-test") {
  const preview = await previewCustomerReceiptHistory(request(receiptIds));
  const input = {
    ...preview.input,
    evidenceHash: preview.evidenceHash,
    batchKey,
  };
  return {
    preview,
    input,
    result: await adoptCustomerReceiptHistory(input, owner),
  };
}
async function frozenMoney() {
  return {
    customers: await db().select().from(s.customers),
    receipts: await db().select().from(s.receipts).orderBy(s.receipts.id),
    ledger: await db()
      .select()
      .from(s.accountingEntries)
      .orderBy(s.accountingEntries.id),
    delivery: await db().select().from(s.deliveryLedgerEntries),
  };
}
describe("historical customer receipt provenance", () => {
  it("links previously paid portions then settles only the missing FIFO remainder without cash or AR", async () => {
    await invoice(1, "100.00", "100.00");
    await invoice(2, "50.00", "0");
    await receive(1001, "130.00");
    await balance("20.00");
    const frozen = await frozenMoney(),
      statement = await getCustomerStatement(1);
    const { result, input } = await apply();
    expect(result).toMatchObject({
      mode: "APPLIED",
      existingPaidLinked: "100.00",
      newInvoiceAllocation: "30.00",
      accountAmount: "0.00",
      newCash: "0.00",
      newLedgerEntries: 0,
    });
    expect(await frozenMoney()).toEqual(frozen);
    expect(
      (await db().select().from(s.invoices).orderBy(s.invoices.id)).map((i) => [
        i.paidAmount,
        i.status,
      ]),
    ).toEqual([
      ["100.00", "PAID"],
      ["30.00", "PARTIALLY_PAID"],
    ]);
    expect((await loadRefundCaps(db(), 1)).pool.toFixed(2)).toBe("100.00");
    const dated = await db()
      .select()
      .from(s.invoices)
      .where(eq(s.invoices.id, 2));
    const [originalEntry] = await db()
      .select()
      .from(s.accountingEntries)
      .where(eq(s.accountingEntries.receiptId, 1001));
    expect(dated[0].paymentDate?.toISOString()).toBe(
      originalEntry.entryDate.toISOString(),
    );
    const after = await getCustomerStatement(1);
    expect(after?.summary.totalPaid).toBe("130.00");
    const paymentFaces = (rows: NonNullable<typeof after>["payments"]) =>
      rows.map((p) => [p.id, p.direction, p.amount]);
    expect(paymentFaces(after!.payments)).toEqual(
      paymentFaces(statement!.payments),
    );
    expect(after?.summary.currentBalance).toBe("20.00");
    expect(after?.payments.filter((p) => p.id === 1001)).toHaveLength(1);
    const allocations = await db().select().from(s.customerReceiptAllocations);
    expect((await adoptCustomerReceiptHistory(input, owner)).mode).toBe(
      "REPLAY_VERIFIED",
    );
    expect(await db().select().from(s.customerReceiptAllocations)).toEqual(
      allocations,
    );
    expect(await frozenMoney()).toEqual(frozen);
  });
  it("records proven opening settlement without paying unpaid invoices again", async () => {
    await entry("OPENING", "200.00", { branchId: null });
    await invoice(1, "100.00", "0");
    await receive(1001, "150.00");
    await balance("150.00");
    const { result } = await apply();
    expect(result).toMatchObject({
      accountAmount: "150.00",
      newInvoiceAllocation: "0.00",
      existingPaidLinked: "0.00",
    });
    expect((await db().select().from(s.invoices))[0].paidAmount).toBe("0.00");
  });
  it("preserves a real account OUT independently and never invents a refund link", async () => {
    await invoice(1, "100.00", "100.00");
    await receive(1001, "110.00");
    await db().insert(s.receipts).values({
      id: 1000,
      branchId: 1,
      direction: "OUT",
      amount: "10.00",
      paymentMethod: "CASH",
      cashBucket: "TREASURY",
      partyType: "CUSTOMER",
      partyId: 1,
      voucherNumber: "PV-1-HISTORY",
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      createdAt,
    });
    await entry("PAYMENT_OUT", "10.00", { receiptId: 1000 });
    await balance("0.00");
    expect((await apply()).result).toMatchObject({
      accountAmount: "10.00",
      existingPaidLinked: "100.00",
      newInvoiceAllocation: "0.00",
    });
    expect(await db().select().from(s.customerReceiptCreditUses)).toHaveLength(
      0,
    );
  });
  it("keeps excess as one proven advance rather than disguising it as an opening payment", async () => {
    await invoice(1, "100.00", "0");
    await receive(1001, "130.00");
    await balance("-30.00");
    expect((await apply()).result).toMatchObject({
      newInvoiceAllocation: "100.00",
      accountAmount: "0.00",
      unallocatedAmount: "30.00",
    });
  });
  it("keeps separate sources on their exact FIFO portions", async () => {
    await invoice(1, "100.00", "100.00");
    await invoice(2, "100.00", "0");
    await receive(1001, "100.00");
    await receive(1002, "50.00");
    await balance("50.00");
    const { preview } = await apply([1001, 1002]);
    expect(preview.sources.map((r) => [r.receiptId, r.allocations])).toEqual([
      [1001, [{ invoiceId: 1, amount: "100.00", applyAmount: "0.00" }]],
      [1002, [{ invoiceId: 2, amount: "50.00", applyAmount: "50.00" }]],
    ]);
  });
  it("rejects stale or incomplete evidence without partial source adoption", async () => {
    await invoice(1, "100.00", "0");
    await receive(1001, "50.00");
    await receive(1002, "25.00");
    await balance("25.00");
    await expect(previewCustomerReceiptHistory(request())).rejects.toThrow(
      /جميع سنداته/,
    );
    const p = await previewCustomerReceiptHistory(request([1001, 1002]));
    await db()
      .update(s.receipts)
      .set({ cashBucket: "DRAWER" })
      .where(eq(s.receipts.id, 1002));
    await expect(
      adoptCustomerReceiptHistory(
        { ...p.input, evidenceHash: p.evidenceHash, batchKey: "stale" },
        owner,
      ),
    ).rejects.toThrow(/تغيرت مصادر/);
    expect(await db().select().from(s.customerReceiptSettlements)).toHaveLength(
      0,
    );
    expect((await db().select().from(s.invoices))[0].paidAmount).toBe("0.00");
  });
  it("funds invoice portions before account debt for each historical source and reverses the exact portion", async () => {
    await entry("OPENING", "50.00", { branchId: null });
    await invoice(1, "100.00", "100.00");
    await receive(1001, "50.00");
    await receive(1002, "100.00");
    await balance("0.00");
    const { preview } = await apply([1001, 1002]);
    expect(
      preview.sources.map((r) => ({
        id: r.receiptId,
        account: r.accountAmount,
        allocations: r.allocations,
      })),
    ).toEqual([
      {
        id: 1001,
        account: "0.00",
        allocations: [{ invoiceId: 1, amount: "50.00", applyAmount: "0.00" }],
      },
      {
        id: 1002,
        account: "50.00",
        allocations: [{ invoiceId: 1, amount: "50.00", applyAmount: "0.00" }],
      },
    ]);
    await cancelVoucher(1001, owner);
    expect((await db().select().from(s.invoices))[0].paidAmount).toBe("50.00");
    expect((await db().select().from(s.customers))[0].currentBalance).toBe(
      "50.00",
    );
  });
  it("keeps a later actual payment date when an older missing allocation is reconstructed", async () => {
    await invoice(1, "200.00", "50.00");
    const later = new Date("2026-10-10T12:00:00Z");
    await db()
      .update(s.invoices)
      .set({ paymentDate: later })
      .where(eq(s.invoices.id, 1));
    await db().insert(s.receipts).values({
      id: 2000,
      invoiceId: 1,
      branchId: 1,
      direction: "IN",
      amount: "50.00",
      paymentMethod: "CASH",
      cashBucket: "TREASURY",
      approvalStatus: "APPROVED",
    });
    await entry("PAYMENT_IN", "50.00", {
      receiptId: 2000,
      invoiceId: 1,
      entryDate: later,
    });
    await receive(1001, "100.00");
    await balance("50.00");
    await apply();
    const [inv] = await db().select().from(s.invoices);
    expect(inv.paidAmount).toBe("150.00");
    expect(inv.paymentDate?.toISOString()).toBe(later.toISOString());
  });
  it("rejects unsupported account portions and owner spoofing", async () => {
    await invoice(1, "100.00", "0");
    await receive(1001, "50.00");
    await balance("50.00");
    await db()
      .update(s.invoices)
      .set({ status: "CANCELLED" })
      .where(eq(s.invoices.id, 1));
    await expect(previewCustomerReceiptHistory(request())).rejects.toThrow(
      /غير مدعوم/,
    );
    await expect(
      adoptCustomerReceiptHistory(
        { ...request(), batchKey: "spoof", evidenceHash: "a".repeat(64) },
        { userId: 1, branchId: 1, isOwner: true },
      ),
    ).rejects.toThrow(/مالكاً نشطاً/);
  });
  it("does not reuse unremitted courier collection as a generic receipt allocation", async () => {
    await invoice(1, "100.00", "100.00");
    await entry("OPENING", "50.00");
    await receive(1001, "50.00");
    await db().insert(s.receipts).values({
      id: 2000,
      invoiceId: 1,
      branchId: 1,
      direction: "IN",
      amount: "40.00",
      paymentMethod: "CASH",
      cashBucket: "TREASURY",
      approvalStatus: "APPROVED",
    });
    await entry("PAYMENT_IN", "40.00", { receiptId: 2000, invoiceId: 1 });
    await db().insert(s.deliveryParties).values({
      id: 1,
      name: "Courier",
      partyType: "COMPANY",
      branchId: 1,
      currentBalance: "60.00",
      defaultFee: "0",
    });
    await db().insert(s.deliveryConsignments).values({
      id: 1,
      consignmentNumber: "CN-HISTORY",
      branchId: 1,
      partyId: 1,
      invoiceId: 1,
      sourceType: "INVOICE",
      sourceId: 1,
      endCustomerId: 1,
      codAmount: "60.00",
      collectedAmount: "60.00",
      status: "DISPATCHED",
      parcelStatus: "DELIVERED",
      moneyStatus: "PARTIAL",
      dispatchedBy: 1,
    });
    await db().insert(s.deliveryLedgerEntries).values({
      eventKey: "history-courier",
      partyId: 1,
      consignmentId: 1,
      branchId: 1,
      entryType: "COD_COLLECTED",
      amount: "60.00",
    });
    await entry("PAYMENT_IN", "60.00", {
      invoiceId: 1,
      deliveryPartyId: 1,
      dedupeKey: "PAYMENT_IN:COURIER_DELIVERY:1",
    });
    await balance("0.00");
    const before = await frozenMoney();
    expect((await apply()).result).toMatchObject({
      existingPaidLinked: "0.00",
      newInvoiceAllocation: "0.00",
      accountAmount: "50.00",
    });
    expect(await frozenMoney()).toEqual(before);
  });
  it("reverses an adopted source through the existing voucher path exactly once", async () => {
    await invoice(1, "100.00", "100.00");
    await receive(1001, "100.00");
    await balance("0.00");
    const { input } = await apply();
    await cancelVoucher(1001, owner);
    expect((await db().select().from(s.invoices))[0].paidAmount).toBe("0.00");
    expect((await db().select().from(s.customers))[0].currentBalance).toBe(
      "100.00",
    );
    expect((await adoptCustomerReceiptHistory(input, owner)).mode).toBe(
      "REPLAY_VERIFIED",
    );
    expect(await db().select().from(s.receipts)).toHaveLength(2);
  });
});
