import { repairHistoricalFeeWithholding } from "../delivery/historicalFeeWithholding";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import {
  recordCompanyStatement,
  recordStaffDeliveryConfirmation,
} from "../delivery/companyStatement";
import { listOpenConsignments } from "../delivery/queries";
import { payDeliveryFee } from "../delivery/fees";
import { recordDeliveryRemittance } from "../delivery/remittance";
import {
  previewDailySettlementTx,
  settleDailyTx,
} from "../delivery/dailySettlement";
import { dispatchOnlineOrder } from "../storeAdmin/dispatchOnlineOrder";
import { loadOnlineOrderLifecycles } from "../storeAdmin/onlineOrderTracking";
import { withTx } from "../tx";
import { money } from "../money";
import { openShift } from "../shiftService";

const CASHIER = { userId: 2, branchId: 1, role: "cashier" };
const MANAGER = { userId: 1, branchId: 1, role: "manager" };
const DRIVER = { userId: 3 };

function db() {
  const connection = getDb();
  if (!connection) throw new Error("DATABASE_URL not set for tests");
  return connection;
}

const amount = (value: string | number) => money(value).toFixed(2);
const sum = (rows: { amount: string }[]) =>
  rows
    .reduce((total, row) => total.plus(money(row.amount)), money(0))
    .toFixed(2);

beforeEach(async () => {
  await db()
    .insert(s.branches)
    .values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await db()
    .insert(s.users)
    .values([
      {
        id: 1,
        openId: "integrity-manager",
        name: "مدير",
        email: "manager@integrity.test",
        role: "manager",
        loginMethod: "local",
        branchId: 1,
      },
      {
        id: 2,
        openId: "integrity-cashier",
        name: "كاشير",
        email: "cashier@integrity.test",
        role: "cashier",
        loginMethod: "local",
        branchId: 1,
      },
      {
        id: 3,
        openId: "integrity-driver",
        name: "مندوب",
        email: "driver@integrity.test",
        role: "courier",
        loginMethod: "local",
        branchId: 1,
      },
    ]);
  await db().insert(s.customers).values({
    id: 1,
    name: "عميل التوصيل",
    phone: "+9647701234567",
    currentBalance: "0.00",
    creditLimit: null,
  });
  await db().insert(s.deliveryParties).values({
    id: 1,
    name: "شركة توصيل",
    partyType: "COMPANY",
    branchId: 1,
    currentBalance: "0.00",
    defaultFee: "0.00",
    isActive: true,
  });
  await db().insert(s.deliveryPartyMembers).values({
    partyId: 1,
    userId: DRIVER.userId,
    memberRole: "DRIVER",
    isActive: true,
  });
  await db().insert(s.products).values({ id: 1, name: "دفتر" });
  await db().insert(s.productVariants).values({
    id: 1,
    productId: 1,
    sku: "COLLECTION-INTEGRITY",
    costPrice: "500.00",
  });
  await db().insert(s.productUnits).values({
    id: 1,
    variantId: 1,
    unitName: "قطعة",
    conversionFactor: 1,
    isBaseUnit: true,
  });
  await db()
    .insert(s.productPrices)
    .values({ productUnitId: 1, priceTier: "RETAIL", price: "1000.00" });
  await db()
    .insert(s.branchStock)
    .values({ variantId: 1, branchId: 1, quantity: 500 });
  // Real journal lines expose a duplicate AR/custody posting that balanced operational totals can hide.
  await db().insert(s.doubleEntrySettings).values({
    id: 1,
    mode: "SHADOW",
    shadowCycleId: "delivery-collection-integrity",
  });
});

