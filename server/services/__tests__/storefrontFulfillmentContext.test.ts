import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { setBranchActive } from "../branchService";
import { getPublicStoreSettings, updateStoreSettings } from "../storeAdmin/storeSettingsService";
import { resolveStorefrontBranchId, storefrontCatalog } from "../storefrontService";
import { truncateAllTables } from "./__testUtils__";

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

beforeEach(async () => {
  await truncateAllTables();
  const d = db();
  await d.insert(s.branches).values([
    { id: 1, name: "Main", code: "MAIN", type: "MAIN" },
    { id: 2, name: "Store fulfillment", code: "STORE", type: "SALES" },
  ]);
  await d.insert(s.users).values({ id: 1, openId: "store-context-owner", role: "admin" });
  await d.insert(s.products).values({ id: 1, name: "Store item", showInStore: true });
  await d.insert(s.productVariants).values({ id: 1, productId: 1, sku: "STORE-CONTEXT-1", costPrice: "1.00" });
  await d.insert(s.productUnits).values({
    id: 1,
    variantId: 1,
    unitName: "piece",
    isBaseUnit: true,
    isStoreSaleUnit: true,
  });
  await d.insert(s.productPrices).values({ productUnitId: 1, priceTier: "RETAIL", price: "1000.00" });
  await d.insert(s.branchStock).values([
    { variantId: 1, branchId: 1, quantity: 50 },
    { variantId: 1, branchId: 2, quantity: 0 },
  ]);
});

describe("storefront fulfillment context", () => {
  it("يرفض غياب المرجع الصريح ولا يسقط إلى MAIN أو أول فرع", async () => {
    await expect(resolveStorefrontBranchId()).rejects.toThrow(/لم يُعيَّن فرع تسليم/);
  });

  it("يرفض فتح المتجر إذا كان الفرع بلا منتج جاهز ويرجع المعاملة كاملة", async () => {
    await expect(updateStoreSettings({ fulfillmentBranchId: 2, isOpen: true }, 1))
      .rejects.toThrow(/لا يوجد منتج واحد جاهز/);
    expect(await db().select().from(s.storeSettings)).toHaveLength(0);
  });

  it("يوحّد الكتالوج العام والإعدادات على الفرع المعيّن ويمنع تعطيله", async () => {
    await db().update(s.branchStock).set({ quantity: 5 }).where(eq(s.branchStock.branchId, 2));
    const settings = await updateStoreSettings({ fulfillmentBranchId: 2, isOpen: true }, 1);
    expect(settings).toMatchObject({ fulfillmentBranchId: 2, fulfillmentBranchActive: true, isOpen: true });
    expect(await resolveStorefrontBranchId()).toBe(2);
    expect((await storefrontCatalog({ limit: 10 })).items.map((item) => item.productId)).toEqual([1]);
    expect(await getPublicStoreSettings()).toMatchObject({
      isOpen: true,
      fulfillmentBranchId: 2,
      fulfillmentBranchName: "Store fulfillment",
      configurationReady: true,
    });

    await expect(setBranchActive(2, false, { userId: 1, branchId: 1 }))
      .rejects.toThrow(/فرع تسليم المتجر/);
    const branch = (await db().select().from(s.branches).where(eq(s.branches.id, 2)))[0];
    expect(branch?.isActive).toBe(true);
  });

  it("لا يعلن المتجر مفتوحاً للعامة إن أصبحت التهيئة غير تشغيلية", async () => {
    await db().insert(s.storeSettings).values({ id: 1, fulfillmentBranchId: 2, isOpen: true });
    await db().update(s.branches).set({ isActive: false }).where(eq(s.branches.id, 2));
    expect(await getPublicStoreSettings()).toMatchObject({
      isOpen: false,
      fulfillmentBranchId: 2,
      fulfillmentBranchActive: false,
      configurationReady: false,
    });
  });
});
