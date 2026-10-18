import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { storefrontSearchSuggestions } from "../storefrontSearchService";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { storefrontCatalog } from "../storefrontService";
import { truncateTables } from "./__testUtils__";

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

beforeEach(async () => {
  await truncateTables([
    "storeSettings", "invoiceItems", "onlineOrderItems", "onlineOrders", "customers", "reservationStock",
    "bundleComponents", "branchStock", "productImages", "productPrices", "productUnits",
    "productVariants", "products", "categories", "branches",
  ]);

  const d = db();
  await d.insert(s.branches).values({ id: 1, name: "Main Branch", code: "MAIN", type: "MAIN" });
  await d.insert(s.storeSettings).values({ id: 1, fulfillmentBranchId: 1 });
  await d.insert(s.categories).values([
    { id: 1, name: "كتب مدرسية" },
    { id: 2, name: "قرطاسية ودفاتر" },
  ]);

  // منتجات لاختبار البحث متعدد الكلمات، تطبيع الأرقام، وتطبيع الحروف، والمخزون
  await d.insert(s.products).values([
    // 1: كتاب احياء متميزين (متوفر)
    { id: 1, name: "كتاب أحياء أول متوسط متميزين", categoryId: 1, showInStore: true, brand: "دار المنهج" },
    // 2: كتاب كيمياء متميزين (متوفر)
    { id: 2, name: "كتاب كيمياء أول متوسط متميزين", categoryId: 1, showInStore: true, brand: "دار المنهج" },
    // 3: دفتر أرقام هندية/مشرقية ١٠٠ ورقة (متوفر)
    { id: 3, name: "دفتر مدرسي ١٠٠ ورقة", categoryId: 2, showInStore: true, brand: "روكو" },
    // 4: دفتر أرقام قياسية 200 ورقة (متوفر)
    { id: 4, name: "دفتر سلك 200 ورقة", categoryId: 2, showInStore: true, brand: "روكو" },
    // 5: كتاب احياء متقدم (نافد من المخزون)
    { id: 5, name: "كتاب أحياء للمتميزين متقدم", categoryId: 1, showInStore: true, brand: "الرواد" },
    // 6: منتج بتاء مربوطة ومستشفى بألف مقصورة
    { id: 6, name: "حقيبة إسعاف مستشفى الأمل", categoryId: 2, showInStore: true, brand: "الهلال" },
  ]);

  await d.insert(s.productVariants).values([
    { id: 1, productId: 1, sku: "BIO-1", costPrice: "5.00" },
    { id: 2, productId: 2, sku: "CHEM-1", costPrice: "5.00" },
    { id: 3, productId: 3, sku: "NOTE-100", costPrice: "1.00" },
    { id: 4, productId: 4, sku: "NOTE-200", costPrice: "2.00" },
    { id: 5, productId: 5, sku: "BIO-OOS", costPrice: "5.00" },
    { id: 6, productId: 6, sku: "MED-1", costPrice: "10.00" },
  ]);

  await d.insert(s.productUnits).values([
    { id: 1, variantId: 1, unitName: "نسخة", isBaseUnit: true, isStoreSaleUnit: true, barcode: "9781001" },
    { id: 2, variantId: 2, unitName: "نسخة", isBaseUnit: true, isStoreSaleUnit: true, barcode: "9781002" },
    { id: 3, variantId: 3, unitName: "دفتر", isBaseUnit: true, isStoreSaleUnit: true, barcode: "6921003" },
    { id: 4, variantId: 4, unitName: "دفتر", isBaseUnit: true, isStoreSaleUnit: true, barcode: "6921004" },
    { id: 5, variantId: 5, unitName: "نسخة", isBaseUnit: true, isStoreSaleUnit: true, barcode: "9781005" },
    { id: 6, variantId: 6, unitName: "حقيبة", isBaseUnit: true, isStoreSaleUnit: true, barcode: "8801006" },
  ]);

  await d.insert(s.productPrices).values([
    { productUnitId: 1, priceTier: "RETAIL", price: "7500.00" },
    { productUnitId: 2, priceTier: "RETAIL", price: "7500.00" },
    { productUnitId: 3, priceTier: "RETAIL", price: "1500.00" },
    { productUnitId: 4, priceTier: "RETAIL", price: "2500.00" },
    { productUnitId: 5, priceTier: "RETAIL", price: "8000.00" },
    { productUnitId: 6, priceTier: "RETAIL", price: "20000.00" },
  ]);

  // ضبط الكميات: منتج 5 نافد (0)، البقية متوفرة (>0)
  await d.insert(s.branchStock).values([
    { variantId: 1, branchId: 1, quantity: 10 },
    { variantId: 2, branchId: 1, quantity: 10 },
    { variantId: 3, branchId: 1, quantity: 15 },
    { variantId: 4, branchId: 1, quantity: 15 },
    { variantId: 5, branchId: 1, quantity: 0 }, // Out of stock
    { variantId: 6, branchId: 1, quantity: 5 },
  ]);
});

