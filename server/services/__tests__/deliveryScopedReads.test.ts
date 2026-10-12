import { eq, gt, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import {
  getDeliveryPartyFinancials,
  getDeliveryPartyStatement,
  getPartyStoreInTransit,
  listConsignmentsForParty,
  listPartyObligations,
  listPartyRemittances,
  predictiveSearchConsignments,
} from "../delivery/queries";
import { getDeliveryParty, listDeliveryParties } from "../delivery/parties";
import { truncateTables } from "./__testUtils__";

const TABLES = [
  "deliveryOutbox",
  "deliveryEvents",
  "deliveryLedgerEntries",
  "deliveryRemittanceLines",
  "deliveryRemittances",
  "deliveryConsignments",
  "deliveryPartyMembers",
  "deliveryParties",
  "onlineOrders",
  "workOrders",
  "accountingEntries",
  "receipts",
  "invoices",
  "customers",
  "branches",
  "users",
];

function db() {
  const database = getDb();
  if (!database) throw new Error("Isolated test database is required");
  return database;
}

const at = (day: string) => new Date(`${day}T12:00:00Z`);

async function seedBase() {
  await db()
    .insert(s.branches)
    .values([
      { id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" },
      { id: 2, name: "المبيعات", code: "SALES", type: "SALES" },
    ]);
  await db().insert(s.users).values({
    id: 1,
    openId: "scoped-delivery-admin",
    name: "المدير",
    role: "admin",
    loginMethod: "local",
    branchId: 1,
  });
  await db().insert(s.customers).values({
    id: 1,
    name: "أحمد عبد الله",
    phone: "+9647701234567",
    currentBalance: "0.00",
  });
  // Shared company: the global cached balance must never substitute for a branch balance.
  await db().insert(s.deliveryParties).values({
    id: 1,
    name: "شركة مشتركة",
    partyType: "COMPANY",
    branchId: null,
    currentBalance: "999999.00",
    isActive: true,
  });
}

type ParcelOverrides = Partial<typeof s.deliveryConsignments.$inferInsert>;
async function seedParcels(
  count: number,
  branchId = 1,
  startId = 1,
  overrides: ParcelOverrides = {},
) {
  const ids = Array.from({ length: count }, (_, index) => startId + index);
  await db()
    .insert(s.invoices)
    .values(
      ids.map((id) => ({
        id,
        invoiceNumber: `SCOPED-INV-${id}`,
        branchId,
        subtotal: "1000.00",
        total: "1000.00",
        paidAmount: "0.00",
        returnedTotal: "0.00",
        createdBy: 1,
      })),
    );
  await db()
    .insert(s.deliveryConsignments)
    .values(
      ids.map((id) => ({
        id,
        consignmentNumber: `SCOPED-CN-${id}`,
        invoiceId: id,
        branchId,
        partyId: 1,
        sourceType: "INVOICE" as const,
        sourceId: id,
        endCustomerId: 1,
        status: "DISPATCHED" as const,
        parcelStatus: "OUT_FOR_DELIVERY" as const,
        moneyStatus: "UNSETTLED" as const,
        codAmount: "1000.00",
        collectedAmount: "0.00",
        counterSettledAmount: "0.00",
        deliveryFee: "0.00",
        feeCollection: "COURIER" as const,
        externalTrackingRef: String(id).padStart(8, "0"),
        dispatchedAt: at("2026-10-10"),
        dispatchedBy: 1,
        ...overrides,
      })),
    );
}

async function seedLedger(
  id: number,
  branchId: number | null,
  consignmentId: number | null,
  entryType: typeof s.deliveryLedgerEntries.$inferInsert.entryType,
  amount: string,
) {
  await db()
    .insert(s.deliveryLedgerEntries)
    .values({
      id,
      eventKey: `SCOPED-LEDGER-${id}`,
      branchId,
      consignmentId,
      partyId: 1,
      entryType,
      amount,
      occurredAt: at("2026-10-10"),
      createdBy: 1,
      shortfallReason:
        entryType === "SHORTFALL_ASSIGNED"
          ? "CUSTOMER_REQUESTED_DISCOUNT"
          : null,
    });
}

async function seedFinancialEvidence() {
  await seedParcels(1, 1, 1);
  await seedParcels(1, 2, 2);
  for (const branchId of [1, 2]) {
    const amount = branchId === 1 ? "100.00" : "900.00";
    await db()
      .insert(s.receipts)
      .values({
        id: branchId,
        branchId,
        amount,
        direction: "IN",
        paymentMethod: "CASH",
        cashBucket: "TREASURY",
        referenceNumber: `SCOPED-CASH-${branchId}`,
        createdBy: 1,
      });
    await db()
      .insert(s.deliveryRemittances)
      .values({
        id: branchId,
        branchId,
        partyId: 1,
        remittanceNumber: `SCOPED-DR-${branchId}`,
        collectedTotal: branchId === 1 ? "120.00" : "900.00",
        netRemitted: amount,
        shortfallTotal: branchId === 1 ? "20.00" : "0.00",
        status: "BALANCED",
        receivedBy: 1,
        receivedAt: at("2026-10-10"),
        receiptInId: branchId,
        companyStatementNumber: `SCOPED-STMT-${branchId}`,
        statementAttachmentUrl: `https://example.test/statement-${branchId}.pdf`,
      });
    await db()
      .insert(s.deliveryRemittanceLines)
      .values({
        id: branchId,
        remittanceId: branchId,
        consignmentId: branchId,
        grossApplied: branchId === 1 ? "120.00" : "900.00",
        cashReceived: amount,
      });
    await db()
      .insert(s.deliveryEvents)
      .values({
        id: branchId,
        eventKey: `SCOPED-EVENT-${branchId}`,
        consignmentId: branchId,
        eventType: "COLLECTION_RECORDED",
        occurredAt: at("2026-10-10"),
        actorUserId: 1,
      });
  }
  await seedLedger(1, 1, 1, "COD_ASSIGNED", "1000.00");
  await seedLedger(2, 1, 1, "COD_COLLECTED", "120.00");
  await seedLedger(3, 1, 1, "COD_REMITTED", "120.00");
  await seedLedger(4, 1, 1, "SHORTFALL_ASSIGNED", "20.00");
  await seedLedger(5, 2, 2, "COD_ASSIGNED", "9000.00");
  await seedLedger(6, 2, 2, "COD_COLLECTED", "900.00");
  await seedLedger(7, 2, 2, "COD_REMITTED", "900.00");
  // Unattributed legacy records are visible to global readers only.
  await seedLedger(8, null, null, "FEE_EARNED", "777.00");
}

async function snapshotEvidence() {
  return {
    consignments: await db()
      .select()
      .from(s.deliveryConsignments)
      .orderBy(s.deliveryConsignments.id),
    ledger: await db()
      .select()
      .from(s.deliveryLedgerEntries)
      .orderBy(s.deliveryLedgerEntries.id),
    remittances: await db()
      .select()
      .from(s.deliveryRemittances)
      .orderBy(s.deliveryRemittances.id),
    allocations: await db()
      .select()
      .from(s.deliveryRemittanceLines)
      .orderBy(s.deliveryRemittanceLines.id),
    events: await db()
      .select()
      .from(s.deliveryEvents)
      .orderBy(s.deliveryEvents.id),
    receipts: await db().select().from(s.receipts).orderBy(s.receipts.id),
    accounting: await db()
      .select()
      .from(s.accountingEntries)
      .orderBy(s.accountingEntries.id),
    invoices: await db().select().from(s.invoices).orderBy(s.invoices.id),
    parties: await db()
      .select()
      .from(s.deliveryParties)
      .orderBy(s.deliveryParties.id),
    customers: await db().select().from(s.customers).orderBy(s.customers.id),
  };
}

beforeEach(async () => {
  await truncateTables(TABLES);
  await seedBase();
});

describe("delivery company reads — branch scope and complete filtered totals", () => {
  it("exports all 240 same-branch rows through keyset pages without leaking newer foreign rows", async () => {
    await seedParcels(240);
    await seedParcels(10, 2, 1001);
    const first = await listConsignmentsForParty(1, false, {}, 1);
    expect(first.rows).toHaveLength(200);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBe(41);
    expect(first.totals).toMatchObject({
      count: 240,
      codAmount: "240000.00",
      creditedCollections: "0.00",
      counterSettledAmount: "0.00",
      shortfallAssigned: "0.00",
      remainingDue: "240000.00",
    });
    const second = await listConsignmentsForParty(
      1,
      false,
      { cursor: first.nextCursor! },
      1,
    );
    expect(second.rows).toHaveLength(40);
    expect(second.hasMore).toBe(false);
    expect(second.nextCursor).toBeNull();
    expect(second.totals).toEqual(first.totals);
    const ids = [...first.rows, ...second.rows].map((row) => row.id);
    expect(ids).toEqual(Array.from({ length: 240 }, (_, index) => 240 - index));
    expect(new Set(ids).size).toBe(240);
    expect((await listConsignmentsForParty(1, false, {}, 2)).totals.count).toBe(
      10,
    );
    expect(
      (await listConsignmentsForParty(1, false, {}, null)).totals.count,
    ).toBe(250);
  });

  it("applies tracking search, state and date bounds before paging and keeps all-filter totals after the cursor", async () => {
    await seedParcels(240);
    await seedParcels(3, 1, 1001, {
      externalTrackingRef: null,
      recipientName: "أحمد عبد الله",
      parcelStatus: "DELIVERED",
      dispatchedAt: at("2026-10-11"),
    });
    const tracking = await listConsignmentsForParty(
      1,
      false,
      { query: "٠٠٠٠٠٠٠١", limit: 1 },
      1,
    );
    expect(tracking.rows.map((row) => row.id)).toEqual([1]);
    expect(tracking.rows[0].externalTrackingRef).toBe("00000001");
    expect(tracking.totals.count).toBe(1);
    const filters = {
      query: "احمد عبد",
      state: "DELIVERED_UNCOLLECTED" as const,
      from: "2026-10-11",
      to: "2026-10-11",
      limit: 2,
    };
    const first = await listConsignmentsForParty(1, false, filters, 1);
    expect(first.rows.map((row) => row.id)).toEqual([1003, 1002]);
    expect(first.totals).toMatchObject({
      count: 3,
      codAmount: "3000.00",
      remainingDue: "3000.00",
    });
    const second = await listConsignmentsForParty(
      1,
      false,
      { ...filters, cursor: first.nextCursor! },
      1,
    );
    expect(second.rows.map((row) => row.id)).toEqual([1001]);
    expect(second.totals).toEqual(first.totals);
    expect(
      (
        await listConsignmentsForParty(
          1,
          false,
          { ...filters, from: "2026-10-12" },
          1,
        )
      ).totals.count,
    ).toBe(0);
  });

  it("subtracts partial collections, counter payments and net assigned shortfall exactly once and clamps each remaining amount", async () => {
    await seedParcels(1, 1, 1, {
      codAmount: "1000.00",
      collectedAmount: "300.00",
      counterSettledAmount: "200.00",
      status: "PARTIAL",
      parcelStatus: "DELIVERED",
      moneyStatus: "PARTIAL",
    });
    await seedLedger(1, 1, 1, "SHORTFALL_ASSIGNED", "100.00");
    await seedLedger(2, 1, 1, "SHORTFALL_SETTLED", "40.00");
    await seedParcels(1, 1, 2, {
      codAmount: "100.00",
      collectedAmount: "150.00",
    });
    const result = await listConsignmentsForParty(1, false, {}, 1);
    expect(result.rows.find((row) => row.id === 1)).toMatchObject({
      collectedAmount: "300.00",
      counterSettledAmount: "200.00",
      shortfallAssigned: "60.00",
      remainingDue: "440.00",
    });
    expect(result.rows.find((row) => row.id === 2)?.remainingDue).toBe("0.00");
    expect(result.totals).toMatchObject({
      count: 2,
      codAmount: "1100.00",
      creditedCollections: "450.00",
      counterSettledAmount: "200.00",
      shortfallAssigned: "60.00",
      remainingDue: "440.00",
    });
  });

  it("isolates financial ledger, allocations, events and summary while distinguishing actual cash from gross settlement", async () => {
    await seedFinancialEvidence();
    const first = await getDeliveryPartyFinancials(1, {}, 1);
    expect(first).not.toBeNull();
    expect(first!.ledger.rows.map((row) => row.id)).toEqual([4, 3, 2, 1]);
    expect(first!.allocations.rows.map((row) => row.id)).toEqual([1]);
    expect(first!.events.rows.map((row) => row.id)).toEqual([1]);
    expect(first!.summary).toMatchObject({
      codAssigned: "1000.00",
      codCollected: "120.00",
      codRemitted: "120.00",
      cashReceived: "100.00",
      grossSettled: "120.00",
      shortfallAssigned: "20.00",
      feeEarned: "0.00",
    });
    const second = await getDeliveryPartyFinancials(1, {}, 2);
    expect(second!.ledger.rows.map((row) => row.id)).toEqual([7, 6, 5]);
    expect(second!.allocations.rows.map((row) => row.id)).toEqual([2]);
    expect(second!.events.rows.map((row) => row.id)).toEqual([2]);
    expect(second!.summary).toMatchObject({
      cashReceived: "900.00",
      grossSettled: "900.00",
      shortfallAssigned: "0.00",
    });
    expect((await getDeliveryPartyFinancials(1))!.ledger.rows).toHaveLength(8);
  });

  it("includes remittance-level assigned shortfall in the scoped summary and subtracts its settlements", async () => {
    await seedFinancialEvidence();
    await db()
      .insert(s.deliveryLedgerEntries)
      .values([
        {
          id: 9,
          eventKey: "SCOPED-REMIT-SHORTFALL",
          partyId: 1,
          branchId: 1,
          consignmentId: null,
          remittanceId: 1,
          entryType: "SHORTFALL_ASSIGNED",
          amount: "30.00",
          shortfallReason: "OTHER",
        },
        {
          id: 10,
          eventKey: "SCOPED-REMIT-SHORTFALL-SETTLED",
          partyId: 1,
          branchId: 1,
          consignmentId: null,
          remittanceId: 1,
          entryType: "SHORTFALL_SETTLED",
          amount: "10.00",
        },
      ]);
    const first = await getDeliveryPartyFinancials(1, {}, 1);
    expect(first!.summary).toMatchObject({
      shortfallAssignedTotal: "50.00",
      shortfallAssigned: "40.00",
    });
    const second = await getDeliveryPartyFinancials(1, {}, 2);
    expect(second!.summary).toMatchObject({
      shortfallAssignedTotal: "0.00",
      shortfallAssigned: "0.00",
    });
    // A remittance-level debt must never be attributed to an individual parcel.
    const parcel = await listConsignmentsForParty(1, false, {}, 1);
    expect(parcel.rows[0].shortfallAssigned).toBe("20.00");
  });

  it("finds work-order contactPhone-only parcels using Arabic international digits while respecting the branch", async () => {
    await db()
      .insert(s.workOrders)
      .values([
        {
          id: 501,
          orderNumber: "SCOPED-WO-501",
          branchId: 1,
          title: "طلب زبون نقدي",
          status: "READY",
          contactName: "جهة الاتصال",
          contactPhone: "07707654321",
          customerId: null,
          deliveryPhone: null,
          createdBy: 1,
        },
        {
          id: 502,
          orderNumber: "SCOPED-WO-502",
          branchId: 2,
          title: "طلب الفرع الآخر",
          status: "READY",
          contactName: "جهة الاتصال",
          contactPhone: "07707654321",
          customerId: null,
          deliveryPhone: null,
          createdBy: 1,
        },
      ]);
    await seedParcels(1, 1, 1, {
      workOrderId: 501,
      sourceType: "WORK_ORDER",
      sourceId: 501,
      endCustomerId: null,
      recipientName: null,
      recipientPhone: null,
    });
    await seedParcels(1, 2, 2, {
      workOrderId: 502,
      sourceType: "WORK_ORDER",
      sourceId: 502,
      endCustomerId: null,
      recipientName: null,
      recipientPhone: null,
    });
    const first = await predictiveSearchConsignments({
      branchId: 1,
      partyId: 1,
      query: "+٩٦٤٧٧٠٧٦٥٤٣٢١",
      limit: 5,
    });
    expect(first.map((row) => row.id)).toEqual([1]);
    expect(first[0]).toMatchObject({
      customerName: "جهة الاتصال",
      customerPhone: "07707654321",
    });
    const second = await predictiveSearchConsignments({
      branchId: 2,
      partyId: 1,
      query: "+٩٦٤٧٧٠٧٦٥٤٣٢١",
      limit: 5,
    });
    expect(second.map((row) => row.id)).toEqual([2]);
  });

  it("keeps remittances as an array and applies branch, date and cursor before limit with receipt evidence", async () => {
    await seedFinancialEvidence();
    const rows = await listPartyRemittances(1, {
      scopedBranchId: 1,
      from: "2026-10-10",
      to: "2026-10-10",
      limit: 1,
    });
    expect(Array.isArray(rows)).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 1,
      branchId: 1,
      receiptInId: 1,
      companyStatementNumber: "SCOPED-STMT-1",
      statementAttachmentUrl: "https://example.test/statement-1.pdf",
    });
    expect(
      await listPartyRemittances(1, { scopedBranchId: 1, cursor: 1 }),
    ).toEqual([]);
    expect(
      await listPartyRemittances(1, { scopedBranchId: 1, from: "2026-10-11" }),
    ).toEqual([]);
    expect((await listPartyRemittances(1)).map((row) => row.id)).toEqual([
      2, 1,
    ]);
  });

  it("isolates store parcels without a live consignment and clamps invoice exposure per order", async () => {
    await db()
      .insert(s.invoices)
      .values([
        {
          id: 1,
          invoiceNumber: "STORE-1",
          branchId: 1,
          subtotal: "1000.00",
          total: "1000.00",
          paidAmount: "200.00",
          returnedTotal: "100.00",
          createdBy: 1,
        },
        {
          id: 2,
          invoiceNumber: "STORE-2",
          branchId: 2,
          subtotal: "9000.00",
          total: "9000.00",
          paidAmount: "0.00",
          createdBy: 1,
        },
        {
          id: 3,
          invoiceNumber: "STORE-3",
          branchId: 1,
          subtotal: "100.00",
          total: "100.00",
          paidAmount: "200.00",
          createdBy: 1,
        },
      ]);
    await db()
      .insert(s.onlineOrders)
      .values(
        [1, 2, 3].map((id) => ({
          id,
          orderNumber: `SCOPED-STORE-${id}`,
          invoiceId: id,
          customerId: 1,
          branchId: id === 2 ? 2 : 1,
          deliveryPartyId: 1,
          status: "SHIPPED" as const,
          subtotal: "1000.00",
          total: "1000.00",
        })),
      );
    expect(await getPartyStoreInTransit(1, 1)).toEqual({
      count: 2,
      value: "700.00",
    });
    expect(await getPartyStoreInTransit(1, 2)).toEqual({
      count: 1,
      value: "9000.00",
    });
    expect(await getPartyStoreInTransit(1)).toEqual({
      count: 3,
      value: "9700.00",
    });
  });

  it("carries pre-period custody, includes both date boundaries, and excludes later and foreign entries from closing", async () => {
    await db()
      .insert(s.accountingEntries)
      .values([
        {
          id: 1,
          branchId: 1,
          deliveryPartyId: 1,
          entryType: "DELIVERY_DISPATCH",
          amount: "1000.00",
          entryDate: "2026-10-01",
        },
        {
          id: 2,
          branchId: 1,
          deliveryPartyId: 1,
          entryType: "DELIVERY_REMIT",
          amount: "200.00",
          entryDate: "2026-10-02",
        },
        {
          id: 3,
          branchId: 1,
          deliveryPartyId: 1,
          entryType: "DELIVERY_DISPATCH",
          amount: "300.00",
          entryDate: "2026-10-10",
        },
        {
          id: 4,
          branchId: 1,
          deliveryPartyId: 1,
          entryType: "DELIVERY_REMIT",
          amount: "100.00",
          entryDate: "2026-10-11",
        },
        {
          id: 5,
          branchId: 1,
          deliveryPartyId: 1,
          entryType: "DELIVERY_DISPATCH",
          amount: "900.00",
          entryDate: "2026-10-12",
        },
        {
          id: 6,
          branchId: 2,
          deliveryPartyId: 1,
          entryType: "DELIVERY_DISPATCH",
          amount: "9000.00",
          entryDate: "2026-10-01",
        },
        {
          id: 7,
          branchId: 2,
          deliveryPartyId: 1,
          entryType: "DELIVERY_REMIT",
          amount: "7000.00",
          entryDate: "2026-10-10",
        },
      ]);
    const statement = await getDeliveryPartyStatement(
      1,
      "2026-10-10",
      "2026-10-11",
      1,
    );
    expect(statement!.entries.map((row) => row.id)).toEqual([3, 4]);
    expect(statement).toMatchObject({
      currentBalance: "1900.00",
      openingBalance: "800.00",
      debitTotal: "300.00",
      creditTotal: "100.00",
      closingBalance: "1000.00",
    });
    const emptyPeriod = await getDeliveryPartyStatement(
      1,
      "2026-10-03",
      "2026-10-09",
      1,
    );
    expect(emptyPeriod).toMatchObject({
      entries: [],
      openingBalance: "800.00",
      debitTotal: "0.00",
      creditTotal: "0.00",
      closingBalance: "800.00",
    });
    const other = await getDeliveryPartyStatement(
      1,
      "2026-10-10",
      "2026-10-11",
      2,
    );
    expect(other!.entries.map((row) => row.id)).toEqual([7]);
    expect(other).toMatchObject({
      openingBalance: "9000.00",
      closingBalance: "2000.00",
    });
  });

  it("discloses writeoff recovery as positive debit and cash remittance as positive credit without netting period movement", async () => {
    await db()
      .insert(s.accountingEntries)
      .values([
        {
          branchId: 1,
          deliveryPartyId: 1,
          entryType: "DELIVERY_DISPATCH",
          amount: "100.00",
          entryDate: "2026-10-01",
        },
        {
          branchId: 1,
          deliveryPartyId: 1,
          entryType: "DELIVERY_WRITEOFF",
          amount: "-25.00",
          entryDate: "2026-10-10",
        },
        {
          branchId: 1,
          deliveryPartyId: 1,
          entryType: "DELIVERY_REMIT",
          amount: "25.00",
          entryDate: "2026-10-10",
        },
        {
          branchId: 1,
          deliveryPartyId: 1,
          entryType: "DELIVERY_FEE",
          amount: "15.00",
          entryDate: "2026-10-10",
        },
      ]);
    const before = await db().select().from(s.accountingEntries);
    expect(
      await getDeliveryPartyStatement(1, "2026-10-10", "2026-10-10", 1),
    ).toMatchObject({
      openingBalance: "100.00",
      debitTotal: "25.00",
      creditTotal: "25.00",
      closingBalance: "100.00",
    });
    expect(await db().select().from(s.accountingEntries)).toEqual(before);
  });

  it("classifies physical and monetary states without treating a received return as pending", async () => {
    await seedParcels(1, 1, 1);
    await seedParcels(1, 1, 2, { parcelStatus: "DELIVERED" });
    await seedParcels(1, 1, 3, {
      parcelStatus: "DELIVERED",
      collectedAmount: "200.00",
      status: "PARTIAL",
      moneyStatus: "PARTIAL",
    });
    await seedLedger(1, 1, 3, "COD_COLLECTED", "200.00");
    await seedParcels(1, 1, 4, { returnDeclaredAt: at("2026-10-10") });
    await seedParcels(1, 1, 5, {
      returnDeclaredAt: at("2026-10-10"),
      parcelStatus: "RETURNED",
      status: "RETURNED",
      moneyStatus: "CANCELLED",
    });
    await seedParcels(1, 1, 6, {
      parcelStatus: "DELIVERED",
      status: "DELIVERED",
      collectedAmount: "1000.00",
      moneyStatus: "SETTLED",
    });
    const expected = {
      IN_TRANSIT: [1],
      DELIVERED_UNCOLLECTED: [3, 2],
      COLLECTED_UNREMITTED: [3],
      RETURN_PENDING: [4],
      CLOSED: [6, 5],
    } as const;
    for (const [state, ids] of Object.entries(expected)) {
      const result = await listConsignmentsForParty(
        1,
        false,
        {
          state: state as keyof typeof expected,
        },
        1,
      );
      expect(
        result.rows.map((row) => row.id),
        state,
      ).toEqual(ids);
      expect(result.totals.count, state).toBe(ids.length);
    }
  });

  it("keeps terminal COD history without adding returned, cancelled or written-off parcels to outstanding totals", async () => {
    await seedParcels(1, 1, 1);
    await seedParcels(1, 1, 2, {
      status: "RETURNED",
      parcelStatus: "RETURNED",
      moneyStatus: "CANCELLED",
    });
    await seedParcels(1, 1, 3, {
      status: "CANCELLED",
      moneyStatus: "CANCELLED",
    });
    await seedParcels(1, 1, 4, {
      status: "WRITTEN_OFF",
      moneyStatus: "WRITTEN_OFF",
    });
    await seedParcels(1, 1, 5, {
      status: "DELIVERED",
      parcelStatus: "DELIVERED",
      moneyStatus: "SETTLED",
    });
    const before = await db().select().from(s.deliveryConsignments);
    const closed = await listConsignmentsForParty(
      1,
      false,
      { state: "CLOSED" },
      1,
    );
    expect(closed.rows.map((row) => row.id)).toEqual([5, 4, 3, 2]);
    expect(closed.rows.every((row) => row.remainingDue === "0.00")).toBe(true);
    expect(closed.totals).toMatchObject({
      count: 4,
      codAmount: "4000.00",
      remainingDue: "0.00",
    });
    const all = await listConsignmentsForParty(
      1,
      false,
      { state: "ALL", limit: 2 },
      1,
    );
    expect(all.totals).toMatchObject({
      count: 5,
      codAmount: "5000.00",
      remainingDue: "1000.00",
    });
    expect(all.rows.every((row) => row.remainingDue === "0.00")).toBe(true);
    expect(await db().select().from(s.deliveryConsignments)).toEqual(before);
  });

  it("ranks an older exact Arabic-digit tracking match before hundreds of newer partial matches", async () => {
    await seedParcels(650);
    await db()
      .update(s.deliveryConsignments)
      .set({
        externalTrackingRef: sql`CONCAT('00000001-', ${s.deliveryConsignments.id})`,
      })
      .where(gt(s.deliveryConsignments.id, 1));
    const results = await predictiveSearchConsignments({
      branchId: 1,
      partyId: 1,
      query: "٠٠٠٠٠٠٠١",
      limit: 5,
    });
    expect(results).toHaveLength(5);
    expect(results[0]).toMatchObject({
      id: 1,
      externalTrackingRef: "00000001",
      score: 0,
    });
    const byName = await predictiveSearchConsignments({
      branchId: 1,
      partyId: 1,
      query: "احمد عبد",
      limit: 3,
    });
    expect(byName).toHaveLength(3);
    expect(byName.every((row) => row.customerName === "أحمد عبد الله")).toBe(
      true,
    );
  });

  it("keeps inactive companies with unpaid historical fees visible without parcels and excludes fully paid fees", async () => {
    await db()
      .insert(s.deliveryParties)
      .values([
        {
          id: 2,
          name: "شركة معطلة بأجرة مستحقة",
          partyType: "COMPANY",
          branchId: null,
          currentBalance: "0.00",
          isActive: false,
        },
        {
          id: 3,
          name: "شركة معطلة سددت أجورها",
          partyType: "COMPANY",
          branchId: null,
          currentBalance: "0.00",
          isActive: false,
        },
      ]);
    await db()
      .insert(s.deliveryLedgerEntries)
      .values([
        {
          id: 1,
          eventKey: "SCOPED-INACTIVE-FEE-1",
          partyId: 2,
          branchId: 1,
          entryType: "FEE_EARNED",
          amount: "500.00",
        },
        {
          id: 2,
          eventKey: "SCOPED-INACTIVE-FEE-2",
          partyId: 2,
          branchId: 2,
          entryType: "FEE_EARNED",
          amount: "900.00",
        },
        {
          id: 3,
          eventKey: "SCOPED-INACTIVE-PAID-1",
          partyId: 3,
          branchId: 1,
          entryType: "FEE_EARNED",
          amount: "300.00",
        },
        {
          id: 4,
          eventKey: "SCOPED-INACTIVE-PAID-2",
          partyId: 3,
          branchId: 1,
          entryType: "FEE_PAID",
          amount: "300.00",
        },
      ]);
    const first = await listPartyObligations(1);
    expect(first.map((row) => row.partyId)).toEqual([2]);
    expect(first[0]).toMatchObject({
      openCount: 0,
      currentBalance: "0.00",
      feeDueTotal: "500.00",
    });
    const second = await listPartyObligations(2);
    expect(second.map((row) => row.partyId)).toEqual([2]);
    expect(second[0].feeDueTotal).toBe("900.00");
  });

  it("returns branch ledger balances and exposures for shared parties instead of the global cached balance", async () => {
    await seedFinancialEvidence();
    await seedLedger(9, 1, 1, "COD_COLLECTED", "80.00");
    await seedLedger(10, 2, 2, "COD_COLLECTED", "300.00");
    await seedLedger(11, 1, 1, "FEE_EARNED", "25.00");
    await seedLedger(12, 2, 2, "FEE_EARNED", "75.00");
    const first = await listDeliveryParties({ branchId: 1 });
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      id: 1,
      currentBalance: "100.00",
      cashInHandLedger: "80.00",
      cashInHandStored: "80.00",
      shortfallOwedAmount: "20.00",
      parcelsInTransitAmount: "1000.00",
      feesOwedAmount: "25.00",
      openConsignments: 1,
    });
    const second = await listDeliveryParties({ branchId: 2 });
    expect(second[0]).toMatchObject({
      id: 1,
      currentBalance: "300.00",
      cashInHandLedger: "300.00",
      cashInHandStored: "300.00",
      shortfallOwedAmount: "0.00",
      parcelsInTransitAmount: "1000.00",
      feesOwedAmount: "75.00",
      openConsignments: 1,
    });
    const obligations = await listPartyObligations(1);
    expect(obligations[0]).toMatchObject({
      partyId: 1,
      currentBalance: "100.00",
      cashInHandLedger: "80.00",
      feeDueTotal: "25.00",
      openCount: 1,
    });
    expect((await listDeliveryParties({}))[0].currentBalance).toBe("999999.00");
    expect((await getDeliveryParty(1, 1))!.currentBalance).toBe("100.00");
    expect((await getDeliveryParty(1, 2))!.currentBalance).toBe("300.00");
    expect((await getDeliveryParty(1))!.currentBalance).toBe("999999.00");
  });

  it("counts actual historical cash receipts once, including unallocated remittances and loose ledger links", async () => {
    await seedFinancialEvidence();
    // Historical allocation snapshots can differ from the actual receipt.
    await db()
      .update(s.deliveryRemittanceLines)
      .set({ cashReceived: "7.00" })
      .where(eq(s.deliveryRemittanceLines.id, 1));
    await db()
      .insert(s.receipts)
      .values([
        {
          id: 3,
          branchId: 1,
          amount: "70.00",
          direction: "IN",
          paymentMethod: "CASH",
          status: "COMPLETED",
        },
        {
          id: 4,
          branchId: 1,
          amount: "30.00",
          direction: "IN",
          paymentMethod: "CASH",
          status: "COMPLETED",
        },
        {
          id: 5,
          branchId: 2,
          amount: "400.00",
          direction: "IN",
          paymentMethod: "CASH",
          status: "COMPLETED",
        },
        {
          id: 6,
          branchId: 1,
          amount: "999.00",
          direction: "IN",
          paymentMethod: "CASH",
          status: "REVERSED",
        },
        {
          id: 7,
          branchId: 1,
          amount: "999.00",
          direction: "IN",
          paymentMethod: "TRANSFER",
          status: "COMPLETED",
        },
        {
          id: 8,
          branchId: 1,
          amount: "999.00",
          direction: "OUT",
          paymentMethod: "CASH",
          status: "COMPLETED",
        },
        {
          id: 9,
          branchId: 1,
          amount: "555.00",
          direction: "IN",
          paymentMethod: "CASH",
          status: "COMPLETED",
        },
      ]);
    await db().insert(s.deliveryRemittances).values({
      id: 3,
      branchId: 1,
      partyId: 1,
      remittanceNumber: "SCOPED-DR-NO-LINES",
      collectedTotal: "70.00",
      netRemitted: "70.00",
      status: "BALANCED",
      receiptInId: 3,
    });
    await db()
      .insert(s.accountingEntries)
      .values([
        {
          id: 1,
          branchId: 1,
          deliveryPartyId: 1,
          receiptId: 4,
          entryType: "DELIVERY_REMIT",
          amount: "30.00",
          entryDate: "2026-10-10",
        },
        {
          id: 2,
          branchId: 1,
          deliveryPartyId: 1,
          receiptId: 4,
          entryType: "DELIVERY_REMIT",
          amount: "30.00",
          entryDate: "2026-10-10",
        },
        {
          id: 3,
          branchId: 2,
          deliveryPartyId: 1,
          receiptId: 5,
          entryType: "DELIVERY_REMIT",
          amount: "400.00",
          entryDate: "2026-10-10",
        },
        ...[6, 7, 8].map((id) => ({
          id,
          branchId: 1,
          deliveryPartyId: 1,
          receiptId: id,
          entryType: "DELIVERY_REMIT" as const,
          amount: "999.00",
          entryDate: "2026-10-10",
        })),
      ]);
    const first = await getDeliveryPartyFinancials(1, {}, 1);
    expect(first!.summary).toMatchObject({
      cashReceived: "200.00",
      grossSettled: "190.00",
    });
    const second = await getDeliveryPartyFinancials(1, {}, 2);
    expect(second!.summary.cashReceived).toBe("1300.00");
    expect((await getDeliveryPartyFinancials(1))!.summary.cashReceived).toBe(
      "1500.00",
    );
  });

  it("repeated scoped reads preserve every receipt, ledger entry, document and stored balance", async () => {
    await seedFinancialEvidence();
    const before = await snapshotEvidence();
    for (let retry = 0; retry < 2; retry++) {
      await listConsignmentsForParty(1, false, { limit: 1 }, 1);
      await getDeliveryPartyFinancials(1, { ledger: { limit: 2 } }, 1);
      await getDeliveryPartyStatement(1, "2026-10-01", "2026-10-12", 1);
      await getPartyStoreInTransit(1, 1);
      await listPartyRemittances(1, { scopedBranchId: 1 });
    }
    expect(await snapshotEvidence()).toEqual(before);
  });
});