async function onlineDelivery(free = true, openingBalance = "0") {
  const shift = await openShift(
    { branchId: 1, openingBalance: "0", shiftType: "RECEPTION" },
    CASHIER,
  );
  if (money(openingBalance).gt(0)) {
    await db().insert(s.receipts).values({
      branchId: 1,
      shiftId: shift.shiftId,
      direction: "IN",
      amount: openingBalance,
      paymentMethod: "CASH",
      cashBucket: "DRAWER",
      status: "COMPLETED",
      referenceNumber: "FEE-TEST-FUND",
      createdBy: 2,
    });
  }
  await db()
    .insert(s.onlineOrders)
    .values({
      id: 1,
      orderNumber: "ORD-FEE",
      customerId: 1,
      branchId: 1,
      subtotal: "20000",
      shippingCost: free ? "0" : "1500",
      deliveryFree: free,
      deliveryWaivedAmount: free ? "1500" : "0",
      total: free ? "20000" : "21500",
      status: "CONFIRMED",
    });
  await db().insert(s.onlineOrderItems).values({
    onlineOrderId: 1,
    variantId: 1,
    productUnitId: 1,
    quantity: 20,
    baseQuantity: 20,
    unitPrice: "1000",
    total: "20000",
  });
  const dispatched = await dispatchOnlineOrder(
    { onlineOrderId: 1, partyId: 1, externalTrackingRef: "ONLINE-FEE" },
    MANAGER,
  );
  return {
    ...dispatched,
    shiftId: shift.shiftId,
    consignmentId: dispatched.consignmentId!,
  };
}

async function assertClosed(invoiceId: number, net: string, fee = "1500.00") {
  const inv = (
    await db().select().from(s.invoices).where(eq(s.invoices.id, invoiceId))
  )[0];
  expect(amount(inv!.paidAmount)).toBe("20000.00");
  expect((await db().select().from(s.customers))[0].currentBalance).toBe(
    "0.00",
  );
  expect((await db().select().from(s.deliveryParties))[0].currentBalance).toBe(
    "0.00",
  );
  const cash = (await db().select().from(s.receipts))
    .filter((r) => r.referenceNumber !== "FEE-TEST-FUND")
    .reduce(
      (v, r) => v.plus(money(r.amount).mul(r.direction === "IN" ? 1 : -1)),
      money(0),
    );
  expect(cash.toFixed(2)).toBe(net);
  const entries = await db().select().from(s.accountingEntries);
  expect(
    entries.filter((r) => r.dedupeKey?.startsWith("DELIVERY_FEE_ACCRUAL:")),
  ).toHaveLength(1);
  expect(
    sum(
      entries.filter((r) => r.dedupeKey?.startsWith("DELIVERY_FEE_ACCRUAL:")),
    ),
  ).toBe(fee);
  expect(
    entries.filter((r) => r.dedupeKey?.startsWith("DLV-STMT-DEDUCTION:")),
  ).toHaveLength(0);
  const journal = await db().select().from(s.journalLines);
  const balance = (role: string) =>
    journal
      .filter((r) => r.role === role)
      .reduce((v, r) => v.plus(money(r.debit)).minus(money(r.credit)), money(0))
      .toFixed(2);
  expect(balance("COURIER_PAYABLE")).toBe("0.00");
  expect(balance("DELIVERY_FLOAT")).toBe("0.00");
  expect(balance("AR")).toBe("0.00");
  expect(balance("DELIVERY_EXPENSE")).toBe(fee);
}

