// توجيه خدمات الطباعة لعروض الأسعار والمبيعات المتقدمة (showInQuotations و showInAdvancedSales)
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { listForPos } from "../catalogService";
import { createProduct } from "../catalog/productCreate";
import { getProductForVariantEdit, updateProductWithVariants } from "../productEditService";
import { PRINT_SERVICE_TYPE } from "../printSaleService";
import { normalizeSearchText } from "../../../shared/searchNormalize";

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set");
  return d;
}

async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of [
    "productPrices",
    "productUnits",
    "productVariants",
    "products",
    "branchStock",
    "branches",
  ]) {
    await d.execute(sql.raw(`DELETE FROM \`${t}\``));
  }
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

async function syncProductSearchNormFixture() {
  const d = db();
  const meta: any = await d.execute(sql`
    SELECT COALESCE(GENERATION_EXPRESSION, '') AS expr
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'products'
      AND COLUMN_NAME = 'searchNorm'
    LIMIT 1
  `);
  const column = Array.isArray(meta) ? meta[0]?.[0] : meta?.rows?.[0];
  if (String(column?.expr ?? "").trim()) return;

  const rows = await d.select({ id: s.products.id, name: s.products.name }).from(s.products);
  for (const row of rows) {
    await d
      .update(s.products)
      .set({ searchNorm: normalizeSearchText(row.name) })
      .where(eq(s.products.id, row.id));
  }
}

let testBranchId = 1;

/** بذرة: صنف عادي + 3 خدمات طباعة بتوجيهات مختلفة. */
async function seed() {
  const d = db();
  const [b] = await d.insert(s.branches).values([{ name: "MAIN", code: "MAIN", type: "MAIN" }]);
  testBranchId = Number(b.insertId);

  const [p1] = await d.insert(s.products).values([{
    name: "دفتر مدرسي سلك",
    productType: null,
    isService: false,
    showInReception: false,
    showInQuotations: false,
    showInAdvancedSales: false,
  }]);
  const [p2] = await d.insert(s.products).values([{
    name: "تصميم شعار وبطاقة",
    productType: PRINT_SERVICE_TYPE,
    isService: true,
    showInReception: false,
    showInQuotations: true,
    showInAdvancedSales: false,
  }]);
  const [p3] = await d.insert(s.products).values([{
    name: "طباعة بوستر هندسي",
    productType: PRINT_SERVICE_TYPE,
    isService: true,
    showInReception: false,
    showInQuotations: false,
    showInAdvancedSales: true,
  }]);
  const [p4] = await d.insert(s.products).values([{
    name: "طباعة كتالوج سنوي",
    productType: PRINT_SERVICE_TYPE,
    isService: true,
    showInReception: false,
    showInQuotations: true,
    showInAdvancedSales: true,
  }]);

  await syncProductSearchNormFixture();

  const [v1] = await d.insert(s.productVariants).values([{ productId: Number(p1.insertId), sku: "NOTEBOOK-WIRE", costPrice: "0.00" }]);
  const [v2] = await d.insert(s.productVariants).values([{ productId: Number(p2.insertId), sku: "SVC-LOGO", costPrice: "0.00" }]);
  const [v3] = await d.insert(s.productVariants).values([{ productId: Number(p3.insertId), sku: "SVC-POSTER", costPrice: "0.00" }]);
  const [v4] = await d.insert(s.productVariants).values([{ productId: Number(p4.insertId), sku: "SVC-CATALOG", costPrice: "0.00" }]);

  const [u1] = await d.insert(s.productUnits).values([{ variantId: Number(v1.insertId), unitName: "قطعة", conversionFactor: "1", isBaseUnit: true }]);
  const [u2] = await d.insert(s.productUnits).values([{ variantId: Number(v2.insertId), unitName: "خدمة", conversionFactor: "1", isBaseUnit: true }]);
  const [u3] = await d.insert(s.productUnits).values([{ variantId: Number(v3.insertId), unitName: "ورقة", conversionFactor: "1", isBaseUnit: true }]);
  const [u4] = await d.insert(s.productUnits).values([{ variantId: Number(v4.insertId), unitName: "كتالوج", conversionFactor: "1", isBaseUnit: true }]);

  await d.insert(s.productPrices).values([
    { productUnitId: Number(u1.insertId), priceTier: "RETAIL", price: "1000.00" },
    { productUnitId: Number(u2.insertId), priceTier: "RETAIL", price: "25000.00" },
    { productUnitId: Number(u3.insertId), priceTier: "RETAIL", price: "5000.00" },
    { productUnitId: Number(u4.insertId), priceTier: "RETAIL", price: "50000.00" },
  ]);
}

