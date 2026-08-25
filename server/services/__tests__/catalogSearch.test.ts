// اختبارات البحث الذكي في الكتالوج — تطبيع عربي + كلمات مستقلة + ترتيب بالملاءمة + تهريب الأنماط.
// تعمل على قاعدة الاختبار الحقيقية (MySQL) لأن جوهر التطبيع REPLACE يُنفَّذ في SQL.
import { sql } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { listForPos, listForPurchase, lookupByBarcode } from "../catalogService";
import { ensureProductSearchNormFixture } from "./__searchNormFixture__";

function db() { const d = getDb(); if (!d) throw new Error("DATABASE_URL not set"); return d; }

async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of ["branchStock", "productPrices", "productUnitBarcodes", "productUnits", "productVariants", "products", "branches"]) {
    await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  }
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
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
  await d.insert(s.productUnitBarcodes).values({
    id: 20,
    productUnitId: 2,
    barcode: "ALT-NB-96",
  });
  await d.insert(s.productPrices).values([
    { productUnitId: 1, priceTier: "RETAIL", price: "500.00" },
    { productUnitId: 2, priceTier: "RETAIL", price: "750.00" },
    { productUnitId: 3, priceTier: "RETAIL", price: "15000.00" },
    { productUnitId: 4, priceTier: "RETAIL", price: "3000.00" },
  ]);
}

beforeAll(ensureProductSearchNormFixture);
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

  it("الباركود البديل يتصدّر أي تطابق نصّي عَرَضي في البيع والشراء", async () => {
    await db().insert(s.products).values({ id: 6, name: "ALT-NB-96 منتج مشتّت" });
    await db().insert(s.productVariants).values({ id: 6, productId: 6, sku: "DISTRACTOR", costPrice: "0.00" });
    await db().insert(s.productUnits).values({
      id: 6,
      variantId: 6,
      unitName: "قطعة",
      conversionFactor: "1",
      isBaseUnit: true,
    });
    await db().insert(s.productPrices).values({ productUnitId: 6, priceTier: "RETAIL", price: "1.00" });

    expect((await listForPos(1, "RETAIL", "ALT-NB-96"))[0]?.productName).toBe("دفتر مدرسي ٩٦ ورقة");
    expect((await listForPurchase(1, "ALT-NB-96"))[0]?.productName).toBe("دفتر مدرسي ٩٦ ورقة");
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

  it("جانب الشراء يعرض ناتج الطباعة المخزني ويستبعد خدمة الطباعة غير المخزنية", async () => {
    const d = db();
    await d.insert(s.products).values([
      { id: 10, name: "كروت توريد جاهزة", productType: "PRINT_SERVICE", isService: false },
      { id: 11, name: "خدمة توريد إلكترونية", productType: "PRINT_SERVICE", isService: true },
    ]);
    await d.insert(s.productVariants).values([
      { id: 10, productId: 10, sku: "PRINT-STOCK", costPrice: "1000.00" },
      { id: 11, productId: 11, sku: "PRINT-NONSTOCK", costPrice: "0.00" },
    ]);
    await d.insert(s.productUnits).values([
      { id: 10, variantId: 10, unitName: "دفعة", conversionFactor: "1", isBaseUnit: true },
      { id: 11, variantId: 11, unitName: "خدمة", conversionFactor: "1", isBaseUnit: true },
    ]);

    const rows = await listForPurchase(1, "توريد");
    expect(rows.map((r) => r.productName)).toContain("كروت توريد جاهزة");
    expect(rows.map((r) => r.productName)).not.toContain("خدمة توريد إلكترونية");
  });

  it("lookupByBarcode يقصّ الفراغات الطرفية (لصق/ماسحات تذيّل بمسافة)", async () => {
    const row = await lookupByBarcode(" 6291041500213 ", 1, "RETAIL");
    expect(row?.productName).toBe("قلم جاف أزرق فاخر");
  });
});

// «التكلفة الصفريّة» (٣٠/٧): كانت PosRow بلا حقل تكلفة ⇒ ProductSearchBar يُثبِّت "0" ⇒ عمود
// «التكلفة» في SalesInvoiceNew يظهر 0 دائماً حتى للمدير. الخدمة تحمل التكلفة الآن؛ الحجب
// خارجيّ في الراوتر (redactPosCost) عبر canSeeCostForUser.
describe("حمْل التكلفة في PosRow (شاشة المبيعات المتقدّمة)", () => {
  it("listForPos يعيد costPriceBase من productVariants.costPrice", async () => {
    const d = db();
    await d.execute(sql`UPDATE productVariants SET costPrice = '350.00' WHERE id = 1`);
    const rows = await listForPos(1, "RETAIL", "ازرق");
    const pen = rows.find((r) => r.productName === "قلم جاف أزرق فاخر");
    expect(pen).toBeDefined();
    expect(pen!.costPriceBase).toBe("350.00");
  });

  it("lookupByBarcode يعيد costPriceBase أيضاً", async () => {
    const d = db();
    await d.execute(sql`UPDATE productVariants SET costPrice = '420.00' WHERE id = 2`);
    const row = await lookupByBarcode("6291041500220", 1, "RETAIL");
    expect(row).not.toBeNull();
    expect(row!.costPriceBase).toBe("420.00");
  });
});
