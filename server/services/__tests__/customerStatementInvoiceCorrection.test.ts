import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { getARAging, getCustomerStatement } from "../reports/arAging";
import { money } from "../money";
import { getMonthlyClosePack } from "../reports/monthlyClosePack";
import { truncateTables } from "./__testUtils__";

beforeEach(async () => {
  await truncateTables(["receipts", "invoiceItems", "invoices", "accountingEntries", "customers", "branches", "users"]);
  const db = getDb()!;
  await db.insert(s.branches).values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await db.insert(s.users).values({ id: 1, openId: "statement-correction", name: "المدير", role: "admin", branchId: 1 });
  await db.insert(s.customers).values({ id: 1, name: "عميل التصحيح", currentBalance: "70.00" });
  await db.insert(s.accountingEntries).values([
    { entryType: "OPENING", branchId: 1, customerId: 1, amount: "100.00", entryDate: new Date("2020-01-01T12:00:00Z") },
    { entryType: "ADJUST", branchId: 1, customerId: 1, amount: "-40.00", entryDate: new Date("2020-01-02T12:00:00Z"), dedupeKey: "INVOICE_CORRECTION_CUSTOMER_RECLASS:1:2:NEW", createdBy: 1 },
    { entryType: "DELIVERY_REMIT", branchId: 1, customerId: 1, amount: "10.00", entryDate: new Date("2020-01-03T12:00:00Z"), dedupeKey: "INVOICE_AMEND_CUSTODY:1:correction", createdBy: 1 },
    { entryType: "ADJUST", branchId: 1, customerId: 1, amount: "9000.00", entryDate: new Date("2020-01-03T12:00:00Z"), dedupeKey: "UNRELATED_ADJUSTMENT" },
  ]);
});

