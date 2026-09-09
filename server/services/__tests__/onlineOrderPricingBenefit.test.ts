import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { hashCouponCode } from "../couponService";
import {
  createOnlineOrder,
  quoteOnlineOrder,
  STOREFRONT_WHOLESALE_MINIMUM_BASE_QUANTITY,
} from "../onlineOrderService";
import { truncateAllTables } from "./__testUtils__";

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

async function seedCatalog() {
  const d = db();
  await d.insert(s.branches).values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await d.insert(s.users).values({ id: 1, openId: "store-pricing-admin", name: "admin", role: "admin", loginMethod: "local" });
  await d.insert(s.products).values({ id: 1, name: "قلم المدرسة", showInStore: true });
  await d.insert(s.productVariants).values([
    { id: 1, productId: 1, sku: "PEN-RED", color: "أحمر", costPrice: "400.00" },
    { id: 2, productId: 1, sku: "PEN-BLUE", color: "أزرق", costPrice: "400.00" },
  ]);
  await d.insert(s.productUnits).values([
    { id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, isStoreSaleUnit: true },
    { id: 2, variantId: 2, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, isStoreSaleUnit: true },
  ]);
  await d.insert(s.productPrices).values([
    { productUnitId: 1, priceTier: "RETAIL", price: "1000.00" },
    { productUnitId: 2, priceTier: "RETAIL", price: "1000.00" },
    { productUnitId: 1, priceTier: "WHOLESALE", price: "750.00" },
    { productUnitId: 2, priceTier: "WHOLESALE", price: "750.00" },
  ]);
  await d.insert(s.branchStock).values([
    { branchId: 1, variantId: 1, quantity: 100 },
    { branchId: 1, variantId: 2, quantity: 100 },
  ]);
  await d.insert(s.storeSettings).values({ id: 1, fulfillmentBranchId: 1, isOpen: true });
}

async function seedCouponAndOffer() {
  const d = db();
  await d.insert(s.promotions).values([
    {
      id: 1,
      name: "عرض المتجر 10%",
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
      applicationMode: "AUTO",
      isStoreManaged: true,
    },
    {
      id: 2,
      name: "كوبون 15%",
      type: "PERCENT",
      discountPercent: "15.00",
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
    },
  ]);
  await d.insert(s.couponPrograms).values({
    id: 1,
    promotionId: 2,
    name: "ترحيب المتجر",
    status: "ACTIVE",
    branchId: 1,
    validFrom: new Date("2026-01-01"),
    validTo: new Date("2027-01-01"),
    perCouponLimit: 1,
    perCustomerLimit: 1,
    codePrefix: "WELCOME",
    createdBy: 1,
  });
  await d.insert(s.coupons).values({
    id: 1,
    programId: 1,
    code: "WELCOME15",
    codeHash: hashCouponCode("WELCOME15"),
    status: "ACTIVE",
  });
}

const mixedColorLines = [
  { productUnitId: 1, quantity: 6 },
  { productUnitId: 2, quantity: 6 },
];

beforeEach(async () => {
  await truncateAllTables();
  await seedCatalog();
});

describe("online storefront pricing benefit", () => {
  it("يُفعّل الجملة عند جمع ألوان المنتج نفسه إلى 12 قطعة أساس", async () => {
    const quote = await quoteOnlineOrder({ governorate: "baghdad", lines: mixedColorLines });

    expect(STOREFRONT_WHOLESALE_MINIMUM_BASE_QUANTITY).toBe(12);
    expect(quote).toMatchObject({
      pricingBenefitType: "WHOLESALE",
      pricingBenefitLabel: "سعر الجملة التلقائي",
      pricingBenefitDiscount: "3000.00",
      retailSubtotal: "12000.00",
      subtotal: "9000.00",
      wholesaleProgress: [],
    });
    expect(quote.lines.map((line) => line.unitPrice)).toEqual(["750.00", "750.00"]);
  });

  it("لا يفعّل سعر الجملة قبل بلوغ الحد حتى مع وجود سعر جملة", async () => {
    const quote = await quoteOnlineOrder({
      governorate: "baghdad",
      lines: [{ productUnitId: 1, quantity: 6 }, { productUnitId: 2, quantity: 5 }],
    });

    expect(quote).toMatchObject({
      pricingBenefitType: "NONE",
      pricingBenefitDiscount: "0.00",
      retailSubtotal: "11000.00",
      subtotal: "11000.00",
      wholesaleProgress: [
        {
          productId: 1,
          productName: "قلم المدرسة",
          currentBaseQuantity: 11,
          minimumBaseQuantity: 12,
          remainingBaseQuantity: 1,
        },
      ],
    });
  });

  it("يختار أعلى منفعة ولا يحجز كوبوناً صالحاً خسر أمام الجملة", async () => {
    await seedCouponAndOffer();
    const quote = await quoteOnlineOrder({
      governorate: "baghdad",
      couponCode: "WELCOME15",
      lines: mixedColorLines,
    });

    expect(quote).toMatchObject({
      couponCode: null,
      couponDiscount: "0.00",
      couponSuperseded: true,
      pricingBenefitType: "WHOLESALE",
      pricingBenefitDiscount: "3000.00",
    });

    const created = await createOnlineOrder({
      customerName: "عميل الجملة",
      customerPhone: "07701234567",
      governorate: "baghdad",
      addressText: "بغداد — الكرادة",
      couponCode: "WELCOME15",
      clientRequestId: "storefront-wholesale-over-coupon",
      lines: mixedColorLines,
      expectedGrandTotal: quote.total,
    });
    const order = (await db()
      .select()
      .from(s.onlineOrders)
      .where(eq(s.onlineOrders.id, created.orderId)))[0]!;

    expect(order).toMatchObject({
      couponCode: null,
      couponDiscount: "0.00",
      pricingBenefitType: "WHOLESALE",
      pricingBenefitLabel: "سعر الجملة التلقائي",
      pricingBenefitDiscount: "3000.00",
    });
    expect(await db().select().from(s.couponReservations)).toHaveLength(0);
  });
});
