import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createSale } from "../saleService";
import { getDashboardMetrics } from "../reportsService";

const actor = { userId: 1, branchId: 1 };

const TABLES = [
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

async function seedBase() {
  const d = db();
  await d.insert(s.branches).values([
    { id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "فرع المبيعات", code: "SALES", type: "SALES" },
  ]);
  await d.insert(s.users).values({ id: 1, openId: "local_test", name: "admin", role: "admin", loginMethod: "local" });
  // منتج بقلم تجريبي (يُستعمل في اختبار AR overdue).
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

beforeEach(async () => {
  await reset();
  await seedBase();
});

describe("getDashboardMetrics", () => {
  it("(أ) lowStockCount = 2 عند وجود متغيّرَين تحت minStock، ويستثني متغيّراً سليماً ومتغيّراً بلا حدّ أدنى", async () => {
    const d = db();
    // متغيّرات إضافية لاختبار العدّ:
    //   v=2: minStock=10، quantity=5 ⇒ منخفض (يُعدّ)
    //   v=3: minStock=20، quantity=20 ⇒ منخفض على الحدّ تماماً (يُعدّ — العلامة ≤)
    //   v=4: minStock=10، quantity=50 ⇒ سليم (لا يُعدّ)
    //   v=5: minStock=0،  quantity=0  ⇒ بلا حدّ أدنى (يُستثنى)
    //   v=1 (من seed): لا قيد على الحدّ — minStock=0 ⇒ يُستثنى تلقائياً.
    await d.insert(s.productVariants).values([
      { id: 2, productId: 1, sku: "PEN-2", costPrice: "4.00", minStock: 10 },
      { id: 3, productId: 1, sku: "PEN-3", costPrice: "4.00", minStock: 20 },
      { id: 4, productId: 1, sku: "PEN-4", costPrice: "4.00", minStock: 10 },
      { id: 5, productId: 1, sku: "PEN-5", costPrice: "4.00", minStock: 0 },
    ]);
    await d.insert(s.branchStock).values([
      { variantId: 1, branchId: 1, quantity: 0 },   // minStock=0 ⇒ يُستثنى
      { variantId: 2, branchId: 1, quantity: 5 },   // منخفض ✓
      { variantId: 3, branchId: 1, quantity: 20 },  // على الحدّ ⇒ منخفض ✓
      { variantId: 4, branchId: 1, quantity: 50 },  // سليم
      { variantId: 5, branchId: 1, quantity: 0 },   // بلا حدّ ⇒ يُستثنى
    ]);

    const m = await getDashboardMetrics({ branchId: 1 });
    expect(m.lowStockCount).toBe(2);
  });

  it("(ب) overdueAR.count=1 ومجموع المتبقّي صحيح لفاتورة عمرها ٤٥ يوماً", async () => {
    const d = db();
    // مخزون كافٍ لإتمام البيع.
    await d.insert(s.branchStock).values({ variantId: 1, branchId: 1, quantity: 100 });
    await d.insert(s.customers).values([
      { id: 1, name: "عميل متأخّر", defaultPriceTier: "RETAIL", currentBalance: "0" },
      { id: 2, name: "عميل حديث", defaultPriceTier: "RETAIL", currentBalance: "0" },
    ]);

    // فاتورة متأخّرة (٤٥ يوماً): 2 درزن × 120 = 240، بلا دفعة ⇒ متبقّي 240.
    const overdueSale = await createSale(
      { branchId: 1, customerId: 1, sourceType: "ORDER", lines: [{ variantId: 1, productUnitId: 2, quantity: "2" }] },
      actor
    );
    // ادفع تاريخ الإصدار إلى الوراء ٤٥ يوماً ⇒ DATEDIFF=45 > 30.
    await d.execute(sql`
      UPDATE invoices SET invoiceDate = DATE_SUB(NOW(), INTERVAL 45 DAY)
      WHERE id = ${overdueSale.invoiceId}
    `);

    // فاتورة حديثة (٥ أيام): يجب ألّا تُعدّ.
    const freshSale = await createSale(
      { branchId: 1, customerId: 2, sourceType: "ORDER", lines: [{ variantId: 1, productUnitId: 2, quantity: "1" }] },
      actor
    );
    await d.execute(sql`
      UPDATE invoices SET invoiceDate = DATE_SUB(NOW(), INTERVAL 5 DAY)
      WHERE id = ${freshSale.invoiceId}
    `);

    const m = await getDashboardMetrics({ branchId: 1 });
    expect(m.overdueAR.count).toBe(1);
    expect(m.overdueAR.total).toBe("240.00");
  });
});
