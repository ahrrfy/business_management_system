/**
 * اختبارات setOnlineOrderStatus — سبب الإلغاء اليدويّ (GAP B) + مرحلة «قيد التجهيز» (GAP A).
 * يغطّي: تثبيت سبب الإلغاء عند CANCELLED، عدم مسّ cancelReason في انتقالٍ غير إلغاء (لا يطمس
 * سبباً سابقاً)، إلغاءٌ بلا سبب ⇒ null، وسماح انتقال CONFIRMED→PROCESSING.
 */
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../../drizzle/schema";
import { getDb } from "../../../db";
import { setOnlineOrderStatus } from "../orderFulfillmentService";
import { truncateTables } from "../../__tests__/__testUtils__";

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

async function seedOrder(status: "PENDING" | "CONFIRMED" | "PROCESSING", cancelReason: string | null = null): Promise<number> {
  await db().insert(s.onlineOrders).values({
    orderNumber: "ORD-TEST-1",
    customerId: 1,
    branchId: 1,
    subtotal: "100.00",
    shippingCost: "0",
    taxAmount: "0",
    total: "100.00",
    status,
    cancelReason,
    shippingAddress: "بغداد",
    governorate: "baghdad",
  });
  return Number(
    (await db().select({ id: s.onlineOrders.id }).from(s.onlineOrders).where(eq(s.onlineOrders.orderNumber, "ORD-TEST-1")).limit(1))[0].id,
  );
}

async function getOrder(id: number) {
  return (await db().select().from(s.onlineOrders).where(eq(s.onlineOrders.id, id)).limit(1))[0];
}

beforeEach(async () => {
  await truncateTables(["storefrontPushDeliveries", "storefrontPushCampaigns", "storefrontPushDevices", "onlineOrderItems", "onlineOrders", "customers", "branches"]);
  await db().insert(s.branches).values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await db().insert(s.customers).values({ id: 1, name: "زبون تجريبيّ" });
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
    const id = await seedOrder("CONFIRMED", "سبب سابق");
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
    expect(campaigns[0].body).toContain("ORD-TEST-1");
    expect(deliveries).toHaveLength(1);
  });
});