describe("online delivery fee withholding", () => {
  it("dispatch, company proof and net remittance settle customer and earned fee once", async () => {
    const d = await onlineDelivery();
    const input = {
      partyId: 1,
      branchId: 1,
      statementNumber: "STORE-NET",
      countedCash: "18500",
      lines: [{ consignmentId: d.consignmentId, collectedAmount: "20000" }],
      clientRequestId: "store-net",
    };
    await recordCompanyStatement(input, CASHIER);
    await assertClosed(d.invoiceId, "18500.00");
    const before = (await db().select().from(s.accountingEntries)).length;
    await recordCompanyStatement(input, CASHIER);
    expect((await db().select().from(s.accountingEntries)).length).toBe(before);
    await expect(
      payDeliveryFee(
        {
          consignmentId: d.consignmentId,
          shiftId: d.shiftId,
          clientRequestId: "again",
        },
        CASHIER,
      ),
    ).rejects.toThrow(/المستحق/);
    expect((await db().select().from(s.deliveryRemittances))[0].feesTotal).toBe(
      "1500.00",
    );
    expect(
      (await db().select().from(s.deliveryRemittanceLines))[0],
    ).toMatchObject({
      grossApplied: "20000.00",
      feeOffset: "1500.00",
      cashReceived: "18500.00",
    });
  });
  it("declared statement deduction settles the existing payable without a second expense", async () => {
    const d = await onlineDelivery();
    await recordCompanyStatement(
      {
        partyId: 1,
        branchId: 1,
        statementNumber: "STORE-DEDUCTION",
        countedCash: "18500",
        deductionsTotal: "1500",
        lines: [{ consignmentId: d.consignmentId, collectedAmount: "20000" }],
        clientRequestId: "store-deduction",
      },
      CASHIER,
    );
    await assertClosed(d.invoiceId, "18500.00");
  });
});

it("retains a fee once across partial remittances and previews the same net", async () => {
  const d = await onlineDelivery();
  expect((await listOpenConsignments(1, 1)).rows[0].feeWithholdingCash).toBe(
    "1500.00",
  );
  await recordStaffDeliveryConfirmation(
    {
      consignmentId: d.consignmentId,
      collectedAmount: "20000",
      evidence: "تأكيد العميل",
      clientRequestId: "proof-partial",
    },
    CASHIER,
  );
  const preview = await withTx((tx) =>
    previewDailySettlementTx(tx, { partyId: 1, branchId: 1 }, CASHIER),
  );
  expect(preview).toMatchObject({
    expectedCash: "20000.00",
    deductions: "1500.00",
    net: "18500.00",
  });
  await recordDeliveryRemittance(
    {
      partyId: 1,
      branchId: 1,
      countedCash: "0",
      lines: [{ consignmentId: d.consignmentId, collectedAmount: "1000" }],
      clientRequestId: "partial-one",
    },
    CASHIER,
  );
  expect((await loadOnlineOrderLifecycles(db(), [1])).get(1)).toMatchObject({
    trackingComplete: true,
    financialComplete: false,
    feeDueAmount: "500.00",
  });
  await recordDeliveryRemittance(
    {
      partyId: 1,
      branchId: 1,
      countedCash: "18500",
      lines: [{ consignmentId: d.consignmentId, collectedAmount: "19000" }],
      clientRequestId: "partial-two",
    },
    CASHIER,
  );
  await assertClosed(d.invoiceId, "18500.00");
  expect((await loadOnlineOrderLifecycles(db(), [1])).get(1)).toMatchObject({
    financialComplete: true,
    feeDueAmount: "0.00",
  });
  expect(
    sum(
      (await db().select().from(s.deliveryLedgerEntries)).filter(
        (r) => r.entryType === "FEE_OFFSET",
      ),
    ),
  ).toBe("1500.00");
});

it("a fee already retained cannot be paid or deducted on the remaining daily settlement", async () => {
  const d = await onlineDelivery();
  await recordStaffDeliveryConfirmation(
    {
      consignmentId: d.consignmentId,
      collectedAmount: "20000",
      evidence: "تأكيد العميل",
      clientRequestId: "proof-daily",
    },
    CASHIER,
  );
  await recordDeliveryRemittance(
    {
      partyId: 1,
      branchId: 1,
      countedCash: "500",
      lines: [{ consignmentId: d.consignmentId, collectedAmount: "2000" }],
      clientRequestId: "first-retain",
    },
    CASHIER,
  );
  const preview = await withTx((tx) =>
    previewDailySettlementTx(tx, { partyId: 1, branchId: 1 }, CASHIER),
  );
  expect(preview).toMatchObject({
    expectedCash: "18000.00",
    deductions: "0.00",
    net: "18000.00",
  });
  const input = {
    partyId: 1,
    branchId: 1,
    countedCash: "18000",
    clientRequestId: "rest-daily",
  };
  await withTx((tx) => settleDailyTx(tx, input, CASHIER));
  await withTx((tx) => settleDailyTx(tx, input, CASHIER));
  await assertClosed(d.invoiceId, "18500.00");
});

