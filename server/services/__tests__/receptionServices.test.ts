// توجيه خدمة الطباعة لكاشير الاستقبال (showInReception): الإظهار المشروط + علم isPrintService.
// يعمل على قاعدة الاختبار الحقيقية (MySQL) لأن شرط الرؤية يُنفَّذ في SQL.
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { listForPos } from "../catalogService";
import { PRINT_SERVICE_TYPE } from "../printSaleService";

function db() { const d = getDb(); if (!d) throw new Error("DATABASE_URL not set"); return d; }

async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of ["branchStock", "productPrices", "productUnits", "productVariants", "products", "branches"]) {
    await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  }
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

/** بذرة: صنف عادي + خدمتا طباعة (واحدة مُوجَّهة للاستقبال وأخرى لا). */
async function seed() {
  const d = db();
  await d.insert(s.branches).values([{ id: 1, name: "MAIN", code: "MAIN", type: "MAIN" }]);
  await d.insert(s.products).values([
    { id: 1, name: "قلم جاف أزرق", productType: null, isService: false, showInReception: false },
    { id: 2, name: "تصوير A4 أبيض/أسود", productType: PRINT_SERVICE_TYPE, isService: true, showInReception: true },
    { id: 3, name: "تجليد حراري", productType: PRINT_SERVICE_TYPE, isService: true, showInReception: false },
  ]);
  await d.insert(s.productVariants).values([
    { id: 1, productId: 1, sku: "PEN-BLUE", costPrice: "0.00" },
    { id: 2, productId: 2, sku: "SVC-COPY-A4", costPrice: "0.00" },
    { id: 3, productId: 3, sku: "SVC-BIND", costPrice: "0.00" },
  ]);
  await d.insert(s.productUnits).values([
    { id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
    { id: 2, variantId: 2, unitName: "ورقة", conversionFactor: "1", isBaseUnit: true },
    { id: 3, variantId: 3, unitName: "خدمة", conversionFactor: "1", isBaseUnit: true },
  ]);
  await d.insert(s.productPrices).values([
    { productUnitId: 1, priceTier: "RETAIL", price: "500.00" },
    { productUnitId: 2, priceTier: "RETAIL", price: "250.00" },
    { productUnitId: 3, priceTier: "RETAIL", price: "1000.00" },
  ]);
}

beforeEach(async () => { await reset(); await seed(); });

const names = (rows: Array<{ productName: string }>) => rows.map((r) => r.productName);

describe("توجيه الخدمة للاستقبال — showInReception", () => {
  it("الكاشير العام (بلا includeReceptionServices) يُخفي كل خدمات الطباعة", async () => {
    const ns = names(await listForPos(1, "RETAIL"));
    expect(ns).toContain("قلم جاف أزرق");
    expect(ns).not.toContain("تصوير A4 أبيض/أسود");
    expect(ns).not.toContain("تجليد حراري");
  });

  it("الاستقبال يُظهر فقط خدمات الطباعة المفعَّل عليها showInReception (لا غيرها)", async () => {
    const ns = names(await listForPos(1, "RETAIL", undefined, 200, { includeReceptionServices: true }));
    expect(ns).toContain("قلم جاف أزرق");        // العادي يبقى ظاهراً
    expect(ns).toContain("تصوير A4 أبيض/أسود");  // مفعَّل ⇒ يَظهر في الاستقبال
    expect(ns).not.toContain("تجليد حراري");      // غير مفعَّل ⇒ يبقى مخفياً
  });

  it("علم isPrintService: خدمة الطباعة true والصنف العادي false (لتوجيه مسار البيع)", async () => {
    const rows = await listForPos(1, "RETAIL", undefined, 200, { includeReceptionServices: true });
    expect(rows.find((r) => r.productName === "تصوير A4 أبيض/أسود")?.isPrintService).toBe(true);
    expect(rows.find((r) => r.productName === "قلم جاف أزرق")?.isPrintService).toBe(false);
  });

  it("البحث النصّي في الاستقبال يجد خدمة الطباعة المُوجَّهة", async () => {
    const ns = names(await listForPos(1, "RETAIL", "تصوير", 200, { includeReceptionServices: true }));
    expect(ns).toContain("تصوير A4 أبيض/أسود");
  });
});
