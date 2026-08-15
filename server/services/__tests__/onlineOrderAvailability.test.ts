import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createOnlineOrder } from "../onlineOrderService";
import { listStockByUnitIds } from "../catalog/pos";
import { setOnlineOrderStatus } from "../storeAdmin/orderFulfillmentService";
import { truncateAllTables } from "./__testUtils__";
import { withTx } from "../tx";
import type { Tx } from "../../db";

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

const baseOrder = {
  customerName: "Test customer",
  customerPhone: "07701234567",
  governorate: "baghdad",
  addressText: "Test address",
};

async function commitMutationWhileCreateWaitsOnUnit(
  mutate: (tx: Tx) => Promise<void>,
  requestId: string,
  expected?: { unitPrice: string; grandTotal: string },
) {
  let unitLocked!: () => void;
  let releaseMutation!: () => void;
  const locked = new Promise<void>((resolve) => { unitLocked = resolve; });
  const release = new Promise<void>((resolve) => { releaseMutation = resolve; });
  const mutation = withTx(async (tx) => {
    await tx.select({ id: s.productUnits.id }).from(s.productUnits).where(eq(s.productUnits.id, 1)).for("update");
    await mutate(tx);
    unitLocked();
    await release;
  });
  await locked;
  const creation = createOnlineOrder({
    ...baseOrder,
    clientRequestId: requestId,
    lines: [{ productUnitId: 1, quantity: 1, expectedUnitPrice: expected?.unitPrice }],
    expectedGrandTotal: expected?.grandTotal,
  });
  // أمهل الإنشاء ليقرأ لقطة الأهلية القديمة ثم يقف عند mutex الوحدة؛ التحرير بعد ذلك
  // يثبت أن Current Read بعد القفل يرى التغيير الملتزم لا snapshot المعاملة القديم.
  await new Promise((resolve) => setTimeout(resolve, 200));
  releaseMutation();
  await mutation;
  return creation;
}

beforeEach(async () => {
  await truncateAllTables();
  const d = db();
  await d.insert(s.branches).values([
    { id: 1, name: "Main", code: "MAIN", type: "MAIN" },
    { id: 2, name: "Other", code: "OTHER", type: "SALES" },
  ]);
  await d.insert(s.products).values({ id: 1, name: "Store item", showInStore: true });
  await d.insert(s.productVariants).values({ id: 1, productId: 1, sku: "STORE-1", costPrice: "1.00" });
  await d.insert(s.productUnits).values({ id: 1, variantId: 1, unitName: "piece", isBaseUnit: true, isStoreSaleUnit: true });
  await d.insert(s.productPrices).values({ productUnitId: 1, priceTier: "RETAIL", price: "1000.00" });
  await d.insert(s.branchStock).values([
    { variantId: 1, branchId: 1, quantity: 3 },
    { variantId: 1, branchId: 2, quantity: 100 },
  ]);
  await d.insert(s.storeSettings).values({ id: 1, fulfillmentBranchId: 1, isOpen: true });
});

