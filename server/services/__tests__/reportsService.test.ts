import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createPurchaseOrder, receivePurchase } from "../purchaseService";
import { createSale, processPayment } from "../saleService";
import {
  getAPAging,
  getARAging,
  getCustomerStatement,
  getProfitByCategory,
  getSlowMovers,
  getSupplierStatement,
  getTopProducts,
} from "../reportsService";
import { truncateTables } from "./__testUtils__";

const actor = { userId: 1, branchId: 1 };

const TABLES = [
  "idempotencyKeys",
  "accountingEntries",
  "receipts",
  "inventoryMovements",
  "invoiceItems",
  "invoices",
  "branchStock",
  "productPrices",
  "productUnits",
  "productVariants",
  "products",
  "categories",
  "purchaseOrderItems",
  "purchaseOrders",
  "shifts",
  "customers",
  "suppliers",
  "branches",
  "users",
  "auditLogs",
];

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}
const insertId = (res: any): number => Number(res?.[0]?.insertId ?? res?.insertId);

async function reset() {
  const d = db();
  await truncateTables(TABLES);
}

async function seedBase() {
  const d = db();
  await d.insert(s.branches).values([
    { id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "فرع المبيعات", code: "SALES", type: "SALES" },
  ]);
  await d.insert(s.users).values({ id: 1, openId: "local_test", name: "admin", role: "admin", loginMethod: "local" });
  // M5/M8/M10: عمليات النقد (processPayment CASH هنا) تَستلزم وردية مفتوحة.
  await d.insert(s.shifts).values({
    userId: 1, branchId: 1, status: "OPEN",
    openedAt: new Date(),
    openGuard: "1:1", openingBalance: "0",
  });
  await d.insert(s.products).values({ id: 1, name: "قلم" });
  await d.insert(s.productVariants).values({ id: 1, productId: 1, sku: "PEN-1", costPrice: "4.00" });
  await d.insert(s.productUnits).values([
    { id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
    { id: 2, variantId: 1, unitName: "درزن", conversionFactor: "12", isBaseUnit: false },
  ]);
  await d.insert(s.productPrices).values([
    { productUnitId: 1, priceTier: "RETAIL", price: "10.00" },
    { productUnitId: 2, priceTier: "RETAIL", price: "120.00" },
  ]);
}
async function setStock(variantId: number, branchId: number, qty: number) {
  await db().insert(s.branchStock).values({ variantId, branchId, quantity: qty });
}

beforeEach(async () => {
  await reset();
  await seedBase();
});

describe("تقارير الذمم المدينة (AR)", () => {
  it("getARAging: يدرج العميل المدين فقط ويجمعه في شريحة 0-30، ويستثني المُسدَّد", async () => {
    await setStock(1, 1, 100);
    await db().insert(s.customers).values([
      { id: 1, name: "عميل مدين", defaultPriceTier: "RETAIL", currentBalance: "0" },
      { id: 2, name: "عميل مسدّد", defaultPriceTier: "RETAIL", currentBalance: "0" },
    ]);

    // عميل 1: بيع آجل 240 بلا دفع ⇒ مستحق
    await createSale({ branchId: 1, customerId: 1, sourceType: "ORDER", lines: [{ variantId: 1, productUnitId: 2, quantity: "2" }] }, actor);
    // عميل 2: بيع آجل ثم تسديد كامل ⇒ لا يظهر
    const paid = await createSale({ branchId: 1, customerId: 2, sourceType: "ORDER", lines: [{ variantId: 1, productUnitId: 2, quantity: "1" }] }, actor);
    await processPayment({ invoiceId: paid.invoiceId, amount: "120.00", method: "CASH" }, actor);

    const aging = await getARAging();
    expect(aging).toHaveLength(1);
    const row = aging[0];
    expect(Number(row.customerId)).toBe(1);
    expect(row.d0_30).toBe("240.00");
    expect(row.d31_60).toBe("0.00");
    expect(row.unpaidTotal).toBe("240.00");
    expect(row.currentBalance).toBe("240.00");
    expect(row.oldestInvoiceDate).not.toBeNull();
  });

  it("getCustomerStatement: فواتير + دفعات + ملخّص صحيح بعد دفعة جزئية", async () => {
    await setStock(1, 1, 100);
    await db().insert(s.customers).values({ id: 1, name: "عميل", defaultPriceTier: "RETAIL", currentBalance: "0" });
    const sale = await createSale({ branchId: 1, customerId: 1, sourceType: "ORDER", lines: [{ variantId: 1, productUnitId: 2, quantity: "2" }] }, actor);
    await processPayment({ invoiceId: sale.invoiceId, amount: "100.00", method: "CASH" }, actor);

    const stmt = await getCustomerStatement(1);
    expect(stmt).not.toBeNull();
    expect(stmt!.invoices).toHaveLength(1);
    expect(stmt!.payments).toHaveLength(1);
    expect(stmt!.payments[0].direction).toBe("IN");
    expect(stmt!.payments[0].amount).toBe("100.00");
    expect(stmt!.summary.totalSales).toBe("240.00");
    expect(stmt!.summary.totalPaid).toBe("100.00");
    expect(stmt!.summary.unpaid).toBe("140.00");
    expect(stmt!.summary.currentBalance).toBe("140.00");
  });

  it("getCustomerStatement لعميل غير موجود = null", async () => {
    expect(await getCustomerStatement(999)).toBeNull();
  });
});

describe("تقارير الذمم الدائنة (AP)", () => {
  async function makePO(supplierId: number, qty: number, unitPrice: string, receive: boolean, pay?: string) {
    const po = await createPurchaseOrder(
      { supplierId, branchId: 1, taxRatePercent: "0", status: "CONFIRMED", items: [{ variantId: 1, productUnitId: 1, quantity: String(qty), unitPrice }] },
      actor
    );
    if (receive) {
      const poItem = (await db().select().from(s.purchaseOrderItems).where(sql`purchaseOrderId = ${po.purchaseOrderId}`))[0];
      await receivePurchase(
        {
          purchaseOrderId: po.purchaseOrderId,
          lines: [{ purchaseOrderItemId: Number(poItem.id), receivedBaseQuantity: qty }],
          payment: pay ? { amount: pay, method: "CASH" } : undefined,
        },
        actor
      );
    }
    return po;
  }

  it("getAPAging: يجمع المستحق للمورد في 0-30 ويستثني المسدّد كلياً", async () => {
    await setStock(1, 1, 0);
    await db().insert(s.suppliers).values([
      { id: 1, name: "مورد مستحق", currentBalance: "0" },
      { id: 2, name: "مورد مسدّد", currentBalance: "0" },
    ]);
    // مورد 1: شراء 500، دفع 200 ⇒ مستحق 300
    await makePO(1, 100, "5.00", true, "200.00");
    // مورد 2: شراء 120، دفع كامل ⇒ لا يظهر
    await makePO(2, 12, "10.00", true, "120.00");

    const aging = await getAPAging();
    expect(aging).toHaveLength(1);
    const row = aging[0];
    expect(Number(row.supplierId)).toBe(1);
    expect(row.d0_30).toBe("300.00");
    expect(row.unpaidTotal).toBe("300.00");
    expect(row.currentBalance).toBe("300.00");
    expect(row.oldestPoDate).not.toBeNull();
  });

  it("getSupplierStatement: أوامر الشراء + دفعات PAYMENT_OUT + ملخّص", async () => {
    await setStock(1, 1, 0);
    await db().insert(s.suppliers).values({ id: 1, name: "مورد", currentBalance: "0" });
    const po = await makePO(1, 100, "5.00", true, "200.00");

    const stmt = await getSupplierStatement(1);
    expect(stmt).not.toBeNull();
    expect(stmt!.purchaseOrders).toHaveLength(1);
    expect(Number(stmt!.purchaseOrders[0].id)).toBe(po.purchaseOrderId);
    expect(stmt!.purchaseOrders[0].total).toBe("500.00");
    expect(stmt!.purchaseOrders[0].paidAmount).toBe("200.00");

    expect(stmt!.payments).toHaveLength(1);
    expect(stmt!.payments[0].amount).toBe("200.00");
    expect(Number(stmt!.payments[0].purchaseOrderId)).toBe(po.purchaseOrderId);

    expect(stmt!.summary.totalPurchases).toBe("500.00");
    expect(stmt!.summary.totalPaid).toBe("200.00");
    expect(stmt!.summary.unpaid).toBe("300.00");
    expect(stmt!.summary.currentBalance).toBe("300.00");
  });

  it("getSupplierStatement لمورد غير موجود = null", async () => {
    expect(await getSupplierStatement(999)).toBeNull();
  });

  it("AP aging يستثني أوامر DRAFT غير الملتزمة", async () => {
    await setStock(1, 1, 0);
    await db().insert(s.suppliers).values({ id: 1, name: "مورد مسودّة", currentBalance: "0" });
    // أمر DRAFT — لا يلتزم مالياً (لا AP)
    const r = await createPurchaseOrder(
      { supplierId: 1, branchId: 1, taxRatePercent: "0", status: "DRAFT", items: [{ variantId: 1, productUnitId: 1, quantity: "10", unitPrice: "5.00" }] },
      actor
    );
    void r;
    const aging = await getAPAging();
    expect(aging).toHaveLength(0);
  });
});

/* ============================ التقارير التحليلية (top/slow/category) ============================ */

/** يضيف منتجاً ثانياً + متغيراً + وحدات + سعراً، في فئة مختلفة لاختبار التجميع بالفئة. */
async function seedSecondProduct(opts: { categoryId?: number } = {}) {
  const d = db();
  await d.insert(s.products).values({ id: 2, name: "كرّاسة", categoryId: opts.categoryId ?? null });
  await d.insert(s.productVariants).values({ id: 2, productId: 2, sku: "NB-1", costPrice: "2.00" });
  await d.insert(s.productUnits).values({ id: 3, variantId: 2, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true });
  await d.insert(s.productPrices).values({ productUnitId: 3, priceTier: "RETAIL", price: "5.00" });
}

describe("تقارير المبيعات التحليلية", () => {
  it("getTopProducts: يرتّب بالإيراد افتراضياً ويحسب الربح والهامش بدقّة", async () => {
    await setStock(1, 1, 100);
    await seedSecondProduct();
    await setStock(2, 1, 100);
    await db().insert(s.customers).values({ id: 1, name: "عميل", defaultPriceTier: "RETAIL", currentBalance: "0" });

    // قلم: درزن × 2 = 240 إيراد، تكلفة 4×12×2=96، ربح 144
    await createSale({ branchId: 1, customerId: 1, sourceType: "POS", lines: [{ variantId: 1, productUnitId: 2, quantity: "2" }] }, actor);
    // كرّاسة: 10 قطع = 50 إيراد، تكلفة 2×10=20، ربح 30
    await createSale({ branchId: 1, customerId: 1, sourceType: "POS", lines: [{ variantId: 2, productUnitId: 3, quantity: "10" }] }, actor);

    const top = await getTopProducts({ by: "revenue" });
    expect(top.length).toBe(2);
    expect(top[0].productId).toBe(1);
    expect(top[0].revenue).toBe("240.00");
    expect(top[0].cost).toBe("96.00");
    expect(top[0].profit).toBe("144.00");
    expect(top[0].marginPct).toBe("60.00");
    expect(top[0].invoicesCount).toBe(1);
    expect(top[1].productId).toBe(2);
    expect(top[1].revenue).toBe("50.00");
  });

  it("getTopProducts بترتيب الكمية: المنتج بكمية أعلى يأتي أولاً حتى لو إيراده أقل", async () => {
    await setStock(1, 1, 100);
    await seedSecondProduct();
    await setStock(2, 1, 100);
    await db().insert(s.customers).values({ id: 1, name: "عميل", defaultPriceTier: "RETAIL", currentBalance: "0" });

    // قلم: درزن واحد = 12 قطعة، 120 إيراد
    await createSale({ branchId: 1, customerId: 1, sourceType: "POS", lines: [{ variantId: 1, productUnitId: 2, quantity: "1" }] }, actor);
    // كرّاسة: 30 قطعة = 150 إيراد لكن كمية أعلى
    await createSale({ branchId: 1, customerId: 1, sourceType: "POS", lines: [{ variantId: 2, productUnitId: 3, quantity: "30" }] }, actor);

    const top = await getTopProducts({ by: "qty" });
    expect(top[0].productId).toBe(2); // الكرّاسة أعلى كمية
    expect(top[0].qtySold).toBe("30");
    expect(top[1].productId).toBe(1);
    expect(top[1].qtySold).toBe("12");
  });

  it("getTopProducts يستبعد الفواتير الملغاة", async () => {
    await setStock(1, 1, 100);
    await db().insert(s.customers).values({ id: 1, name: "عميل", defaultPriceTier: "RETAIL", currentBalance: "0" });

    const sale = await createSale({ branchId: 1, customerId: 1, sourceType: "POS", lines: [{ variantId: 1, productUnitId: 1, quantity: "5" }] }, actor);
    await db().update(s.invoices).set({ status: "CANCELLED" }).where(sql`id = ${sale.invoiceId}`);

    const top = await getTopProducts();
    expect(top).toHaveLength(0);
  });

  it("getProfitByCategory: يجمّع على الفئة و«بلا فئة» للمنتجات بلا تصنيف", async () => {
    await setStock(1, 1, 100);
    await db().insert(s.categories).values({ id: 1, name: "قرطاسية" });
    await seedSecondProduct({ categoryId: 1 });
    await setStock(2, 1, 100);
    await db().insert(s.customers).values({ id: 1, name: "عميل", defaultPriceTier: "RETAIL", currentBalance: "0" });

    // القلم بلا فئة: 5 قطع × 10 = 50 إيراد، تكلفة 5×4=20
    await createSale({ branchId: 1, customerId: 1, sourceType: "POS", lines: [{ variantId: 1, productUnitId: 1, quantity: "5" }] }, actor);
    // الكرّاسة في «قرطاسية»: 20 قطعة × 5 = 100 إيراد، تكلفة 20×2=40
    await createSale({ branchId: 1, customerId: 1, sourceType: "POS", lines: [{ variantId: 2, productUnitId: 3, quantity: "20" }] }, actor);

    const cats = await getProfitByCategory();
    expect(cats).toHaveLength(2);
    // الترتيب بالإيراد تنازلياً ⇒ قرطاسية أولاً
    expect(cats[0].categoryName).toBe("قرطاسية");
    expect(cats[0].revenue).toBe("100.00");
    expect(cats[0].cost).toBe("40.00");
    expect(cats[0].profit).toBe("60.00");
    expect(cats[0].marginPct).toBe("60.00");
    expect(cats[1].categoryName).toBe("بلا فئة");
    expect(cats[1].categoryId).toBeNull();
    expect(cats[1].revenue).toBe("50.00");
  });

  it("getSlowMovers: يظهر المنتج بمخزون موجب بلا بيع منذ النافذة، ويختفي بعد بيع حديث", async () => {
    await setStock(1, 1, 100);
    // بلا مبيعات إطلاقاً ⇒ يجب أن يظهر
    let slow = await getSlowMovers({ sinceDays: 30 });
    expect(slow).toHaveLength(1);
    expect(slow[0].productId).toBe(1);
    expect(slow[0].qtyInStock).toBe("100");
    expect(slow[0].lastSaleDate).toBeNull();
    expect(slow[0].daysSinceLastSale).toBeNull();

    // بعد بيع حديث ⇒ لا يجب أن يظهر
    await db().insert(s.customers).values({ id: 1, name: "عميل", defaultPriceTier: "RETAIL", currentBalance: "0" });
    await createSale({ branchId: 1, customerId: 1, sourceType: "POS", lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }] }, actor);
    slow = await getSlowMovers({ sinceDays: 30 });
    expect(slow).toHaveLength(0);
  });

  it("getSlowMovers يستثني منتجاً بمخزون صفر حتى لو لم يُبَع", async () => {
    // مخزون صفر ⇒ لا اهتمام بالحركة (لا شيء للتخلّص منه)
    await setStock(1, 1, 0);
    const slow = await getSlowMovers({ sinceDays: 30 });
    expect(slow).toHaveLength(0);
  });
});