it("non-free delivery stays a direct customer-to-courier fee outside invoice COD", async () => {
  const d = await onlineDelivery(false);
  await recordCompanyStatement(
    {
      partyId: 1,
      branchId: 1,
      statementNumber: "NONFREE",
      countedCash: "20000",
      lines: [{ consignmentId: d.consignmentId, collectedAmount: "20000" }],
      clientRequestId: "nonfree",
    },
    CASHIER,
  );
  expect((await db().select().from(s.invoices))[0]).toMatchObject({
    total: "20000.00",
    paidAmount: "20000.00",
  });
  expect((await db().select().from(s.deliveryRemittances))[0]).toMatchObject({
    feesTotal: "0.00",
    netRemitted: "20000.00",
    receiptOutId: null,
  });
  expect(
    (await db().select().from(s.deliveryConsignments))[0].feeSettledAt,
  ).not.toBeNull();
  expect((await db().select().from(s.customers))[0].currentBalance).toBe(
    "0.00",
  );
});

it("retains the configured commission into treasury and clears the whole fee payable", async () => {
  const d = await onlineDelivery();
  await db()
    .update(s.deliveryParties)
    .set({ useCommissionForSettlement: true })
    .where(eq(s.deliveryParties.id, 1));
  await db().insert(s.courierCommissionRules).values({
    partyId: 1,
    ruleType: "FLAT_PER_DELIVERY",
    flatAmount: "1000",
    isActive: true,
  });
  expect((await listOpenConsignments(1, 1)).rows[0].feeWithholdingCash).toBe(
    "1000.00",
  );
  await recordCompanyStatement(
    {
      partyId: 1,
      branchId: 1,
      statementNumber: "COMMISSION-TREASURY",
      countedCash: "19000",
      lines: [{ consignmentId: d.consignmentId, collectedAmount: "20000" }],
      clientRequestId: "commission-treasury",
    },
    MANAGER,
  );
  expect(
    (await db().select().from(s.journalEntries))
      .filter((r) => r.status === "UNMAPPED")
      .map((r) => r.unmappedReason),
  ).toEqual([]);
  await assertClosed(d.invoiceId, "19000.00");
  expect(
    (await db().select().from(s.accountingEntries)).find((r) =>
      r.dedupeKey?.startsWith("DELIVERY_FEE_OFFSET:"),
    ),
  ).toMatchObject({ revenue: "500.00", profit: "500.00", cost: "0.00" });
  const rs = await db().select().from(s.receipts);
  expect(
    rs.every((r) => r.cashBucket === "TREASURY" && r.shiftId == null),
  ).toBe(true);
  const journal = await db().select().from(s.journalLines);
  expect(
    journal
      .filter((r) => r.role === "TREASURY_CASH")
      .reduce((v, r) => v.plus(money(r.debit)).minus(money(r.credit)), money(0))
      .toFixed(2),
  ).toBe("19000.00");
  expect(
    journal
      .filter((r) => r.role === "DELIVERY_REVENUE")
      .reduce((v, r) => v.plus(money(r.credit)).minus(money(r.debit)), money(0))
      .toFixed(2),
  ).toBe("500.00");
});

