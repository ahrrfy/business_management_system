import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import type { TrpcContext } from "../../context";
import { getDb } from "../../db";
import { appRouter } from "../../routers";
import { listForPos, listProductsAdmin, listStockByUnitIds } from "../catalogService";

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set");
  return d;
}

async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const table of [
    "onlineOrderItems",
    "onlineOrders",
    "customers",
    "reservationStock",
    "branchStock",
    "bundleComponents",
    "productPrices",
    "productUnits",
    "productVariants",
    "products",
    "branches",
  ]) {
    await d.execute(sql.raw(`TRUNCATE TABLE \`${table}\``));
  }
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

async function seedStock(onHand: number, reserved: number, opts: { isService?: boolean } = {}) {
  const d = db();
  await d.insert(s.branches).values([
    { id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "فرع المبيعات", code: "SALES", type: "SALES" },
  ]);
  await d.insert(s.products).values({
    id: 1,
    name: "دفتر اختبار تطابق الرصيد",
    isService: opts.isService ?? false,
  });
  await d.insert(s.productVariants).values({
    id: 1,
    productId: 1,
    sku: "PARITY-1",
    costPrice: "500.00",
  });
  await d.insert(s.productUnits).values({
    id: 1,
    variantId: 1,
    unitName: "قطعة",
    conversionFactor: "1",
    isBaseUnit: true,
  });
  await d.insert(s.productPrices).values({ productUnitId: 1, priceTier: "RETAIL", price: "1000.00" });
  if (!opts.isService || onHand !== 0) {
    await d.insert(s.branchStock).values({ variantId: 1, branchId: 1, quantity: onHand });
  }
  if (reserved > 0) {
    await d.insert(s.reservationStock).values({ variantId: 1, branchId: 1, reservedBase: reserved });
  }
}

beforeEach(reset);

function caller(role: string, branchId: number | null) {
  const ctx: TrpcContext = {
    req: { headers: {} } as unknown as TrpcContext["req"],
    res: {} as unknown as TrpcContext["res"],
    user: { id: 1, role, branchId, name: "test", email: "test@local", isActive: true } as unknown as TrpcContext["user"],
  };
  return appRouter.createCaller(ctx);
}