describe("Storefront live MySQL catalog search & normalization (R1, R2, R3, R4)", () => {
  it("matches multi-word tokens in any order (R1)", async () => {
    // بحث «احياء متميزين» أو «متميزين احياء»
    const r1 = await storefrontCatalog({ branchId: 1, search: "احياء متميزين", availability: "ALL" });
    const ids1 = r1.items.map((i) => i.productId);
    expect(ids1).toContain(1);
    expect(ids1).not.toContain(2); // كيمياء لا تحتوي احياء

    const r2 = await storefrontCatalog({ branchId: 1, search: "متميزين احياء", availability: "ALL" });
    const ids2 = r2.items.map((i) => i.productId);
    expect(ids2).toContain(1);
    expect(ids2).not.toContain(2);

    // بحث «متميزين اول» يطابق 1 و 2
    const r3 = await storefrontCatalog({ branchId: 1, search: "متميزين اول", availability: "ALL" });
    const ids3 = r3.items.map((i) => i.productId);
    expect(ids3).toContain(1);
    expect(ids3).toContain(2);
  });

  it("normalizes digits bidirectionally (Eastern Arabic ١٠٠ matches Western 100 and vice versa) (R1)", async () => {
    // المنتج 3 اسمه فيه «١٠٠» — نبحث عنه بـ «100»
    const r1 = await storefrontCatalog({ branchId: 1, search: "دفتر 100", availability: "ALL" });
    expect(r1.items.map((i) => i.productId)).toContain(3);

    // المنتج 4 اسمه فيه «200» — نبحث عنه بـ «٢٠٠»
    const r2 = await storefrontCatalog({ branchId: 1, search: "دفتر ٢٠٠", availability: "ALL" });
    expect(r2.items.map((i) => i.productId)).toContain(4);
  });

  it("normalizes Arabic letters (alef variants, taa marbuta/haa, alif maqsura/yaa) (R1)", async () => {
    // منتج 1 اسمه «أحياء» مع همزة — نبحث عنه بلا همزة «احياء»
    const r1 = await storefrontCatalog({ branchId: 1, search: "احياء", availability: "ALL" });
    expect(r1.items.map((i) => i.productId)).toContain(1);

    // منتج 6 فيه «مستشفى» بألف مقصورة و «إسعاف» — نبحث بـ «مستشفي اسعاف»
    const r2 = await storefrontCatalog({ branchId: 1, search: "مستشفي اسعاف", availability: "ALL" });
    expect(r2.items.map((i) => i.productId)).toContain(6);

    // تاء مربوطة وهاء: منتج 6 فيه «حقيبة» — نبحث بـ «حقيبه»
    const r3 = await storefrontCatalog({ branchId: 1, search: "حقيبه", availability: "ALL" });
    expect(r3.items.map((i) => i.productId)).toContain(6);
  });

  it("supports partial word prefix matching (R1)", async () => {
    // «متميز» جزء من «متميزين»
    const r = await storefrontCatalog({ branchId: 1, search: "احياء متميز", availability: "ALL" });
    expect(r.items.map((i) => i.productId)).toContain(1);
  });

  it("prioritizes in-stock items over out-of-stock items in ranking (R3)", async () => {
    // منتج 1 متوفر في المخزون (qty: 10)، منتج 5 نافد (qty: 0) وكلاهما يطابق «احياء متميزين»
    const r = await storefrontCatalog({ branchId: 1, search: "احياء متميزين", availability: "ALL" });
    expect(r.items.length).toBeGreaterThanOrEqual(2);
    // المتوفر (1) يجب أن يسبق غير المتوفر (5) في الترتيب
    const idx1 = r.items.findIndex((i) => i.productId === 1);
    const idx5 = r.items.findIndex((i) => i.productId === 5);
    expect(idx1).toBeLessThan(idx5);
  });

  it("filters out out-of-stock items when availability is IN_STOCK (R4)", async () => {
    const r = await storefrontCatalog({ branchId: 1, search: "احياء متميزين", availability: "IN_STOCK" });
    const ids = r.items.map((i) => i.productId);
    expect(ids).toContain(1);
    expect(ids).not.toContain(5); // نافد
  });

  it("preserves category filters alongside search query (R4)", async () => {
    // فئة 1 هي كتب مدرسية، فئة 2 هي قرطاسية
    // بحث «روكو» في فئة 1 يجب ألا يعيد شيئاً
    const r1 = await storefrontCatalog({ branchId: 1, categoryId: 1, search: "روكو", availability: "ALL" });
    expect(r1.items).toHaveLength(0);

    // بحث «روكو» في فئة 2 يعيد دفاتر روكو
    const r2 = await storefrontCatalog({ branchId: 1, categoryId: 2, search: "روكو", availability: "ALL" });
    expect(r2.items.map((i) => i.productId)).toContain(3);
    expect(r2.items.map((i) => i.productId)).toContain(4);
  });

  it("returns 0 results for non-alphanumeric punctuation search (R2 consistency)", async () => {
    const r = await storefrontCatalog({ branchId: 1, search: "???", availability: "ALL" });
    expect(r.items).toHaveLength(0);

    const r2 = await storefrontCatalog({ branchId: 1, search: "!@#$", availability: "ALL" });
    expect(r2.items).toHaveLength(0);
  });
});


