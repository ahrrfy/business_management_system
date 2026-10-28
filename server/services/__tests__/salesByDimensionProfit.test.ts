// بند 9 (٧/٧): اختبارات ربحية تقرير «حسب البُعد» — بُعد «الصنف» الجديد + أعمدة الربح،
// مع تحقق تقاطعي: ربح بُعد الصنف (صيغة السطر) = ربح سجلّ المبيعات على نفس البيانات.
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { getSalesByDimension, getSalesRegister } from "../reportsSalesService";
import { getTopProducts, getProfitByCategory, getSlowMovers } from "../reports/salesAnalytics";
import { getAbcAnalysis } from "../reportsInventoryAnalyticsService";
import { money } from "../money";

const TABLES = [
  "accountingEntries",
  "receipts",
  "invoiceItems",
  "invoices",
  "branchStock",
  "productPrices",
  "productUnits",
  "productVariants",
  "products",
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

const TODAY = new Date().toISOString().slice(0, 10);

async function seedBase() {
  const d = db();
  await d.insert(s.branches).values([
    { id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "فرع المبيعات", code: "SALES", type: "SALES" },
  ]);
  await d.insert(s.users).values({ id: 1, openId: "t", name: "admin", role: "admin", loginMethod: "local" });
  await d.insert(s.customers).values([
    { id: 10, name: "عميل أ" },
    { id: 11, name: "عميل ب" },
  ]);
  await d.insert(s.products).values([
    { id: 1, name: "قلم أزرق", categoryId: null },
    { id: 2, name: "دفتر كبير", categoryId: null },
  ]);
  await d.insert(s.productVariants).values([
    { id: 1, productId: 1, sku: "PEN-1", costPrice: "100" },
    { id: 2, productId: 2, sku: "NB-1", costPrice: "400" },
  ]);
}

/** فاتورة ببنود معلومة: القيم مقصودة يدوياً لتُحسب الأرباح على الورق. */
async function seedInvoice(opts: {
  id: number;
  customerId: number;
  branchId?: number;
  items: Array<{ variantId: number; qty: number; unitPrice: string; unitCost: string; restockedReturn?: number }>;
}) {
  const d = db();
  const total = opts.items
    .reduce((acc, it) => acc + it.qty * Number(it.unitPrice), 0)
    .toFixed(2);
  await d.insert(s.invoices).values({
    id: opts.id,
    invoiceNumber: `INV-${opts.id}`,
    sourceType: "POS",
    sourceId: `t-${opts.id}`,
    branchId: opts.branchId ?? 1,
    customerId: opts.customerId,
    priceTier: "RETAIL",
    subtotal: total,
    total,
    // costTotal على مستوى الفاتورة (مصدر ربح أبعاد الفواتير) = Σ(qty×unitCost) بلا تحييد مرتجع —
    // نبقيه متطابقاً مع مجموع البنود غير المرتجعة في هذه البيانات كي يصح التحقق التقاطعي.
    costTotal: opts.items
      .reduce((acc, it) => acc + (it.qty - (it.restockedReturn ?? 0)) * Number(it.unitCost), 0)
      .toFixed(2),
    paidAmount: total,
    status: "PAID",
    invoiceDate: new Date(),
  });
  for (const it of opts.items) {
    await d.insert(s.invoiceItems).values({
      invoiceId: opts.id,
      variantId: it.variantId,
      quantity: String(it.qty),
      baseQuantity: it.qty,
      returnedRestockedBaseQuantity: it.restockedReturn ?? 0,
      unitPrice: it.unitPrice,
      unitCost: it.unitCost,
      lineCost: (it.qty * Number(it.unitCost)).toFixed(2),
      total: (it.qty * Number(it.unitPrice)).toFixed(2),
    });
  }
}

beforeEach(async () => {
  await reset();
  await seedBase();
});

describe("salesByDimension — بُعد الصنف والربحية", () => {
  it.each([
    { price: "1100.00", total: "1000.00", rounding: "-100.00" },
    { price: "900.00", total: "1000.00", rounding: "100.00" },
  ])("تقريب النقد $rounding لا يصبح خصماً أو ربحاً للصنف", async ({ price, total, rounding }) => {
    await seedInvoice({ id: 120, customerId: 10, items: [{ variantId: 1, qty: 1, unitPrice: price, unitCost: "400.00" }] });
    await db().update(s.invoices).set({ total, paidAmount: total, cashRoundingAdjustment: rounding }).where(sql`${s.invoices.id} = 120`);
    for (const dimension of ["product", "customer", "branch", "cashier", "paymentMethod"] as const) {
      const result = await getSalesByDimension({ from: TODAY, to: TODAY, dimension });
      expect(result.totals).toMatchObject({ grossSales: price, revenue: price, netSales: price, discounts: "0.00", returns: "0.00", deliveryRevenue: "0.00" });
    }
    await db().update(s.invoices).set({ status: "RETURNED", returnedTotal: total, paidAmount: "0.00" }).where(sql`${s.invoices.id} = 120`);
    await db().update(s.invoiceItems).set({ returnedBaseQuantity: 1 }).where(sql`${s.invoiceItems.invoiceId} = 120`);
    for (const dimension of ["product", "customer", "branch", "cashier", "paymentMethod"] as const) {
      expect((await getSalesByDimension({ from: TODAY, to: TODAY, dimension })).totals).toMatchObject({ grossSales: price, revenue: "0.00", netSales: "0.00", discounts: "0.00", returns: price, deliveryRevenue: "0.00" });
    }
  });
  it("بُعد الصنف: تجميع منتج عبر فاتورتين + ربح بصيغة السطر", async () => {
    // قلم: 10 قطع ×250 (تكلفة 100) في فاتورة أ + 5 قطع ×250 في فاتورة ب ⇒ إيراد 3750، تكلفة 1500، ربح 2250.
    await seedInvoice({ id: 100, customerId: 10, items: [{ variantId: 1, qty: 10, unitPrice: "250", unitCost: "100" }] });
    await seedInvoice({ id: 101, customerId: 11, items: [
      { variantId: 1, qty: 5, unitPrice: "250", unitCost: "100" },
      { variantId: 2, qty: 2, unitPrice: "1000", unitCost: "400" },
    ] });

    const res = await getSalesByDimension({ from: TODAY, to: TODAY, dimension: "product" });
    expect(res.rows).toHaveLength(2);
    const pen = res.rows.find((r) => r.label === "قلم أزرق")!;
    expect(pen.invoices).toBe(2);
    expect(pen.revenue).toBe("3750.00");
    expect(pen.cost).toBe("1500.00");
    expect(pen.profit).toBe("2250.00");
    expect(pen.marginPct).toBe("60");
    // paid/unpaid بلا معنى للصنف ⇒ صفران.
    expect(pen.paid).toBe("0.00");
    expect(pen.unpaid).toBe("0.00");
  });

  it("المرتجع المُعاد للرف يحيَّد من تكلفة الصنف (التالف يبقى خسارة)", async () => {
    // 10 قطع بيعت، 4 أعيدت للرف ⇒ التكلفة المحسوبة = (10−4)×100 = 600 (الإيراد يبقى إجمالي البند).
    await seedInvoice({ id: 102, customerId: 10, items: [
      { variantId: 1, qty: 10, unitPrice: "250", unitCost: "100", restockedReturn: 4 },
    ] });
    const res = await getSalesByDimension({ from: TODAY, to: TODAY, dimension: "product" });
    expect(res.rows[0].cost).toBe("600.00");
  });

  it("تحقق تقاطعي: إجماليات بُعد الصنف = إجماليات سجلّ المبيعات على نفس البيانات", async () => {
    await seedInvoice({ id: 103, customerId: 10, items: [
      { variantId: 1, qty: 3, unitPrice: "300", unitCost: "100" },
      { variantId: 2, qty: 1, unitPrice: "1500", unitCost: "400", restockedReturn: 1 },
    ] });
    await seedInvoice({ id: 104, customerId: 11, items: [{ variantId: 2, qty: 4, unitPrice: "900", unitCost: "400" }] });

    const byProduct = await getSalesByDimension({ from: TODAY, to: TODAY, dimension: "product" });
    const register = await getSalesRegister({ from: TODAY, to: TODAY });
    expect(byProduct.totals.revenue).toBe(register.totals.revenue);
    expect(byProduct.totals.cost).toBe(register.totals.cost);
    expect(byProduct.totals.profit).toBe(register.totals.profit);
  });

  it("بُعد العميل يحمل الربح من costTotal الفاتورة ويطابق بُعد الصنف على بيانات بلا مرتجعات", async () => {
    await seedInvoice({ id: 105, customerId: 10, items: [{ variantId: 1, qty: 2, unitPrice: "500", unitCost: "100" }] });
    await seedInvoice({ id: 106, customerId: 11, items: [{ variantId: 2, qty: 1, unitPrice: "2000", unitCost: "400" }] });

    const byCustomer = await getSalesByDimension({ from: TODAY, to: TODAY, dimension: "customer" });
    const a = byCustomer.rows.find((r) => r.label === "عميل أ")!;
    expect(a.revenue).toBe("1000.00");
    expect(a.cost).toBe("200.00");
    expect(a.profit).toBe("800.00");
    expect(a.marginPct).toBe("80");

    const byProduct = await getSalesByDimension({ from: TODAY, to: TODAY, dimension: "product" });
    expect(byProduct.totals.profit).toBe(byCustomer.totals.profit);
  });

  it("بُعد الكاشير يفصل الإجمالي والخصومات والمرتجعات وصافي المبيعات", async () => {
    await seedInvoice({ id: 109, customerId: 10, items: [{ variantId: 1, qty: 2, unitPrice: "500", unitCost: "100" }] });
    await db().update(s.invoices).set({
      createdBy: 1,
      salespersonNameSnapshot: "موظف المبيعات",
      // الإجمالي 1000 بعد خصم 100، والمرتجع 250 ⇒ الصافي 750.
      discountAmount: "100.00",
      returnedTotal: "250.00",
    }).where(sql`${s.invoices.id} = 109`);

    const res = await getSalesByDimension({ from: TODAY, to: TODAY, dimension: "cashier" });
    expect(res.rows[0]).toMatchObject({
      label: "موظف المبيعات",
      invoices: 1,
      grossSales: "1100.00",
      discounts: "100.00",
      returns: "250.00",
      netSales: "750.00",
      revenue: "750.00",
    });
  });

  it("تكلفة الأشغال من قيد المواد المثبت لا من صفر السطر أو أجور الرأس التحليلية", async () => {
    await seedInvoice({ id: 115, customerId: 10, items: [{ variantId: 1, qty: 1, unitPrice: "2000", unitCost: "1700" }] });
    await db().update(s.invoices).set({ sourceType: "WORKORDER" }).where(sql`${s.invoices.id}=115`);
    await db().update(s.invoiceItems).set({ lineCost: "0.00" }).where(sql`${s.invoiceItems.invoiceId}=115`);
    await db().insert(s.accountingEntries).values({ entryType: "SALE", branchId: 1, invoiceId: 115, revenue: "2000.00", cost: "1000.00", amount: "2000.00", entryDate: new Date(TODAY) });
    for (const dimension of ["product", "customer", "branch", "cashier", "paymentMethod"] as const) {
      expect((await getSalesByDimension({ from: TODAY, to: TODAY, dimension })).totals).toMatchObject({ cost: "1000.00", profit: "1000.00" });
    }
    expect((await getSalesRegister({ from: TODAY, to: TODAY })).totals.cost).toBe("1000.00");
    expect((await getTopProducts({ from: TODAY, to: TODAY }))[0].cost).toBe("1000.00");
    expect((await getProfitByCategory({ from: TODAY, to: TODAY }))[0].cost).toBe("1000.00");
    await db().update(s.accountingEntries).set({ cost: "0.00" }).where(sql`${s.accountingEntries.invoiceId}=115`);
    expect((await getSalesByDimension({ from: TODAY, to: TODAY, dimension: "product" })).totals.cost).toBe("0.00");
    await db().update(s.accountingEntries).set({ cost: "1000.00" }).where(sql`${s.accountingEntries.invoiceId}=115`);
    await db().insert(s.accountingEntries).values({ entryType: "RETURN", branchId: 1, invoiceId: 115, cost: "-1000.00", revenue: "-2000.00", amount: "-2000.00", entryDate: new Date(TODAY) });
    await db().update(s.invoices).set({ status: "RETURNED", returnedTotal: "2000.00" }).where(sql`${s.invoices.id}=115`);
    for (const dimension of ["product", "customer", "branch", "cashier", "paymentMethod"] as const)
      expect((await getSalesByDimension({ from: TODAY, to: TODAY, dimension })).totals).toMatchObject({ cost: "0.00", profit: "0.00" });
  });

  it("عزل الفرع في بُعد الصنف", async () => {
    await seedInvoice({ id: 107, customerId: 10, branchId: 1, items: [{ variantId: 1, qty: 1, unitPrice: "250", unitCost: "100" }] });
    await seedInvoice({ id: 108, customerId: 10, branchId: 2, items: [{ variantId: 1, qty: 9, unitPrice: "250", unitCost: "100" }] });

    const b1 = await getSalesByDimension({ from: TODAY, to: TODAY, branchId: 1, dimension: "product" });
    expect(b1.totals.revenue).toBe("250.00");
    const all = await getSalesByDimension({ from: TODAY, to: TODAY, dimension: "product" });
    expect(all.totals.revenue).toBe("2500.00");
  });

  it("يوزّع خصم الرأس والسنت المتبقي مرة واحدة ويحفظ التطابق بين كل الأبعاد والبحث", async () => {
    await seedInvoice({ id: 110, customerId: 10, items: [
      { variantId: 1, qty: 1, unitPrice: "1", unitCost: "0.10" },
      { variantId: 2, qty: 1, unitPrice: "1", unitCost: "0.10" },
      { variantId: 1, qty: 1, unitPrice: "1", unitCost: "0.10" },
    ] });
    await db().update(s.invoices).set({ total: "2.99", discountAmount: "0.01", paidAmount: "2.99" }).where(sql`${s.invoices.id} = 110`);
    for (const dimension of ["product", "customer", "branch", "cashier", "paymentMethod"] as const) {
      const result = await getSalesByDimension({ from: TODAY, to: TODAY, dimension });
      expect(result.totals.revenue).toBe("2.99");
      expect(result.totals.profit).toBe("2.69");
      expect(result.totals.discounts).toBe("0.01");
    }
    const register = await getSalesRegister({ from: TODAY, to: TODAY });
    expect(register.rows.reduce((sum, row) => sum.plus(row.total), money(0)).toFixed(2)).toBe("2.99");
    const notebook = await getSalesRegister({ from: TODAY, to: TODAY, q: "دفتر" });
    expect(notebook.totals.revenue).toBe("0.99"); // search must not allocate the whole invoice to its matching line
    expect((await getAbcAnalysis({ from: TODAY, to: TODAY })).totals.revenue).toBe("2.99");
    const categories = await getProfitByCategory({ from: TODAY, to: TODAY });
    expect(categories.reduce((sum, row) => sum.plus(row.revenue), money(0)).toFixed(2)).toBe("2.99");
  });

  it("لا يحوّل مرتجعاً جزئياً يساوي الإجمالي المقرّب لأسفل إلى مرتجع كامل", async () => {
    await seedInvoice({ id: 114, customerId: 10, items: [{ variantId: 1, qty: 11, unitPrice: "100", unitCost: "60", restockedReturn: 10 }] });
    await db().update(s.invoices).set({ total: "1000.00", cashRoundingAdjustment: "-100.00", returnedTotal: "1000.00", status: "PARTIALLY_PAID" }).where(sql`${s.invoices.id}=114`);
    await db().update(s.invoiceItems).set({ returnedBaseQuantity: 10 }).where(sql`${s.invoiceItems.invoiceId}=114`);
    for (const dimension of ["product", "customer", "branch", "cashier", "paymentMethod"] as const) {
      const result=await getSalesByDimension({ from: TODAY, to: TODAY, dimension });
      expect(result.totals).toMatchObject({ revenue: "100.00", grossSales: "1100.00", returns: "1000.00", cost: "60.00", profit: "40.00" });
    }
  });

  it("يفصل الضريبة والتوصيل ويخصم المرتجع الجزئي مع خصم الرأس دون ازدواج", async () => {
    await seedInvoice({ id: 111, customerId: 10, items: [
      { variantId: 1, qty: 2, unitPrice: "50", unitCost: "20", restockedReturn: 1 },
      { variantId: 2, qty: 1, unitPrice: "100", unitCost: "40" },
    ] });
    await db().update(s.invoices).set({ total: "218.00", discountAmount: "20.00", taxAmount: "18.00", deliveryFee: "20.00", returnedTotal: "49.50", paidAmount: "168.50" }).where(sql`${s.invoices.id} = 111`);
    await db().update(s.invoiceItems).set({ returnedBaseQuantity: 1 }).where(sql`${s.invoiceItems.invoiceId} = 111 AND ${s.invoiceItems.variantId} = 1`);
    await db().insert(s.accountingEntries).values({ entryType: "RETURN", branchId: 1, invoiceId: 111, amount: "-49.50", revenue: "-45.00", taxAmount: "-4.50", cost: "-20.00", entryDate: new Date(TODAY) });
    for (const dimension of ["product", "customer", "branch", "cashier", "paymentMethod"] as const) {
      const result = await getSalesByDimension({ from: TODAY, to: TODAY, dimension });
      expect(result.totals.revenue).toBe("135.00");
      expect(result.totals.deliveryRevenue).toBe("20.00");
      expect(result.totals.cost).toBe("60.00");
      expect(result.totals.profit).toBe("75.00");
    }
    expect((await getSalesRegister({ from: TODAY, to: TODAY })).totals.revenue).toBe("135.00");
    const products = await getTopProducts({ from: TODAY, to: TODAY });
    expect(products.reduce((sum, row) => sum.plus(row.revenue), money(0)).toFixed(2)).toBe("135.00");
    expect((await getAbcAnalysis({ from: TODAY, to: TODAY })).totals.revenue).toBe("135.00");
  });

  it("ABC وبطيئات الحركة لا يعتبران الفاتورة المستبدلة بيعاً قائماً", async () => {
    await seedInvoice({ id: 112, customerId: 10, items: [{ variantId: 1, qty: 1, unitPrice: "100", unitCost: "40" }] });
    await db().update(s.invoices).set({ status: "SUPERSEDED" }).where(sql`${s.invoices.id} = 112`);
    expect((await getAbcAnalysis({ from: TODAY, to: TODAY })).totals.revenue).toBe("0.00");
    await db().insert(s.branchStock).values({ variantId: 1, branchId: 1, quantity: 3 });
    expect((await getSlowMovers({ branchId: 1, sinceDays: 30 })).map((row) => row.productId)).toContain(1);
  });

  it("المرتجع الكامل يلغي إيراد التوصيل والبضاعة ويحتفظ بخسارة التالف", async () => {
    await seedInvoice({ id: 113, customerId: 10, items: [{ variantId: 1, qty: 1, unitPrice: "100", unitCost: "40" }] });
    await db().update(s.invoices).set({ total: "120.00", deliveryFee: "20.00", returnedTotal: "120.00", paidAmount: "0.00", status: "RETURNED" }).where(sql`${s.invoices.id} = 113`);
    await db().update(s.invoiceItems).set({ returnedBaseQuantity: 1 }).where(sql`${s.invoiceItems.invoiceId} = 113`);
    const result = await getSalesByDimension({ from: TODAY, to: TODAY, dimension: "product" });
    expect(result.totals.revenue).toBe("0.00");
    expect(result.totals.deliveryRevenue).toBe("0.00");
    expect(result.totals.cost).toBe("40.00");
    expect(result.totals.profit).toBe("-40.00");
  });
});
