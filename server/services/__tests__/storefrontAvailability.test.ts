import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { storefrontCatalog, storefrontCategories, storefrontProduct } from "../storefrontService";
import { truncateTables } from "./__testUtils__";

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

beforeEach(async () => {
  await truncateTables([
    "invoiceItems", "onlineOrderItems", "onlineOrders", "customers", "reservationStock", "bundleComponents", "branchStock", "productImages", "productPrices", "productUnits", "productVariants", "products", "categories", "branches",
  ]);
  const d = db();
  await d.insert(s.branches).values({ id: 1, name: "Main", code: "MAIN", type: "MAIN" });
  await d.insert(s.categories).values([
    { id: 1, name: "Available" },
    { id: 2, name: "Out of stock" },
    { id: 3, name: "Hidden" },
  ]);
  await d.insert(s.products).values([
    { id: 1, name: "Available item", categoryId: 1, showInStore: true },
    { id: 2, name: "Out of stock item", categoryId: 2, showInStore: true },
    { id: 3, name: "Hidden item", categoryId: 3, showInStore: false },
  ]);
  await d.insert(s.productVariants).values([
    { id: 1, productId: 1, sku: "AVAILABLE", costPrice: "1.00" },
    { id: 2, productId: 2, sku: "OUT", costPrice: "1.00" },
    { id: 3, productId: 3, sku: "HIDDEN", costPrice: "1.00" },
  ]);
  await d.insert(s.productUnits).values([
    { id: 1, variantId: 1, unitName: "piece", isBaseUnit: true, isStoreSaleUnit: true },
    { id: 2, variantId: 2, unitName: "piece", isBaseUnit: true, isStoreSaleUnit: true },
    { id: 3, variantId: 3, unitName: "piece", isBaseUnit: true, isStoreSaleUnit: true },
  ]);
  await d.insert(s.productPrices).values([
    { productUnitId: 1, priceTier: "RETAIL", price: "1000.00" },
    { productUnitId: 2, priceTier: "RETAIL", price: "1000.00" },
    { productUnitId: 3, priceTier: "RETAIL", price: "1000.00" },
  ]);
  await d.insert(s.branchStock).values([
    { variantId: 1, branchId: 1, quantity: 3 },
    { variantId: 2, branchId: 1, quantity: 0 },
    { variantId: 3, branchId: 1, quantity: 3 },
  ]);
});

