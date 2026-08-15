import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { appRouter } from "../../routers";

const TABLES = [
  "auditLogs",
  "promotionTargets",
  "promotions",
  "stockAdjustmentRequests",
  "productImages",
  "productVariants",
  "products",
  "categories",
  "storeBanners",
  "storeSettings",
  "users",
  "branches",
];

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

async function reset() {
  const connection = db();
  await connection.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const table of TABLES) await connection.execute(sql.raw(`TRUNCATE TABLE \`${table}\``));
  await connection.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

async function seed() {
  await db().insert(s.branches).values([
    { id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "المبيعات", code: "SALES", type: "SALES" },
  ]);
  await db().insert(s.users).values([
    { id: 1, openId: "store-admin", name: "الأدمن", role: "admin", branchId: 1 },
    { id: 2, openId: "sales-manager", name: "مدير المبيعات", role: "manager", branchId: 2 },
    { id: 3, openId: "main-manager", name: "مدير الرئيسي", role: "manager", branchId: 1 },
  ]);
  await db().insert(s.storeSettings).values({
    id: 1,
    isOpen: false,
    fulfillmentBranchId: 1,
    updatedBy: 1,
  });
  await db().insert(s.categories).values({ id: 1, name: "قرطاسية", showInStore: true });
  await db().insert(s.products).values({ id: 1, name: "دفتر", categoryId: 1, showInStore: true, isFeatured: false });
  await db().insert(s.productVariants).values({ id: 1, productId: 1, sku: "STORE-SCOPE-1", costPrice: "1.00" });
}

function context(user: s.User) {
  return {
    req: { headers: {} },
    res: { cookie() {}, clearCookie() {} },
    user,
    sessionId: null,
    platformAdmin: null,
  } as any;
}

async function user(id: number) {
  return (await db().select().from(s.users).where(eq(s.users.id, id)).limit(1))[0];
}

beforeEach(async () => {
  await reset();
  await seed();
});

describe("عزل إدارة متجر MAIN عن مدير SALES", () => {
  it("يمنع قراءة الرصيد الدقيق وطلب تسوية، بلا إنشاء طلب", async () => {
    const caller = appRouter.createCaller(context(await user(2)));
    await expect(caller.storeAdmin.catalog.list({ limit: 20, offset: 0 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      caller.storeAdmin.catalog.setStock({ variantId: 1, targetQuantity: 10 }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await db().select().from(s.stockAdjustmentRequests)).toHaveLength(0);
  });

  it("يمنع فتح/إغلاق المتجر أو تغيير فرع تنفيذه", async () => {
    const caller = appRouter.createCaller(context(await user(2)));
    await expect(caller.storeAdmin.settings.update({ isOpen: false })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      caller.storeAdmin.settings.update({ fulfillmentBranchId: 2 }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const [settings] = await db().select().from(s.storeSettings).where(eq(s.storeSettings.id, 1));
    expect(Number(settings.fulfillmentBranchId)).toBe(1);
    expect(settings.isOpen).toBe(false);
  });

  it("يمنع إنشاء أو تعطيل عروض فرع التنفيذ العالمي", async () => {
    const caller = appRouter.createCaller(context(await user(2)));
    await expect(caller.storeAdmin.promotions.create({
      name: "عرض غير مخوّل",
      type: "PERCENT",
      discountPercent: "10",
      scope: "ALL",
      effectiveFrom: "2026-08-15",
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      caller.storeAdmin.promotions.deactivate({ promotionId: 999 }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await db().select().from(s.promotions)).toHaveLength(0);
  });

  it("الحارس المركزي يمنع تغيير البنرات والفئات وظهور/صورة/تمييز المنتجات", async () => {
    const caller = appRouter.createCaller(context(await user(2)));
    await expect(caller.storeAdmin.banners.create({ title: "بنر غير مخوّل" }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller.storeAdmin.categories.setVisibility({ id: 1, showInStore: false }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller.storeAdmin.catalog.setVisible({ productId: 1, showInStore: false }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller.storeAdmin.catalog.setFeatured({ productId: 1, isFeatured: true }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller.storeAdmin.catalog.setImage({ productId: 1, url: null }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(await db().select().from(s.storeBanners)).toHaveLength(0);
    expect(await db().select().from(s.productImages)).toHaveLength(0);
    const [category] = await db().select().from(s.categories).where(eq(s.categories.id, 1));
    const [product] = await db().select().from(s.products).where(eq(s.products.id, 1));
    expect(category.showInStore).toBe(true);
    expect(product).toMatchObject({ showInStore: true, isFeatured: false });
  });

  it("يلغي TOCTOU جذرياً: حتى مدير fulfillment الحالي لا يعدّل السطح العام أثناء تبديل المالك للفرع", async () => {
    const manager = appRouter.createCaller(context(await user(3)));
    const owner = appRouter.createCaller(context(await user(1)));
    const [managerResult, ownerResult] = await Promise.allSettled([
      manager.storeAdmin.settings.update({ announcement: "تعديل متسابق" }),
      owner.storeAdmin.settings.update({ fulfillmentBranchId: 2 }),
    ]);
    expect(managerResult.status).toBe("rejected");
    if (managerResult.status === "rejected") {
      expect(managerResult.reason).toMatchObject({ code: "FORBIDDEN" });
    }
    expect(ownerResult.status).toBe("fulfilled");
    const [settings] = await db().select().from(s.storeSettings).where(eq(s.storeSettings.id, 1));
    expect(Number(settings.fulfillmentBranchId)).toBe(2);
    expect(settings.announcement).toBeNull();
  });
});