describe("تطابق دلالة المخزون بين شاشة المنتجات وشاشات البيع", () => {
  it("يعرض الرصيد الفعلي نفسه في المصدرين للحساب والفرع نفسيهما بلا حجوزات", async () => {
    await seedStock(10, 0);

    const adminResult = await listProductsAdmin({ branchId: 1, q: "تطابق" });
    const admin = adminResult.rows[0];
    const sale = (await listForPos(1, "RETAIL", "تطابق"))[0];

    expect(adminResult.branchId).toBe(1);
    expect(admin).toMatchObject({ branchId: 1, stockBase: 10, reservedBase: 0, availableBase: 10 });
    expect(sale).toMatchObject({ branchId: 1, stockBase: 10, reservedBase: 0, availableBase: 10 });
  });

  it("يفصل الفعلي والمحجوز ويثبت المتاح عند الصفر إذا تجاوز الحجز الرصيد", async () => {
    await seedStock(10, 13);

    const admin = (await listProductsAdmin({ branchId: 1, q: "تطابق" })).rows[0];
    const sale = (await listForPos(1, "RETAIL", "تطابق"))[0];

    expect(admin).toMatchObject({ stockBase: 10, reservedBase: 13, availableBase: 0 });
    expect(sale).toMatchObject({ stockBase: 10, reservedBase: 13, availableBase: 0 });
  });

  it("يعيد الفرع الفعلي بعد إجبار حساب غير عابر على فرعه", async () => {
    await seedStock(50, 0);

    const ownerRows = await caller("admin", 1).catalog.posList({
      branchId: 1,
      tier: "RETAIL",
      query: "تطابق",
      limit: 10,
    });
    // المدير لم يعد عابراً في سياسة main الحديثة: طلب الرئيسي يُجبر على فرعه 2.
    const managerRows = await caller("manager", 2).catalog.posList({
      branchId: 1,
      tier: "RETAIL",
      query: "تطابق",
      limit: 10,
    });

    expect(ownerRows[0]).toMatchObject({ branchId: 1, stockBase: 50 });
    expect(managerRows[0]).toMatchObject({ branchId: 2, stockBase: 0 });

    const ownerSnapshot = await caller("admin", 1).catalog.stockByUnitIds({ branchId: 1, productUnitIds: [1] });
    const managerSnapshot = await caller("manager", 2).catalog.stockByUnitIds({ branchId: 1, productUnitIds: [1] });
    expect(ownerSnapshot).toMatchObject({ branchId: 1, rows: [{ branchId: 1, stockBase: 50 }] });
    expect(managerSnapshot).toMatchObject({ branchId: 2, rows: [{ branchId: 2, stockBase: 0 }] });
  });

  it("تقرأ كل لقطة من الحالة الحالية ولا تخفي السالب الذي تسمح به قنوات أرضية السالب", async () => {
    await seedStock(3, 0);
    const before = await listStockByUnitIds([1], 1);

    await db().update(s.branchStock).set({ quantity: -4 }).where(eq(s.branchStock.variantId, 1));
    const after = await listStockByUnitIds([1], 1);

    expect(before[0]).toMatchObject({ stockBase: 3, availableBase: 3 });
    expect(after[0]).toMatchObject({ stockBase: -4, reservedBase: 0, availableBase: 0 });
  });

  it("تبقى الخدمة موسومةً خدمة ولو لم يكن لها صف مخزون", async () => {
    await seedStock(0, 0, { isService: true });

    const [sale] = await listForPos(1, "RETAIL", "تطابق", 10, { includeAllServices: true });
    const [snapshot] = await listStockByUnitIds([1], 1);

    expect(sale).toMatchObject({ branchId: 1, isService: true, stockBase: 0, availableBase: 0 });
    expect(snapshot).toMatchObject({ branchId: 1, isService: true, stockBase: 0, availableBase: 0 });
  });

  it("يشتق حجز البكج من مكوّناته مرة واحدة ولا يطرح صف حجز البكج فوقه", async () => {
    await seedStock(10, 4);
    await db().insert(s.products).values({ id: 2, name: "بكج اختبار التطابق", isBundle: true });
    await db().insert(s.productVariants).values({ id: 2, productId: 2, sku: "PARITY-BUNDLE", costPrice: "1000.00" });
    await db().insert(s.productUnits).values({
      id: 2,
      variantId: 2,
      unitName: "بكج",
      conversionFactor: "1",
      isBaseUnit: true,
    });
    await db().insert(s.bundleComponents).values({
      bundleVariantId: 2,
      componentVariantId: 1,
      componentBaseQuantity: 2,
    });

    const [fromComponents] = await listStockByUnitIds([2], 1);
    expect(fromComponents).toMatchObject({ stockBase: 5, reservedBase: 2, availableBase: 3 });

    // صفّ قديم/ملفّق على variant البكج لا يُطرح ثانيةً؛ المسار الرسمي يمنع حجز البكجات أصلاً.
    await db().insert(s.reservationStock).values({ variantId: 2, branchId: 1, reservedBase: 2 });
    const [withLegacyBundleRow] = await listStockByUnitIds([2], 1);
    expect(withLegacyBundleRow).toMatchObject({ stockBase: 5, reservedBase: 2, availableBase: 3 });
  });

  it("يوحّد تخصيص الطلب الإلكتروني النشط بين المنتجات وPOS ولقطة السلة", async () => {
    await seedStock(10, 2);
    await db().insert(s.customers).values({ id: 1, name: "زبون طلب نشط" });
    await db().insert(s.onlineOrders).values({
      id: 1,
      orderNumber: "ORD-PARITY",
      customerId: 1,
      branchId: 1,
      subtotal: "3000.00",
      total: "3000.00",
      status: "CONFIRMED",
    });
    await db().insert(s.onlineOrderItems).values({
      onlineOrderId: 1,
      variantId: 1,
      productUnitId: 1,
      quantity: "3.000",
      baseQuantity: 3,
      unitPrice: "1000.00",
      total: "3000.00",
    });

    const admin = (await listProductsAdmin({ branchId: 1, q: "تطابق" })).rows[0];
    const sale = (await listForPos(1, "RETAIL", "تطابق"))[0];
    const snapshot = (await listStockByUnitIds([1], 1))[0];
    expect(admin).toMatchObject({ stockBase: 10, reservedBase: 5, availableBase: 5 });
    expect(sale).toMatchObject({ stockBase: 10, reservedBase: 5, availableBase: 5 });
    expect(snapshot).toMatchObject({ stockBase: 10, reservedBase: 5, availableBase: 5 });
  });

  it("يبقي الرصيد الفعلي السالب للبكج ظاهراً ويحصر ATP وحده بالصفر", async () => {
    await seedStock(-1, 0);
    await db().insert(s.products).values({ id: 2, name: "بكج بعجز", isBundle: true });
    await db().insert(s.productVariants).values({ id: 2, productId: 2, sku: "NEG-BUNDLE", costPrice: "1000.00" });
    await db().insert(s.productUnits).values({
      id: 2,
      variantId: 2,
      unitName: "بكج",
      conversionFactor: "1",
      isBaseUnit: true,
    });
    await db().insert(s.bundleComponents).values({
      bundleVariantId: 2,
      componentVariantId: 1,
      componentBaseQuantity: 2,
    });

    const [snapshot] = await listStockByUnitIds([2], 1);
    expect(snapshot).toMatchObject({ stockBase: -1, reservedBase: 0, availableBase: 0 });
  });
});