it("only the excess of a declared deduction is a new expense", async () => {
  const d = await onlineDelivery();
  await recordCompanyStatement(
    {
      partyId: 1,
      branchId: 1,
      statementNumber: "EXTRA-DEDUCTION",
      countedCash: "18000",
      deductionsTotal: "2000",
      lines: [{ consignmentId: d.consignmentId, collectedAmount: "20000" }],
      clientRequestId: "extra-deduction",
    },
    CASHIER,
  );
  expect((await db().select().from(s.deliveryRemittances))[0]).toMatchObject({
    feesTotal: "1500.00",
    deductionsTotal: "500.00",
    netRemitted: "18000.00",
  });
  expect(
    sum(
      (await db().select().from(s.accountingEntries)).filter((r) =>
        r.dedupeKey?.startsWith("DLV-STMT-DEDUCTION:"),
      ),
    ),
  ).toBe("500.00");
  expect(
    (await db().select().from(s.deliveryRemittanceLines))[0].cashReceived,
  ).toBe("18000.00");
  expect((await db().select().from(s.invoices))[0].paidAmount).toBe("20000.00");
});

it("retained fees and classified remittance shortfall remain different liabilities", async () => {
  const d = await onlineDelivery();
  await recordStaffDeliveryConfirmation(
    {
      consignmentId: d.consignmentId,
      collectedAmount: "20000",
      evidence: "تأكيد العميل",
      clientRequestId: "proof-short",
    },
    CASHIER,
  );
  await recordDeliveryRemittance(
    {
      partyId: 1,
      branchId: 1,
      countedCash: "17500",
      shortfall: { reason: "OTHER" },
      lines: [{ consignmentId: d.consignmentId, collectedAmount: "20000" }],
      clientRequestId: "short-net",
    },
    CASHIER,
  );
  expect((await db().select().from(s.invoices))[0].paidAmount).toBe("20000.00");
  expect((await db().select().from(s.customers))[0].currentBalance).toBe(
    "0.00",
  );
  expect((await db().select().from(s.deliveryParties))[0].currentBalance).toBe(
    "1000.00",
  );
  expect((await db().select().from(s.deliveryRemittances))[0]).toMatchObject({
    feesTotal: "1500.00",
    shortfallTotal: "1000.00",
    status: "SHORT",
  });
  expect(
    (await db().select().from(s.deliveryRemittanceLines))[0],
  ).toMatchObject({ cashReceived: "17500.00", feeOffset: "1500.00" });
});

it("daily confirmation accepts its net fee preview without inventing a shortfall", async () => {
  const d = await onlineDelivery();
  await recordStaffDeliveryConfirmation(
    {
      consignmentId: d.consignmentId,
      collectedAmount: "20000",
      evidence: "تأكيد العميل",
      clientRequestId: "proof-full-daily",
    },
    CASHIER,
  );
  const preview = await withTx((tx) =>
    previewDailySettlementTx(tx, { partyId: 1, branchId: 1 }, CASHIER),
  );
  const result = await withTx((tx) =>
    settleDailyTx(
      tx,
      {
        partyId: 1,
        branchId: 1,
        countedCash: preview.net,
        clientRequestId: "full-daily",
      },
      CASHIER,
    ),
  );
  expect(result).toMatchObject({
    feesTotal: "1500.00",
    shortfallTotal: "0.00",
    status: "BALANCED",
  });
  await assertClosed(d.invoiceId, "18500.00");
});

it("percentage-of-order commission uses the invoice value in preview and daily posting", async () => {
  const d = await onlineDelivery();
  await db()
    .update(s.deliveryParties)
    .set({ useCommissionForSettlement: true })
    .where(eq(s.deliveryParties.id, 1));
  await db().insert(s.courierCommissionRules).values({
    partyId: 1,
    ruleType: "PERCENT_OF_ORDER",
    percentValue: "5",
    isActive: true,
  });
  expect((await listOpenConsignments(1, 1)).rows[0].feeWithholdingCash).toBe(
    "1000.00",
  );
  await recordStaffDeliveryConfirmation(
    {
      consignmentId: d.consignmentId,
      collectedAmount: "20000",
      evidence: "تأكيد العميل",
      clientRequestId: "proof-percent",
    },
    CASHIER,
  );
  const preview = await withTx((tx) =>
    previewDailySettlementTx(tx, { partyId: 1, branchId: 1 }, CASHIER),
  );
  expect(preview.net).toBe("19000.00");
  await withTx((tx) =>
    settleDailyTx(
      tx,
      {
        partyId: 1,
        branchId: 1,
        countedCash: preview.net,
        clientRequestId: "percent-daily",
      },
      CASHIER,
    ),
  );
  await assertClosed(d.invoiceId, "19000.00");
});

