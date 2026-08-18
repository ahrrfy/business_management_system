import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createOnlineOrder, quoteOnlineOrder } from "../onlineOrderService";
import { listStockByUnitIds } from "../catalog/pos";
import { loadVariantAvailability } from "../catalog/variantAvailability";
import { setOnlineOrderStatus } from "../storeAdmin/orderFulfillmentService";
import { truncateAllTables } from "./__testUtils__";
import { withTx } from "../tx";
import type { Tx } from "../../db";
import { createSaleInTx } from "../sale/create";

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

async function waitForOnlineCustomerNamedLock(phone: string): Promise<void> {
  const lockName = `online-customer:${phone}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    const raw = await db().execute(sql`SELECT IS_USED_LOCK(${lockName}) AS ownerId`) as unknown;
    const row = Array.isArray(raw)
      ? (raw[0] as Array<{ ownerId?: number | string | null }>)?.[0]
      : (raw as { rows?: Array<{ ownerId?: number | string | null }> }).rows?.[0];
    if (row?.ownerId != null) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("online order did not reach the customer lock barrier");
}

beforeEach(async () => {
  await truncateAllTables();
  const d = db();
  // truncateAllTables removes the singleton seeded by the production
  // migration. Restore it before concurrency barriers so financial writers
  // acquire the intended shared gate instead of serializing on first insert.
  await d
    .insert(s.monthCloseSequence)
    .values({ id: 1, status: "NEEDS_BOOTSTRAP", version: 0 })
    .onDuplicateKeyUpdate({ set: { id: 1 } });
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
  it("persists one immutable 24-hour reservation deadline and replays the same snapshot", async () => {
    const before = Date.now();
    const request = {
      ...baseOrder,
      clientRequestId: "reservation-expiry-snapshot",
      lines: [{ productUnitId: 1, quantity: 1 }],
    };
    const created = await createOnlineOrder(request);
    const after = Date.now();
    expect(created.reservationExpiresAt.getTime()).toBeGreaterThanOrEqual(before + 24 * 60 * 60 * 1000);
    expect(created.reservationExpiresAt.getTime()).toBeLessThanOrEqual(after + 24 * 60 * 60 * 1000);
    const stored = (
      await db()
        .select({ expiryMs: sql<number | null>`ROUND(UNIX_TIMESTAMP(\`onlineOrders\`.\`reservationExpiresAt\`) * 1000)` })
        .from(s.onlineOrders)
        .where(eq(s.onlineOrders.id, created.orderId))
        .limit(1)
    )[0]?.expiryMs;
    expect(Number(stored)).toBe(created.reservationExpiresAt.getTime());

    const replay = await createOnlineOrder(request);
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.reservationExpiresAt.getTime()).toBe(created.reservationExpiresAt.getTime());
  });

  it("gives an old-version insert that omits the column a database 24-hour default", async () => {
    await db().insert(s.customers).values({ id: 99, name: "Mixed version customer" });
    await db().insert(s.onlineOrders).values({
      orderNumber: "ORD-MIXED-VERSION-DEFAULT",
      customerId: 99,
      branchId: 1,
      subtotal: "1000.00",
      total: "1000.00",
      status: "PENDING",
    });
    const timing = (
      await db()
        .select({
          orderMs: sql<number>`ROUND(UNIX_TIMESTAMP(${s.onlineOrders.orderDate}) * 1000)`,
          expiryMs: sql<number | null>`ROUND(UNIX_TIMESTAMP(${s.onlineOrders.reservationExpiresAt}) * 1000)`,
        })
        .from(s.onlineOrders)
        .where(eq(s.onlineOrders.orderNumber, "ORD-MIXED-VERSION-DEFAULT"))
        .limit(1)
    )[0];
    expect(Number(timing.expiryMs) - Number(timing.orderMs)).toBe(24 * 60 * 60 * 1000);
  });

  it("releases expired PENDING allocation from ATP immediately", async () => {
    const expired = await createOnlineOrder({
      ...baseOrder,
      clientRequestId: "expired-allocation",
      lines: [{ productUnitId: 1, quantity: 3 }],
    });
    await db().execute(sql`
      UPDATE onlineOrders
      SET reservationExpiresAt = DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 1 SECOND)
      WHERE id = ${expired.orderId}
    `);

    await expect(
      createOnlineOrder({
        ...baseOrder,
        clientRequestId: "replacement-after-expiry",
        lines: [{ productUnitId: 1, quantity: 3 }],
      }),
    ).resolves.toMatchObject({ itemCount: 1 });
  });

  it("derives mixed-version NULL expiry from orderDate for replay and ATP", async () => {
    const request = {
      ...baseOrder,
      clientRequestId: "legacy-null-expiry",
      lines: [{ productUnitId: 1, quantity: 3 }],
    };
    const legacy = await createOnlineOrder(request);
    await db().execute(sql`
      UPDATE onlineOrders
      SET orderDate = DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 25 HOUR),
          reservationExpiresAt = NULL
      WHERE id = ${legacy.orderId}
    `);
    const effectiveMs = (
      await db()
        .select({ value: sql<number>`ROUND(UNIX_TIMESTAMP(DATE_ADD(${s.onlineOrders.orderDate}, INTERVAL 24 HOUR)) * 1000)` })
        .from(s.onlineOrders)
        .where(eq(s.onlineOrders.id, legacy.orderId))
        .limit(1)
    )[0].value;

    const replay = await createOnlineOrder(request);
    expect(replay.reservationExpiresAt.getTime()).toBe(Number(effectiveMs));
    await expect(
      createOnlineOrder({
        ...baseOrder,
        clientRequestId: "after-legacy-null-expiry",
        lines: [{ productUnitId: 1, quantity: 3 }],
      }),
    ).resolves.toMatchObject({ itemCount: 1 });
  });

  it("keeps a recent mixed-version NULL expiry allocated until orderDate plus 24 hours", async () => {
    const legacy = await createOnlineOrder({
      ...baseOrder,
      clientRequestId: "recent-legacy-null-expiry",
      lines: [{ productUnitId: 1, quantity: 3 }],
    });
    await db().execute(sql`
      UPDATE onlineOrders
      SET reservationExpiresAt = NULL
      WHERE id = ${legacy.orderId}
    `);
    await expect(
      createOnlineOrder({
        ...baseOrder,
        clientRequestId: "blocked-by-recent-legacy",
        lines: [{ productUnitId: 1, quantity: 1 }],
      }),
    ).rejects.toThrow(/الكمية المطلوبة|الحجوزات النشطة/);
  });

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

  it("quote يطبق minLineAmount على كمية السلة نفسها ثم ينجح التأكيد بالسعر الموافق عليه", async () => {
    await db().update(s.productPrices).set({ price: "100.00" }).where(eq(s.productPrices.productUnitId, 1));
    await db().update(s.storeSettings).set({ freeShippingThreshold: "1.00" }).where(eq(s.storeSettings.id, 1));
    await db().insert(s.promotions).values({
      id: 1,
      name: "خصم كمية",
      type: "PERCENT",
      discountPercent: "10.00",
      discountAmount: "0.00",
      scope: "ALL",
      effectiveFrom: new Date("2020-01-01"),
      effectiveTo: new Date("2099-12-31"),
      branchId: 1,
      customerTier: "RETAIL",
      minLineAmount: "200.00",
      priority: 100,
      isActive: true,
      applicationMode: "AUTO",
      isStoreManaged: true,
    });

    const quote = await quoteOnlineOrder({
      governorate: "baghdad",
      lines: [{ productUnitId: 1, quantity: 2 }],
    });
    expect(quote).toMatchObject({ subtotal: "180.00", deliveryFee: "0.00", total: "180.00" });
    expect(quote.lines[0]).toMatchObject({ unitPrice: "90.00", discountPerUnit: "10.00", lineTotal: "180.00" });

    const created = await createOnlineOrder({
      ...baseOrder,
      clientRequestId: "quantity-threshold-quote",
      lines: [{ productUnitId: 1, quantity: 2, expectedUnitPrice: quote.lines[0].unitPrice }],
      expectedGrandTotal: quote.total,
    });
    expect(created).toMatchObject({ subtotal: "180.00", total: "180.00" });
    expect(await db().select().from(s.onlineOrders)).toHaveLength(1);
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

  it("ينهي طلب المتجر وبيع POS للعميل والفرع نفسيهما بلا deadlock ويحفظ أثريهما", async () => {
    await db().insert(s.users).values({
      id: 1,
      openId: "storefront-pos-lock-test",
      name: "Lock test admin",
      role: "admin",
      loginMethod: "local",
    });
    await db().insert(s.customers).values({
      id: 1,
      name: "Test customer",
      phone: "+9647701234567",
      creditLimit: null,
      currentBalance: "0.00",
    });

    let customerLocked!: () => void;
    let releasePos!: () => void;
    const customerBarrier = new Promise<void>((resolve) => { customerLocked = resolve; });
    const releaseBarrier = new Promise<void>((resolve) => { releasePos = resolve; });
    const posSale = withTx(async (tx) => {
      await tx.select({ id: s.customers.id })
        .from(s.customers)
        .where(eq(s.customers.id, 1))
        .for("update");
      customerLocked();
      await releaseBarrier;
      return createSaleInTx(tx, {
        branchId: 1,
        customerId: 1,
        sourceType: "POS",
        clientRequestId: "pos-vs-online-branch-share",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
        payment: null,
      }, { userId: 1, branchId: 1, role: "admin" });
    });
    await customerBarrier;

    const online = createOnlineOrder({
      ...baseOrder,
      clientRequestId: "online-vs-pos-branch-share",
      lines: [{ productUnitId: 1, quantity: 1 }],
    });
    await waitForOnlineCustomerNamedLock("+9647701234567");
    releasePos();

    const [sale, order] = await Promise.all([posSale, online]);
    expect(sale.invoiceId).toBeGreaterThan(0);
    expect(order.orderId).toBeGreaterThan(0);
    expect((await listStockByUnitIds([1], 1))[0]).toMatchObject({
      stockBase: 2,
      reservedBase: 1,
      availableBase: 1,
    });
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

  it("releases an expired bundle allocation in both component and bundle ATP", async () => {
    const d = db();
    await d.insert(s.products).values({ id: 2, name: "Expiring bundle", showInStore: true, isBundle: true });
    await d.insert(s.productVariants).values({ id: 2, productId: 2, sku: "EXPIRING-BUNDLE", costPrice: "1.00" });
    await d.insert(s.productUnits).values({ id: 2, variantId: 2, unitName: "bundle", isBaseUnit: true, isStoreSaleUnit: true });
    await d.insert(s.productPrices).values({ productUnitId: 2, priceTier: "RETAIL", price: "2500.00" });
    await d.insert(s.bundleComponents).values({ bundleVariantId: 2, componentVariantId: 1, componentBaseQuantity: 2 });

    const created = await createOnlineOrder({
      ...baseOrder,
      clientRequestId: "expiring-bundle-allocation",
      lines: [{ productUnitId: 2, quantity: 1 }],
    });
    const before = await loadVariantAvailability(d, 1, [1, 2]);
    expect(before.get(1)).toMatchObject({ reservedBase: 2, availableBase: 1 });
    expect(before.get(2)).toMatchObject({ availableBase: 0 });

    await d.execute(sql`
      UPDATE onlineOrders
      SET reservationExpiresAt = DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 1 SECOND)
      WHERE id = ${created.orderId}
    `);
    const after = await loadVariantAvailability(d, 1, [1, 2]);
    expect(after.get(1)).toMatchObject({ reservedBase: 0, availableBase: 3 });
    expect(after.get(2)).toMatchObject({ availableBase: 1 });
  });
});
