// بند 9 (٧/٧): اختبارات ربحية تقرير «حسب البُعد» — بُعد «الصنف» الجديد + أعمدة الربح،
// مع تحقق تقاطعي: ربح بُعد الصنف (صيغة السطر) = ربح سجلّ المبيعات على نفس البيانات.
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { getSalesByDimension, getSalesRegister } from "../reportsSalesService";

const TABLES = [
  "accountingEntries",
  "receipts",
  "invoiceItems",
  "invoices",
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
      total: (it.qty * Number(it.unitPrice)).toFixed(2),
    });
  }
}

beforeEach(async () => {
  await reset();
  await seedBase();
});

describe("salesByDimension — بُعد الصنف والربحية", () => {
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

  it("عزل الفرع في بُعد الصنف", async () => {
    await seedInvoice({ id: 107, customerId: 10, branchId: 1, items: [{ variantId: 1, qty: 1, unitPrice: "250", unitCost: "100" }] });
    await seedInvoice({ id: 108, customerId: 10, branchId: 2, items: [{ variantId: 1, qty: 9, unitPrice: "250", unitCost: "100" }] });

    const b1 = await getSalesByDimension({ from: TODAY, to: TODAY, branchId: 1, dimension: "product" });
    expect(b1.totals.revenue).toBe("250.00");
    const all = await getSalesByDimension({ from: TODAY, to: TODAY, dimension: "product" });
    expect(all.totals.revenue).toBe("2500.00");
  });
});
