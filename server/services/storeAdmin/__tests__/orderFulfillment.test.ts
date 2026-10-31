/**
 * اختبارات شاملة وعدائية لآلة حالة طلبات المتجر والأقفال التنافسية (Order Fulfillment Concurrency & State Machine).
 *
 * يغطّي:
 * ١. أقفال الصفوف الحصرية (Pessimistic Row Locking `for update`):
 *    - التنافس اللحظي على استلام الطلب (Race Condition).
 *    - رفض الاستلام المكرر لنفس الطلب من موظف آخر (CONFLICT).
 *    - استلام نفس الموظف للطلب مرتين بصورة Idempotent.
 *    - صلاحية المدير/الأدمن في إعادة التعيين.
 * ٢. حراس آلة الحالة (State Machine Guards):
 *    - رفض تجهيز الطلبات الواردة (PENDING) قبل تثبيتها.
 *    - رفض تجهيز الطلبات الملغاة (CANCELLED) أو المنتهية (DELIVERED/SHIPPED).
 *    - رفض تجهيز الطلب إذا كان مستلماً لموظف آخر.
 *    - حساب سرعة التجهيز بالدقائق (fulfillmentDurationMinutes) مع صمام الأمان الأدنى (دقيقة واحدة).
 * ٣. تحديث التواصل (updateOnlineOrderContact):
 *    - الذرّية وحفظ الملاحظات.
 *    - التثبيت الهاتفي CALLED_CONFIRMED لنقل PENDING إلى CONFIRMED.
 *    - رفض التحديث على الطلبات النهائية (CANCELLED/DELIVERED).
 * ٤. حارس انتهاء مهلة حجز المخزون (24h Reservation Expiry):
 *    - رفض تأكيد أو استلام الطلبات المنتهية (CONFLICT).
 *    - كنس الطلبات المنتهية بواسطة السويبر (sweepExpiredOnlineOrdersOnce).
 */
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../../drizzle/schema";
import { getDb } from "../../../db";
import { storeAdminRouter } from "../../../routers/storeAdminRouter";
import {
  autoAssignRoundRobinOnlineOrders,
  claimOnlineOrder,
  getOnlineOrder,
  listOnlineOrders,
  markOnlineOrderPrepared,
  reviveAndConfirmOnlineOrder,
  setOnlineOrderStatus,
  updateOnlineOrder,
  updateOnlineOrderContact,
} from "../orderFulfillmentService";
import { closeShift, openShift } from "../../shiftService";
import { sweepExpiredOnlineOrdersOnce } from "../../onlineOrderExpirySweeper";
import { truncateTables } from "../../__tests__/__testUtils__";

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

async function seedOrder(
  status: "PENDING" | "CONFIRMED" | "PROCESSING" | "SHIPPED" | "DELIVERED" | "CANCELLED" = "PENDING",
  opts: {
    cancelReason?: string | null;
    claimedByUserId?: number | null;
    claimedAt?: Date | null;
    orderNumber?: string;
    orderDate?: Date;
    reservationExpiresAt?: Date | null;
    preparedByUserId?: number | null;
    preparedAt?: Date | null;
    fulfillmentDurationMinutes?: number | null;
    contactStatus?: "NOT_CONTACTED" | "WHATSAPP_SENT" | "CALLED_CONFIRMED" | "NO_ANSWER" | "RETRY";
    contactNotes?: string | null;
  } = {}
): Promise<number> {
  const num = opts.orderNumber ?? `ORD-${Math.random().toString(36).substring(2, 9).toUpperCase()}`;
  await db().insert(s.onlineOrders).values({
    orderNumber: num,
    customerId: 1,
    branchId: 1,
    subtotal: "100.00",
    shippingCost: "0",
    taxAmount: "0",
    total: "100.00",
    status,
    cancelReason: opts.cancelReason ?? null,
    claimedByUserId: opts.claimedByUserId ?? null,
    claimedAt: opts.claimedAt ?? null,
    preparedByUserId: opts.preparedByUserId ?? null,
    preparedAt: opts.preparedAt ?? null,
    fulfillmentDurationMinutes: opts.fulfillmentDurationMinutes ?? null,
    contactStatus: opts.contactStatus ?? "NOT_CONTACTED",
    contactNotes: opts.contactNotes ?? null,
    shippingAddress: "بغداد",
    governorate: "baghdad",
    ...(opts.orderDate ? { orderDate: opts.orderDate } : {}),
    ...(opts.reservationExpiresAt !== undefined ? { reservationExpiresAt: opts.reservationExpiresAt } : {}),
  });
  return Number(
    (await db().select({ id: s.onlineOrders.id }).from(s.onlineOrders).where(eq(s.onlineOrders.orderNumber, num)).limit(1))[0].id,
  );
}

async function getOrder(id: number) {
  return (await db().select().from(s.onlineOrders).where(eq(s.onlineOrders.id, id)).limit(1))[0];
}

beforeEach(async () => {
  await truncateTables([
    "couponReservations",
    "coupons",
    "couponPrograms",
    "loyaltyLedgerEntries",
    "loyaltyAccounts",
    "loyaltyPrograms",
    "deliveryConsignments",
    "deliveryParties",
    "invoices",
    "storefrontPushDeliveries",
    "storefrontPushCampaigns",
    "storefrontPushDevices",
    "onlineOrderItems",
    "onlineOrders",
    "branchStock",
    "productPrices",
    "productUnits",
    "productVariants",
    "products",
    "shifts",
  ]);
  await db()
    .insert(s.branches)
    .values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" })
    .onDuplicateKeyUpdate({ set: { name: "الرئيسي" } });
  await db()
    .insert(s.customers)
    .values({ id: 1, name: "زبون تجريبيّ" })
    .onDuplicateKeyUpdate({ set: { name: "زبون تجريبيّ" } });
  await db()
    .insert(s.users)
    .values([
      { id: 1, openId: "user_admin", name: "المشرف العام", username: "admin_test", email: "admin@test.com", passwordHash: "h", role: "admin", branchId: 1 },
      { id: 2, openId: "user_staff1", name: "موظف التجهيز 1", username: "staff1_test", email: "staff1@test.com", passwordHash: "h", role: "user", branchId: 1 },
      { id: 3, openId: "user_staff2", name: "موظف التجهيز 2", username: "staff2_test", email: "staff2@test.com", passwordHash: "h", role: "user", branchId: 1 },
      { id: 4, openId: "user_manager", name: "مدير الفرع", username: "manager_test", email: "manager@test.com", passwordHash: "h", role: "manager", branchId: 1 },
    ])
    .onDuplicateKeyUpdate({ set: { name: sql`values(\`name\`)` } });
});