it("an independent partial payout is deducted from the fee still eligible for withholding", async () => {
  const d = await onlineDelivery(true, "2000");
  await recordStaffDeliveryConfirmation(
    {
      consignmentId: d.consignmentId,
      collectedAmount: "20000",
      evidence: "تأكيد العميل",
      clientRequestId: "proof-paid",
    },
    CASHIER,
  );
  await payDeliveryFee(
    {
      consignmentId: d.consignmentId,
      shiftId: d.shiftId,
      amount: "500",
      clientRequestId: "fee-before-remit",
    },
    CASHIER,
  );
  expect((await listOpenConsignments(1, 1)).rows[0].feeWithholdingCash).toBe(
    "1000.00",
  );
  await recordDeliveryRemittance(
    {
      partyId: 1,
      branchId: 1,
      countedCash: "19000",
      lines: [{ consignmentId: d.consignmentId, collectedAmount: "20000" }],
      clientRequestId: "after-paid",
    },
    CASHIER,
  );
  await assertClosed(d.invoiceId, "18500.00");
});

it("concurrent independent payout and net remittance cannot settle the fee twice", async () => {
  const d = await onlineDelivery(true, "2000");
  await recordStaffDeliveryConfirmation(
    {
      consignmentId: d.consignmentId,
      collectedAmount: "20000",
      evidence: "تأكيد العميل",
      clientRequestId: "proof-race",
    },
    CASHIER,
  );
  const remit = {
    partyId: 1,
    branchId: 1,
    countedCash: "18500",
    lines: [{ consignmentId: d.consignmentId, collectedAmount: "20000" }],
    clientRequestId: "race-remit",
  };
  const results = await Promise.allSettled([
    recordDeliveryRemittance(remit, CASHIER),
    payDeliveryFee(
      {
        consignmentId: d.consignmentId,
        shiftId: d.shiftId,
        clientRequestId: "race-pay",
      },
      CASHIER,
    ),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  if (results[0].status === "rejected")
    await recordDeliveryRemittance(
      { ...remit, countedCash: "20000", clientRequestId: "race-remit-retry" },
      CASHIER,
    );
  await assertClosed(d.invoiceId, "18500.00");
  const fees = (await db().select().from(s.deliveryLedgerEntries)).filter((r) =>
    ["FEE_PAID", "FEE_OFFSET"].includes(r.entryType),
  );
  expect(sum(fees)).toBe("1500.00");
});

it("adopts an owner-confirmed historical fee, preserves closed drawers and replays without cash or AR duplication", async () => {
  const d = await onlineDelivery();
  // Reproduce the old implementation: the store fee accrued, but gross COD was recorded as cash.
  await db()
    .update(s.deliveryConsignments)
    .set({ sourceType: "INVOICE" })
    .where(eq(s.deliveryConsignments.id, d.consignmentId));
  await recordCompanyStatement(
    {
      partyId: 1,
      branchId: 1,
      statementNumber: "HISTORICAL-GROSS",
      countedCash: "20000",
      lines: [{ consignmentId: d.consignmentId, collectedAmount: "20000" }],
      clientRequestId: "historical-gross",
    },
    CASHIER,
  );
  await db()
    .update(s.deliveryConsignments)
    .set({ sourceType: "ONLINE_ORDER" })
    .where(eq(s.deliveryConsignments.id, d.consignmentId));
  const rm = (await db().select().from(s.deliveryRemittances))[0];
  await db()
    .insert(s.receipts)
    .values([
      {
        branchId: 1,
        shiftId: d.shiftId,
        direction: "OUT",
        amount: "20000",
        paymentMethod: "CASH",
        cashBucket: "DRAWER",
        status: "COMPLETED",
        referenceNumber: "HISTORICAL-HANDOVER",
        createdBy: 2,
      },
      {
        branchId: 1,
        shiftId: null,
        direction: "IN",
        amount: "20000",
        paymentMethod: "CASH",
        cashBucket: "TREASURY",
        status: "COMPLETED",
        referenceNumber: "HISTORICAL-HANDOVER",
        createdBy: 1,
      },
    ]);
  await db()
    .update(s.shifts)
    .set({ status: "CLOSED", closingBalance: "20000" })
    .where(eq(s.shifts.id, d.shiftId));
  const target = {
    consignmentId: d.consignmentId,
    remittanceId: Number(rm.id),
    receiptInId: Number(rm.receiptInId),
    shiftId: d.shiftId,
    fee: "1500",
    batchGross: "20000",
    actualBatchNet: "18500",
  };
  const actor = { userId: 1, role: "admin", branchId: 1 };
  const before = {
    receipts: await db().select().from(s.receipts),
    ledger: await db().select().from(s.deliveryLedgerEntries),
    entries: await db().select().from(s.accountingEntries),
    shift: await db().select().from(s.shifts),
  };
  expect(
    (
      await repairHistoricalFeeWithholding([target], actor, {
        evidence: "confirmed actual net",
      })
    )[0].status,
  ).toBe("PREVIEW");
  expect(await db().select().from(s.receipts)).toEqual(before.receipts);
  await expect(
    repairHistoricalFeeWithholding(
      [target, { ...target, remittanceId: 999999 }],
      actor,
      { apply: true, evidence: "confirmed actual net" },
    ),
  ).rejects.toThrow();
  expect(await db().select().from(s.receipts)).toEqual(before.receipts);
  expect(await db().select().from(s.deliveryLedgerEntries)).toEqual(
    before.ledger,
  );
  const applied = await repairHistoricalFeeWithholding([target], actor, {
    apply: true,
    evidence: "confirmed actual net",
  });
  expect(applied[0].status).toBe("APPLIED");
  await assertClosed(d.invoiceId, "18500.00");
  expect(await db().select().from(s.shifts)).toEqual(before.shift);
  const after = await db().select().from(s.receipts);
  expect(after.filter((r) => r.cashBucket === "DRAWER")).toEqual(
    before.receipts.filter((r) => r.cashBucket === "DRAWER"),
  );
  expect(
    after
      .filter((r) => r.cashBucket === "TREASURY")
      .reduce(
        (v, r) => v.plus(money(r.amount).mul(r.direction === "IN" ? 1 : -1)),
        money(0),
      )
      .toFixed(2),
  ).toBe("18500.00");
  expect(
    (
      await repairHistoricalFeeWithholding([target], actor, {
        apply: true,
        evidence: "confirmed actual net",
      })
    )[0].status,
  ).toBe("REPLAY_VERIFIED");
  expect(await db().select().from(s.receipts)).toEqual(after);
  await db()
    .update(s.receipts)
    .set({ status: "REVERSED" })
    .where(eq(s.receipts.id, applied[0].receiptOutId!));
  await expect(
    repairHistoricalFeeWithholding([target], actor, {
      apply: true,
      evidence: "confirmed actual net",
    }),
  ).rejects.toThrow(/غير متطابق/);

  expect(
    (await db().select().from(s.accountingEntries)).filter(
      (r) => r.entryType === "PAYMENT_IN",
    ),
  ).toEqual(before.entries.filter((r) => r.entryType === "PAYMENT_IN"));
});
