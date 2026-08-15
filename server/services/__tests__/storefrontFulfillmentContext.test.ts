import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { setBranchActive } from "../branchService";
import {
  getPublicStoreSettings,
  updateStoreSettings,
} from "../storeAdmin/storeSettingsService";
import { loadStorefrontReadiness } from "../storeAdmin/storefrontReadinessService";
import {
  resolveStorefrontBranchId,
  storefrontCatalog,
} from "../storefrontService";
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
  await d
    .insert(s.users)
    .values({ id: 1, openId: "store-context-owner", role: "admin" });
  await d
    .insert(s.products)
    .values({ id: 1, name: "Store item", showInStore: true });
  await d
    .insert(s.productVariants)
    .values({ id: 1, productId: 1, sku: "STORE-CONTEXT-1", costPrice: "1.00" });
  await d.insert(s.productUnits).values({
    id: 1,
    variantId: 1,
    unitName: "piece",
    isBaseUnit: true,
    isStoreSaleUnit: true,
  });
  await d
    .insert(s.productPrices)
    .values({ productUnitId: 1, priceTier: "RETAIL", price: "1000.00" });
  await d.insert(s.branchStock).values([
    { variantId: 1, branchId: 1, quantity: 50 },
    { variantId: 1, branchId: 2, quantity: 0 },
  ]);
});