async function seedPrepaidDelivery() {
  const orderId = await seedOrder("SHIPPED");
  await db().insert(s.deliveryParties).values({ id: 1, name: "شركة التوصيل", partyType: "COMPANY" });
  await db().insert(s.invoices).values({
    id: 1, invoiceNumber: "INV-PREPAID", branchId: 1, customerId: 1,
    subtotal: "100.00", total: "100.00", paidAmount: "100.00", status: "PAID", sourceType: "ONLINE",
  });
  await db().update(s.onlineOrders).set({ invoiceId: 1, deliveryPartyId: 1 }).where(eq(s.onlineOrders.id, orderId));
  // Redispatch keeps the existing invoice identity even when its source is INVOICE.
  await db().insert(s.deliveryConsignments).values({
    id: 1, consignmentNumber: "CN-PREPAID", branchId: 1, partyId: 1, invoiceId: 1,
    sourceType: "INVOICE", sourceId: 1, codAmount: "0.00", parcelStatus: "OUT_FOR_DELIVERY",
    moneyStatus: "SETTLED", status: "DISPATCHED",
  });
  await db().insert(s.loyaltyPrograms).values({ name: "نقاط التسليم", status: "ACTIVE", pointsPerIqd: "1.000000" });
  await db().insert(s.storefrontPushDevices).values({
    customerId: 1, tokenHash: "b".repeat(64), tokenCiphertext: "encrypted-test-token",
    platform: "ANDROID", appVersion: "1.0.0", transactionalOptIn: true,
  });
  return orderId;
}

