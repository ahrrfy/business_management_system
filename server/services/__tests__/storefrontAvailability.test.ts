import { beforeEach, describe, expect, it } from "vitest";
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
    { id: 1, variantId: 1, unitName: "piece", isBaseUnit: true },
    { id: 2, variantId: 2, unitName: "piece", isBaseUnit: true },
    { id: 3, variantId: 3, unitName: "piece", isBaseUnit: true },
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
});
