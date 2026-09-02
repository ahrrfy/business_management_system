/**
 * صور البكجات في المتجر: مراجع لصور المكوّنات، لا ملفات مولّدة أو base64 منسوخ.
 * الصورة الخاصة للبكج تتقدّم دائماً؛ وPENDING/REJECTED لا يدخلان العرض العام.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { storefrontCatalog, storefrontProduct } from "../storefrontService";
import { truncateTables } from "./__testUtils__";

const JPEG_DATA_URL = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64")}`;

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

async function seedBundle() {
  const d = db();
  await d.insert(s.products).values([
    { id: 1, name: "قلم أزرق", showInStore: true },
    { id: 2, name: "دفتر", showInStore: true },
    { id: 3, name: "بكج مدرسي", showInStore: true, isBundle: true },
  ]);
  await d.insert(s.productVariants).values([
    { id: 1, productId: 1, sku: "PEN-BLUE" },
    { id: 2, productId: 2, sku: "NOTEBOOK" },
    { id: 3, productId: 3, sku: "SCHOOL-BUNDLE" },
  ]);
  await d.insert(s.productUnits).values([
    { id: 1, variantId: 1, unitName: "قطعة", isBaseUnit: true, isStoreSaleUnit: true },
    { id: 2, variantId: 2, unitName: "قطعة", isBaseUnit: true, isStoreSaleUnit: true },
    { id: 3, variantId: 3, unitName: "بكج", isBaseUnit: true, isStoreSaleUnit: true },
  ]);
  await d.insert(s.productPrices).values([
    { productUnitId: 1, priceTier: "RETAIL", price: "1000" },
    { productUnitId: 2, priceTier: "RETAIL", price: "2000" },
    { productUnitId: 3, priceTier: "RETAIL", price: "2500" },
  ]);
  await d.insert(s.branchStock).values([
    { branchId: 1, variantId: 1, quantity: 10 },
    { branchId: 1, variantId: 2, quantity: 10 },
  ]);
  await d.insert(s.bundleComponents).values([
    { bundleVariantId: 3, componentVariantId: 1, componentBaseQuantity: 1, sortOrder: 0 },
    { bundleVariantId: 3, componentVariantId: 2, componentBaseQuantity: 1, sortOrder: 1 },
  ]);
}

beforeEach(async () => {
  await truncateTables([
    "bundleComponents", "branchStock", "productImages", "productPrices", "productUnits", "productVariants", "products", "branches",
  ]);
  await db().insert(s.branches).values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
});

describe("storefront bundle component media", () => {
  it("يرجع حتى أربع صور مكوّنات معتمدة بالمرجع ويستعمل أولها fallback للصورة", async () => {
    await seedBundle();
    await db().insert(s.productImages).values([
      // صورة مستوى المنتج للمكوّن الأول.
      { id: 11, productId: 1, url: JPEG_DATA_URL, isPrimary: true, reviewStatus: "APPROVED" },
      // صورة متغير المنتج الثاني تتقدم على أي صورة مستوى منتج له.
      { id: 12, productId: 2, variantId: 2, url: "/media/notebook-blue.webp", isPrimary: false, reviewStatus: "APPROVED" },
      // لا يجوز تسريب المرشح غير المعتمد حتى لو كان للمكوّن.
      { id: 13, productId: 2, variantId: 2, url: "/media/pending.webp", isPrimary: false, sortOrder: 1, reviewStatus: "PENDING_REVIEW" },
    ]);

    const detail = await storefrontProduct(3, 1);
    expect(detail?.bundleImageUrls).toHaveLength(2);
    expect(detail?.bundleImageUrls?.[0]).toMatch(/^\/api\/img\/product\/11\?v=[0-9a-f]{16}&w=320$/);
    expect(detail?.bundleImageUrls?.[1]).toBe("/media/notebook-blue.webp");
    expect(detail?.bundleImageUrls).not.toContain("/media/pending.webp");
    expect(detail?.imageUrl).toBe(detail?.bundleImageUrls?.[0]);
    expect(await db().select().from(s.productImages).where(eq(s.productImages.productId, 3))).toHaveLength(0);

    const card = (await storefrontCatalog({ branchId: 1, limit: 20 })).items.find((item) => item.productId === 3);
    expect(card?.bundleImageUrls).toEqual(detail?.bundleImageUrls);
    expect(card?.imageUrl).toBe(detail?.imageUrl);
  });

  it("الصورة التسويقية الخاصة للبكج تتقدّم ولا تُنشأ صور مكوّنات مكرّرة", async () => {
    await seedBundle();
    await db().insert(s.productImages).values([
      { id: 21, productId: 1, url: "/media/pen.webp", isPrimary: true, reviewStatus: "APPROVED" },
      { id: 22, productId: 2, url: "/media/notebook.webp", isPrimary: true, reviewStatus: "APPROVED" },
      { id: 23, productId: 3, url: "/media/school-bundle-campaign.webp", isPrimary: true, reviewStatus: "APPROVED" },
    ]);

    const detail = await storefrontProduct(3, 1);
    expect(detail?.imageUrl).toBe("/media/school-bundle-campaign.webp");
    expect(detail?.bundleImageUrls).toBeUndefined();
    // لم يكتب المسار صفاً جديداً أو ملفاً مكرّراً للبكج.
    const bundleImageRows = await db().select().from(s.productImages).where(eq(s.productImages.productId, 3));
    expect(bundleImageRows).toHaveLength(1);
  });

  it("صورة بكج غير معتمدة لا تتقدّم على صور مكوّناته المنشورة", async () => {
    await seedBundle();
    await db().insert(s.productImages).values([
      { id: 31, productId: 1, url: "/media/pen.webp", isPrimary: true, reviewStatus: "APPROVED" },
      { id: 32, productId: 3, url: "/media/unreviewed-campaign.webp", isPrimary: true, reviewStatus: "PENDING_REVIEW" },
    ]);
    const detail = await storefrontProduct(3, 1);
    expect(detail?.imageUrl).toBe("/media/pen.webp");
    expect(detail?.bundleImageUrls).toEqual(["/media/pen.webp"]);
  });
});
