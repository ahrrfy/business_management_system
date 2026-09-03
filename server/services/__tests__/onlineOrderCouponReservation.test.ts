import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createOnlineOrder, quoteOnlineOrder } from "../onlineOrderService";
import { hashCouponCode } from "../couponService";
import { sweepExpiredOnlineOrdersOnce } from "../onlineOrderExpirySweeper";
import { setOnlineOrderStatus } from "../storeAdmin/orderFulfillmentService";
import { truncateAllTables } from "./__testUtils__";

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

async function seedCoupon(input: { code: string; customerId?: number | null; perCouponLimit?: number; perCustomerLimit?: number }) {
  const d = db();
  await d.insert(s.promotions).values({
    id: 1,
    name: "خصم متجر 10%",
    type: "PERCENT",
    discountPercent: "10.00",
    discountAmount: "0.00",
    scope: "ALL",
    effectiveFrom: new Date("2026-01-01"),
    effectiveTo: new Date("2027-01-01"),
    branchId: 1,
    customerTier: "RETAIL",
    minLineAmount: "0.00",
    priority: 100,
    isActive: true,
    applicationMode: "COUPON",
    isStoreManaged: true,
  });
  await d.insert(s.couponPrograms).values({
    id: 1,
    promotionId: 1,
    name: "برنامج متجر",
    status: "ACTIVE",
    branchId: 1,
    validFrom: new Date("2026-01-01"),
    validTo: new Date("2027-01-01"),
    perCouponLimit: input.perCouponLimit ?? 1,
    perCustomerLimit: input.perCustomerLimit ?? 1,
    codePrefix: "WEB",
    createdBy: 1,
  });
  await d.insert(s.coupons).values({
    id: 1,
    programId: 1,
    code: input.code,
    codeHash: hashCouponCode(input.code),
    customerId: input.customerId ?? null,
    status: "ACTIVE",
  });
}

function orderInput(phone: string, requestId: string, couponCode: string) {
  return {
    customerName: "زبون متجر",
    customerPhone: phone,
    governorate: "baghdad",
    addressText: "بغداد — الكرادة",
    couponCode,
    clientRequestId: requestId,
    lines: [{ productUnitId: 1, quantity: 1 }],
  };
}

beforeEach(async () => {
  await truncateAllTables();
  const d = db();
  await d.insert(s.branches).values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await d.insert(s.users).values({ id: 1, openId: "coupon-reservation-owner", name: "admin", role: "admin", loginMethod: "local" });
  await d.insert(s.products).values({ id: 1, name: "دفتر", showInStore: true });
  await d.insert(s.productVariants).values({ id: 1, productId: 1, sku: "WEB-COUPON-1", costPrice: "100.00" });
  await d.insert(s.productUnits).values({
    id: 1,
    variantId: 1,
    unitName: "قطعة",
    conversionFactor: "1",
    isBaseUnit: true,
    isStoreSaleUnit: true,
  });
  await d.insert(s.productPrices).values({ productUnitId: 1, priceTier: "RETAIL", price: "1000.00" });
  await d.insert(s.branchStock).values({ branchId: 1, variantId: 1, quantity: 20 });
  await d.insert(s.storeSettings).values({
    id: 1,
    fulfillmentBranchId: 1,
    isOpen: true,
    freeShippingThreshold: "1.00",
  });
});