describe("createOnlineOrder availability guards", () => {
  it("rejects a requested quantity above stock, including duplicate cart lines", async () => {
    await expect(createOnlineOrder({ ...baseOrder, lines: [{ productUnitId: 1, quantity: 4 }] }))
      .rejects.toThrow(/الكمية المطلوبة/);
    await expect(createOnlineOrder({ ...baseOrder, lines: [{ productUnitId: 1, quantity: 2 }, { productUnitId: 1, quantity: 2 }] }))
      .rejects.toThrow(/الكمية المطلوبة/);
  });

  it("uses ATP after active reservations rather than raw on-hand", async () => {
    await db().insert(s.reservationStock).values({ variantId: 1, branchId: 1, reservedBase: 2 });
    await expect(createOnlineOrder({ ...baseOrder, lines: [{ productUnitId: 1, quantity: 2 }] }))
      .rejects.toThrow(/الحجوزات النشطة/);
  });

  it("rejects a product hidden from the storefront", async () => {
    await db().update(s.products).set({ showInStore: false }).where(eq(s.products.id, 1));
    await expect(createOnlineOrder({ ...baseOrder, lines: [{ productUnitId: 1, quantity: 1 }] })).rejects.toThrow();
  });

  it("rejects a product whose category is disabled or hidden", async () => {
    await db().insert(s.categories).values({ id: 1, name: "Hidden category", showInStore: false });
    await db().update(s.products).set({ categoryId: 1 }).where(eq(s.products.id, 1));
    await expect(createOnlineOrder({ ...baseOrder, lines: [{ productUnitId: 1, quantity: 1 }] })).rejects.toThrow(/لم يعُد متاحاً/);
  });

  it("rejects a unit that the manager did not enable for storefront sales", async () => {
    await db().update(s.productUnits).set({ isStoreSaleUnit: false }).where(eq(s.productUnits.id, 1));
    await expect(createOnlineOrder({ ...baseOrder, lines: [{ productUnitId: 1, quantity: 1 }] })).rejects.toThrow();
  });

  it("ignores a caller-supplied branch and always stores the order on the configured fulfillment branch", async () => {
    const created = await createOnlineOrder({ ...baseOrder, branchId: 2, lines: [{ productUnitId: 1, quantity: 1 }] });
    const order = (await db().select({ branchId: s.onlineOrders.branchId }).from(s.onlineOrders).where(eq(s.onlineOrders.id, created.orderId)))[0];
    expect(order?.branchId).toBe(1);
  });

  it("uses a non-MAIN configured fulfillment branch for availability and persistence", async () => {
    await db().update(s.storeSettings).set({ fulfillmentBranchId: 2 }).where(eq(s.storeSettings.id, 1));
    const created = await createOnlineOrder({ ...baseOrder, branchId: 1, lines: [{ productUnitId: 1, quantity: 50 }] });
    expect(created.branchId).toBe(2);
    const order = (await db().select().from(s.onlineOrders).where(eq(s.onlineOrders.id, created.orderId)))[0];
    expect(order?.branchId).toBe(2);
  });

  it("replays only an identical order key and rejects a collision or altered cart", async () => {
    const request = { ...baseOrder, clientRequestId: "store-order-key-1", lines: [{ productUnitId: 1, quantity: 1 }] };
    const created = await createOnlineOrder(request);
    const replay = await createOnlineOrder(request);
    expect(replay.orderId).toBe(created.orderId);
    expect(replay.idempotentReplay).toBe(true);

    await expect(createOnlineOrder({ ...request, customerPhone: "07801234567" })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(createOnlineOrder({ ...request, lines: [{ productUnitId: 1, quantity: 2 }] })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("server commit ثم lost response/reload يعيد نفس الطلب والتخصيص بنفس المفتاح المحفوظ", async () => {
    const request = {
      ...baseOrder,
      clientRequestId: "persisted-after-lost-response",
      expectedGrandTotal: "6000.00",
      lines: [{ productUnitId: 1, quantity: 1, expectedUnitPrice: "1000.00" }],
    };
    const committed = await createOnlineOrder(request); // الرد يُفقد عند العميل بعد هذه النقطة
    const retriedAfterReload = await createOnlineOrder(request);
    expect(retriedAfterReload).toMatchObject({ orderId: committed.orderId, idempotentReplay: true });
    expect(await db().select().from(s.onlineOrders)).toHaveLength(1);
    expect(await db().select().from(s.onlineOrderItems)).toHaveLength(1);
    expect((await listStockByUnitIds([1], 1))[0]).toMatchObject({ stockBase: 3, reservedBase: 1, availableBase: 2 });
  });

  it("يعيد التسعير من Current Read بعد انتظار mutex الوحدة ولا يثبت سعر اللقطة القديمة", async () => {
    const created = await commitMutationWhileCreateWaitsOnUnit(async (tx) => {
      await tx.update(s.productPrices).set({ price: "1250.00" }).where(eq(s.productPrices.productUnitId, 1));
    }, "price-current-read-race");
    const [item] = await db().select().from(s.onlineOrderItems).where(eq(s.onlineOrderItems.onlineOrderId, created.orderId));
    expect(item.unitPrice).toBe("1250.00");
    expect(created.subtotal).toBe("1250.00");
  });

  it("يرفض زيادة سعر بين العرض والتثبيت إذا لم يوافق الزبون على الإجمالي الجديد", async () => {
    await expect(commitMutationWhileCreateWaitsOnUnit(async (tx) => {
      await tx.update(s.productPrices).set({ price: "1250.00" }).where(eq(s.productPrices.productUnitId, 1));
    }, "price-consent-race", { unitPrice: "1000.00", grandTotal: "6000.00" }))
      .rejects.toMatchObject({ code: "CONFLICT" });
    expect(await db().select().from(s.onlineOrders)).toHaveLength(0);

    // بعد أن تعرض الواجهة السعر والإجمالي الجديدين وتولد بصمة/مفتاحاً جديداً، ينجح التأكيد.
    const accepted = await createOnlineOrder({
      ...baseOrder,
      clientRequestId: "price-consent-after-refresh",
      lines: [{ productUnitId: 1, quantity: 1, expectedUnitPrice: "1250.00" }],
      expectedGrandTotal: "6250.00",
    });
    expect(accepted).toMatchObject({ subtotal: "1250.00", total: "6250.00" });
  });

  it("حل العرض Locking Current Read: تعطيل متزامن لا يترك خصماً من snapshot قديم", async () => {
    await db().insert(s.promotions).values({
      id: 1, name: "Store half price", type: "PERCENT", discountPercent: "50.00",
      discountAmount: "0.00", scope: "ALL", effectiveFrom: new Date("2020-01-01"),
      effectiveTo: new Date("2099-12-31"), branchId: 1, customerTier: "RETAIL",
      minLineAmount: "0.00", priority: 100, isActive: true, applicationMode: "AUTO",
      isStoreManaged: true,
    });
    const created = await commitMutationWhileCreateWaitsOnUnit(async (tx) => {
      await tx.update(s.promotions).set({ isActive: false }).where(eq(s.promotions.id, 1));
    }, "promotion-current-read-race");
    const [item] = await db().select().from(s.onlineOrderItems).where(eq(s.onlineOrderItems.onlineOrderId, created.orderId));
    expect(item.unitPrice).toBe("1000.00");
    expect(created.subtotal).toBe("1000.00");
  });

  it("يرفض إلغاء عرض بين checkout والتثبيت بدلاً من إنشاء COD أعلى من موافقة الزبون", async () => {
    await db().insert(s.promotions).values({
      id: 1, name: "Store half price", type: "PERCENT", discountPercent: "50.00",
      discountAmount: "0.00", scope: "ALL", effectiveFrom: new Date("2020-01-01"),
      effectiveTo: new Date("2099-12-31"), branchId: 1, customerTier: "RETAIL",
      minLineAmount: "0.00", priority: 100, isActive: true, applicationMode: "AUTO",
      isStoreManaged: true,
    });
    await expect(commitMutationWhileCreateWaitsOnUnit(async (tx) => {
      await tx.update(s.promotions).set({ isActive: false }).where(eq(s.promotions.id, 1));
    }, "promotion-consent-race", { unitPrice: "500.00", grandTotal: "5500.00" }))
      .rejects.toMatchObject({ code: "CONFLICT" });
    expect(await db().select().from(s.onlineOrders)).toHaveLength(0);
  });

  it.each([
    ["product", async (tx: Tx) => { await tx.update(s.products).set({ showInStore: false }).where(eq(s.products.id, 1)); }],
    ["variant", async (tx: Tx) => { await tx.update(s.productVariants).set({ isActive: false }).where(eq(s.productVariants.id, 1)); }],
    ["category", async (tx: Tx) => { await tx.update(s.categories).set({ showInStore: false }).where(eq(s.categories.id, 1)); }],
  ] as const)("يرفض إنشاءً انتظر الوحدة إذا تغيّرت أهلية %s قبل التثبيت", async (kind, mutate) => {
    if (kind === "category") {
      await db().insert(s.categories).values({ id: 1, name: "Visible category", showInStore: true });
      await db().update(s.products).set({ categoryId: 1 }).where(eq(s.products.id, 1));
    }
    await expect(commitMutationWhileCreateWaitsOnUnit(mutate, `eligibility-current-read-${kind}`))
      .rejects.toThrow(/أهلية|متاح/);
    expect(await db().select().from(s.onlineOrders)).toHaveLength(0);
  });

  it("replays an already committed request before store-open and fulfillment-branch checks", async () => {
    const request = { ...baseOrder, clientRequestId: "store-order-closed-replay", lines: [{ productUnitId: 1, quantity: 1 }] };
    const created = await createOnlineOrder(request);
    await db().update(s.storeSettings).set({ isOpen: false, fulfillmentBranchId: 2 }).where(eq(s.storeSettings.id, 1));

    await expect(createOnlineOrder(request)).resolves.toMatchObject({
      orderId: created.orderId,
      branchId: 1,
      idempotentReplay: true,
    });
    await expect(createOnlineOrder({ ...request, customerPhone: "07801234567" }))
      .rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("serializes concurrent retries into one order", async () => {
    const request = { ...baseOrder, clientRequestId: "store-order-concurrent", lines: [{ productUnitId: 1, quantity: 1 }] };
    const [first, second] = await Promise.all([createOnlineOrder(request), createOnlineOrder(request)]);
    expect(first.orderId).toBe(second.orderId);
    expect((await db().select().from(s.onlineOrders)).filter((row) => row.clientRequestId === request.clientRequestId)).toHaveLength(1);
  });

  it("يسمح replay لصاحب phone حتى لو كان whatsapp مختلفاً", async () => {
    const request = { ...baseOrder, clientRequestId: "store-order-multi-phone", lines: [{ productUnitId: 1, quantity: 1 }] };
    const created = await createOnlineOrder(request);
    const [order] = await db().select({ customerId: s.onlineOrders.customerId }).from(s.onlineOrders).where(eq(s.onlineOrders.id, created.orderId));
    await db().update(s.customers).set({ whatsapp: "+9647801234567" }).where(eq(s.customers.id, Number(order.customerId)));
    await expect(createOnlineOrder(request)).resolves.toMatchObject({ orderId: created.orderId, idempotentReplay: true });
  });

  it("يخصص آخر قطعة ذرياً: طلب واحد فقط ينجح تحت التزامن", async () => {
    await db().update(s.branchStock).set({ quantity: 1 }).where(eq(s.branchStock.variantId, 1));
    const [first, second] = await Promise.allSettled([
      createOnlineOrder({ ...baseOrder, customerPhone: "07701234567", clientRequestId: "last-piece-a", lines: [{ productUnitId: 1, quantity: 1 }] }),
      createOnlineOrder({ ...baseOrder, customerPhone: "07801234567", clientRequestId: "last-piece-b", lines: [{ productUnitId: 1, quantity: 1 }] }),
    ]);
    expect([first, second].filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect([first, second].filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await db().select().from(s.onlineOrders)).toHaveLength(1);
    const [snapshot] = await listStockByUnitIds([1], 1);
    expect(snapshot).toMatchObject({ stockBase: 1, reservedBase: 1, availableBase: 0 });
  });

  it("CANCELLED يحرر تخصيص الطلب تلقائياً", async () => {
    const created = await createOnlineOrder({ ...baseOrder, clientRequestId: "cancel-release", lines: [{ productUnitId: 1, quantity: 2 }] });
    expect((await listStockByUnitIds([1], 1))[0]).toMatchObject({ stockBase: 3, reservedBase: 2, availableBase: 1 });
    await setOnlineOrderStatus({ id: created.orderId, status: "CANCELLED", scopedBranchId: null }, 1);
    expect((await listStockByUnitIds([1], 1))[0]).toMatchObject({ stockBase: 3, reservedBase: 0, availableBase: 3 });
  });

  it("derives bundle ATP from components and ignores a legacy reservation row on the bundle", async () => {
    const d = db();
    await d.insert(s.products).values({ id: 2, name: "Store bundle", showInStore: true, isBundle: true });
    await d.insert(s.productVariants).values({ id: 2, productId: 2, sku: "ORDER-BUNDLE", costPrice: "1.00" });
    await d.insert(s.productUnits).values({ id: 2, variantId: 2, unitName: "bundle", isBaseUnit: true, isStoreSaleUnit: true });
    await d.insert(s.productPrices).values({ productUnitId: 2, priceTier: "RETAIL", price: "2500.00" });
    await d.insert(s.bundleComponents).values({ bundleVariantId: 2, componentVariantId: 1, componentBaseQuantity: 2 });
    await d.insert(s.reservationStock).values({ variantId: 2, branchId: 1, reservedBase: 99 });

    await expect(createOnlineOrder({
      ...baseOrder,
      clientRequestId: "bundle-order-ok",
      lines: [{ productUnitId: 2, quantity: 1 }],
    })).resolves.toMatchObject({ itemCount: 1 });

    // الطلب النشط للبكج يخصص مكوّنين؛ لا يمكن لبند مباشر على المكوّن تجاوز الباقي.
    await expect(createOnlineOrder({
      ...baseOrder,
      customerPhone: "07801234567",
      clientRequestId: "bundle-blocks-component",
      lines: [{ productUnitId: 1, quantity: 2 }],
    })).rejects.toThrow(/الطلبات النشطة/);

    await d.insert(s.reservationStock).values({ variantId: 1, branchId: 1, reservedBase: 2 });
    await expect(createOnlineOrder({
      ...baseOrder,
      clientRequestId: "bundle-order-reserved",
      lines: [{ productUnitId: 2, quantity: 1 }],
    })).rejects.toThrow(/الحجوزات النشطة/);
  });
});
