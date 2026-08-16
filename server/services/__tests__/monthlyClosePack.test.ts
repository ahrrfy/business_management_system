// بند 11 (٧/٧): اختبارات حزمة الإقفال الشهري — كل قسم يُتحقَّق رقمياً بدقة decimal على
// بيانات شهر معلومة، مع فلترة الشهر (حركة خارج الشهر لا تدخل) وعزل الفرع.
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { money, toDbMoney } from "../money";
import { getMonthlyClosePack } from "../reports/monthlyClosePack";

const TABLES = [
  "journalLines",
  "journalEntries",
  "doubleEntrySettings",
  "payrollAccountingEvents",
  "payrollObligationAllocations",
  "payrollObligations",
  "payrollRemittanceRequests",
  "payrollItems",
  "payrollRuns",
  "accountingEntries",
  "receipts",
  "expenses",
  "invoiceItems",
  "invoices",
  "purchaseOrders",
  "workOrders",
  "productVariants",
  "products",
  "suppliers",
  "customers",
  "branches",
  "users",
];

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of TABLES) await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

// شهر ثابت معلوم (لا اعتماد على «اليوم») — تموز/يوليو 2026.
const MONTH = "2026-07";
const IN_MONTH = "2026-07-10 12:00:00";
const OUT_MONTH = "2026-06-25 12:00:00";

async function seedBase() {
  const d = db();
  await d.insert(s.branches).values([
    { id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "فرع المبيعات", code: "SALES", type: "SALES" },
  ]);
  await d.insert(s.users).values({ id: 1, openId: "t", name: "admin", role: "admin", loginMethod: "local" });
  await d.insert(s.customers).values({ id: 10, name: "عميل أ", currentBalance: "7500" });
  await d.insert(s.suppliers).values({ id: 20, name: "مورّد أ", currentBalance: "3000" });
  await d.insert(s.products).values({ id: 1, name: "قلم" });
  await d.insert(s.productVariants).values({ id: 1, productId: 1, sku: "P-1", costPrice: "100" });
}

async function seedInvoice(opts: { id: number; branchId?: number; date: string; total: string; cost: string; returned?: string; tax?: string }) {
  const d = db();
  await d.insert(s.invoices).values({
    id: opts.id,
    invoiceNumber: `INV-${opts.id}`,
    sourceType: "POS",
    sourceId: `t-${opts.id}`,
    branchId: opts.branchId ?? 1,
    customerId: 10,
    priceTier: "RETAIL",
    subtotal: opts.total,
    taxAmount: opts.tax ?? "0",
    total: opts.total,
    returnedTotal: opts.returned ?? "0",
    costTotal: opts.cost,
    paidAmount: opts.total,
    status: "PAID",
    invoiceDate: new Date(opts.date),
  });
  await d.insert(s.invoiceItems).values({
    invoiceId: opts.id,
    variantId: 1,
    quantity: "1",
    baseQuantity: 1,
    unitPrice: opts.total,
    unitCost: opts.cost,
    total: opts.total,
  });
  await d.insert(s.accountingEntries).values({
    entryType: "SALE",
    invoiceId: opts.id,
    branchId: opts.branchId ?? 1,
    customerId: 10,
    revenue: opts.total,
    cost: opts.cost,
    profit: toDbMoney(money(opts.total).sub(opts.cost)),
    amount: opts.total,
    entryDate: new Date(opts.date),
  });
}

beforeEach(async () => {
  await reset();
  await seedBase();
});