describe("setOnlineOrderStatus — physical delivery authority", () => {
  it.each([false, true])("reads fee-only prepaid due after cancellation and redispatch (free shipping=%s)", async (deliveryFree) => {
    const id = await seedPrepaidDelivery();
    await db().update(s.invoices).set({ subtotal: "40000.00", total: "40000.00", paidAmount: "40000.00" }).where(eq(s.invoices.id, 1));
    await db().update(s.onlineOrders).set({ subtotal: "40000.00", total: "45000.00", shippingCost: "5000.00", deliveryFree }).where(eq(s.onlineOrders.id, id));
    for (const parcelStatus of ["CANCELLED", "OUT_FOR_DELIVERY"] as const) {
      await db().update(s.deliveryConsignments).set({ parcelStatus }).where(eq(s.deliveryConsignments.id, 1));
      await db().update(s.onlineOrders).set({ status: parcelStatus === "CANCELLED" ? "PROCESSING" : "SHIPPED" }).where(eq(s.onlineOrders.id, id));
      const detail = await getOnlineOrder(id, 1);
      const [row] = await listOnlineOrders({ scopedBranchId: 1 });
      expect(detail?.amountDueAtDoor).toBe(deliveryFree ? "0.00" : "5000.00");
      expect(row.amountDueAtDoor).toBe(detail?.amountDueAtDoor);
      expect(detail?.total).toBe("45000.00");
      expect(row.total).toBe("45000.00");
    }
  });

  it("keeps unbilled order total as due without adding shipping twice", async () => {
    const id = await seedOrder();
    await db().update(s.onlineOrders).set({ subtotal: "40000.00", total: "45000.00", shippingCost: "5000.00" }).where(eq(s.onlineOrders.id, id));
    expect((await getOnlineOrder(id, 1))?.amountDueAtDoor).toBe("45000.00");
    expect((await listOnlineOrders({ scopedBranchId: 1 }))[0].amountDueAtDoor).toBe("45000.00");
  });

  it("deducts current payments and returns and clamps overpayment before adding customer shipping", async () => {
    const id = await seedPrepaidDelivery();
    await db().update(s.onlineOrders).set({ shippingCost: "5000.00" }).where(eq(s.onlineOrders.id, id));
    for (const [paidAmount, expected] of [["10000.00", "30000.00"], ["40000.00", "5000.00"]]) {
      await db().update(s.invoices).set({ total: "40000.00", returnedTotal: "5000.00", paidAmount }).where(eq(s.invoices.id, 1));
      expect((await getOnlineOrder(id, 1))?.amountDueAtDoor).toBe(expected);
      expect((await listOnlineOrders({ scopedBranchId: 1 }))[0].amountDueAtDoor).toBe(expected);
    }
  });

  it("rejects prepaid COD-zero redispatch before physical delivery without loyalty or delivered push", async () => {
    const id = await seedPrepaidDelivery();

    await expect(setOnlineOrderStatus({ id, status: "DELIVERED", scopedBranchId: 1 }, 1))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect((await getOrder(id)).status).toBe("SHIPPED");
    expect(await db().select().from(s.loyaltyLedgerEntries)).toHaveLength(0);
    expect(await db().select().from(s.storefrontPushCampaigns)).toHaveLength(0);
    expect(await db().select().from(s.storefrontPushDeliveries)).toHaveLength(0);
  });

  it("accepts locked delivered proof and repeats without duplicate loyalty or push", async () => {
    const id = await seedPrepaidDelivery();
    await db().update(s.deliveryConsignments).set({ parcelStatus: "DELIVERED" }).where(eq(s.deliveryConsignments.id, 1));
    await setOnlineOrderStatus({ id, status: "DELIVERED", scopedBranchId: 1 }, 1);
    await setOnlineOrderStatus({ id, status: "DELIVERED", scopedBranchId: 1 }, 1);
    expect((await getOrder(id)).status).toBe("DELIVERED");
    const ledger = await db().select().from(s.loyaltyLedgerEntries);
    expect(ledger).toHaveLength(1);
    expect(ledger[0].entryType).toBe("ORDER_EARN");
    expect(await db().select().from(s.storefrontPushCampaigns)).toHaveLength(1);
    expect(await db().select().from(s.storefrontPushDeliveries)).toHaveLength(1);
  });

  it("rolls back promptly on an occupied parcel and releases the order for the parcel writer", async () => {
    const id = await seedPrepaidDelivery();
    await db().update(s.deliveryConsignments).set({ parcelStatus: "DELIVERED" }).where(eq(s.deliveryConsignments.id, 1));
    let pending: Promise<unknown> | undefined;
    let observed: unknown;
    const timedOut = Symbol("proof waited on parcel");
    let timeout: ReturnType<typeof setTimeout> | undefined;
    await db().transaction(async (parcelWriter) => {
      // A real independent connection holds the parcel, as courier/assignment writers do.
      await parcelWriter.select({ id: s.deliveryConsignments.id }).from(s.deliveryConsignments)
        .where(eq(s.deliveryConsignments.id, 1)).for("update");
      pending = setOnlineOrderStatus({ id, status: "DELIVERED", scopedBranchId: 1 }, 1)
        .catch((error: unknown) => error);
      try {
        observed = await Promise.race([
          pending,
          new Promise((resolve) => { timeout = setTimeout(() => resolve(timedOut), 3000); }),
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
      if (observed !== timedOut) {
        // The failed service must already have released its order lock while our parcel
        // lock is still held. NOWAIT also makes a retained order lock fail immediately.
        const [order] = await parcelWriter.select().from(s.onlineOrders)
          .where(eq(s.onlineOrders.id, id)).for("update", { noWait: true });
        expect(order.status).toBe("SHIPPED");
        await parcelWriter.update(s.onlineOrders).set({ contactNotes: "parcel writer progressed" })
          .where(eq(s.onlineOrders.id, id));
      }
    });
    // Even the old blocking implementation is drained after releasing the fixture lock,
    // preventing an orphan service transaction from contaminating the next test.
    await pending;
    expect(observed).not.toBe(timedOut);
    expect(observed).toMatchObject({ code: "CONFLICT" });
    expect((await getOrder(id)).status).toBe("SHIPPED");
    expect((await getOrder(id)).contactNotes).toBe("parcel writer progressed");
    expect(await db().select().from(s.loyaltyAccounts)).toHaveLength(0);
    expect(await db().select().from(s.loyaltyLedgerEntries)).toHaveLength(0);
    expect(await db().select().from(s.storefrontPushCampaigns)).toHaveLength(0);
    expect(await db().select().from(s.storefrontPushDeliveries)).toHaveLength(0);
    await setOnlineOrderStatus({ id, status: "DELIVERED", scopedBranchId: 1 }, 1);
    expect((await getOrder(id)).status).toBe("DELIVERED");
    expect(await db().select().from(s.loyaltyLedgerEntries)).toHaveLength(1);
    expect(await db().select().from(s.storefrontPushCampaigns)).toHaveLength(1);
  });

  it("rejects a delivery-linked order with missing consignment proof", async () => {
    const id = await seedPrepaidDelivery();
    await db().delete(s.deliveryConsignments);
    await expect(setOnlineOrderStatus({ id, status: "DELIVERED", scopedBranchId: 1 }, 1))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect((await getOrder(id)).status).toBe("SHIPPED");
  });

  it("uses linked parcel proof even when the order delivery-party header is absent", async () => {
    const id = await seedPrepaidDelivery();
    await db().update(s.onlineOrders).set({ deliveryPartyId: null }).where(eq(s.onlineOrders.id, id));
    await expect(setOnlineOrderStatus({ id, status: "DELIVERED", scopedBranchId: 1 }, 1))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect((await getOrder(id)).status).toBe("SHIPPED");
  });
});

describe("setOnlineOrderStatus — سبب الإلغاء + مرحلة التجهيز", () => {
  it("يرفض تأكيد طلب انتهت مهلة حجز مخزونه ويبقيه PENDING", async () => {
    const id = await seedOrder("PENDING");
    await db().execute(sql`
      UPDATE onlineOrders
      SET reservationExpiresAt = DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 1 SECOND)
      WHERE id = ${id}
    `);

    await expect(
      setOnlineOrderStatus({ id, status: "CONFIRMED", scopedBranchId: null }, 1),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await getOrder(id)).status).toBe("PENDING");
  });

  it("يرفض تأكيد PENDING قديم كتبه إصدار مختلط بلا لقطة انتهاء", async () => {
    const id = await seedOrder("PENDING");
    await db().execute(sql`
      UPDATE onlineOrders
      SET reservationExpiresAt = NULL,
          orderDate = DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 25 HOUR)
      WHERE id = ${id}
    `);

    await expect(
      setOnlineOrderStatus({ id, status: "CONFIRMED", scopedBranchId: null }, 1),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await getOrder(id)).status).toBe("PENDING");
  });

  it("إلغاء يدويّ (بلا فاتورة) يُثبِّت سبب الإلغاء", async () => {
    const id = await seedOrder("PENDING");
    await setOnlineOrderStatus({ id, status: "CANCELLED", scopedBranchId: null, cancelReason: "نفد المخزون" }, 1);
    const o = await getOrder(id);
    expect(o.status).toBe("CANCELLED");
    expect(o.cancelReason).toBe("نفد المخزون");
  });

  it("انتقالٌ غير إلغاء لا يمسّ cancelReason (لا يطمس سبباً سابقاً)", async () => {
    const id = await seedOrder("CONFIRMED", { cancelReason: "سبب سابق" });
    await setOnlineOrderStatus({ id, status: "PROCESSING", scopedBranchId: null }, 1);
    const o = await getOrder(id);
    expect(o.status).toBe("PROCESSING");
    expect(o.cancelReason).toBe("سبب سابق");
  });

  it("إلغاء بلا سبب ⇒ cancelReason = null", async () => {
    const id = await seedOrder("PENDING");
    await setOnlineOrderStatus({ id, status: "CANCELLED", scopedBranchId: null }, 1);
    const o = await getOrder(id);
    expect(o.cancelReason).toBeNull();
  });

  it("CONFIRMED → PROCESSING مسموح (مرحلة التجهيز — GAP A)", async () => {
    const id = await seedOrder("CONFIRMED");
    const res = await setOnlineOrderStatus({ id, status: "PROCESSING", scopedBranchId: null }, 1);
    expect(res.from).toBe("CONFIRMED");
    expect(res.to).toBe("PROCESSING");
  });

  it("يُنشئ إشعار حالة موجهاً لأجهزة العميل داخل نفس المعاملة ومن دون تكرار", async () => {
    await db().insert(s.storefrontPushDevices).values({
      customerId: 1,
      tokenHash: "a".repeat(64),
      tokenCiphertext: "encrypted-test-token",
      platform: "ANDROID",
      appVersion: "1.0.0",
      marketingOptIn: false,
      transactionalOptIn: true,
    });
    const id = await seedOrder("PENDING");

    await setOnlineOrderStatus({ id, status: "CONFIRMED", scopedBranchId: null }, 1);
    await setOnlineOrderStatus({ id, status: "CONFIRMED", scopedBranchId: null }, 1);

    const campaigns = await db().select().from(s.storefrontPushCampaigns);
    const deliveries = await db().select().from(s.storefrontPushDeliveries);
    expect(campaigns).toHaveLength(1);
    expect(campaigns[0]).toMatchObject({
      eventKey: `storefront-order:${id}:status:CONFIRMED`,
      kind: "TRANSACTIONAL",
      status: "RUNNING",
      destination: "/orders",
      recipientCount: 1,
    });
    expect(campaigns[0].body).toContain((await getOrder(id)).orderNumber);
    expect(deliveries).toHaveLength(1);
  });
});

describe("claimOnlineOrder — Pessimistic Row Locking & Rejection of Duplicate/Concurrent Claims", () => {
  it("موظف يستلم طلباً وارداً (PENDING) بنجاح ويتحول الطلب إلى CONFIRMED ومسجلاً باسمه", async () => {
    const id = await seedOrder("PENDING");
    const res = await claimOnlineOrder({ id, scopedBranchId: 1 }, { userId: 2, role: "user" });

    expect(res.success).toBe(true);
    expect(res.claimedByUserId).toBe(2);

    const o = await getOrder(id);
    expect(o.status).toBe("CONFIRMED");
    expect(o.claimedByUserId).toBe(2);
    expect(o.claimedAt).not.toBeNull();
  });

  it("رفض استلام طلب مستلم مسبقاً من موظف آخر (CONFLICT)", async () => {
    const id = await seedOrder("CONFIRMED", { claimedByUserId: 2, claimedAt: new Date() });

    await expect(
      claimOnlineOrder({ id, scopedBranchId: 1 }, { userId: 3, role: "user" }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
    });

    const o = await getOrder(id);
    expect(o.claimedByUserId).toBe(2);
  });

  it("استلام نفس الموظف للطلب مرة أخرى idempotent ولا يغير تاريخ الاستلام الأصلي", async () => {
    const originalClaimedAt = new Date(Math.floor((Date.now() - 1000 * 60 * 10) / 1000) * 1000);
    const id = await seedOrder("CONFIRMED", { claimedByUserId: 2, claimedAt: originalClaimedAt });

    const res = await claimOnlineOrder({ id, scopedBranchId: 1 }, { userId: 2, role: "user" });
    expect(res.success).toBe(true);

    const o = await getOrder(id);
    expect(o.claimedByUserId).toBe(2);
    expect(Math.floor(new Date(o.claimedAt!).getTime() / 1000)).toBe(Math.floor(originalClaimedAt.getTime() / 1000));
  });

  it("المدير أو الأدمن يستطيع إعادة تعيين/استلام طلب محجوز لموظف آخر", async () => {
    const id = await seedOrder("CONFIRMED", { claimedByUserId: 2, claimedAt: new Date() });

    const res = await claimOnlineOrder({ id, scopedBranchId: 1 }, { userId: 4, role: "manager" });
    expect(res.success).toBe(true);
    expect(res.claimedByUserId).toBe(4);

    const o = await getOrder(id);
    expect(o.claimedByUserId).toBe(4);
  });

  it("تنافس موظفين في نفس اللحظة (Race Condition) — قفل الصف يضمن فوز موظف واحد فقط ورفض الآخر", async () => {
    const id = await seedOrder("PENDING");

    const results = await Promise.allSettled([
      claimOnlineOrder({ id, scopedBranchId: null }, { userId: 2, role: "user" }),
      claimOnlineOrder({ id, scopedBranchId: null }, { userId: 3, role: "user" }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const winningUserId = (fulfilled[0] as PromiseFulfilledResult<any>).value.claimedByUserId;
    expect([2, 3]).toContain(winningUserId);

    const o = await getOrder(id);
    expect(o.claimedByUserId).toBe(winningUserId);
    expect(o.status).toBe("CONFIRMED");
  });

  it("رفض استلام طلب بحالة نهائية (CANCELLED أو DELIVERED أو SHIPPED)", async () => {
    const cancelledId = await seedOrder("CANCELLED");
    await expect(
      claimOnlineOrder({ id: cancelledId, scopedBranchId: null }, { userId: 2, role: "user" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const deliveredId = await seedOrder("DELIVERED");
    await expect(
      claimOnlineOrder({ id: deliveredId, scopedBranchId: null }, { userId: 2, role: "user" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const shippedId = await seedOrder("SHIPPED");
    await expect(
      claimOnlineOrder({ id: shippedId, scopedBranchId: null }, { userId: 2, role: "user" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("رفض استلام طلب انتهت مهلة حجز مخزونه (24 ساعة) ويبقيه PENDING", async () => {
    const id = await seedOrder("PENDING");
    await db().execute(sql`
      UPDATE onlineOrders
      SET reservationExpiresAt = DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 1 MINUTE)
      WHERE id = ${id}
    `);

    await expect(
      claimOnlineOrder({ id, scopedBranchId: null }, { userId: 2, role: "user" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const o = await getOrder(id);
    expect(o.status).toBe("PENDING");
    expect(o.claimedByUserId).toBeNull();
  });
});

describe("markOnlineOrderPrepared — State Guards, Attribution & Duration Calculation", () => {
  it("رفض تجهيز طلب وارد (PENDING) مباشرة قبل تأكيده", async () => {
    const id = await seedOrder("PENDING");
    await expect(
      markOnlineOrderPrepared({ id, scopedBranchId: null }, { userId: 2, role: "user" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const o = await getOrder(id);
    expect(o.status).toBe("PENDING");
    expect(o.preparedByUserId).toBeNull();
  });

  it("رفض تجهيز طلب ملغى (CANCELLED)", async () => {
    const id = await seedOrder("CANCELLED");
    await expect(
      markOnlineOrderPrepared({ id, scopedBranchId: null }, { userId: 2, role: "user" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("رفض تجهيز طلب مرسل أو مسلّم (SHIPPED أو DELIVERED)", async () => {
    const shippedId = await seedOrder("SHIPPED");
    await expect(
      markOnlineOrderPrepared({ id: shippedId, scopedBranchId: null }, { userId: 2, role: "user" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const deliveredId = await seedOrder("DELIVERED");
    await expect(
      markOnlineOrderPrepared({ id: deliveredId, scopedBranchId: null }, { userId: 2, role: "user" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("رفض تجهيز الطلب إذا كان مستلماً للتجهيز بواسطة موظف آخر", async () => {
    const id = await seedOrder("CONFIRMED", { claimedByUserId: 2, claimedAt: new Date() });

    await expect(
      markOnlineOrderPrepared({ id, scopedBranchId: null }, { userId: 3, role: "user" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const o = await getOrder(id);
    expect(o.preparedByUserId).toBeNull();
    expect(o.status).toBe("CONFIRMED");
  });

  it("الموظف المستلم يضع علامة تم التجهيز وتتحول الحالة إلى PROCESSING ويُحسب الوقت بالدقائق", async () => {
    const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000);
    const id = await seedOrder("CONFIRMED", {
      claimedByUserId: 2,
      claimedAt: fifteenMinutesAgo,
    });

    const res = await markOnlineOrderPrepared({ id, scopedBranchId: null }, { userId: 2, role: "user" });
    expect(res.success).toBe(true);
    expect(res.durationMinutes).toBe(15);

    const o = await getOrder(id);
    expect(o.status).toBe("PROCESSING");
    expect(o.preparedByUserId).toBe(2);
    expect(o.fulfillmentDurationMinutes).toBe(15);
    expect(o.preparedAt).not.toBeNull();
  });

  it("احتساب الحد الأدنى لدقيقة واحدة حتى لو اكتمل التجهيز في بضع ثوانٍ", async () => {
    const fiveSecondsAgo = new Date(Date.now() - 5 * 1000);
    const id = await seedOrder("CONFIRMED", {
      claimedByUserId: 2,
      claimedAt: fiveSecondsAgo,
    });

    const res = await markOnlineOrderPrepared({ id, scopedBranchId: null }, { userId: 2, role: "user" });
    expect(res.success).toBe(true);
    expect(res.durationMinutes).toBe(1);

    const o = await getOrder(id);
    expect(o.fulfillmentDurationMinutes).toBe(1);
  });

  it("المدير يستطيع إتمام تجهيز طلب حتى لو كان مستلماً لموظف آخر", async () => {
    const id = await seedOrder("CONFIRMED", {
      claimedByUserId: 2,
      claimedAt: new Date(Date.now() - 10 * 60 * 1000),
    });

    const res = await markOnlineOrderPrepared({ id, scopedBranchId: null }, { userId: 4, role: "manager" });
    expect(res.success).toBe(true);

    const o = await getOrder(id);
    expect(o.preparedByUserId).toBe(4);
    expect(o.status).toBe("PROCESSING");
  });

  it("استدعاء markOnlineOrderPrepared مرتين لنفس الموظف idempotent ولا يعدل preparedAt أو المدة الأصلية", async () => {
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    const id = await seedOrder("CONFIRMED", {
      claimedByUserId: 2,
      claimedAt: tenMinutesAgo,
    });

    const firstRes = await markOnlineOrderPrepared({ id, scopedBranchId: null }, { userId: 2, role: "user" });
    expect(firstRes.success).toBe(true);
    expect(firstRes.durationMinutes).toBe(10);
    expect(firstRes.idempotent).toBe(false);

    const firstOrder = await getOrder(id);
    expect(firstOrder.status).toBe("PROCESSING");
    expect(firstOrder.preparedByUserId).toBe(2);
    expect(firstOrder.fulfillmentDurationMinutes).toBe(10);
    const firstPreparedAt = new Date(firstOrder.preparedAt!).getTime();

    // استدعاء ثانٍ لنفس الموظف
    const secondRes = await markOnlineOrderPrepared({ id, scopedBranchId: null }, { userId: 2, role: "user" });
    expect(secondRes.success).toBe(true);
    expect(secondRes.idempotent).toBe(true);
    expect(secondRes.durationMinutes).toBe(10);

    const secondOrder = await getOrder(id);
    expect(new Date(secondOrder.preparedAt!).getTime()).toBe(firstPreparedAt);
    expect(secondOrder.fulfillmentDurationMinutes).toBe(10);
    expect(secondOrder.preparedByUserId).toBe(2);
  });

  it("المدير يستدعي markOnlineOrderPrepared لطلب مجهز مسبقاً بشكل idempotent دون تغيير وقت التجهيز الأصلي", async () => {
    const twentyMinutesAgo = new Date(Date.now() - 20 * 60 * 1000);
    const id = await seedOrder("CONFIRMED", {
      claimedByUserId: 2,
      claimedAt: twentyMinutesAgo,
    });

    const firstRes = await markOnlineOrderPrepared({ id, scopedBranchId: null }, { userId: 2, role: "user" });
    expect(firstRes.success).toBe(true);
    expect(firstRes.durationMinutes).toBe(20);

    const firstOrder = await getOrder(id);
    const originalPreparedAt = new Date(firstOrder.preparedAt!).getTime();

    const managerRes = await markOnlineOrderPrepared({ id, scopedBranchId: null }, { userId: 4, role: "manager" });
    expect(managerRes.success).toBe(true);
    expect(managerRes.idempotent).toBe(true);
    expect(managerRes.durationMinutes).toBe(20);

    const afterManagerOrder = await getOrder(id);
    expect(new Date(afterManagerOrder.preparedAt!).getTime()).toBe(originalPreparedAt);
    expect(afterManagerOrder.preparedByUserId).toBe(2);
  });

  it("رفض تجهيز طلب مجهز مسبقاً لموظف آخر إذا كان المستدعي موظفاً عادياً (CONFLICT)", async () => {
    const id = await seedOrder("CONFIRMED", {
      claimedByUserId: 2,
      claimedAt: new Date(Date.now() - 10 * 60 * 1000),
    });

    await markOnlineOrderPrepared({ id, scopedBranchId: null }, { userId: 2, role: "user" });

    await expect(
      markOnlineOrderPrepared({ id, scopedBranchId: null }, { userId: 3, role: "user" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("updateOnlineOrderContact — Atomic Contact Updates & Notes Persistence", () => {
  it("تحديث حالة الاتصال إلى WHATSAPP_SENT مع حفظ الملاحظات ذرّياً", async () => {
    const id = await seedOrder("PENDING");

    const res = await updateOnlineOrderContact(
      {
        id,
        contactStatus: "WHATSAPP_SENT",
        contactNotes: "تم مراسلة العميل عبر الواتساب لتأكيد العنوان",
        scopedBranchId: null,
      },
      { userId: 2, role: "user" }
    );

    expect(res.success).toBe(true);
    expect(res.contactStatus).toBe("WHATSAPP_SENT");

    const o = await getOrder(id);
    expect(o.contactStatus).toBe("WHATSAPP_SENT");
    expect(o.contactNotes).toBe("تم مراسلة العميل عبر الواتساب لتأكيد العنوان");
    expect(o.claimedByUserId).toBeNull();
    expect(o.status).toBe("PENDING");
  });

  it("تأكيد هاتفياً (CALLED_CONFIRMED) يحوّل الطلب الوارد PENDING إلى CONFIRMED ويسجل المستلم", async () => {
    const id = await seedOrder("PENDING");

    const res = await updateOnlineOrderContact(
      {
        id,
        contactStatus: "CALLED_CONFIRMED",
        contactNotes: "تم الاتصال بالعميل وأكد الطلب هاتفياً",
        scopedBranchId: null,
      },
      { userId: 2, role: "user" }
    );

    expect(res.success).toBe(true);

    const o = await getOrder(id);
    expect(o.status).toBe("CONFIRMED");
    expect(o.contactStatus).toBe("CALLED_CONFIRMED");
    expect(o.claimedByUserId).toBe(2);
  });

  it("رفض تأكيد طلب منتهي الصلاحية هاتفياً (CALLED_CONFIRMED على PENDING منتهي)", async () => {
    const id = await seedOrder("PENDING");
    await db().execute(sql`
      UPDATE onlineOrders
      SET reservationExpiresAt = DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 2 HOUR)
      WHERE id = ${id}
    `);

    await expect(
      updateOnlineOrderContact(
        {
          id,
          contactStatus: "CALLED_CONFIRMED",
          scopedBranchId: null,
        },
        { userId: 2, role: "user" }
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const o = await getOrder(id);
    expect(o.status).toBe("PENDING");
  });

  it("رفض تحديث حالة الاتصال لطلب بحالة نهائية (CANCELLED)", async () => {
    const id = await seedOrder("CANCELLED");

    await expect(
      updateOnlineOrderContact(
        {
          id,
          contactStatus: "WHATSAPP_SENT",
          scopedBranchId: null,
        },
        { userId: 2, role: "user" }
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("onlineOrderExpirySweeper — 24h Reservation Expiry Sweep", () => {
  it("عامل الكنس يلغي الطلبات المنتهية فقط ويبقي الطلبات النشطة والمؤكدة", async () => {
    const expiredPendingId = await seedOrder("PENDING");
    await db().execute(sql`
      UPDATE onlineOrders
      SET reservationExpiresAt = DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 1 HOUR)
      WHERE id = ${expiredPendingId}
    `);

    const activePendingId = await seedOrder("PENDING");
    await db().execute(sql`
      UPDATE onlineOrders
      SET reservationExpiresAt = DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL 10 HOUR)
      WHERE id = ${activePendingId}
    `);

    const confirmedId = await seedOrder("CONFIRMED");
    await db().execute(sql`
      UPDATE onlineOrders
      SET reservationExpiresAt = DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 1 HOUR)
      WHERE id = ${confirmedId}
    `);

    const sweepRes = await sweepExpiredOnlineOrdersOnce(new Date());
    expect(sweepRes.cancelled).toBeGreaterThanOrEqual(1);

    const expiredO = await getOrder(expiredPendingId);
    expect(expiredO.status).toBe("CANCELLED");
    expect(expiredO.cancelReason).toContain("انتهت مهلة حجز المخزون");

    const activeO = await getOrder(activePendingId);
    expect(activeO.status).toBe("PENDING");

    const confirmedO = await getOrder(confirmedId);
    expect(confirmedO.status).toBe("CONFIRMED");
  });
});

describe("reviveAndConfirmOnlineOrder — إحياء الطلبات منتهية الحجز والتأكيد المباشر", () => {
  it("إحياء طلب منتهي الحجز (CANCELLED) يعيد تمديد الحجز 24 ساعة ويؤكده ويسنده للموظف", async () => {
    const expiredOrderId = await seedOrder("CANCELLED", {
      cancelReason: "انتهت مهلة حجز المخزون (24 ساعة تلقائياً)",
    });
    await db().execute(sql`
      UPDATE onlineOrders
      SET reservationExpiresAt = DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 2 HOUR)
      WHERE id = ${expiredOrderId}
    `);

    const result = await reviveAndConfirmOnlineOrder(
      { id: expiredOrderId, scopedBranchId: 1 },
      { userId: 2, role: "user" }
    );

    expect(result.success).toBe(true);
    expect(result.status).toBe("CONFIRMED");
    expect(result.claimedByUserId).toBe(2);

    const order = await getOrder(expiredOrderId);
    expect(order.status).toBe("CONFIRMED");
    expect(order.claimedByUserId).toBe(2);
    expect(order.cancelReason).toBeNull();
    expect(new Date(order.reservationExpiresAt!).getTime()).toBeGreaterThan(Date.now());
  });

  it("يرفض إحياء طلب ليس بحالة PENDING أو CANCELLED (مثل SHIPPED أو DELIVERED)", async () => {
    const shippedId = await seedOrder("SHIPPED");

    await expect(
      reviveAndConfirmOnlineOrder(
        { id: shippedId, scopedBranchId: 1 },
        { userId: 2, role: "user" }
      )
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("يرفض إحياء الطلب إذا كان المخزون الحر في الفرع أقل من baseQuantity المطلوبة", async () => {
    // إدخال منتج ووحدة ورصيد مخزون أساس
    await db().insert(s.products).values({
      id: 99,
      name: "دفتر تجريبي",
      type: "STOCK",
    }).onDuplicateKeyUpdate({ set: { name: "دفتر تجريبي" } });

    await db().insert(s.productVariants).values({
      id: 99,
      productId: 99,
      sku: "TEST-SKU-99",
      costPrice: "1000.00",
      isActive: true,
    }).onDuplicateKeyUpdate({ set: { sku: "TEST-SKU-99" } });

    await db().insert(s.productUnits).values({
      id: 99,
      variantId: 99,
      unitName: "درزن (12)",
      conversionFactor: "12.0000",
      isBaseUnit: false,
      isStoreSaleUnit: true,
      isActive: true,
    }).onDuplicateKeyUpdate({ set: { unitName: "درزن (12)" } });

    // رصيد المخزون في الفرع 15 وحدة أساس فقط (يكفي علبة واحدة 12، لكن لا يكفي درزنين 24)
    await db().insert(s.branchStock).values({
      variantId: 99,
      branchId: 1,
      quantity: 15,
    }).onDuplicateKeyUpdate({ set: { quantity: 15 } });

    const expiredId = await seedOrder("CANCELLED", {
      cancelReason: "انتهت مهلة حجز المخزون (24 ساعة تلقائياً)",
    });

    // إضافة بند: 2 درزن (كمية العرض 2، الكمية الأساسية 24)
    await db().insert(s.onlineOrderItems).values({
      onlineOrderId: expiredId,
      variantId: 99,
      productUnitId: 99,
      unitPrice: "10000.00",
      quantity: 2,
      baseQuantity: 24,
      total: "20000.00",
    });

    await expect(
      reviveAndConfirmOnlineOrder(
        { id: expiredId, scopedBranchId: 1 },
        { userId: 2, role: "user" }
      )
    ).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });
});

describe("autoAssignRoundRobinOnlineOrders — توزيع الورديات الذكي وموازنة العبء الفعلي", () => {
  async function seedOtherBranchOrderWithCoupon() {
    await db().insert(s.branches).values({ id: 2, name: "الفرع الآخر", code: "OTHER", type: "SALES" })
      .onDuplicateKeyUpdate({ set: { name: "الفرع الآخر" } });
    await db().insert(s.shifts).values({ branchId: 2, userId: 3, openingBalance: "0", status: "OPEN", shiftType: "RETAIL", openGuard: "3:2:RETAIL" });
    const id = await seedOrder("PENDING");
    await db().update(s.onlineOrders).set({ branchId: 2 }).where(eq(s.onlineOrders.id, id));
    await db().insert(s.promotions).values({ id: 50, name: "عرض", type: "PERCENT", discountPercent: "10.00", scope: "ALL", effectiveFrom: new Date("2026-01-01") });
    await db().insert(s.couponPrograms).values({ id: 50, promotionId: 50, name: "قسيمة", status: "ACTIVE", branchId: 2, validFrom: new Date("2026-01-01"), createdBy: 1 });
    await db().insert(s.coupons).values({ id: 50, programId: 50, code: "SCOPE50", codeHash: "5".repeat(64) });
    await db().insert(s.couponReservations).values({
      couponId: 50, programId: 50, onlineOrderId: id, customerId: 1, branchId: 2,
      discountAmount: "10.00", expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    return id;
  }

  it.each(["manager", "cashier"])("rejects cross-branch %s before any order or coupon mutation", async (role) => {
    const id = await seedOtherBranchOrderWithCoupon();
    const beforeOrder = await getOrder(id);
    const beforeCoupon = await db().select().from(s.couponReservations);
    await expect(autoAssignRoundRobinOnlineOrders({ scopedBranchId: 2 }, { userId: 4, branchId: 1, role }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await getOrder(id)).toEqual(beforeOrder);
    expect(await db().select().from(s.couponReservations)).toEqual(beforeCoupon);
    expect(await db().select().from(s.storefrontPushCampaigns)).toHaveLength(0);
  });

  it.each(["manager", "cashier"] as const)("rejects branch override through the %s router caller without mutations", async (role) => {
    const id = await seedOtherBranchOrderWithCoupon();
    const [user] = await db().select().from(s.users).where(eq(s.users.id, 4));
    const caller = storeAdminRouter.createCaller({
      req: { headers: {}, ip: "127.0.0.1" }, res: {}, sessionId: null,
      user: { ...user, role, permissionsOverride: { store: "FULL" } },
    } as never);
    const beforeOrder = await getOrder(id);
    const beforeCoupon = await db().select().from(s.couponReservations);
    await expect(caller.orders.autoAssignRoundRobin({ branchId: 2 }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await getOrder(id)).toEqual(beforeOrder);
    expect(await db().select().from(s.couponReservations)).toEqual(beforeCoupon);
  });

  it("accepts the manager router caller for its assigned branch", async () => {
    const id = await seedOrder("PENDING");
    await db().insert(s.shifts).values({ branchId: 1, userId: 2, openingBalance: "0", status: "OPEN", shiftType: "RETAIL", openGuard: "2:1:RETAIL" });
    const [user] = await db().select().from(s.users).where(eq(s.users.id, 4));
    const caller = storeAdminRouter.createCaller({
      req: { headers: {}, ip: "127.0.0.1" }, res: {}, sessionId: null,
      user: { ...user, permissionsOverride: { store: "FULL" } },
    } as never);
    const result = await caller.orders.autoAssignRoundRobin({ branchId: 1 });
    expect(result.assignments.map((row) => row.orderId)).toEqual([id]);
    expect((await getOrder(id)).status).toBe("CONFIRMED");
  });

  it("derives missing scope from the actor branch and leaves other branch coupons untouched", async () => {
    const otherId = await seedOtherBranchOrderWithCoupon();
    await db().insert(s.shifts).values({ branchId: 1, userId: 2, openingBalance: "0", status: "OPEN", shiftType: "RETAIL", openGuard: "2:1:RETAIL" });
    const ownId = await seedOrder("PENDING");
    const beforeCoupon = await db().select().from(s.couponReservations);
    const result = await autoAssignRoundRobinOnlineOrders({ scopedBranchId: null }, { userId: 4, branchId: 1, role: "manager" });
    expect(result.assignments.map((row) => row.orderId)).toEqual([ownId]);
    expect((await getOrder(ownId)).status).toBe("CONFIRMED");
    expect((await getOrder(otherId)).status).toBe("PENDING");
    expect(await db().select().from(s.couponReservations)).toEqual(beforeCoupon);
  });

  it.each([
    { userId: 1, branchId: 1, role: "admin" },
    { userId: 4, branchId: 1, role: "manager", isOwner: true },
  ])("preserves authorized cross-branch assignment for $role / owner=$isOwner", async (actor) => {
    const id = await seedOtherBranchOrderWithCoupon();
    const result = await autoAssignRoundRobinOnlineOrders({ scopedBranchId: 2 }, actor);
    expect(result.assignments.map((row) => row.orderId)).toEqual([id]);
    expect((await getOrder(id)).status).toBe("CONFIRMED");
    expect((await db().select().from(s.couponReservations))[0].expiresAt).toBeNull();
  });

  it("rejects an unassigned branch actor even when an input scope is supplied", async () => {
    const id = await seedOtherBranchOrderWithCoupon();
    await expect(autoAssignRoundRobinOnlineOrders({ scopedBranchId: 2 }, { userId: 4, branchId: null, role: "manager" }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await getOrder(id)).status).toBe("PENDING");
  });

  it("يسند الطلبات حصراً للموظفين أصحاب الورديات المفتوحة (Shift-Aware)", async () => {
    // موظف 2 لديه وردية مفتوحة
    await db().insert(s.shifts).values({
      branchId: 1,
      userId: 2,
      openingBalance: "0",
      status: "OPEN",
      shiftType: "RETAIL",
      openGuard: "2:1:RETAIL",
    });

    // موظف 3 لديه وردية مغلقة
    await db().insert(s.shifts).values({
      branchId: 1,
      userId: 3,
      openingBalance: "0",
      status: "CLOSED",
      shiftType: "RETAIL",
      openGuard: null,
    });

    const o1 = await seedOrder("PENDING");
    const o2 = await seedOrder("PENDING");

    const res = await autoAssignRoundRobinOnlineOrders(
      { scopedBranchId: 1 },
      { userId: 1, branchId: 1, role: "admin" }
    );

    expect(res.assignedCount).toBe(2);
    expect(res.assignments.every((a) => a.assignedToUserId === 2)).toBe(true);

    const row1 = await getOrder(o1);
    const row2 = await getOrder(o2);
    expect(row1.claimedByUserId).toBe(2);
    expect(row1.status).toBe("CONFIRMED");
    expect(row2.claimedByUserId).toBe(2);
    expect(row2.status).toBe("CONFIRMED");
  });

  it("يوازن العبء الفعلي ويختار الموظف الأقل حملاً من بين الورديات المفتوحة (Least-Loaded)", async () => {
    // كلا الموظفين 2 و 3 لديهما وردية مفتوحة
    await db().insert(s.shifts).values([
      {
        branchId: 1,
        userId: 2,
        openingBalance: "0",
        status: "OPEN",
        shiftType: "RETAIL",
        openGuard: "2:1:RETAIL",
      },
      {
        branchId: 1,
        userId: 3,
        openingBalance: "0",
        status: "OPEN",
        shiftType: "RETAIL",
        openGuard: "3:1:RETAIL",
      },
    ]);

    // موظف 2 لديه مسبقاً طلبان قيد التجهيز
    await seedOrder("CONFIRMED", { claimedByUserId: 2 });
    await seedOrder("PROCESSING", { claimedByUserId: 2 });

    // موظف 3 لديه طلب واحد فقط
    await seedOrder("CONFIRMED", { claimedByUserId: 3 });

    // طلب جديد غير مسند
    const newOrder = await seedOrder("PENDING");

    const res = await autoAssignRoundRobinOnlineOrders(
      { scopedBranchId: 1 },
      { userId: 1, branchId: 1, role: "admin" }
    );

    expect(res.assignedCount).toBe(1);
    expect(res.assignments[0].assignedToUserId).toBe(3);

    const updated = await getOrder(newOrder);
    expect(updated.claimedByUserId).toBe(3);
    expect(updated.status).toBe("CONFIRMED");
  });

  it("يعزل الفروع ولا يسند طلبات فرع لموظفي فرع آخر حتى لو كان للفرع الأول وردية مفتوحة", async () => {
    await db()
      .insert(s.branches)
      .values({ id: 2, name: "فرع الكرخ", code: "KARKH", type: "SALES" })
      .onDuplicateKeyUpdate({ set: { name: "فرع الكرخ" } });

    // موظف 2 لديه وردية مفتوحة في فرع 1
    await db().insert(s.shifts).values({
      branchId: 1,
      userId: 2,
      openingBalance: "0",
      status: "OPEN",
      shiftType: "RETAIL",
      openGuard: "2:1:RETAIL",
    });

    // طلب يخص فرع 2
    const b2Order = await seedOrder("PENDING");
    await db().execute(sql`UPDATE onlineOrders SET branchId = 2 WHERE id = ${b2Order}`);

    // تشغيل التوزيع الآلي على مستوى النظام (scopedBranchId = null)
    const res = await autoAssignRoundRobinOnlineOrders(
      { scopedBranchId: null },
      { userId: 1, branchId: 1, role: "admin" }
    );

    // الطلب في فرع 2 لا يجب أن يُسند لموظف فرع 1
    expect(res.assignedCount).toBe(0);
    const b2Row = await getOrder(b2Order);
    expect(b2Row.claimedByUserId).toBeNull();
    expect(b2Row.status).toBe("PENDING");
  });
});

describe("closeShift — تحرير الطلبات غير المكتملة عند إغلاق الوردية", () => {
  it("يحرر الطلبات غير المكتملة (CONFIRMED/PROCESSING) ويعيد PROCESSING إلى CONFIRMED ويحفظ الطلبات المجهزة والمشحونة", async () => {
    const shift = await openShift(
      { branchId: 1, openingBalance: "0", shiftType: "RETAIL" },
      { userId: 2, branchId: 1 }
    );

    const pendingOrder = await seedOrder("PENDING", { claimedByUserId: 2 });
    const confirmedOrder = await seedOrder("CONFIRMED", { claimedByUserId: 2 });
    const processingOrder = await seedOrder("PROCESSING", { claimedByUserId: 2 });
    const preparedOrder = await seedOrder("PROCESSING", {
      claimedByUserId: 2,
      preparedByUserId: 2,
      preparedAt: new Date(),
    });
    const shippedOrder = await seedOrder("SHIPPED", { claimedByUserId: 2 });

    await closeShift(
      { shiftId: shift.shiftId, countedCash: "0" },
      { userId: 2, branchId: 1, role: "user" }
    );

    const pRow = await getOrder(pendingOrder);
    const cRow = await getOrder(confirmedOrder);
    const prRow = await getOrder(processingOrder);
    const prepRow = await getOrder(preparedOrder);
    const sRow = await getOrder(shippedOrder);

    expect(pRow.claimedByUserId).toBeNull();
    expect(cRow.claimedByUserId).toBeNull();
    expect(prRow.claimedByUserId).toBeNull();
    expect(prRow.status).toBe("CONFIRMED");

    // الطلب المجهز يحتفظ بمعرّف وتوقيت التجهيز
    expect(prepRow.preparedByUserId).toBe(2);
    expect(prepRow.preparedAt).not.toBeNull();

    expect(sRow.claimedByUserId).toBe(2);
  });
});

describe("updateOnlineOrder — إضافة صنف جديد وتحديث الطلب من لوحة المتجر", () => {
  it("يسمح للموظف بإضافة صنف من الكتالوج الموحّد (حتى لو لم يكن معروضاً علناً في المتجر) ويعيد تسعير الطلب بدقة", async () => {
    const d = db();
    await d.insert(s.products).values([
      { id: 101, name: "هايلايت Schneider JOP برتقالي", showInStore: true, isActive: true },
      { id: 102, name: "قلم تحديد باركود 4007817131404", showInStore: false, isActive: true },
    ]);
    await d.insert(s.productVariants).values([
      { id: 201, productId: 101, sku: "HL-ORG", color: "برتقالي", costPrice: "500.00", isActive: true },
      { id: 202, productId: 102, sku: "HL-4007", color: "أصفر", costPrice: "500.00", isActive: true },
    ]);
    await d.insert(s.productUnits).values([
      { id: 301, variantId: 201, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, isStoreSaleUnit: true, isActive: true },
      { id: 302, variantId: 202, unitName: "قطعة", barcode: "4007817131404", conversionFactor: "1", isBaseUnit: true, isStoreSaleUnit: false, isActive: true },
    ]);
    await d.insert(s.productPrices).values([
      { productUnitId: 301, priceTier: "RETAIL", price: "1000.00" },
      { productUnitId: 302, priceTier: "RETAIL", price: "1500.00" },
    ]);
    await d.insert(s.branchStock).values([
      { variantId: 201, branchId: 1, quantity: 20 },
      { variantId: 202, branchId: 1, quantity: 15 },
    ]);

    const orderId = await seedOrder("CONFIRMED");
    await d.insert(s.onlineOrderItems).values({
      onlineOrderId: orderId,
      variantId: 201,
      productUnitId: 301,
      quantity: "1.00",
      baseQuantity: 1,
      unitPrice: "1000.00",
      total: "1000.00",
    });

    const res = await updateOnlineOrder(
      {
        id: orderId,
        baselineFingerprint: (await getOnlineOrder(orderId, null))!.baselineFingerprint,
        scopedBranchId: null,
        governorate: "baghdad",
        items: [
          { productUnitId: 301, quantity: 2 },
          { productUnitId: 302, quantity: 1 },
        ],
      },
      1,
    );

    expect(res.id).toBe(orderId);
    // 2 * 1000 + 1 * 1500 = 3500 + أجرة توصيل بغداد 5000 = 8500
    expect(Number(res.subtotal)).toBe(3500);
    expect(Number(res.total)).toBe(8500);

    const savedItems = await d
      .select()
      .from(s.onlineOrderItems)
      .where(eq(s.onlineOrderItems.onlineOrderId, orderId));
    expect(savedItems).toHaveLength(2);
    expect(savedItems.map((i) => [i.productUnitId, Number(i.quantity)])).toEqual([
      [301, 2],
      [302, 1],
    ]);
  });

  it("يرفض إضافة صنف معطّل أو وحدة بلا سعر مفرد أو كمية تتجاوز الرصيد المتاح", async () => {
    const d = db();
    await d.insert(s.products).values([
      { id: 103, name: "صنف معطّل", showInStore: true, isActive: false },
      { id: 104, name: "صنف بلا سعر", showInStore: true, isActive: true },
    ]);
    await d.insert(s.productVariants).values([
      { id: 203, productId: 103, sku: "INACT-1", costPrice: "500.00", isActive: true },
      { id: 204, productId: 104, sku: "NOPRICE-1", costPrice: "500.00", isActive: true },
    ]);
    await d.insert(s.productUnits).values([
      { id: 303, variantId: 203, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, isStoreSaleUnit: true, isActive: true },
      { id: 304, variantId: 204, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, isStoreSaleUnit: true, isActive: true },
    ]);
    await d.insert(s.productPrices).values([
      { productUnitId: 303, priceTier: "RETAIL", price: "1000.00" },
    ]);
    await d.insert(s.branchStock).values([
      { variantId: 203, branchId: 1, quantity: 10 },
      { variantId: 204, branchId: 1, quantity: 5 },
    ]);

    const orderId = await seedOrder("CONFIRMED");

    // ١) صنف معطّل ⇒ CONFLICT
    await expect(
      updateOnlineOrder(
        { id: orderId,
        baselineFingerprint: (await getOnlineOrder(orderId, null))!.baselineFingerprint, scopedBranchId: null, items: [{ productUnitId: 303, quantity: 1 }] },
        1,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    // ٢) وحدة بلا سعر مفرد ⇒ CONFLICT
    await expect(
      updateOnlineOrder(
        { id: orderId,
        baselineFingerprint: (await getOnlineOrder(orderId, null))!.baselineFingerprint, scopedBranchId: null, items: [{ productUnitId: 304, quantity: 1 }] },
        1,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    // ٣) بعد إضافة السعر، طلب كمية تتجاوز الرصيد (10 > 5) ⇒ CONFLICT
    await d.insert(s.productPrices).values({ productUnitId: 304, priceTier: "RETAIL", price: "1200.00" });
    await expect(
      updateOnlineOrder(
        { id: orderId,
        baselineFingerprint: (await getOnlineOrder(orderId, null))!.baselineFingerprint, scopedBranchId: null, items: [{ productUnitId: 304, quantity: 10 }] },
        1,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    // ٤) تكرار نفس productUnitId في المصفوفة يُدمج في بند واحد (2 + 2 = 4 <= 5)
    const mergedRes = await updateOnlineOrder(
      {
        id: orderId,
        baselineFingerprint: (await getOnlineOrder(orderId, null))!.baselineFingerprint,
        scopedBranchId: null,
        items: [
          { productUnitId: 304, quantity: 2 },
          { productUnitId: 304, quantity: 2 },
        ],
      },
      1,
    );
    expect(Number(mergedRes.subtotal)).toBe(4800);
    const mergedItems = await d
      .select()
      .from(s.onlineOrderItems)
      .where(eq(s.onlineOrderItems.onlineOrderId, orderId));
    expect(mergedItems).toHaveLength(1);
    expect(Number(mergedItems[0]!.quantity)).toBe(4);
  });
});

