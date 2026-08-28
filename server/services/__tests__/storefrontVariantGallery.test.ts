import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { storefrontCartRecommendations, storefrontProduct, storefrontRelated } from "../storefrontService";
import { truncateTables } from "./__testUtils__";

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

beforeEach(async () => {
  await truncateTables([
    "productRelatedProducts",
    "productImages",
    "productPrices",
    "productUnits",
    "branchStock",
    "productVariants",
    "products",
    "branches",
  ]);

  const d = db();
  await d.insert(s.branches).values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await d.insert(s.products).values([
    { id: 1, name: "دفتر", isActive: true, showInStore: true },
    { id: 2, name: "قلم", isActive: true, showInStore: true },
  ]);
  await d.insert(s.productVariants).values([
    {
      id: 11,
      productId: 1,
      sku: "NOTE-RED",
      variantName: "أحمر",
      color: "أحمر",
      isActive: true,
    },
    {
      id: 12,
      productId: 1,
      sku: "NOTE-BLUE",
      variantName: "أزرق",
      color: "أزرق",
      isActive: true,
    },
    {
      id: 13,
      productId: 2,
      sku: "PEN-BLACK",
      variantName: "أسود",
      color: "أسود",
      isActive: true,
    },
  ]);
  await d.insert(s.productUnits).values([
    {
      id: 21,
      variantId: 11,
      unitName: "قطعة",
      conversionFactor: "1",
      isBaseUnit: true,
      isStoreSaleUnit: true,
      isActive: true,
    },
    {
      id: 22,
      variantId: 12,
      unitName: "قطعة",
      conversionFactor: "1",
      isBaseUnit: true,
      isStoreSaleUnit: true,
      isActive: true,
    },
    {
      id: 23,
      variantId: 13,
      unitName: "قطعة",
      conversionFactor: "1",
      isBaseUnit: true,
      isStoreSaleUnit: true,
      isActive: true,
    },
  ]);
  await d.insert(s.productPrices).values([
    { productUnitId: 21, priceTier: "RETAIL", price: "1000" },
    { productUnitId: 22, priceTier: "RETAIL", price: "1000" },
    { productUnitId: 23, priceTier: "RETAIL", price: "500" },
  ]);
  await d.insert(s.branchStock).values([
    { branchId: 1, variantId: 11, quantity: 5 },
    { branchId: 1, variantId: 12, quantity: 5 },
    { branchId: 1, variantId: 13, quantity: 5 },
  ]);
  await d.insert(s.productImages).values([
    {
      id: 101,
      productId: 1,
      variantId: null,
      url: "/media/product.webp",
      isPrimary: true,
      sortOrder: 1,
      reviewStatus: "APPROVED",
    },
    {
      id: 102,
      productId: 1,
      variantId: 11,
      url: "/media/red-primary.webp",
      isPrimary: true,
      sortOrder: 1,
      reviewStatus: "APPROVED",
    },
    {
      id: 103,
      productId: 1,
      variantId: 11,
      url: "/media/red-side.webp",
      isPrimary: false,
      sortOrder: 2,
      reviewStatus: "APPROVED",
    },
    {
      id: 104,
      productId: 1,
      variantId: 12,
      url: "/media/blue-primary.webp",
      isPrimary: true,
      sortOrder: 1,
      reviewStatus: "APPROVED",
    },
    {
      id: 105,
      productId: 1,
      variantId: 12,
      url: "/media/blue-rejected.webp",
      isPrimary: false,
      sortOrder: 2,
      reviewStatus: "REJECTED",
    },
    {
      id: 106,
      productId: 2,
      variantId: 13,
      url: "/media/pen-black.webp",
      isPrimary: true,
      sortOrder: 1,
      reviewStatus: "APPROVED",
    },
  ]);
  await d.insert(s.productRelatedProducts).values({
    sourceProductId: 1,
    relatedProductId: 2,
    relationType: "COMPATIBLE",
    sortOrder: 1,
    isActive: true,
  });
});

describe("storefrontProduct — معرض الصور حسب البديل", () => {
  it("يجمع صور كل بديل أولاً ثم صور المنتج العامة بلا مضاعفة وحدات البيع", async () => {
    const product = await storefrontProduct(1, 1);
    expect(product).not.toBeNull();

    const variants = new Map(product!.variants!.map((variant) => [variant.variantId, variant]));
    expect(variants.get(11)?.imageUrls).toEqual(["/media/red-primary.webp", "/media/red-side.webp", "/media/product.webp"]);
    expect(variants.get(11)?.imageUrl).toBe("/media/red-primary.webp");
    expect(variants.get(11)?.units).toHaveLength(1);

    expect(variants.get(12)?.imageUrls).toEqual(["/media/blue-primary.webp", "/media/product.webp"]);
    expect(variants.get(12)?.imageUrl).toBe("/media/blue-primary.webp");
    expect(variants.get(12)?.units).toHaveLength(1);

    expect(product?.variantId).toBe(11);
    expect(product?.imageUrls).toEqual(variants.get(11)?.imageUrls);
    expect(product?.imageUrl).toBe("/media/red-primary.webp");
  });

  it("يرطب صور توصيات السلة والمنتجات ذات الصلة بعد حسم الصفوف", async () => {
    const [cartRecommendations, related] = await Promise.all([
      storefrontCartRecommendations([1], 1),
      storefrontRelated(1, 1),
    ]);

    expect(cartRecommendations.find((item) => item.productId === 2)?.imageUrl).toBe("/media/pen-black.webp");
    expect(related.find((item) => item.productId === 2)?.imageUrl).toBe("/media/pen-black.webp");
  });
});
