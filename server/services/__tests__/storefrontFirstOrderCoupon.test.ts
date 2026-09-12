import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { requestStorefrontFirstOrderCoupon } from "../storefrontFirstOrderCouponService";
import { truncateAllTables } from "./__testUtils__";

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

async function seedFirstOrderProgram() {
  const d = db();
  await d.insert(s.users).values({ id: 1, openId: "first-order-coupon-admin", name: "مدير", role: "admin", loginMethod: "local" });
  await d.insert(s.promotions).values({
    id: 1,
    name: "خصم أول طلب",
    type: "PERCENT",
    discountPercent: "10.00",
    discountAmount: "0.00",
    scope: "ALL",
    effectiveFrom: new Date("2026-01-01"),
    effectiveTo: new Date("2099-12-31"),
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
    name: "ترحيب الطلب الأول",
    status: "ACTIVE",
    branchId: 1,
    validFrom: new Date("2026-01-01"),
    validTo: new Date("2099-12-31"),
    perCouponLimit: 1,
    perCustomerLimit: 1,
    isFirstOrderSelfService: true,
    codePrefix: "WELCOME",
    createdBy: 1,
  });
}

beforeEach(async () => {
  await truncateAllTables();
  const d = db();
  await d.insert(s.branches).values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await d.insert(s.storeSettings).values({ id: 1, fulfillmentBranchId: 1, isOpen: true });
  await d.insert(s.customers).values([{ id: 1, name: "عميل جديد" }, { id: 2, name: "عميل له طلب" }]);
  await seedFirstOrderProgram();
});

describe("storefront first-order coupon", () => {
  it("issues one personal coupon only when the verified customer asks, and replays it safely", async () => {
    const [first, second] = await Promise.all([
      requestStorefrontFirstOrderCoupon(1),
      requestStorefrontFirstOrderCoupon(1),
    ]);
    expect([first.outcome, second.outcome].sort()).toEqual(["ALREADY_ISSUED", "ISSUED"]);
    expect(first.code).toBe(second.code);
    expect(first.code).toMatch(/^WELCOME-/);
    expect(await db().select().from(s.coupons)).toHaveLength(1);
    expect(await db().select().from(s.storefrontFirstOrderCouponClaims)).toHaveLength(1);
  });

  it("rejects a customer with an earlier storefront order and never creates a coupon claim", async () => {
    await db().insert(s.onlineOrders).values({
      id: 1,
      orderNumber: "ORD-EXISTING-FIRST",
      customerId: 2,
      branchId: 1,
      subtotal: "1000.00",
      total: "1000.00",
      status: "CANCELLED",
    });

    await expect(requestStorefrontFirstOrderCoupon(2)).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    expect(await db().select().from(s.coupons).where(eq(s.coupons.customerId, 2))).toHaveLength(0);
    expect(await db().select().from(s.storefrontFirstOrderCouponClaims).where(eq(s.storefrontFirstOrderCouponClaims.customerId, 2))).toHaveLength(0);
  });
});