describe("monthlyClosePack", () => {
  it("أقسام المبيعات والربح والمصاريف والخزينة تُحسب لشهرٍ معلوم بدقة", async () => {
    const d = db();
    await seedInvoice({ id: 200, date: IN_MONTH, total: "10000.00", cost: "4000.00", returned: "1000.00" });
    await seedInvoice({ id: 201, date: IN_MONTH, total: "5000.00", cost: "2000.00" });
    // خارج الشهر — يجب ألا تدخل بأي قسم.
    await seedInvoice({ id: 202, date: OUT_MONTH, total: "99999.00", cost: "9999.00" });

    await d.insert(s.expenses).values([
      { branchId: 1, expenseDate: "2026-07-05", category: "RENT", amount: "300000.00", paymentMethod: "CASH", description: "إيجار", payee: "المالك" },
      { branchId: 1, expenseDate: "2026-06-05", category: "RENT", amount: "77777.00", paymentMethod: "CASH", description: "خارج الشهر", payee: "المالك" },
    ]);
    // ⚠️ عمود تاريخ الخزينة هو createdAt: getTreasurySummary يفلتر على `DATE(r.createdAt)`.
    // كان هنا `receiptDate` — **حقل لا وجود له في مخطّط receipts** (الموجود voucherDate) فكان drizzle
    // يُسقطه صامتاً ويأخذ createdAt = الآن ⇒ الاختبار «الثابت على شهرٍ معلوم» كان يعتمد سرّاً على
    // اليوم، فيمرّ داخل تموز ٢٠٢٦ فقط وينهار على حدّ الشهر (أحمرَ CI في ١/٨).
    await d.insert(s.receipts).values([
      { branchId: 1, direction: "IN", amount: "8000.00", paymentMethod: "CASH", cashBucket: "TREASURY", status: "COMPLETED", partyType: "OTHER", description: "قبض", referenceNumber: "R-1", createdBy: 1, createdAt: new Date(IN_MONTH) },
      { branchId: 1, direction: "OUT", amount: "3000.00", paymentMethod: "CASH", cashBucket: "TREASURY", status: "COMPLETED", partyType: "OTHER", description: "صرف", referenceNumber: "R-2", createdBy: 1, createdAt: new Date(IN_MONTH) },
    ]);
    // مرتجع بيع مُقيَّد بتاريخ الإرجاع (entryDate) — تدقيق ١٧/٧: المرتجعات تُنسب لشهر الإرجاع لا الفاتورة.
    await d.insert(s.accountingEntries).values({
      entryType: "RETURN", branchId: 1, customerId: 10, supplierId: null,
      revenue: "-1000.00", cost: "-400.00", profit: "-600.00", amount: "-1000.00", entryDate: new Date(IN_MONTH),
    });

    const pack = await getMonthlyClosePack({ month: MONTH });

    expect(pack.sales.invoiceCount).toBe(2);
    expect(pack.sales.total).toBe("15000.00");
    expect(pack.sales.returnedTotal).toBe("1000.00");
    expect(pack.sales.netAfterReturns).toBe("14000.00");

    expect(pack.profit.revenue).toBe("14000.00");
    expect(pack.profit.cost).toBe("5600.00");
    expect(pack.profit.profit).toBe("8400.00");

    expect(pack.expenses.total).toBe("300000.00");
    expect(pack.treasury.totalIn).toBe("8000.00");
    expect(pack.treasury.totalOut).toBe("3000.00");
    expect(pack.treasury.net).toBe("5000.00");

    expect(pack.receivablesSnapshot.arTotal).toBe("7500.00");
    expect(pack.receivablesSnapshot.apTotal).toBe("3000.00");
  });

  it("عزل الفرع: فرع 1 لا يرى مبيعات فرع 2", async () => {
    await seedInvoice({ id: 210, branchId: 1, date: IN_MONTH, total: "1000.00", cost: "400.00" });
    await seedInvoice({ id: 211, branchId: 2, date: IN_MONTH, total: "9000.00", cost: "3600.00" });

    const b1 = await getMonthlyClosePack({ month: MONTH, branchId: 1 });
    expect(b1.sales.total).toBe("1000.00");
    expect(b1.profit.profit).toBe("600.00");

    const all = await getMonthlyClosePack({ month: MONTH });
    expect(all.sales.total).toBe("10000.00");
  });

  it("المرتجعات تُنسب لشهر الإرجاع (entryDate) لا شهر الفاتورة، وتستبعد مرتجع الشراء (تدقيق ١٧/٧)", async () => {
    const d = db();
    // فاتورة من شهرٍ سابق — لا تدخل مبيعات هذا الشهر.
    await seedInvoice({ id: 220, date: OUT_MONTH, total: "8000.00", cost: "3000.00" });
    await d.insert(s.accountingEntries).values([
      // إرجاع بيع داخل الشهر ⇒ يُحسَب (٥٠٠) رغم أن الفاتورة الأصل خارجه.
      { entryType: "RETURN", branchId: 1, customerId: 10, supplierId: null, revenue: "-500.00", cost: "-200.00", profit: "-300.00", amount: "-500.00", entryDate: new Date(IN_MONTH) },
      // إرجاع بيع خارج الشهر ⇒ لا يُحسَب.
      { entryType: "RETURN", branchId: 1, customerId: 10, supplierId: null, revenue: "-700.00", cost: "-300.00", profit: "-400.00", amount: "-700.00", entryDate: new Date(OUT_MONTH) },
      // مرتجع شراء (supplierId مضبوط) داخل الشهر ⇒ يُستبعَد من مرتجعات المبيعات.
      { entryType: "RETURN", branchId: 1, supplierId: 20, revenue: "0.00", cost: "-900.00", profit: "900.00", amount: "-900.00", entryDate: new Date(IN_MONTH) },
    ]);

    const pack = await getMonthlyClosePack({ month: MONTH });
    expect(pack.sales.returnedTotal).toBe("500.00"); // فقط إرجاع البيع داخل الشهر
    expect(pack.sales.invoiceCount).toBe(0); // لا فواتير مؤرَّخة في الشهر
  });

  it("مرتجع شهرٍ لاحق لا يعيد كتابة ربح الشهر السابق المقفَل ويظهر في شهر entryDate", async () => {
    const d = db();
    await seedInvoice({ id: 230, date: OUT_MONTH, total: "8000.00", cost: "3000.00" });
    await d.insert(s.accountingEntries).values({
      entryType: "RETURN",
      branchId: 1,
      invoiceId: 230,
      customerId: 10,
      supplierId: null,
      revenue: "-1000.00",
      cost: "-400.00",
      profit: "-600.00",
      amount: "-1000.00",
      entryDate: new Date(IN_MONTH),
    });

    const june = await getMonthlyClosePack({ month: "2026-06" });
    const july = await getMonthlyClosePack({ month: MONTH });

    expect(june.profit).toMatchObject({ revenue: "8000.00", cost: "3000.00", profit: "5000.00" });
    expect(june.sales.returnedTotal).toBe("0.00");
    expect(july.profit).toMatchObject({ revenue: "-1000.00", cost: "-400.00", profit: "-600.00" });
    expect(july.sales.returnedTotal).toBe("1000.00");
  });

  it("شهر فارغ ⇒ أصفار سليمة بلا أخطاء", async () => {
    const pack = await getMonthlyClosePack({ month: "2025-01" });
    expect(pack.sales.invoiceCount).toBe(0);
    expect(pack.sales.netAfterReturns).toBe("0.00");
    expect(pack.profit.profit).toBe("0.00");
    expect(pack.treasury.net).toBe("0.00");
  });

  it("يأخذ تكلفة الرواتب من استحقاق الشهر لا من دفع الصافي", async () => {
    const d = db();
    await d.insert(s.accountingEntries).values([
      {
        id: 940,
        entryType: "ADJUST",
        branchId: 1,
        amount: "1250.00",
        entryDate: new Date("2026-07-31"),
        dedupeKey: "PAYROLL:ACCRUAL:94:0:1",
      },
      {
        id: 941,
        entryType: "PAYMENT_OUT",
        branchId: 1,
        amount: "1000.00",
        entryDate: new Date("2026-07-31"),
        dedupeKey: "PAYROLL:94:1",
      },
    ]);
    await d.insert(s.payrollAccountingEvents).values([
      {
        id: 940,
        branchIdSnapshot: 1,
        revisionNo: 0,
        eventKind: "ACCRUAL",
        accountingEntryId: 940,
        sourceKey: "PAYROLL:ACCRUAL:94:0:1",
        sourceHash: "d".repeat(64),
        occurredAt: new Date("2026-07-31T12:00:00Z"),
        createdBy: 1,
      },
      {
        id: 941,
        branchIdSnapshot: 1,
        revisionNo: 0,
        eventKind: "SALARY_PAYMENT",
        accountingEntryId: 941,
        sourceKey: "PAYROLL:94:1",
        sourceHash: "e".repeat(64),
        occurredAt: new Date("2026-07-31T13:00:00Z"),
        createdBy: 1,
      },
    ]);

    const pack = await getMonthlyClosePack({ month: MONTH, branchId: 1 });
    expect(pack.profit.revenue).toBe("0.00");
    expect(pack.profit.cost).toBe("0.00");
    expect(pack.profit.profit).toBe("0.00");
    expect(pack.profit.totalExpenses).toBe("1250.00");
    expect(pack.profit.netProfit).toBe("-1250.00");
    expect(pack.expenses.total).toBe("1250.00");
    expect(pack.accountingBasis).toBe("LEGACY_DERIVED");
  });

  it("في ACTIVE يأخذ قائمة الدخل من أدوار اليومية بإشارتها ويستبعد تسوية الخصوم النقدية", async () => {
    const d = db();
    const cycleId = "active-payroll-cycle";
    await d.insert(s.doubleEntrySettings).values({ id: 1, mode: "ACTIVE", shadowCycleId: cycleId });
    await d.insert(s.accountingEntries).values([
      { id: 980, entryType: "ADJUST", branchId: 1, amount: "1250.00", entryDate: new Date("2026-07-31") },
      { id: 981, entryType: "ADJUST", branchId: 1, amount: "-250.00", entryDate: new Date("2026-07-31") },
      { id: 982, entryType: "PAYMENT_OUT", branchId: 1, amount: "800.00", entryDate: new Date("2026-07-31") },
    ]);
    await d.insert(s.journalEntries).values([
      { id: 980, entryId: 980, cycleId, entryDate: "2026-07-31", branchId: 1, status: "POSTED" },
      { id: 981, entryId: 981, cycleId, entryDate: "2026-07-31", branchId: 1, status: "POSTED" },
      { id: 982, entryId: 982, cycleId, entryDate: "2026-07-31", branchId: 1, status: "POSTED" },
    ]);
    await d.insert(s.journalLines).values([
      // E + حصة رب العمل في الضمان + مخصص نهاية الخدمة = 1250.
      { journalId: 980, role: "SALARIES", debit: "1000.00", credit: "0.00" },
      { journalId: 980, role: "SOCIAL_SECURITY_EXPENSE", debit: "150.00", credit: "0.00" },
      { journalId: 980, role: "EOS_EXPENSE", debit: "100.00", credit: "0.00" },
      { journalId: 980, role: "ACCRUED_SALARY", debit: "0.00", credit: "1250.00" },
      // عكس جزءٍ من الاستحقاق يخفض مصروف الشهر 250.
      { journalId: 981, role: "SALARIES", debit: "0.00", credit: "250.00" },
      { journalId: 981, role: "ACCRUED_SALARY", debit: "250.00", credit: "0.00" },
      // دفع الصافي تسوية خصم/نقد فقط؛ يجب ألا يدخل قائمة الدخل.
      { journalId: 982, role: "ACCRUED_SALARY", debit: "800.00", credit: "0.00" },
      { journalId: 982, role: "CASH_MAIN", debit: "0.00", credit: "800.00" },
    ]);

    const pack = await getMonthlyClosePack({ month: MONTH, branchId: 1 });
    expect(pack.accountingBasis).toBe("DOUBLE_ENTRY_ACTIVE");
    expect(pack.profit.grossProfit).toBe("0.00");
    expect(pack.profit.totalExpenses).toBe("1000.00");
    expect(pack.profit.netProfit).toBe("-1000.00");
    expect(pack.expenses.total).toBe("1000.00");
  });
});