beforeEach(async () => {
  await reset();
  await seed();
});

const names = (rows: Array<{ productName: string }>) => rows.map((r) => r.productName);

describe("توجيه الخدمة لعروض الأسعار والمبيعات المتقدمة", () => {
  it("عروض الأسعار تُظهر الخدمات المفعّل عليها showInQuotations فقط", async () => {
    const ns = names(await listForPos(testBranchId, "RETAIL", undefined, 200, { includeQuotationServices: true }));
    expect(ns).toContain("دفتر مدرسي سلك"); // الصنف العادي يظهر دائماً
    expect(ns).toContain("تصميم شعار وبطاقة"); // showInQuotations: true
    expect(ns).toContain("طباعة كتالوج سنوي"); // showInQuotations: true
    expect(ns).not.toContain("طباعة بوستر هندسي"); // showInQuotations: false ⇒ مخفي في عروض الأسعار
  });

  it("المبيعات المتقدمة تُظهر الخدمات المفعّل عليها showInAdvancedSales فقط", async () => {
    const ns = names(await listForPos(testBranchId, "RETAIL", undefined, 200, { includeAdvancedSaleServices: true }));
    expect(ns).toContain("دفتر مدرسي سلك"); // الصنف العادي يظهر دائماً
    expect(ns).toContain("طباعة بوستر هندسي"); // showInAdvancedSales: true
    expect(ns).toContain("طباعة كتالوج سنوي"); // showInAdvancedSales: true
    expect(ns).not.toContain("تصميم شعار وبطاقة"); // showInAdvancedSales: false ⇒ مخفي في المبيعات المتقدمة
  });

  it("includeAllServices يتطابق مع includeAdvancedSaleServices", async () => {
    const ns = names(await listForPos(testBranchId, "RETAIL", undefined, 200, { includeAllServices: true }));
    expect(ns).toContain("دفتر مدرسي سلك");
    expect(ns).toContain("طباعة بوستر هندسي");
    expect(ns).toContain("طباعة كتالوج سنوي");
    expect(ns).not.toContain("تصميم شعار وبطاقة");
  });

  it("إنشاء وتعديل خدمة بتوجيهات عروض الأسعار والمبيعات المتقدمة يحفظ الحقول ويسترجعها", async () => {
    const created = await createProduct({
      name: "خدمة تغليف حراري فاخر",
      isService: true,
      showInQuotations: true,
      showInAdvancedSales: false,
      variants: [
        {
          sku: "SVC-LUX-BIND",
          costPrice: "100.00",
          unitBarcodes: {},
          units: [
            {
              unitName: "حبة",
              conversionFactor: "1",
              isBaseUnit: true,
              prices: [{ priceTier: "RETAIL", price: "2000.00" }],
            },
          ],
        },
      ],
    });

    const doc = await getProductForVariantEdit(created.productId);
    expect(doc).not.toBeNull();
    expect(doc?.showInQuotations).toBe(true);
    expect(doc?.showInAdvancedSales).toBe(false);

    // تعديل التوجيه
    await updateProductWithVariants(
      {
        productId: created.productId,
        name: "خدمة تغليف حراري فاخر معدلة",
        showInQuotations: false,
        showInAdvancedSales: true,
        unitTemplate: [
          {
            unitName: "حبة",
            conversionFactor: "1",
            isBaseUnit: true,
            prices: [{ priceTier: "RETAIL", price: "2000.00" }],
          },
        ],
        variants: doc!.variants.map((v) => ({
          id: v.id,
          sku: v.sku,
          costPrice: v.costPrice,
          unitBarcodes: v.unitBarcodes ?? {},
        })),
      },
      { userId: 1 },
    );

    const updatedDoc = await getProductForVariantEdit(created.productId);
    expect(updatedDoc?.showInQuotations).toBe(false);
    expect(updatedDoc?.showInAdvancedSales).toBe(true);
  });
});
