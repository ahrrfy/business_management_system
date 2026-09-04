import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { listProductsAdmin } from "../catalog/adminList";
import { listForPos } from "../catalog/pos";
import { listForPurchase } from "../catalog/purchase";
import { countPriceWaveScope } from "../priceWaveService";
import { storefrontCatalog } from "../storefrontService";
import { withTx } from "../tx";
import { truncateTables } from "./__testUtils__";

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

beforeEach(async () => {
  await truncateTables([
    "reservationStock",
    "branchStock",
    "productUnitBarcodes",
    "productPrices",
    "productUnits",
    "productVariants",
    "products",
    "branches",
  ]);

  const d = db();
  await d
    .insert(s.branches)
    .values({ id: 1, name: "MAIN", code: "MAIN", type: "MAIN" });
  await d.insert(s.products).values([
    { id: 4600, name: "دفتر المورد الحقيقي", showInStore: true },
    {
      id: 4601,
      name: "1 0095 نتيجة اسم مشتتة",
      showInStore: true,
      isFeatured: true,
    },
    {
      id: 4602,
      name: "SUP 0095 نتيجة اسم مشتتة",
      showInStore: true,
      isFeatured: true,
    },
    {
      id: 4603,
      name: "036000291452 نتيجة اسم مشتتة",
      showInStore: true,
      isFeatured: true,
    },
  ]);
  await d.insert(s.productVariants).values([
    { id: 4700, productId: 4600, sku: "SUPPLIER-REAL", costPrice: "1.00" },
    { id: 4701, productId: 4601, sku: "DISTRACTOR-SPACES", costPrice: "1.00" },
    { id: 4702, productId: 4602, sku: "DISTRACTOR-ALIAS", costPrice: "1.00" },
    { id: 4703, productId: 4603, sku: "DISTRACTOR-UPC", costPrice: "1.00" },
  ]);
  await d.insert(s.productUnits).values([
    {
      id: 5827,
      variantId: 4700,
      unitName: "قطعة",
      conversionFactor: "1",
      isBaseUnit: true,
      isStoreSaleUnit: true,
      barcode: "1  0095",
    },
    {
      id: 5828,
      variantId: 4700,
      unitName: "علبة",
      conversionFactor: "10",
      isStoreSaleUnit: true,
      barcode: "0036000291452",
    },
    {
      id: 5829,
      variantId: 4701,
      unitName: "قطعة",
      conversionFactor: "1",
      isBaseUnit: true,
      isStoreSaleUnit: true,
    },
    {
      id: 5830,
      variantId: 4702,
      unitName: "قطعة",
      conversionFactor: "1",
      isBaseUnit: true,
      isStoreSaleUnit: true,
    },
    {
      id: 5831,
      variantId: 4703,
      unitName: "قطعة",
      conversionFactor: "1",
      isBaseUnit: true,
      isStoreSaleUnit: true,
    },
  ]);
  await d
    .insert(s.productUnitBarcodes)
    .values({ productUnitId: 5827, barcode: "\u200fSUP  0095\t" });
  await d.insert(s.productPrices).values([
    { productUnitId: 5827, priceTier: "RETAIL", price: "1000.00" },
    { productUnitId: 5828, priceTier: "RETAIL", price: "9000.00" },
    { productUnitId: 5829, priceTier: "RETAIL", price: "1000.00" },
    { productUnitId: 5830, priceTier: "RETAIL", price: "1000.00" },
    { productUnitId: 5831, priceTier: "RETAIL", price: "1000.00" },
  ]);
  await d.insert(s.branchStock).values([
    { branchId: 1, variantId: 4700, quantity: "100" },
    { branchId: 1, variantId: 4701, quantity: "100" },
    { branchId: 1, variantId: 4702, quantity: "100" },
    { branchId: 1, variantId: 4703, quantity: "100" },
  ]);
});

describe("إغلاق بحث باركود المورد عبر مستهلكي الكتالوج", () => {
  for (const [label, query, expectedUnitId] of [
    ["مسافتان داخليتان", "1  0095", 5827],
    ["باركود بديل موروث بتنسيق ومسافتين", "SUP  0095", 5827],
    ["UPC-A مقابل EAN-13 محفوظ", "036000291452", 5828],
  ] as const) {
    it(`${label}: يتقدم المالك الحقيقي ولا تدخل نتيجة الاسم المشتتة`, async () => {
      const pos = await listForPos(1, "RETAIL", query, 20);
      expect(pos.map((row) => Number(row.productUnitId))).toEqual([
        expectedUnitId,
      ]);

      const purchase = await listForPurchase(1, query, 20);
      expect(purchase.map((row) => Number(row.productUnitId))).toEqual([
        expectedUnitId,
      ]);

      const admin = await listProductsAdmin({
        branchId: 1,
        q: query,
        limit: 20,
      });
      expect(admin.rows.map((row) => Number(row.productUnitId))).toEqual([
        expectedUnitId,
      ]);

      const waveScope = await withTx((tx) =>
        countPriceWaveScope(tx, {
          scope: "FILTERED",
          productSearch: query,
        }),
      );
      expect(waveScope).toMatchObject({ products: 1, priceRows: 1 });

      const storefront = await storefrontCatalog({
        branchId: 1,
        search: query,
        limit: 20,
      });
      expect(storefront.items.map((item) => item.productId)).toEqual([4600]);
    });
  }
});
