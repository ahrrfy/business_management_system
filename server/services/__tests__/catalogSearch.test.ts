// اختبارات البحث الذكي في الكتالوج — تطبيع عربي + كلمات مستقلة + ترتيب بالملاءمة + تهريب الأنماط.
// تعمل على قاعدة الاختبار الحقيقية (MySQL) لأن جوهر التطبيع REPLACE يُنفَّذ في SQL.
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { listForPos, listForPurchase, lookupByBarcode } from "../catalogService";
import { truncateTables } from "./__testUtils__";

function db() { const d = getDb(); if (!d) throw new Error("DATABASE_URL not set"); return d; }

async function reset() {
  await truncateTables(["branchStock", "productPrices", "productUnits", "productVariants", "products", "branches"]);
}

/** بذرة بأسماء تتعمّد فخاخ الإملاء العربي (همزات/تاء مربوطة/مقصورة). */
async function seed() {
  const d = db();
  await d.insert(s.branches).values([{ id: 1, name: "MAIN", code: "MAIN", type: "MAIN" }]);
  await d.insert(s.products).values([
    { id: 1, name: "قلم جاف أزرق فاخر" },
    { id: 2, name: "دفتر مدرسي ٩٦ ورقة" },
    { id: 3, name: "مكتبة خشبية صغيرة" },
    { id: 4, name: "علبة أقلام 100%" },
  ]);
  await d.insert(s.productVariants).values([
    { id: 1, productId: 1, sku: "PEN-BLUE", costPrice: "0.00" },
    { id: 2, productId: 2, sku: "NB-96", costPrice: "0.00" },
    { id: 3, productId: 3, sku: "SHELF-S", costPrice: "0.00" },
    { id: 4, productId: 4, sku: "PENBOX", costPrice: "0.00" },
  ]);
  await d.insert(s.productUnits).values([
    { id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, barcode: "6291041500213" },
    { id: 2, variantId: 2, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, barcode: "6291041500220" },
    { id: 3, variantId: 3, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
    { id: 4, variantId: 4, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
  ]);
  await d.insert(s.productPrices).values([
    { productUnitId: 1, priceTier: "RETAIL", price: "500.00" },
    { productUnitId: 2, priceTier: "RETAIL", price: "750.00" },
    { productUnitId: 3, priceTier: "RETAIL", price: "15000.00" },
    { productUnitId: 4, priceTier: "RETAIL", price: "3000.00" },
  ]);
}

beforeEach(async () => { await reset(); await seed(); });

const names = (rows: Array<{ productName: string }>) => rows.map((r) => r.productName);

describe("البحث الذكي — تطبيع عربي", () => {
  it("«ازرق» (بلا همزة) يجد «أزرق»", async () => {
    const rows = await listForPos(1, "RETAIL", "ازرق");
    expect(names(rows)).toContain("قلم جاف أزرق فاخر");
  });

  it("«مكتبه» (تاء مفتوحة... هاء) تجد «مكتبة»", async () => {
    const rows = await listForPos(1, "RETAIL", "مكتبه");
    expect(names(rows)).toContain("مكتبة خشبية صغيرة");
  });

  it("«ورقه» تجد «ورقة» والأرقام اللاتينية تجد العربية-الهندية: «96» يجد «٩٦»", async () => {
    expect(names(await listForPos(1, "RETAIL", "ورقه"))).toContain("دفتر مدرسي ٩٦ ورقة");
    expect(names(await listForPos(1, "RETAIL", "96"))).toContain("دفتر مدرسي ٩٦ ورقة");
  });
});

describe("البحث الذكي — كلمات مستقلة (AND عبر الأعمدة)", () => {
  it("«قلم ازرق» يجد «قلم جاف أزرق» رغم كلمة تفصل بينهما", async () => {
    const rows = await listForPos(1, "RETAIL", "قلم ازرق");
    expect(names(rows)).toContain("قلم جاف أزرق فاخر");
  });

  it("كلمتان من عمودين مختلفين (اسم + SKU) تتقاطعان", async () => {
    const rows = await listForPos(1, "RETAIL", "قلم PEN-BLUE");
    expect(names(rows)).toEqual(["قلم جاف أزرق فاخر"]);
  });

  it("كلمة غير موجودة تُفشل المطابقة كلها (AND لا OR)", async () => {
    const rows = await listForPos(1, "RETAIL", "قلم مستحيل");
    expect(rows).toHaveLength(0);
  });
});

describe("البحث الذكي — الترتيب بالملاءمة", () => {
  it("الاسم الذي يبدأ بالاستعلام يتقدّم على من يحتويه وسطاً", async () => {
    const d = db();
    // «مقلمة» تحوي «قلم» متصلةً وسط الكلمة (م-قلم-ة) — بخلاف جمع التكسير «أقلام»
    await d.insert(s.products).values({ id: 5, name: "مقلمة مدرسية" });
    await d.insert(s.productVariants).values({ id: 5, productId: 5, sku: "PENCASE", costPrice: "0.00" });
    await d.insert(s.productUnits).values({ id: 5, variantId: 5, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true });
    const rows = await listForPos(1, "RETAIL", "قلم");
    const idxStart = names(rows).indexOf("قلم جاف أزرق فاخر");
    const idxMid = names(rows).indexOf("مقلمة مدرسية");
    expect(idxStart).toBeGreaterThanOrEqual(0);
    expect(idxMid).toBeGreaterThanOrEqual(0);
    expect(idxStart).toBeLessThan(idxMid);
  });

  it("تطابق الباركود التام يتصدّر", async () => {
    const rows = await listForPos(1, "RETAIL", "6291041500220");
    expect(rows[0]?.productName).toBe("دفتر مدرسي ٩٦ ورقة");
  });
});

describe("البحث الذكي — أمان الأنماط وحواف", () => {
  it("«%» لا يطابق كل شيء (تهريب LIKE) — فقط من يحويها حرفياً", async () => {
    const rows = await listForPos(1, "RETAIL", "%");
    expect(names(rows)).toEqual(["علبة أقلام 100%"]);
  });

  it("«100%» يجد المنتج الذي يحوي النسبة حرفياً", async () => {
    const rows = await listForPos(1, "RETAIL", "100%");
    expect(names(rows)).toEqual(["علبة أقلام 100%"]);
  });

  it("استعلام فارغ/مسافات يعيد القائمة الكاملة (سلوك التصفّح)", async () => {
    const rows = await listForPos(1, "RETAIL", "   ");
    expect(rows.length).toBeGreaterThanOrEqual(4);
  });

  it("جانب الشراء يستعمل نفس الذكاء: «ازرق» يجد «أزرق»", async () => {
    const rows = await listForPurchase(1, "ازرق");
    expect(rows.map((r) => r.productName)).toContain("قلم جاف أزرق فاخر");
  });

  it("lookupByBarcode يقصّ الفراغات الطرفية (لصق/ماسحات تذيّل بمسافة)", async () => {
    const row = await lookupByBarcode(" 6291041500213 ", 1, "RETAIL");
    expect(row?.productName).toBe("قلم جاف أزرق فاخر");
  });
});