describe("storefront availability", () => {
  it("يبقي IN_STOCK افتراضياً ويعيد الفئات المنشورة حتى لو كان المتاح فيها صفراً", async () => {
    const catalog = await storefrontCatalog({ branchId: 1, limit: 20 });
    expect(catalog.items.map((item) => item.productId)).toEqual([1]);
    expect(catalog.items[0]?.inStock).toBe(true);

    const categories = await storefrontCategories(1);
    expect(categories).toEqual([
      { id: 1, name: "Available", productCount: 1, availableCount: 1 },
      { id: 2, name: "Out of stock", productCount: 1, availableCount: 0 },
    ]);
  });

  it("ALL يعيد المنشور النافد صراحةً ولا يعيد المنتج المخفي", async () => {
    const catalog = await storefrontCatalog({ branchId: 1, availability: "ALL", limit: 20 });
    expect(catalog.items.map((item) => [item.productId, item.inStock])).toEqual([
      [1, true],
      [2, false],
    ]);
  });

  it("keeps an out-of-stock direct product explicit and non-purchasable", async () => {
    const product = await storefrontProduct(2, 1);
    expect(product?.inStock).toBe(false);
  });

  it("separates the inventory base unit from the units sold in the store", async () => {
    const d = db();
    await d.update(s.productUnits).set({ isStoreSaleUnit: false }).where(eq(s.productUnits.id, 1));
    await d.insert(s.productUnits).values([
      { id: 20, variantId: 1, unitName: "ream", conversionFactor: "500", isStoreSaleUnit: true },
      { id: 21, variantId: 1, unitName: "carton", conversionFactor: "2500", isStoreSaleUnit: true },
    ]);
    await d.insert(s.productPrices).values([
      { productUnitId: 20, priceTier: "RETAIL", price: "5000.00" },
      { productUnitId: 21, priceTier: "RETAIL", price: "24000.00" },
    ]);
    await d.update(s.branchStock).set({ quantity: 1000 }).where(eq(s.branchStock.variantId, 1));

    const product = await storefrontProduct(1, 1);
    expect(product?.unitName).toBe("ream");
    expect(product?.storeUnits?.map((u) => [u.unitName, u.inStock])).toEqual([
      ["ream", true],
      ["carton", false],
    ]);
    expect(product?.storeUnits?.some((u) => u.unitName === "piece")).toBe(false);
  });

  it("يقيس التوفّر مقابل معامل وحدة البيع لا مقابل stock > 0", async () => {
    const d = db();
    await d.update(s.productUnits).set({ conversionFactor: "12" }).where(eq(s.productUnits.id, 1));
    await d.update(s.branchStock).set({ quantity: 1 }).where(eq(s.branchStock.variantId, 1));

    expect((await storefrontCatalog({ branchId: 1 })).items).toHaveLength(0);
    const all = await storefrontCatalog({ branchId: 1, availability: "ALL" });
    expect(all.items.find((item) => item.productId === 1)?.inStock).toBe(false);
    expect((await storefrontCategories(1)).find((category) => category.id === 1)?.availableCount).toBe(0);
  });

  it("يطرح الحجز النشط من ATP في الكتالوج والتفاصيل والفئات", async () => {
    await db().insert(s.reservationStock).values({ variantId: 1, branchId: 1, reservedBase: 3 });

    expect((await storefrontCatalog({ branchId: 1 })).items).toHaveLength(0);
    expect((await storefrontCatalog({ branchId: 1, availability: "ALL" })).items.find((item) => item.productId === 1)?.inStock).toBe(false);
    expect((await storefrontProduct(1, 1))?.inStock).toBe(false);
    expect((await storefrontCategories(1)).find((category) => category.id === 1)?.availableCount).toBe(0);
  });

  it("يطبق limit على المنتجات بعد تجميع متغيراتها ووحداتها لا على صفوف SQL الخام", async () => {
    const d = db();
    const extraUnits = Array.from({ length: 10 }, (_, index) => ({
      id: 30 + index,
      variantId: 1,
      unitName: `unit-${index}`,
      conversionFactor: String(index + 1),
      isStoreSaleUnit: true,
    }));
    await d.insert(s.productUnits).values(extraUnits);
    await d.insert(s.productPrices).values(extraUnits.map((unit) => ({
      productUnitId: unit.id,
      priceTier: "RETAIL" as const,
      price: "1000.00",
    })));
    await d.insert(s.products).values({ id: 5, name: "Second ready product", categoryId: 1, showInStore: true });
    await d.insert(s.productVariants).values({ id: 5, productId: 5, sku: "SECOND-READY", costPrice: "1.00" });
    await d.insert(s.productUnits).values({ id: 5, variantId: 5, unitName: "piece", isBaseUnit: true, isStoreSaleUnit: true });
    await d.insert(s.productPrices).values({ productUnitId: 5, priceTier: "RETAIL", price: "1000.00" });
    await d.insert(s.branchStock).values({ variantId: 5, branchId: 1, quantity: 2 });

    expect((await storefrontCatalog({ branchId: 1, limit: 2 })).items.map((item) => item.productId)).toEqual([1, 5]);
  });

  it("يعيد الصفحات كلها بمؤشر استكمال بلا تكرار أو اقتطاع صامت", async () => {
    const d = db();
    await d.insert(s.products).values([
      { id: 4, name: "Second catalog item", categoryId: 1, showInStore: true },
      { id: 5, name: "Third catalog item", categoryId: 1, showInStore: true },
    ]);
    await d.insert(s.productVariants).values([
      { id: 4, productId: 4, sku: "CATALOG-2", costPrice: "1.00" },
      { id: 5, productId: 5, sku: "CATALOG-3", costPrice: "1.00" },
    ]);
    await d.insert(s.productUnits).values([
      { id: 4, variantId: 4, unitName: "piece", isBaseUnit: true, isStoreSaleUnit: true },
      { id: 5, variantId: 5, unitName: "piece", isBaseUnit: true, isStoreSaleUnit: true },
    ]);
    await d.insert(s.productPrices).values([
      { productUnitId: 4, priceTier: "RETAIL", price: "1000.00" },
      { productUnitId: 5, priceTier: "RETAIL", price: "1000.00" },
    ]);
    await d.insert(s.branchStock).values([
      { variantId: 4, branchId: 1, quantity: 3 },
      { variantId: 5, branchId: 1, quantity: 3 },
    ]);

    const first = await storefrontCatalog({ branchId: 1, limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBe(first.items[1]?.productId);

    const second = await storefrontCatalog({ branchId: 1, limit: 2, cursor: first.nextCursor });
    expect(second.hasMore).toBe(false);
    expect(second.nextCursor).toBeNull();
    expect(second.items).toHaveLength(1);

    const allIds = [...first.items, ...second.items].map((item) => item.productId);
    expect(new Set(allIds).size).toBe(3);
    expect([...allIds].sort((a, b) => a - b)).toEqual([1, 4, 5]);
  });

  it("يختار بطاقة variant×unit حتمياً عند تعادل التوفّر والمعامل", async () => {
    const d = db();
    await d.insert(s.productVariants).values({ id: 9, productId: 1, sku: "AVAILABLE-SECOND", color: "أزرق", costPrice: "1.00" });
    await d.insert(s.productUnits).values({ id: 9, variantId: 9, unitName: "piece-2", conversionFactor: "1", isBaseUnit: true, isStoreSaleUnit: true });
    await d.insert(s.productPrices).values({ productUnitId: 9, priceTier: "RETAIL", price: "2000.00" });
    await d.insert(s.branchStock).values({ variantId: 9, branchId: 1, quantity: 3 });

    const samples = await Promise.all(Array.from({ length: 8 }, () => storefrontCatalog({ branchId: 1, limit: 1 })));
    expect(samples.map((sample) => sample.items[0]?.productUnitId)).toEqual(Array(8).fill(1));
    expect(samples.map((sample) => sample.items[0]?.price)).toEqual(Array(8).fill("1000.00"));
  });

  it("يكسر تعادل اختيار products عند cap بمعرّف ثابت", async () => {
    const d = db();
    await d.update(s.products).set({ name: "Same" }).where(eq(s.products.id, 1));
    await d.update(s.products).set({ name: "Same" }).where(eq(s.products.id, 2));
    await d.update(s.branchStock).set({ quantity: 3 }).where(eq(s.branchStock.variantId, 2));
    const ids = [];
    for (let i = 0; i < 8; i += 1) ids.push((await storefrontCatalog({ branchId: 1, limit: 1 })).items[0]?.productId);
    expect(ids).toEqual(Array(8).fill(1));
  });

  it("يشتق توفر البكج من ATP مكوّناته بلا branchStock ذاتي ولا طرح حجز البكج مرتين", async () => {
    const d = db();
    await d.insert(s.products).values({ id: 20, name: "Bundle", categoryId: 1, showInStore: true, isBundle: true });
    await d.insert(s.productVariants).values({ id: 20, productId: 20, sku: "BUNDLE-20", costPrice: "1.00" });
    await d.insert(s.productUnits).values({ id: 20, variantId: 20, unitName: "bundle", isBaseUnit: true, isStoreSaleUnit: true });
    await d.insert(s.productPrices).values({ productUnitId: 20, priceTier: "RETAIL", price: "2500.00" });
    await d.insert(s.bundleComponents).values({ bundleVariantId: 20, componentVariantId: 1, componentBaseQuantity: 2 });

    expect((await storefrontProduct(20, 1))?.inStock).toBe(true);
    expect((await storefrontCatalog({ branchId: 1 })).items.some((item) => item.productId === 20)).toBe(true);

    await d.insert(s.reservationStock).values([
      { variantId: 1, branchId: 1, reservedBase: 2 },
      // صف legacy للبكج نفسه يجب تجاهله تماماً؛ الحجز الرسمي يمنعه.
      { variantId: 20, branchId: 1, reservedBase: 99 },
    ]);
    expect((await storefrontProduct(20, 1))?.inStock).toBe(false);
    expect((await storefrontCatalog({ branchId: 1 })).items.some((item) => item.productId === 20)).toBe(false);
  });
});

describe("storefront color swatches", () => {
  // منتج بلونين: أحمر (بقياسين، أحدهما متوفّر) وأزرق (نافد كلّياً) — يختبر عرض النافد + تجميع التوفّر.
  beforeEach(async () => {
    const d = db();
    await d.insert(s.products).values({ id: 4, name: "Colored item", categoryId: 1, showInStore: true });
    await d.insert(s.productVariants).values([
      { id: 10, productId: 4, sku: "C-RED-S", color: "أحمر", size: "S", costPrice: "1.00" },
      { id: 11, productId: 4, sku: "C-RED-L", color: "أحمر", size: "L", costPrice: "1.00" },
      { id: 12, productId: 4, sku: "C-BLU", color: "أزرق", size: "M", costPrice: "1.00" },
    ]);
    await d.insert(s.productUnits).values([
      { id: 10, variantId: 10, unitName: "piece", isBaseUnit: true, isStoreSaleUnit: true },
      { id: 11, variantId: 11, unitName: "piece", isBaseUnit: true, isStoreSaleUnit: true },
      { id: 12, variantId: 12, unitName: "piece", isBaseUnit: true, isStoreSaleUnit: true },
    ]);
    await d.insert(s.productPrices).values([
      { productUnitId: 10, priceTier: "RETAIL", price: "1000.00" },
      { productUnitId: 11, priceTier: "RETAIL", price: "1000.00" },
      { productUnitId: 12, priceTier: "RETAIL", price: "1000.00" },
    ]);
    await d.insert(s.branchStock).values([
      { variantId: 10, branchId: 1, quantity: 0 }, // أحمر (قياس S) نافد
      { variantId: 11, branchId: 1, quantity: 5 }, // أحمر (قياس L) متوفّر ⇒ اللون أحمر متوفّر (تجميع)
      { variantId: 12, branchId: 1, quantity: 0 }, // أزرق نافد بكل متغيّراته
    ]);
  });

  it("يعرض كل الألوان (بما فيها النافدة) بتوفّرٍ مُجمَّع لكل لون", async () => {
    const product = await storefrontProduct(4, 1);
    const colors = product?.colors ?? [];
    // اللونان معروضان — النافد لا يُخفى (قرار المالك: إظهار الألوان النافدة).
    expect([...colors.map((c) => c.name)].sort()).toEqual(["أحمر", "أزرق"].sort());
    // أحمر متوفّر عبر أحد قياساته (تجميع OR)؛ أزرق نافد لكنه معروض.
    expect(colors.find((c) => c.name === "أحمر")?.inStock).toBe(true);
    expect(colors.find((c) => c.name === "أزرق")?.inStock).toBe(false);
    // الخيارات ليست مجرد نقاط لونية: كل متغير يعيد وحدة البيع والمخزون الخاصين به.
    // الخيار المتاح يتقدّم كي لا تختار بطاقة المنتج متغيّراً نافداً بينما بديلٌ متاح.
    expect(product?.variants?.map((v) => [v.color, v.size, v.inStock])).toEqual([
      ["أحمر", "L", true], ["أحمر", "S", false], ["أزرق", "M", false],
    ]);
    expect(product?.variants?.find((v) => v.size === "L")?.units[0]?.productUnitId).toBe(11);
  });
});