describe("storefront fulfillment context", () => {
  it("يرفض غياب المرجع الصريح ولا يسقط إلى MAIN أو أول فرع", async () => {
    await expect(resolveStorefrontBranchId()).rejects.toThrow(
      /لم يُعيَّن فرع تسليم/,
    );
  });

  it("يرفض فتح المتجر إذا كان الفرع بلا منتج جاهز ويرجع المعاملة كاملة", async () => {
    await expect(
      updateStoreSettings({ fulfillmentBranchId: 2, isOpen: true }, 1),
    ).rejects.toThrow(/لا يوجد منتج واحد جاهز/);
    expect(await db().select().from(s.storeSettings)).toHaveLength(0);
  });

  it("يوحّد الكتالوج العام والإعدادات على الفرع المعيّن ويمنع تعطيله", async () => {
    await db()
      .update(s.branchStock)
      .set({ quantity: 5 })
      .where(eq(s.branchStock.branchId, 2));
    const settings = await updateStoreSettings(
      { fulfillmentBranchId: 2, isOpen: true },
      1,
    );
    expect(settings).toMatchObject({
      fulfillmentBranchId: 2,
      fulfillmentBranchActive: true,
      isOpen: true,
    });
    expect(await resolveStorefrontBranchId()).toBe(2);
    expect(
      (await storefrontCatalog({ limit: 10 })).items.map(
        (item) => item.productId,
      ),
    ).toEqual([1]);
    expect(await getPublicStoreSettings()).toMatchObject({
      isOpen: true,
      fulfillmentBranchId: 2,
      fulfillmentBranchName: "Store fulfillment",
      configurationReady: true,
    });

    await expect(
      setBranchActive(2, false, { userId: 1, branchId: 1 }),
    ).rejects.toThrow(/فرع تسليم المتجر/);
    const branch = (
      await db().select().from(s.branches).where(eq(s.branches.id, 2))
    )[0];
    expect(branch?.isActive).toBe(true);
  });

  it("لا يعلن المتجر مفتوحاً للعامة إن أصبحت التهيئة غير تشغيلية", async () => {
    await db()
      .insert(s.storeSettings)
      .values({ id: 1, fulfillmentBranchId: 2, isOpen: true });
    await db()
      .update(s.branches)
      .set({ isActive: false })
      .where(eq(s.branches.id, 2));
    expect(await getPublicStoreSettings()).toMatchObject({
      isOpen: false,
      fulfillmentBranchId: 2,
      fulfillmentBranchActive: false,
      configurationReady: false,
    });
  });

  it("يفتح على بكج جاهز مشتق من مكوّناته ويرفضه حين تستهلك الحجوزات ATP", async () => {
    const d = db();
    await d
      .update(s.products)
      .set({ showInStore: false })
      .where(eq(s.products.id, 1));
    await d
      .update(s.branchStock)
      .set({ quantity: 4 })
      .where(eq(s.branchStock.branchId, 2));
    await d
      .insert(s.products)
      .values({
        id: 2,
        name: "Store bundle",
        showInStore: true,
        isBundle: true,
      });
    await d
      .insert(s.productVariants)
      .values({ id: 2, productId: 2, sku: "STORE-BUNDLE", costPrice: "1.00" });
    await d
      .insert(s.productUnits)
      .values({
        id: 2,
        variantId: 2,
        unitName: "bundle",
        isBaseUnit: true,
        isStoreSaleUnit: true,
      });
    await d
      .insert(s.productPrices)
      .values({ productUnitId: 2, priceTier: "RETAIL", price: "3000.00" });
    await d
      .insert(s.bundleComponents)
      .values({
        bundleVariantId: 2,
        componentVariantId: 1,
        componentBaseQuantity: 2,
      });

    await expect(
      updateStoreSettings({ fulfillmentBranchId: 2, isOpen: true }, 1),
    ).resolves.toMatchObject({ isOpen: true });
    expect(
      (await storefrontCatalog({ limit: 10 })).items.map(
        (item) => item.productId,
      ),
    ).toEqual([2]);
    expect(
      (await loadStorefrontReadiness({ branchId: 2, productIds: [2] })).get(2)
        ?.inStock,
    ).toBe(true);

    await d
      .insert(s.customers)
      .values({ id: 1, name: "Bundle customer", phone: "+9647701234567" });
    await d.insert(s.onlineOrders).values({
      id: 1,
      orderNumber: "ORD-BUNDLE-ACTIVE",
      customerId: 1,
      branchId: 2,
      subtotal: "6000.00",
      total: "6000.00",
      status: "PENDING",
    });
    await d.insert(s.onlineOrderItems).values({
      onlineOrderId: 1,
      variantId: 2,
      productUnitId: 2,
      quantity: "2.000",
      baseQuantity: 2,
      unitPrice: "3000.00",
      total: "6000.00",
    });
    expect(await getPublicStoreSettings()).toMatchObject({
      isOpen: false,
      configurationReady: false,
    });
    expect((await storefrontCatalog({ limit: 10 })).items).toHaveLength(0);
    expect(
      (await loadStorefrontReadiness({ branchId: 2, productIds: [2] })).get(2)
        ?.inStock,
    ).toBe(false);

    await d
      .update(s.onlineOrders)
      .set({ status: "CANCELLED" })
      .where(eq(s.onlineOrders.id, 1));
    expect(await getPublicStoreSettings()).toMatchObject({
      isOpen: true,
      configurationReady: true,
    });
    expect(
      (await storefrontCatalog({ limit: 10 })).items.map(
        (item) => item.productId,
      ),
    ).toEqual([2]);

    await d
      .insert(s.reservationStock)
      .values({ variantId: 1, branchId: 2, reservedBase: 4 });
    expect(await getPublicStoreSettings()).toMatchObject({
      isOpen: false,
      configurationReady: false,
    });
    await updateStoreSettings({ isOpen: false }, 1);
    await expect(updateStoreSettings({ isOpen: true }, 1)).rejects.toThrow(
      /لا يوجد منتج واحد جاهز/,
    );
    expect((await storefrontCatalog({ limit: 10 })).items).toHaveLength(0);
    expect(
      (await loadStorefrontReadiness({ branchId: 2, productIds: [2] })).get(2)
        ?.inStock,
    ).toBe(false);
  });

  it("يخفض الجاهزية العامة ديناميكياً عند إخفاء المنتج أو فئته أو نفاد ATP", async () => {
    const d = db();
    await d
      .insert(s.categories)
      .values({
        id: 1,
        name: "Store category",
        isActive: true,
        showInStore: true,
      });
    await d
      .update(s.products)
      .set({ categoryId: 1 })
      .where(eq(s.products.id, 1));
    await d
      .update(s.branchStock)
      .set({ quantity: 5 })
      .where(eq(s.branchStock.branchId, 2));
    await updateStoreSettings({ fulfillmentBranchId: 2, isOpen: true }, 1);
    await expect(getPublicStoreSettings()).resolves.toMatchObject({
      isOpen: true,
      configurationReady: true,
    });

    await d
      .update(s.products)
      .set({ showInStore: false })
      .where(eq(s.products.id, 1));
    await expect(getPublicStoreSettings()).resolves.toMatchObject({
      isOpen: false,
      configurationReady: false,
    });
    await d
      .update(s.products)
      .set({ showInStore: true })
      .where(eq(s.products.id, 1));
    await expect(getPublicStoreSettings()).resolves.toMatchObject({
      isOpen: true,
      configurationReady: true,
    });

    await d
      .update(s.categories)
      .set({ showInStore: false })
      .where(eq(s.categories.id, 1));
    await expect(getPublicStoreSettings()).resolves.toMatchObject({
      isOpen: false,
      configurationReady: false,
    });
    expect((await storefrontCatalog({ limit: 10 })).items).toHaveLength(0);
    await d
      .update(s.categories)
      .set({ showInStore: true })
      .where(eq(s.categories.id, 1));

    await d
      .insert(s.reservationStock)
      .values({ variantId: 1, branchId: 2, reservedBase: 5 });
    await expect(getPublicStoreSettings()).resolves.toMatchObject({
      isOpen: false,
      configurationReady: false,
    });
  });

  it("يفحص readiness على دفعات ضيقة ولا يفقد منتجاً جاهزاً بعد الدفعة الأولى", async () => {
    const d = db();
    await d
      .update(s.products)
      .set({ showInStore: false })
      .where(eq(s.products.id, 1));
    const count = 270;
    const productRows = Array.from({ length: count }, (_, index) => ({
      id: 1000 + index,
      name: `Catalog ${index}`,
      showInStore: true,
    }));
    const variantRows = productRows.map((product, index) => ({
      id: 1000 + index,
      productId: product.id,
      sku: `CAT-${index}`,
      costPrice: "1.00",
    }));
    const unitRows = variantRows.map((variant, index) => ({
      id: 1000 + index,
      variantId: variant.id,
      unitName: "piece",
      conversionFactor: "1",
      isBaseUnit: true,
      isStoreSaleUnit: true,
    }));
    await d.insert(s.products).values(productRows);
    await d.insert(s.productVariants).values(variantRows);
    await d.insert(s.productUnits).values(unitRows);
    await d.insert(s.productPrices).values(
      unitRows.map((unit) => ({
        productUnitId: unit.id,
        priceTier: "RETAIL" as const,
        price: "1000.00",
      })),
    );
    const lastVariantId = variantRows.at(-1)!.id;
    await d
      .insert(s.branchStock)
      .values({ variantId: lastVariantId, branchId: 2, quantity: 1 });

    await expect(
      updateStoreSettings({ fulfillmentBranchId: 2, isOpen: true }, 1),
    ).resolves.toMatchObject({ isOpen: true, configurationReady: true });
  });

  it("لا يمزج قراءة فتح قديمة مع فرع جديد أثناء تبديل الإعدادات المتزامن", async () => {
    const d = db();
    await d
      .update(s.branchStock)
      .set({ quantity: 5 })
      .where(eq(s.branchStock.branchId, 2));
    await d
      .insert(s.storeSettings)
      .values({ id: 1, fulfillmentBranchId: 1, isOpen: true });

    const switchSettings = async () => {
      for (let index = 0; index < 30; index += 1) {
        const stateA = index % 2 === 0;
        await d
          .update(s.storeSettings)
          .set({ fulfillmentBranchId: stateA ? 1 : 2, isOpen: stateA })
          .where(eq(s.storeSettings.id, 1));
      }
    };
    const readSnapshots = Promise.all(
      Array.from({ length: 30 }, async () => {
        await Promise.resolve();
        return getPublicStoreSettings();
      }),
    );
    const [, snapshots] = await Promise.all([switchSettings(), readSnapshots]);

    for (const snapshot of snapshots) {
      expect(snapshot.configurationReady).toBe(true);
      // الحالتان الذريتان الوحيدتان: A مفتوح على MAIN أو B مغلق على STORE.
      expect(["1:true", "2:false"]).toContain(
        `${snapshot.fulfillmentBranchId}:${snapshot.isOpen}`,
      );
    }
  });
});
