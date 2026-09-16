import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { hashCouponCode } from "../couponService";
import {
  cancelOnlineOrderByGuestToken,
  cancelOnlineOrderForCustomer,
  createOnlineOrder,
} from "../onlineOrderService";
import { truncateAllTables } from "./__testUtils__";

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

async function seedStorefront() {
  const d = db();
  await d.insert(s.branches).values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await d.insert(s.users).values({ id: 1, openId: "cancel-order-admin", name: "admin", role: "admin", loginMethod: "local" });
  await d.insert(s.products).values({ id: 1, name: "دفتر", showInStore: true });
  await d.insert(s.productVariants).values({ id: 1, productId: 1, sku: "CANCEL-BOOK", costPrice: "100.00" });
  await d.insert(s.productUnits).values({ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, isStoreSaleUnit: true });
  await d.insert(s.productPrices).values({ productUnitId: 1, priceTier: "RETAIL", price: "1000.00" });
  await d.insert(s.branchStock).values({ branchId: 1, variantId: 1, quantity: 30 });
  await d.insert(s.storeSettings).values({ id: 1, fulfillmentBranchId: 1, isOpen: true });
}

async function seedCoupon(code: string) {
  const d = db();
  await d.insert(s.promotions).values({
    id: 1,
    name: "كوبون المتجر",
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
    name: "ترحيب",
    status: "ACTIVE",
    branchId: 1,
    validFrom: new Date("2026-01-01"),
    validTo: new Date("2027-01-01"),
    perCouponLimit: 1,
    perCustomerLimit: 1,
    codePrefix: "WEB",
    createdBy: 1,
  });
  await d.insert(s.coupons).values({ id: 1, programId: 1, code, codeHash: hashCouponCode(code), status: "ACTIVE" });
}

function orderInput(phone: string, clientRequestId: string, couponCode?: string) {
  return {
    customerName: "عميل المتجر",
    customerPhone: phone,
    governorate: "baghdad",
    addressText: "بغداد — الكرادة",
    clientRequestId,
    couponCode,
    lines: [{ productUnitId: 1, quantity: 1 }],
  };
}

beforeEach(async () => {
  await truncateAllTables();
  await seedStorefront();
});

describe("storefront customer cancellation", () => {
  it("يلغي مالك الطلب PENDING فقط ويحرر حجز الكوبون", async () => {
    await seedCoupon("CANCEL10");
    const created = await createOnlineOrder(orderInput("07701234567", "customer-cancel-pending", "CANCEL10"));
    const order = (await db().select().from(s.onlineOrders).where(eq(s.onlineOrders.id, created.orderId)))[0]!;

    await expect(cancelOnlineOrderForCustomer(created.orderNumber, Number(order.customerId)))
      .resolves.toEqual({ orderNumber: created.orderNumber, status: "CANCELLED" });
    const after = (await db().select().from(s.onlineOrders).where(eq(s.onlineOrders.id, created.orderId)))[0]!;
    const reservation = (await db().select().from(s.couponReservations).where(
      eq(s.couponReservations.onlineOrderId, created.orderId),
    ))[0]!;
    expect(after).toMatchObject({ status: "CANCELLED", cancelReason: expect.stringContaining("العميل") });
    expect(reservation).toMatchObject({ status: "RELEASED", releaseReason: expect.stringContaining("العميل") });
    await expect(cancelOnlineOrderForCustomer(created.orderNumber, Number(order.customerId)))
      .rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("يسمح لرمز الضيف الموقّع بإلغاء طلبه وحده", async () => {
    const created = await createOnlineOrder(orderInput("07801234567", "guest-cancel-pending"));

    await expect(cancelOnlineOrderByGuestToken(created.guestTrackingToken))
      .resolves.toEqual({ orderNumber: created.orderNumber, status: "CANCELLED" });
  });

  it("لا يكشف طلب عميل آخر عند الإلغاء بجلسة مالك مختلف", async () => {
    const created = await createOnlineOrder(orderInput("07701234567", "other-customer-cancel"));

    await expect(cancelOnlineOrderForCustomer(created.orderNumber, 999_999))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
