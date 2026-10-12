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
import {
  claimOnlineOrder,
  markOnlineOrderPrepared,
  setOnlineOrderStatus,
  updateOnlineOrderContact,
} from "../orderFulfillmentService";
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
    "storefrontPushDeliveries",
    "storefrontPushCampaigns",
    "storefrontPushDevices",
    "onlineOrderItems",
    "onlineOrders",
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
    expect(o.claimedByUserId).toBe(2);
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