describe("online order coupon reservation", () => {
  it("يسمح بفائز واحد فقط عند حجز آخر استخدام لقسيمة بالتزامن", async () => {
    const code = "WEB-LAST-USE";
    await seedCoupon({ code, perCouponLimit: 1 });

    const results = await Promise.allSettled([
      createOnlineOrder(orderInput("07701234567", "coupon-race-order-a", code)),
      createOnlineOrder(orderInput("07801234567", "coupon-race-order-b", code)),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await db().select().from(s.onlineOrders)).toHaveLength(1);
    const coupon = (await db().select().from(s.coupons).where(eq(s.coupons.id, 1)))[0];
    expect(coupon.redemptionCount).toBe(0);
    expect(coupon.status).toBe("ACTIVE");
    const reservations = await db().select().from(s.couponReservations);
    expect(reservations).toHaveLength(1);
    expect(reservations[0].status).toBe("ACTIVE");
  });

  it("يدعم القسيمة الشخصية بجلسة مطابقة ويرفض جلسة عميل آخر", async () => {
    const d = db();
    await d.insert(s.customers).values([
      { id: 41, name: "صاحب القسيمة", phone: "+9647701234567" },
      { id: 42, name: "عميل آخر", phone: "+9647801234567" },
    ]);
    const code = "WEB-PERSONAL";
    await seedCoupon({ code, customerId: 41 });

    await expect(quoteOnlineOrder({
      couponCode: code,
      governorate: "baghdad",
      lines: [{ productUnitId: 1, quantity: 1 }],
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(quoteOnlineOrder({
      couponCode: code,
      governorate: "baghdad",
      lines: [{ productUnitId: 1, quantity: 1 }],
      authenticatedCustomer: { customerId: 41, phone: "+9647701234567" },
    })).resolves.toMatchObject({ couponCode: code, couponDiscount: "100.00" });

    await expect(createOnlineOrder({
      ...orderInput("07801234567", "personal-coupon-wrong-owner", code),
      authenticatedCustomer: { customerId: 42, phone: "+9647801234567" },
    })).rejects.toMatchObject({ code: "FORBIDDEN" });

    // معرفة هاتف الضحية ليست إثبات ملكية: القسيمة الشخصية لا تُحجز من storefront بلا session.
    await expect(createOnlineOrder(
      orderInput("07701234567", "personal-coupon-victim-phone-without-session", code),
    )).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await d.select().from(s.onlineOrders)).toHaveLength(0);

    const created = await createOnlineOrder({
      ...orderInput("07701234567", "personal-coupon-owner", code),
      authenticatedCustomer: { customerId: 41, phone: "+9647701234567" },
    });
    const reservation = (await d.select().from(s.couponReservations).where(
      eq(s.couponReservations.onlineOrderId, created.orderId),
    ))[0];
    expect(reservation).toMatchObject({ customerId: 41, status: "ACTIVE", discountAmount: "100.00" });
  });

  it("يثبت authenticatedCustomer بالمعرّف ويقبل أي هاتف ثانوي canonical في صفه", async () => {
    const d = db();
    await d.insert(s.customers).values({
      id: 61,
      name: "عميل متعدد الهواتف",
      phone: "+9647700000001",
      phone2: "0780-000-0002",
      phone3: "00964 790 000 0003",
      whatsapp: "+9647500000004",
      isActive: true,
    });

    for (const [index, phone] of [
      "+9647800000002",
      "+9647900000003",
      "+9647500000004",
    ].entries()) {
      const created = await createOnlineOrder({
        customerName: "عميل متعدد الهواتف",
        customerPhone: phone,
        authenticatedCustomer: { customerId: 61, phone },
        governorate: "baghdad",
        addressText: "بغداد — الكرادة",
        clientRequestId: `authenticated-secondary-phone-${index}`,
        lines: [{ productUnitId: 1, quantity: 1 }],
      });
      const row = (await d.select({ customerId: s.onlineOrders.customerId }).from(s.onlineOrders).where(
        eq(s.onlineOrders.id, created.orderId),
      ))[0];
      expect(Number(row.customerId)).toBe(61);
    }
    expect(await d.select().from(s.customers)).toHaveLength(1);
  });

  it("يسلسل حد العميل عبر قسيمتين مختلفتين من البرنامج نفسه", async () => {
    const d = db();
    await d.insert(s.customers).values({ id: 51, name: "عميل واحد", phone: "+9647701234567" });
    await seedCoupon({ code: "WEB-CUSTOMER-A", perCouponLimit: 1, perCustomerLimit: 1 });
    await d.insert(s.coupons).values({
      id: 2,
      programId: 1,
      code: "WEB-CUSTOMER-B",
      codeHash: hashCouponCode("WEB-CUSTOMER-B"),
      status: "ACTIVE",
    });

    const results = await Promise.allSettled([
      createOnlineOrder({
        ...orderInput("07701234567", "per-customer-order-a", "WEB-CUSTOMER-A"),
        authenticatedCustomer: { customerId: 51, phone: "+9647701234567" },
      }),
      createOnlineOrder({
        ...orderInput("07701234567", "per-customer-order-b", "WEB-CUSTOMER-B"),
        authenticatedCustomer: { customerId: 51, phone: "+9647701234567" },
      }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await d.select().from(s.couponReservations)).toHaveLength(1);
  });

  it("CONFIRMED يثبت الحجز، والإلغاء قبل الإرسال يحرره ويسمح بطلب جديد", async () => {
    const code = "WEB-RELEASE-CANCEL";
    await seedCoupon({ code });
    const created = await createOnlineOrder(orderInput("07701234567", "coupon-cancel-first", code));
    await setOnlineOrderStatus({ id: created.orderId, status: "CONFIRMED", scopedBranchId: 1 }, 1);
    let reservation = (await db().select().from(s.couponReservations).where(
      eq(s.couponReservations.onlineOrderId, created.orderId),
    ))[0];
    expect(reservation.status).toBe("ACTIVE");
    expect(reservation.expiresAt).toBeNull();

    await setOnlineOrderStatus({
      id: created.orderId,
      status: "CANCELLED",
      scopedBranchId: 1,
      cancelReason: "طلب الزبون الإلغاء",
    }, 1);
    reservation = (await db().select().from(s.couponReservations).where(
      eq(s.couponReservations.onlineOrderId, created.orderId),
    ))[0];
    expect(reservation.status).toBe("RELEASED");
    expect(reservation.releaseReason).toContain("طلب الزبون");

    await expect(createOnlineOrder(orderInput("07801234567", "coupon-cancel-replacement", code)))
      .resolves.toMatchObject({ deliveryFee: "0.00" });
    expect((await db().select().from(s.couponReservations).where(
      eq(s.couponReservations.status, "ACTIVE"),
    ))).toHaveLength(1);
  });

  it("عامل انتهاء PENDING يلغي الطلب ويحرر القسيمة في المعاملة نفسها", async () => {
    const code = "WEB-RELEASE-EXPIRY";
    await seedCoupon({ code });
    const created = await createOnlineOrder(orderInput("07701234567", "coupon-expiry-first", code));
    await db().execute(sql`
      UPDATE onlineOrders
      SET reservationExpiresAt = DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 1 SECOND)
      WHERE id = ${created.orderId}
    `);

    expect(await sweepExpiredOnlineOrdersOnce()).toEqual({ cancelled: 1 });
    const order = (await db().select().from(s.onlineOrders).where(eq(s.onlineOrders.id, created.orderId)))[0];
    const reservation = (await db().select().from(s.couponReservations).where(
      eq(s.couponReservations.onlineOrderId, created.orderId),
    ))[0];
    expect(order.status).toBe("CANCELLED");
    expect(reservation.status).toBe("RELEASED");
    expect(reservation.releaseReason).toContain("انتهت مهلة");
  });
});
