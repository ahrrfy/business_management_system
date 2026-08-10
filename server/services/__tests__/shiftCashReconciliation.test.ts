import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { getShiftReport } from "../shiftService";
import { money, toDbMoney } from "../money";

function db() {
  const connection = getDb();
  if (!connection) throw new Error("DATABASE_URL not set for tests");
  return connection;
}

const BRANCH_ID = 1;
const CASHIER_ID = 10;
const SHIFT_ID = 100;

beforeEach(async () => {
  await db().insert(s.branches).values({
    id: BRANCH_ID,
    name: "الفرع الرئيسي",
    code: "MAIN",
    type: "MAIN",
  });
  await db().insert(s.users).values({
    id: CASHIER_ID,
    openId: "shift-reconciliation-cashier",
    name: "مروة",
    role: "cashier",
    loginMethod: "local",
    branchId: BRANCH_ID,
  });
});

describe("getShiftReport cash reconciliation", () => {
  it("derives every equation term from detailed items and excludes paired CH without double-counting CD", async () => {
    const openedAt = new Date("2026-08-10T07:00:00.000Z");
    await db()
      .insert(s.shifts)
      .values({
        id: SHIFT_ID,
        branchId: BRANCH_ID,
        userId: CASHIER_ID,
        openingBalance: "1000.00",
        expectedCash: "1500.00",
        countedCash: "1500.00",
        variance: "0.00",
        status: "CLOSED",
        openedAt,
        closedAt: new Date("2026-08-10T15:00:00.000Z"),
        reconciliationStatus: "MATCHED",
      });
    await db()
      .insert(s.invoices)
      .values([
        {
          id: 201,
          invoiceNumber: "INV-CURRENT",
          sourceType: "POS",
          branchId: BRANCH_ID,
          shiftId: SHIFT_ID,
          subtotal: "900.00",
          total: "900.00",
          paidAmount: "900.00",
          status: "PAID",
        },
        {
          id: 202,
          invoiceNumber: "INV-PRIOR",
          sourceType: "POS",
          branchId: BRANCH_ID,
          shiftId: null,
          subtotal: "200.00",
          total: "200.00",
          paidAmount: "200.00",
          status: "PAID",
        },
      ]);

    const createdAt = new Date("2026-08-10T08:00:00.000Z");
    await db()
      .insert(s.receipts)
      .values([
        {
          id: 1101,
          invoiceId: 201,
          branchId: BRANCH_ID,
          shiftId: SHIFT_ID,
          direction: "IN",
          amount: "500.00",
          paymentMethod: "CASH",
          cashBucket: "DRAWER",
          description: "بيع نقدي جزئي",
          createdBy: CASHIER_ID,
          createdAt,
        },
        {
          id: 1102,
          invoiceId: 201,
          branchId: BRANCH_ID,
          shiftId: SHIFT_ID,
          direction: "IN",
          amount: "400.00",
          paymentMethod: "CARD",
          cashBucket: null,
          description: "جزء البطاقة",
          createdBy: CASHIER_ID,
          createdAt,
        },
        {
          id: 1103,
          invoiceId: 202,
          branchId: BRANCH_ID,
          shiftId: SHIFT_ID,
          direction: "IN",
          amount: "200.00",
          paymentMethod: "CASH",
          cashBucket: "DRAWER",
          referenceNumber: "COLL-202",
          description: "تحصيل فاتورة سابقة",
          createdBy: CASHIER_ID,
          createdAt,
        },
        {
          id: 1104,
          workOrderId: 701,
          branchId: BRANCH_ID,
          shiftId: SHIFT_ID,
          direction: "IN",
          amount: "30.00",
          paymentMethod: "CASH",
          cashBucket: "DRAWER",
          referenceNumber: "DEP-701",
          description: "عربون أمر شغل",
          createdBy: CASHIER_ID,
          createdAt,
        },
        {
          id: 1105,
          invoiceId: 201,
          branchId: BRANCH_ID,
          shiftId: SHIFT_ID,
          direction: "OUT",
          amount: "50.00",
          paymentMethod: "CASH",
          cashBucket: "DRAWER",
          referenceNumber: "RET-201",
          description: "مرتجع نقدي",
          createdBy: CASHIER_ID,
          createdAt,
        },
        {
          id: 1106,
          branchId: BRANCH_ID,
          shiftId: SHIFT_ID,
          direction: "OUT",
          amount: "70.00",
          paymentMethod: "CASH",
          cashBucket: "DRAWER",
          referenceNumber: "EXP-2001",
          description: "مستلزمات",
          createdBy: CASHIER_ID,
          createdAt,
        },
        {
          id: 1107,
          branchId: BRANCH_ID,
          shiftId: SHIFT_ID,
          direction: "OUT",
          amount: "100.00",
          paymentMethod: "CASH",
          cashBucket: "DRAWER",
          referenceNumber: "CD-1-100-00001",
          description: "سحب نقدي أثناء الوردية",
          createdBy: CASHIER_ID,
          createdAt,
        },
        {
          id: 1108,
          branchId: BRANCH_ID,
          shiftId: null,
          direction: "IN",
          amount: "100.00",
          paymentMethod: "CASH",
          cashBucket: "TREASURY",
          referenceNumber: "CD-1-100-00001",
          status: "PENDING",
          description: "استلام سحب نقدي",
          createdBy: CASHIER_ID,
          createdAt,
        },
        {
          id: 1109,
          branchId: BRANCH_ID,
          shiftId: SHIFT_ID,
          direction: "OUT",
          amount: "10.00",
          paymentMethod: "CASH",
          cashBucket: "DRAWER",
          referenceNumber: "MISC-1",
          description: "صرف آخر",
          createdBy: CASHIER_ID,
          createdAt,
        },
        {
          id: 1110,
          branchId: BRANCH_ID,
          shiftId: SHIFT_ID,
          direction: "OUT",
          amount: "1500.00",
          paymentMethod: "CASH",
          cashBucket: "DRAWER",
          referenceNumber: "CH-1-100-00001",
          description: "تسليم إغلاق الوردية",
          createdBy: CASHIER_ID,
          createdAt,
        },
        {
          id: 1111,
          branchId: BRANCH_ID,
          shiftId: null,
          direction: "IN",
          amount: "1500.00",
          paymentMethod: "CASH",
          cashBucket: "TREASURY",
          referenceNumber: "CH-1-100-00001",
          description: "استلام إغلاق الوردية",
          createdBy: CASHIER_ID,
          createdAt,
        },
      ]);
    await db().insert(s.expenses).values({
      id: 2001,
      branchId: BRANCH_ID,
      shiftId: SHIFT_ID,
      expenseDate: "2026-08-10",
      category: "SUPPLIES",
      amount: "70.00",
      paymentMethod: "CASH",
      cashBucket: "DRAWER",
      source: "CASH",
      description: "مستلزمات",
      referenceNumber: "EXP-2001",
      receiptId: 1106,
      status: "ACTIVE",
      createdBy: CASHIER_ID,
    });

    const report = await getShiftReport(SHIFT_ID);
    expect(report).not.toBeNull();
    const reconciliation = report!.cashReconciliation;

    expect(reconciliation).toMatchObject({
      opening: "1000.00",
      cashSales: "500.00",
      priorInvoiceCollections: "200.00",
      otherCashIn: "30.00",
      cashRefunds: "50.00",
      expenses: "70.00",
      cashDrops: "100.00",
      otherCashOut: "10.00",
      expectedCash: "1500.00",
      storedExpectedCash: "1500.00",
      matchesStoredExpectedCash: true,
    });

    for (const key of [
      "opening",
      "cashSales",
      "priorInvoiceCollections",
      "otherCashIn",
      "cashRefunds",
      "expenses",
      "cashDrops",
      "otherCashOut",
    ] as const) {
      const itemTotal = reconciliation.breakdown[key].reduce(
        (total, item) => total.plus(money(item.amount)),
        money("0"),
      );
      expect(
        toDbMoney(itemTotal),
        `${key} must equal the sum of its items`,
      ).toBe(reconciliation[key]);
    }
    const equationTotal = reconciliation.equation.reduce(
      (total, term) =>
        term.operation === "ADD"
          ? total.plus(money(term.amount))
          : total.minus(money(term.amount)),
      money("0"),
    );
    expect(toDbMoney(equationTotal)).toBe(reconciliation.expectedCash);
    expect(report!.expectedCash).toBe(reconciliation.expectedCash);

    expect(reconciliation.breakdown.cashSales[0]).toMatchObject({
      receiptId: 1101,
      documentType: "INVOICE",
      documentId: 201,
      invoiceNumber: "INV-CURRENT",
      createdBy: CASHIER_ID,
      createdByName: "مروة",
      cashBucket: "DRAWER",
      shiftId: SHIFT_ID,
    });
    expect(reconciliation.breakdown.expenses[0]).toMatchObject({
      receiptId: 1106,
      documentType: "EXPENSE",
      expenseId: 2001,
    });
    expect(reconciliation.breakdown.cashDrops[0]).toMatchObject({
      receiptId: 1107,
      pairedTreasuryReceiptId: 1108,
      pairedTreasuryReceiptStatus: "PENDING",
    });
    expect(reconciliation.excludedTreasuryHandovers).toHaveLength(1);
    expect(reconciliation.excludedTreasuryHandovers[0]).toMatchObject({
      receiptId: 1110,
      pairedTreasuryReceiptId: 1111,
      category: "treasuryHandover",
    });

    // إجمالي الفواتير الخام منفصل صراحةً عن النقد: الفاتورة 900 = 500 نقد + 400 بطاقة.
    expect(report!.salesTotal).toBe("900.00");
    expect(report!.invoiceSummary).toMatchObject({
      grossTotal: "900.00",
      usedInCashReconciliation: false,
    });
    expect(report!.salesTotal).not.toBe(reconciliation.cashSales);
  });

  it("does not hide legitimate CH/CD-looking references without a matching treasury pair", async () => {
    await db()
      .insert(s.shifts)
      .values({
        id: SHIFT_ID,
        branchId: BRANCH_ID,
        userId: CASHIER_ID,
        openingBalance: "0.00",
        status: "OPEN",
        openedAt: new Date("2026-08-10T07:00:00.000Z"),
        openGuard: `${CASHIER_ID}:${BRANCH_ID}:RETAIL`,
      });
    await db().insert(s.invoices).values({
      id: 301,
      invoiceNumber: "INV-REFERENCE",
      sourceType: "POS",
      branchId: BRANCH_ID,
      shiftId: SHIFT_ID,
      subtotal: "125.00",
      total: "125.00",
      paidAmount: "125.00",
      status: "PAID",
    });
    await db()
      .insert(s.receipts)
      .values([
        {
          id: 1201,
          invoiceId: 301,
          branchId: BRANCH_ID,
          shiftId: SHIFT_ID,
          direction: "IN",
          amount: "125.00",
          paymentMethod: "CASH",
          cashBucket: "DRAWER",
          referenceNumber: "CH-CUSTOMER-REFERENCE",
          createdBy: CASHIER_ID,
        },
        {
          id: 1202,
          branchId: BRANCH_ID,
          shiftId: SHIFT_ID,
          direction: "OUT",
          amount: "5.00",
          paymentMethod: "CASH",
          cashBucket: "DRAWER",
          referenceNumber: "CD-LEGITIMATE-REFERENCE",
          description: "مرجع مشابه بلا تحويل خزينة",
          createdBy: CASHIER_ID,
        },
      ]);

    const report = await getShiftReport(SHIFT_ID);
    expect(report!.cashReconciliation).toMatchObject({
      cashSales: "125.00",
      cashDrops: "0.00",
      otherCashOut: "5.00",
      expectedCash: "120.00",
    });
    expect(
      report!.cashReconciliation.breakdown.cashSales[0].referenceNumber,
    ).toBe("CH-CUSTOMER-REFERENCE");
    expect(
      report!.cashReconciliation.breakdown.otherCashOut[0].referenceNumber,
    ).toBe("CD-LEGITIMATE-REFERENCE");
    expect(report!.cashReconciliation.excludedTreasuryHandovers).toEqual([]);
  });
});
