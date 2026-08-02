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
    "invoiceItems", "branchStock", "productImages", "productPrices", "productUnits", "productVariants", "products", "categories", "branches",
  ]);
  const d = db();
  await d.insert(s.branches).values({ id: 1, name: "Main", code: "MAIN", type: "MAIN" });
  await d.insert(s.categories).values([{ id: 1, name: "Available" }, { id: 2, name: "Hidden" }]);
  await d.insert(s.products).values([
    { id: 1, name: "Available item", categoryId: 1, showInStore: true },
    { id: 2, name: "Out of stock item", categoryId: 1, showInStore: true },
    { id: 3, name: "Hidden item", categoryId: 2, showInStore: false },
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
  it("lists only in-stock, store-visible products and categories", async () => {
    const catalog = await storefrontCatalog({ branchId: 1, limit: 20 });
    expect(catalog.items.map((item) => item.productId)).toEqual([1]);
    expect(catalog.items[0]?.inStock).toBe(true);

    const categories = await storefrontCategories(1);
    expect(categories.map((category) => category.id)).toEqual([1]);
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
    expect(product?.variants?.map((v) => [v.color, v.size, v.inStock])).toEqual([
      ["أحمر", "S", false], ["أحمر", "L", true], ["أزرق", "M", false],
    ]);
    expect(product?.variants?.find((v) => v.size === "L")?.units[0]?.productUnitId).toBe(11);
  });
});
