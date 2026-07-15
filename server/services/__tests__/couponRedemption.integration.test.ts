import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { hashCouponCode } from "../couponService";
import { createSale } from "../saleService";
import { createPromotion, resolvePromotionForLine } from "../salesPromotionService";
import { withTx } from "../tx";
import { truncateTables } from "./__testUtils__";

const TABLES = [
  "couponRedemptions", "coupons", "couponPrograms", "crmCampaigns",
  "accountingEntries", "receipts", "inventoryMovements", "invoiceItemBundleComponents", "invoiceItems", "invoices",
  "promotionTargets", "promotions", "branchStock", "productPrices", "productUnits", "productVariants", "products",
  "categories", "users", "branches",
];
const actor = { userId: 1, branchId: 1, role: "admin" };
function db() { const value = getDb(); if (!value) throw new Error("DATABASE_URL not set"); return value; }

async function seed() {
  await db().insert(s.branches).values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await db().insert(s.users).values({ id: 1, openId: "coupon-test", name: "admin", role: "admin", loginMethod: "local" });
  await db().insert(s.categories).values({ id: 1, name: "قرطاسية" });
  await db().insert(s.products).values({ id: 1, name: "دفتر", categoryId: 1 });
  await db().insert(s.productVariants).values({ id: 1, productId: 1, sku: "NOTE-1", costPrice: "10.00" });
  await db().insert(s.productUnits).values({ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true });
  await db().insert(s.productPrices).values({ productUnitId: 1, priceTier: "RETAIL", price: "100.00" });
  await db().insert(s.branchStock).values({ branchId: 1, variantId: 1, quantity: 100 });
}

async function couponFixture(code = "CRM-ATOMIC-1") {
  const promotionId = await withTx((tx) => createPromotion(tx, {
    name: "كوبون 10%", type: "PERCENT", discountPercent: "10", scope: "ALL",
    effectiveFrom: "2026-01-01", effectiveTo: "2027-01-01", branchId: 1, applicationMode: "COUPON",
  }, 1));
  const result = await db().insert(s.couponPrograms).values({
    promotionId, name: "برنامج اختباري", status: "ACTIVE", branchId: 1,
    validFrom: new Date("2026-01-01"), validTo: new Date("2027-01-01"), perCouponLimit: 1, perCustomerLimit: 1,
    codePrefix: "CRM", createdBy: 1,
  });
  const programId = Number((result as any)[0]?.insertId ?? (result as any).insertId);
  await db().insert(s.coupons).values({ programId, code, codeHash: hashCouponCode(code), status: "ACTIVE" });
  return { promotionId, code };
}

function saleInput(promotionId: number, code: string) {
  return {
    branchId: 1, sourceType: "ORDER" as const, priceTier: "RETAIL" as const, couponCode: code,
    lines: [{ variantId: 1, productUnitId: 1, quantity: "1", unitPriceOverride: "100.00", discountAmount: "10.00", promotionId }],
    payment: { amount: "90.00", method: "CARD" as const },
  };
}

beforeEach(async () => { await truncateTables(TABLES); await seed(); });

describe("coupon redemption in createSale", () => {
  it("does not allow a COUPON promotion into automatic pricing", async () => {
    const { promotionId } = await couponFixture();
    const resolved = await withTx((tx) => resolvePromotionForLine(tx, {
      branchId: 1, customerTier: "RETAIL", productId: 1, variantId: 1, categoryId: 1,
      unitPrice: "100.00", lineAmount: "100.00", hasContractPrice: false, todayYmd: "2026-07-15",
    }));
    expect(resolved).toBeNull();
    expect(promotionId).toBeGreaterThan(0);
  });

  it("records invoice, discount and redemption atomically and consumes the coupon", async () => {
    const fixture = await couponFixture();
    const sale = await createSale(saleInput(fixture.promotionId, fixture.code), actor);
    expect(sale.total).toBe("90.00");
    const redemption = (await db().select().from(s.couponRedemptions).where(eq(s.couponRedemptions.invoiceId, sale.invoiceId)))[0];
    expect(redemption.discountAmount).toBe("10.00");
    const coupon = (await db().select().from(s.coupons).where(eq(s.coupons.codeHash, hashCouponCode(fixture.code))))[0];
    expect(coupon.status).toBe("REDEEMED");
    expect(coupon.redemptionCount).toBe(1);
  });

  it("permits exactly one winner under concurrent redemption", async () => {
    const fixture = await couponFixture("CRM-RACE-ONE");
    const results = await Promise.allSettled([
      createSale(saleInput(fixture.promotionId, fixture.code), actor),
      createSale(saleInput(fixture.promotionId, fixture.code), actor),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const redemptions = await db().select().from(s.couponRedemptions);
    expect(redemptions).toHaveLength(1);
  });
});