describe("أثر تصحيح الفاتورة في كشف العميل", () => {
  it("يحفظ أصل الإلغاء وعكسه عبر الفترات ولا يصنع ائتمانًا وهميًا", async () => {
    const db = getDb()!;
    await db.delete(s.accountingEntries).where(eq(s.accountingEntries.customerId, 1));
    await db.update(s.customers).set({ currentBalance: "0.00" }).where(eq(s.customers.id, 1));
    await db.insert(s.invoices).values({ id: 50, invoiceNumber: "CANCEL-HISTORY", customerId: 1,
      branchId: 1, sourceType: "POS", status: "CANCELLED", subtotal: "100", total: "100",
      returnedTotal: "100", paidAmount: "0", invoiceDate: new Date("2020-02-01T12:00:00Z"), createdBy: 1 });
    await db.insert(s.accountingEntries).values([
      { entryType: "SALE", customerId: 1, invoiceId: 50, branchId: 1, amount: "100", revenue: "100", entryDate: new Date("2020-02-01T12:00:00Z") },
      { entryType: "RETURN", customerId: 1, invoiceId: 50, branchId: 1, amount: "-100", revenue: "-100", entryDate: new Date("2020-03-01T12:00:00Z") },
    ]);
    const later = (await getCustomerStatement(1, { from: "2021-01-01", branchId: 1 }))!;
    expect(later.summary.openingBalance).toBe("0.00");
    expect(later.payments).toHaveLength(0);
    const beforeCancellation = (await getCustomerStatement(1, { to: "2020-02-28", branchId: 1 }))!;
    expect(beforeCancellation.invoices[0].ledgerTotal).toBe("100.00");
    expect(beforeCancellation.payments).toHaveLength(0);
    const reversalPeriod = (await getCustomerStatement(1, { from: "2020-03-01", to: "2020-03-31", branchId: 1 }))!;
    expect(reversalPeriod.summary.openingBalance).toBe("100.00");
    expect(reversalPeriod.payments).toMatchObject([{ paymentMethod: "RETURN", amount: "100.00" }]);
    expect((await getMonthlyClosePack({ month: "2020-02", branchId: 1 })).sales).toMatchObject({ total: "100.00", returnedTotal: "0.00", netAfterReturns: "100.00" });
    expect((await getMonthlyClosePack({ month: "2020-03", branchId: 1 })).sales).toMatchObject({ total: "0.00", returnedTotal: "100.00", netAfterReturns: "-100.00" });
  });

  it("يعزل فواتير وحركات وافتتاح الفرع ويُفصح عن رصيد الشركة منفصلًا", async () => {
    const db = getDb()!;
    await db.delete(s.accountingEntries).where(eq(s.accountingEntries.customerId, 1));
    await db.insert(s.branches).values({ id: 2, name: "المبيعات", code: "SALES", type: "SALES" });
    await db.update(s.customers).set({ currentBalance: "0.00" }).where(eq(s.customers.id, 1));
    await db.insert(s.invoices).values({ id: 51, invoiceNumber: "BRANCH-CLAIM", customerId: 1, branchId: 1,
      sourceType: "POS", status: "PENDING", subtotal: "100", total: "100", invoiceDate: new Date("2020-01-01T12:00:00Z"), createdBy: 1 });
    await db.insert(s.receipts).values({ id: 51, direction: "IN", branchId: 2, partyType: "CUSTOMER", partyId: 1,
      amount: "100", paymentMethod: "CARD", approvalStatus: "APPROVED", status: "COMPLETED", createdBy: 1,
      createdAt: new Date("2020-01-02T12:00:00Z") });
    await db.insert(s.accountingEntries).values([
      { entryType: "SALE", customerId: 1, invoiceId: 51, branchId: 1, amount: "100", entryDate: new Date("2020-01-01T12:00:00Z") },
      { entryType: "PAYMENT_IN", customerId: 1, branchId: 2, receiptId: 51, amount: "100", entryDate: new Date("2020-01-02T12:00:00Z") },
    ]);
    const statement = (await getCustomerStatement(1, { branchId: 1, from: "2020-01-01" }))!;
    expect(statement.payments).toHaveLength(0);
    expect(statement.summary).toMatchObject({ currentBalance: "100.00", companyCurrentBalance: "0.00", scopedBranchId: 1 });
    const aging = await getARAging({ branchId: 1 });
    expect(aging).toMatchObject([{ customerId: 1, currentBalance: "100.00", unpaidTotal: "100.00" }]);
  });

  it("يعرض الصافي والمتبقي الحاليين دون احتساب الأصل المستبدل ويحفظ مستنداته التاريخية", async () => {
    const db = getDb()!;
    await db.insert(s.invoices).values([
      { id: 2, invoiceNumber: "CURRENT-31712", branchId: 1, customerId: 1, sourceType: "POS", status: "PARTIALLY_PAID", subtotal: "20000", total: "20000", paidAmount: "5000", returnedTotal: "4000", createdBy: 1 },
      { id: 1, invoiceNumber: "OLD-30525", branchId: 1, customerId: 1, sourceType: "POS", status: "SUPERSEDED", subtotal: "40000", total: "40000", paidAmount: "0", returnedTotal: "0", correctedByInvoiceId: 2, createdBy: 1 },
      { id: 3, invoiceNumber: "RETURNED", branchId: 1, customerId: 1, sourceType: "POS", status: "RETURNED", subtotal: "25000", total: "25000", paidAmount: "0", returnedTotal: "25000", createdBy: 1 },
      { id: 4, invoiceNumber: "CANCELLED", branchId: 1, customerId: 1, sourceType: "POS", status: "CANCELLED", subtotal: "9000", total: "9000", paidAmount: "0", returnedTotal: "9000", createdBy: 1 },
    ]);
    const statement = (await getCustomerStatement(1))!;
    expect(statement.summary.totalSales).toBe("16000.00");
    expect(statement.summary.totalPaid).toBe("5000.00");
    expect(statement.summary.unpaid).toBe("11000.00");
    expect(statement.invoices.find(row => row.id === 1)).toMatchObject({ total: "40000.00", currentTotal: "0.00", remainingAmount: "0.00", status: "SUPERSEDED" });
    expect(statement.invoices.find(row => row.id === 2)).toMatchObject({ total: "20000.00", currentTotal: "16000.00", remainingAmount: "11000.00" });
    for (const id of [3, 4]) expect(statement.invoices.find(row => row.id === id)).toMatchObject({ currentTotal: "0.00", remainingAmount: "0.00" });
  });

  it("يعرض تسوية الذمة وتحرير عهدة التصحيح كمستندات غير نقدية ويتزن مع الرصيد", async () => {
    const statement = (await getCustomerStatement(1))!;
    expect(statement.payments).toHaveLength(2);
    const net = statement.payments.reduce((sum, entry) => sum.plus(money(entry.amount).times(entry.direction === "OUT" ? 1 : -1)), money(0));
    expect(money(statement.summary.openingBalance).plus(net).toFixed(2)).toBe("70.00");
    expect(statement.payments.every(entry => entry.createdBy === 1)).toBe(true);
    expect(statement.payments.every(entry => entry.paymentMethod === "INVOICE_ADJUSTMENT")).toBe(true);
    expect(statement.payments.every(entry => entry.provenance?.docRefs?.every(ref => ref.docType !== "receipt"))).toBe(true);
  });

  it("يرحّل الحركات السابقة للفترة ويعرضها مرة واحدة فقط داخل حدود الفترة", async () => {
    const later = (await getCustomerStatement(1, { from: "2021-01-01" }))!;
    expect(later.summary.openingBalance).toBe("70.00");
    expect(later.payments).toHaveLength(0);
    const during = (await getCustomerStatement(1, { from: "2020-01-02", to: "2020-01-03" }))!;
    expect(during.summary.openingBalance).toBe("100.00");
    expect(during.payments).toHaveLength(2);
  });

  it("يستخدم التعديلات المحددة المصدر وحدها في رصيد تقادم الفرع", async () => {
    expect(await getARAging({ branchId: 1 })).toMatchObject([{ customerId: 1, currentBalance: "70.00", unbucketed: "70.00" }]);
  });
});