describe("full catalog public suggestions and recovery", () => {
  async function product(id: number, name: string, options: { stock?: number; show?: boolean; active?: boolean; price?: string; categoryId?: number; brand?: string } = {}) {
    const d = db();
    await d.insert(s.products).values({ id, name, categoryId: options.categoryId ?? 1, showInStore: options.show ?? true, isActive: options.active ?? true, brand: options.brand ?? "دار المنهج" });
    await d.insert(s.productVariants).values({ id, productId: id, sku: `SEARCH-${id}`, costPrice: "1.00" });
    await d.insert(s.productUnits).values({ id, variantId: id, unitName: "قطعة", isBaseUnit: true, isStoreSaleUnit: true, barcode: `SEARCH-UNIT-${id}` });
    await d.insert(s.productPrices).values({ productUnitId: id, priceTier: "RETAIL", price: options.price ?? "8000.00" });
    await d.insert(s.branchStock).values({ variantId: id, branchId: 1, quantity: options.stock ?? 10 });
  }
  it("finds simple workbook keys across the full catalog, agrees with submitted results and returns only safe fields", async () => {
    await product(70, "ملزمة ثالث بكر سامي انكليزي 2027");
    for (const query of ["مل", "ملزمه", "انكليزي ثالث", "ملازم ثالث", "ثالث ٢٠٢٧"]) {
      const suggestions = await storefrontSearchSuggestions({ query });
      const catalog = await storefrontCatalog({ branchId: 1, search: query });
      expect(suggestions.products.map((p) => p.productId), query).toContain(70);
      expect(catalog.items.map((p) => p.productId), query).toContain(70);
      expect(Object.keys(suggestions.products.find((p) => p.productId === 70)!)).toEqual(["productId", "productName", "brand", "categoryId", "category", "price", "salePrice", "inStock"]);
    }
    const first = await storefrontCatalog({ branchId: 1, limit: 1 });
    expect(first.items.map((p) => p.productId)).not.toContain(70);
  });
  it("maps highlighter phrases to the published product without conflating generic markers", async () => {
    await product(71, "باكيت هايلايت 4 لون CHOSCH H954");
    for (const query of ["هايلايتر", "قلم تأشير"]) {
      expect((await storefrontSearchSuggestions({ query })).products.map((p) => p.productId)).toContain(71);
      expect((await storefrontCatalog({ branchId: 1, search: query })).items.map((p) => p.productId)).toContain(71);
    }
    expect((await storefrontSearchSuggestions({ query: "ماركر" })).products).toEqual([]);
  });
  it("offers explicit one-word correction and separates approximate products from direct matches", async () => {
    await product(70, "ملزمة ثالث بكر سامي انكليزي 2027");
    const suggestions = await storefrontSearchSuggestions({ query: "انكليوي ثالث" });
    expect(suggestions.products).toEqual([]);
    expect(suggestions.correction).toBe("انكليزي ثالث");
    expect(suggestions.similar.map((p) => p.productId)).toEqual([70]);
    expect((await storefrontCatalog({ branchId: 1, search: "انكليوي ثالث" })).items).toEqual([]);
    for (const query of ["ملزمة 2028", "H955", "سيارة فضائية", "%_!"]) {
      const response = await storefrontSearchSuggestions({ query });
      expect(response.products, query).toEqual([]); expect(response.similar, query).toEqual([]); expect(response.correction, query).toBeNull();
    }
  });
  it("obeys publication, active state, category, availability, brand and price scope", async () => {
    await product(70, "ملزمة ثالث انكليزي", { categoryId: 1 });
    await product(71, "ملزمة ثالث مخفية", { show: false });
    await product(72, "ملزمة ثالث معطلة", { active: false });
    await product(73, "ملزمة ثالث نافدة", { stock: 0 });
    await product(74, "ملزمة ثالث غالية", { price: "20000.00", categoryId: 2, brand: "دار أخرى" });
    const base = await storefrontSearchSuggestions({ query: "ملزمة ثالث" });
    expect(base.products.map((p) => p.productId).sort((a, b) => a - b)).toEqual([70, 74]);
    const all = await storefrontSearchSuggestions({ query: "ملزمة ثالث", availability: "ALL" });
    expect(all.products.map((p) => p.productId)).toContain(73);
    expect(all.products.map((p) => p.productId)).not.toContain(71); expect(all.products.map((p) => p.productId)).not.toContain(72);
    expect((await storefrontSearchSuggestions({ query: "ملزمة", categoryId: 2 })).products.map((p) => p.productId)).toEqual([74]);
    expect((await storefrontSearchSuggestions({ query: "ملزمة", brand: "دار أخرى" })).products.map((p) => p.productId)).toEqual([74]);
    expect((await storefrontSearchSuggestions({ query: "ملزمة", priceFilter: "FROM_5000_TO_15000" })).products.map((p) => p.productId)).toEqual([70]);
    expect((await storefrontSearchSuggestions({ query: "ملزمة", productIds: [] })).products).toEqual([]);
    await db().update(s.categories).set({ showInStore: false }).where(eq(s.categories.id, 1));
    expect((await storefrontSearchSuggestions({ query: "ملزمة", categoryId: 1 })).products).toEqual([]);
  });
  it("searches category terms even when absent from the product title", async () => {
    await product(70, "صنف خاص", { categoryId: 2 });
    const response = await storefrontSearchSuggestions({ query: "قرطاسية" });
    expect(response.products.map((p) => p.productId)).toContain(70);
    expect(response.categories).toContainEqual({ id: 2, name: "قرطاسية ودفاتر" });
    expect((await storefrontCatalog({ branchId: 1, search: "قرطاسية" })).items.map((p) => p.productId)).toContain(70);
  });
  it("filters unavailable candidates before limiting even beyond 192 higher-ranked matches", async () => {
    const d = db(); const ids = Array.from({ length: 200 }, (_, i) => i + 100);
    await d.insert(s.products).values(ids.map((id) => ({ id, name: "ملزمة", categoryId: 1, showInStore: true })));
    await d.insert(s.productVariants).values(ids.map((id) => ({ id, productId: id, sku: `MANY-${id}`, costPrice: "1.00" })));
    await d.insert(s.productUnits).values(ids.map((id) => ({ id, variantId: id, unitName: "قطعة", isBaseUnit: true, isStoreSaleUnit: true })));
    await d.insert(s.productPrices).values(ids.map((id) => ({ productUnitId: id, priceTier: "RETAIL" as const, price: "1000.00" })));
    await product(500, "ملزمة ثالث بكر سامي انكليزي 2027");
    expect((await storefrontSearchSuggestions({ query: "ملزمة" })).products.map((p) => p.productId)).toEqual([500]);
  });
  it("uses promotion-adjusted prices before applying a price refinement", async () => {
    await product(71, "باكيت هايلايت 4 لون", { price: "6000.00" });
    await db().insert(s.promotions).values({ name: "خصم الاختبار", type: "PERCENT", discountPercent: "25", scope: "ALL", effectiveFrom: "2020-01-01", effectiveTo: "2099-12-31", customerTier: "RETAIL", isActive: true });
    const response = await storefrontSearchSuggestions({ query: "هايلايتر", priceFilter: "UNDER_5000" });
    expect(response.products.map((p) => p.productId)).toEqual([71]); expect(response.products[0].salePrice).toBe("4500.00");
  });
  it("keeps exact hits before available synonym products with ALL availability", async () => {
    await product(70, "هايلايتر", { stock: 0 }); await product(71, "هايلايت", { stock: 10 });
    const response = await storefrontSearchSuggestions({ query: "هايلايتر", availability: "ALL" });
    expect(response.products.map((p) => p.productId)).toEqual([70, 71]);
    const catalog = await storefrontCatalog({ branchId: 1, search: "هايلايتر", availability: "ALL" });
    expect(catalog.items.map((p) => p.productId)).toEqual([70, 71]);
  });
});
