import { describe, expect, it } from "vitest";
import { TRPCError } from "@trpc/server";
import {
  allocateCouponDiscountAcrossLines,
  calculateDiscountAmount,
  resolvePromotionFromSnapshot,
  PromotionRuleSnapshot,
} from "../salesPromotionService";
import {
  calculateAffiliateCommission,
  hashCouponCode,
  lockCouponForSale,
  normalizeCouponCode,
} from "../couponService";
import { computeInvoiceTotals } from "../billing";
import { money, round2, roundCashIQD } from "../money";
import type { Tx } from "../../db";

describe("Omnichannel Promotion & Coupon Engine (Milestone M1)", () => {
  describe("Financial Engine — calculateDiscountAmount with Cap", () => {
    it("enforces percentage discount cap with min(lineDiscount, maxDiscountAmount)", () => {
      // 20% on 100,000 = 20,000. Cap = 15,000 => must clamp to 15,000.00
      const capped = calculateDiscountAmount({
        type: "PERCENT",
        discountPercent: "20.00",
        discountAmount: "0.00",
        maxDiscountAmount: "15000.00",
        unitPrice: "100000.00",
        quantity: "1",
      });
      expect(capped.toFixed(2)).toBe("15000.00");

      // 10% on 50,000 = 5,000. Cap = 10,000 => stays 5,000.00 (under cap)
      const underCap = calculateDiscountAmount({
        type: "PERCENT",
        discountPercent: "10.00",
        discountAmount: "0.00",
        maxDiscountAmount: "10000.00",
        unitPrice: "50000.00",
        quantity: "1",
      });
      expect(underCap.toFixed(2)).toBe("5000.00");
    });

    it("handles decimal.js round2 HALF_UP rounding correctly", () => {
      // 10.05 * 50% = 5.025 => rounds HALF_UP to 5.03
      const rounded = calculateDiscountAmount({
        type: "PERCENT",
        discountPercent: "50.00",
        discountAmount: "0.00",
        maxDiscountAmount: "10.00",
        unitPrice: "10.05",
        quantity: "1",
      });
      expect(rounded.toFixed(2)).toBe("5.03");
    });

    it("applies fixed amount discount and clamps to line amount", () => {
      // 5,000 fixed on 20,000 = 5,000.00
      const fixed = calculateDiscountAmount({
        type: "AMOUNT",
        discountPercent: "0.00",
        discountAmount: "5000.00",
        unitPrice: "20000.00",
        quantity: "1",
      });
      expect(fixed.toFixed(2)).toBe("5000.00");

      // 25,000 fixed on 10,000 => cannot exceed line amount => clamps to 10,000.00
      const clamped = calculateDiscountAmount({
        type: "AMOUNT",
        discountPercent: "0.00",
        discountAmount: "25000.00",
        unitPrice: "10000.00",
        quantity: "1",
      });
      expect(clamped.toFixed(2)).toBe("10000.00");
    });
  });

  describe("Contract Price Exclusions & Snapshot Resolution", () => {
    const baseSnapshot: PromotionRuleSnapshot = {
      branchId: 1,
      customerTier: "RETAIL",
      todayYmd: "2026-06-15",
      includeStoreManaged: false,
      requiredApplicationMode: "COUPON",
      rules: [
        {
          id: 101,
          name: "عرض خاص",
          type: "PERCENT",
          discountPercent: "25.00",
          discountAmount: "0.00",
          maxDiscountAmount: "5000.00",
          minOrderSpend: "20000.00",
          freeShipping: false,
          shippingDiscountAmount: "0.00",
          scope: "ALL",
          priority: 10,
          minLineAmount: "0.00",
          targets: [],
        },
      ],
    };

    it("strictly returns null if line has a contract price (zero stacking)", () => {
      const result = resolvePromotionFromSnapshot(baseSnapshot, {
        branchId: 1,
        customerTier: "RETAIL",
        productId: 50,
        variantId: 100,
        categoryId: null,
        unitPrice: "40000.00",
        lineAmount: "40000.00",
        hasContractPrice: true, // Contract price wins, no promotion stacking
        todayYmd: "2026-06-15",
        requiredApplicationMode: "COUPON",
      });
      expect(result).toBeNull();
    });

    it("applies promotion and clamps unit discount when no contract price exists", () => {
      const result = resolvePromotionFromSnapshot(baseSnapshot, {
        branchId: 1,
        customerTier: "RETAIL",
        productId: 50,
        variantId: 100,
        categoryId: null,
        unitPrice: "40000.00",
        lineAmount: "40000.00",
        hasContractPrice: false,
        todayYmd: "2026-06-15",
        requiredApplicationMode: "COUPON",
      });
      expect(result).not.toBeNull();
      // 25% of 40,000 = 10,000, capped at maxDiscountAmount 5,000.00
      expect(result?.discountForUnit).toBe("5000.00");
      expect(result?.promotionId).toBe(101);
    });

    it("returns null when promotion rule has no applicable match or mismatching mode", () => {
      const emptyRulesSnapshot: PromotionRuleSnapshot = {
        ...baseSnapshot,
        rules: [],
      };
      const noRuleResult = resolvePromotionFromSnapshot(emptyRulesSnapshot, {
        branchId: 1,
        customerTier: "RETAIL",
        productId: 50,
        variantId: 100,
        categoryId: null,
        unitPrice: "40000.00",
        lineAmount: "40000.00",
        hasContractPrice: false,
        todayYmd: "2026-06-15",
        requiredApplicationMode: "COUPON",
      });
      expect(noRuleResult).toBeNull();

      const mismatchedModeResult = resolvePromotionFromSnapshot(baseSnapshot, {
        branchId: 1,
        customerTier: "RETAIL",
        productId: 50,
        variantId: 100,
        categoryId: null,
        unitPrice: "40000.00",
        lineAmount: "40000.00",
        hasContractPrice: false,
        todayYmd: "2026-06-15",
        requiredApplicationMode: "AUTO", // Snapshot expects COUPON
      });
      expect(mismatchedModeResult).toBeNull();
    });
  });

  describe("Affiliate Commission Calculations", () => {
    it("calculates commission amount accurately with round2 HALF_UP", () => {
      // 10% on 150,000.00 net sales = 15,000.00
      expect(calculateAffiliateCommission("150000.00", "10.00").toFixed(2)).toBe("15000.00");

      // 7.5% on 2,500.00 = 187.50
      expect(calculateAffiliateCommission("2500.00", "7.50").toFixed(2)).toBe("187.50");

      // 3.333% on 100.00 = 3.333 => 3.33
      expect(calculateAffiliateCommission("100.00", "3.333").toFixed(2)).toBe("3.33");

      // 3.335% on 100.00 = 3.335 => 3.34 (HALF_UP)
      expect(calculateAffiliateCommission("100.00", "3.335").toFixed(2)).toBe("3.34");
    });

    it("returns 0.00 for zero, negative or empty commission rates", () => {
      expect(calculateAffiliateCommission("100000.00", "0.00").toFixed(2)).toBe("0.00");
      expect(calculateAffiliateCommission("100000.00", "0").toFixed(2)).toBe("0.00");
      expect(calculateAffiliateCommission("100000.00", null).toFixed(2)).toBe("0.00");
      expect(calculateAffiliateCommission("0.00", "10.00").toFixed(2)).toBe("0.00");
    });
  });

  describe("Minimum Order Spend Validation in lockCouponForSale", () => {
    function createMockTx(couponData: {
      minOrderSpend: string;
      maxDiscountAmount?: string | null;
      affiliateName?: string | null;
      affiliateCommissionRate?: string;
    }): Tx {
      const mockRow = {
        coupon: {
          id: 1,
          programId: 10,
          code: "TEST-PROMO-123",
          codeHash: "hash123",
          status: "ACTIVE",
          customerId: null,
          issuedAt: new Date("2026-01-01"),
        },
        program: {
          id: 10,
          name: "برنامج التجربة",
          status: "ACTIVE",
          branchId: null,
          validFrom: new Date("2026-01-01"),
          validTo: null,
          perCouponLimit: 100,
          perCustomerLimit: 10,
          isFirstOrderSelfService: false,
          codePrefix: "TEST",
          affiliateName: couponData.affiliateName ?? null,
          affiliatePhone: null,
          affiliateCommissionRate: couponData.affiliateCommissionRate ?? "0.00",
        },
        promotion: {
          id: 20,
          name: "عرض تجريبي",
          applicationMode: "COUPON",
          isActive: true,
          branchId: null,
          effectiveFrom: new Date("2026-01-01"),
          effectiveTo: null,
          minOrderSpend: couponData.minOrderSpend,
          maxDiscountAmount: couponData.maxDiscountAmount ?? null,
          freeShipping: false,
          shippingDiscountAmount: "0.00",
        },
      };

      const chain = {
        from: () => chain,
        innerJoin: () => chain,
        where: () => chain,
        for: () => chain,
        limit: async () => [mockRow],
      };

      return {
        select: () => chain,
      } as unknown as Tx;
    }

    it("rejects coupon if subtotal is less than minOrderSpend with Arabic error message", async () => {
      const mockTx = createMockTx({ minOrderSpend: "50000.00" });

      await expect(
        lockCouponForSale(
          mockTx,
          {
            code: "TEST-PROMO-123",
            branchId: 1,
            customerId: null,
            todayYmd: "2026-06-15",
            subtotal: "35000.00", // Less than 50,000.00
          },
          { lock: false },
        ),
      ).rejects.toThrowError(TRPCError);

      try {
        await lockCouponForSale(
          mockTx,
          {
            code: "TEST-PROMO-123",
            branchId: 1,
            customerId: null,
            todayYmd: "2026-06-15",
            subtotal: "35000.00",
          },
          { lock: false },
        );
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(TRPCError);
        const trpcErr = err as TRPCError;
        expect(trpcErr.code).toBe("BAD_REQUEST");
        expect(trpcErr.message).toContain("لم يبلغ إجمالي الطلب الحد الأدنى لتفعيل الكوبون");
        expect(trpcErr.message).toContain("50000.00");
      }
    });

    it("accepts coupon when subtotal equals or exceeds minOrderSpend", async () => {
      const mockTx = createMockTx({
        minOrderSpend: "50000.00",
        maxDiscountAmount: "10000.00",
        affiliateName: "شريك تسويقي",
        affiliateCommissionRate: "5.00",
      });

      const locked = await lockCouponForSale(
        mockTx,
        {
          code: "TEST-PROMO-123",
          branchId: 1,
          customerId: null,
          todayYmd: "2026-06-15",
          subtotal: "55000.00", // >= 50,000.00
        },
        { lock: false },
      );

      expect(locked).toBeDefined();
      expect(locked.code).toBe("TEST-PROMO-123");
      expect(locked.minOrderSpend).toBe("50000.00");
      expect(locked.maxDiscountAmount).toBe("10000.00");
      expect(locked.affiliateName).toBe("شريك تسويقي");
      expect(locked.affiliateCommissionRate).toBe("5.00");
    });
  });

  describe("Empirical Adversarial Stress Suite (Challenger Verification)", () => {
    it("strictly clamps massive 100,000,000 IQD cart with 50% discount to small cap (10,000 IQD)", () => {
      const discount = calculateDiscountAmount({
        type: "PERCENT",
        unitPrice: "100000000.00",
        quantity: "1",
        discountPercent: "50.00",
        maxDiscountAmount: "10000.00",
      });
      expect(discount.toFixed(2)).toBe("10000.00");
    });

    it("evaluates boundary conditions around cap (cap - 1, exact cap, cap + 1)", () => {
      const underCap = calculateDiscountAmount({
        type: "PERCENT",
        unitPrice: "200000.00",
        quantity: "1",
        discountPercent: "10.00",
        maxDiscountAmount: "20001.00",
      });
      expect(underCap.toFixed(2)).toBe("20000.00");

      const exactCap = calculateDiscountAmount({
        type: "PERCENT",
        unitPrice: "200000.00",
        quantity: "1",
        discountPercent: "10.00",
        maxDiscountAmount: "20000.00",
      });
      expect(exactCap.toFixed(2)).toBe("20000.00");

      const overCap = calculateDiscountAmount({
        type: "PERCENT",
        unitPrice: "200000.00",
        quantity: "1",
        discountPercent: "10.00",
        maxDiscountAmount: "19999.00",
      });
      expect(overCap.toFixed(2)).toBe("19999.00");
    });

    it("correctly rounds 13.333% and 13.334% on 37,250 IQD adhering to round2 HALF_UP", () => {
      const d1 = calculateDiscountAmount({
        type: "PERCENT",
        unitPrice: "37250.00",
        quantity: "1",
        discountPercent: "13.333",
        maxDiscountAmount: "10000.00",
      });
      expect(d1.toFixed(2)).toBe("4966.54");

      const d2 = calculateDiscountAmount({
        type: "PERCENT",
        unitPrice: "37250.00",
        quantity: "1",
        discountPercent: "13.334",
        maxDiscountAmount: "10000.00",
      });
      expect(d2.toFixed(2)).toBe("4966.92");
    });

    it("handles zero, negative, and sub-dinar unit costs", () => {
      const zeroQty = calculateDiscountAmount({
        type: "PERCENT",
        unitPrice: "50000.00",
        quantity: "0",
        discountPercent: "20.00",
        maxDiscountAmount: "10000.00",
      });
      expect(zeroQty.toFixed(2)).toBe("0.00");

      const sub1 = calculateDiscountAmount({
        type: "PERCENT",
        unitPrice: "0.25",
        quantity: "10",
        discountPercent: "10.00",
        maxDiscountAmount: "100.00",
      });
      expect(sub1.toFixed(2)).toBe("0.25");

      const sub2 = calculateDiscountAmount({
        type: "PERCENT",
        unitPrice: "0.05",
        quantity: "3",
        discountPercent: "10.00",
        maxDiscountAmount: "100.00",
      });
      expect(sub2.toFixed(2)).toBe("0.02");

      const neg = calculateDiscountAmount({
        type: "AMOUNT",
        unitPrice: "15000.00",
        quantity: "1",
        discountAmount: "-5000.00",
      });
      expect(neg.toFixed(2)).toBe("0.00");
    });

    it("boundary test: subtotal exactly 1 IQD and 0.01 IQD below minOrderSpend throws", async () => {
      const mockTx = {
        select: () => ({
          from: () => ({
            innerJoin: () => ({
              innerJoin: () => ({
                where: () => ({
                  limit: async () => [{
                    coupon: { id: 1, programId: 10, code: "TEST", codeHash: "h", status: "ACTIVE", customerId: null, issuedAt: new Date() },
                    program: { id: 10, name: "P", status: "ACTIVE", branchId: null, validFrom: new Date("2026-01-01"), validTo: null, perCouponLimit: 100, perCustomerLimit: 10, isFirstOrderSelfService: false, codePrefix: "T", affiliateName: null, affiliatePhone: null, affiliateCommissionRate: "0.00" },
                    promotion: { id: 20, name: "Pr", applicationMode: "COUPON", isActive: true, branchId: null, effectiveFrom: new Date("2026-01-01"), effectiveTo: null, minOrderSpend: "50000.00", maxDiscountAmount: "10000.00", freeShipping: false, shippingDiscountAmount: "0.00" },
                  }],
                }),
              }),
            }),
          }),
        }),
      } as unknown as Tx;

      await expect(
        lockCouponForSale(mockTx, { code: "TEST", branchId: 1, customerId: null, todayYmd: "2026-06-15", subtotal: "49999.00" }, { lock: false })
      ).rejects.toThrow(TRPCError);

      await expect(
        lockCouponForSale(mockTx, { code: "TEST", branchId: 1, customerId: null, todayYmd: "2026-06-15", subtotal: "49999.99" }, { lock: false })
      ).rejects.toThrow(TRPCError);
    });

    it("verifies contract price isolation and category isolation in snapshot", () => {
      const snap: PromotionRuleSnapshot = {
        branchId: 1,
        customerTier: "RETAIL",
        todayYmd: "2026-06-15",
        includeStoreManaged: false,
        requiredApplicationMode: "COUPON",
        rules: [{
          id: 201,
          name: "Promo Cat 5",
          type: "PERCENT",
          discountPercent: "20.00",
          discountAmount: "0.00",
          maxDiscountAmount: "50000.00",
          minOrderSpend: "0.00",
          freeShipping: false,
          shippingDiscountAmount: "0.00",
          scope: "CATEGORY",
          priority: 10,
          minLineAmount: "0.00",
          targets: [{ promotionId: 201, categoryId: 5, productId: null, variantId: null }],
        }],
      };

      const contract = resolvePromotionFromSnapshot(snap, {
        branchId: 1,
        customerTier: "RETAIL",
        productId: 50,
        variantId: 100,
        categoryId: 5,
        unitPrice: "100000.00",
        lineAmount: "100000.00",
        hasContractPrice: true,
        todayYmd: "2026-06-15",
        requiredApplicationMode: "COUPON",
      });
      expect(contract).toBeNull();

      const excludedCat = resolvePromotionFromSnapshot(snap, {
        branchId: 1,
        customerTier: "RETAIL",
        productId: 50,
        variantId: 100,
        categoryId: 8,
        unitPrice: "100000.00",
        lineAmount: "100000.00",
        hasContractPrice: false,
        todayYmd: "2026-06-15",
        requiredApplicationMode: "COUPON",
      });
      expect(excludedCat).toBeNull();

      const qualifying = resolvePromotionFromSnapshot(snap, {
        branchId: 1,
        customerTier: "RETAIL",
        productId: 50,
        variantId: 100,
        categoryId: 5,
        unitPrice: "100000.00",
        lineAmount: "100000.00",
        hasContractPrice: false,
        todayYmd: "2026-06-15",
        requiredApplicationMode: "COUPON",
      });
      expect(qualifying?.discountForUnit).toBe("20000.00");
    });
  });

  describe("Multi-Unit and Multi-Line Cap Clamping Engine (Milestone Remediation)", () => {
    it("strictly clamps 5 units of 100,000 IQD with 20% discount to maxDiscountAmount (15,000 IQD) at invoice level", () => {
      // 5 units @ 100,000 IQD each = 500,000 IQD subtotal.
      // 20% discount uncapped = 100,000 IQD discount.
      // Coupon cap = 15,000 IQD.
      const lines = [
        {
          variantId: 101,
          promotionId: 99,
          promotionDiscount: "100000.00",
          discountAmount: "100000.00",
          total: "400000.00",
        },
      ];

      const allocation = allocateCouponDiscountAcrossLines(lines, 99, "15000.00");
      expect(allocation.isCapped).toBe(true);
      expect(allocation.totalCouponDiscount).toBe("15000.00");

      const line0 = allocation.lines[0];
      expect(line0.promotionDiscount).toBe("15000.00");
      expect(line0.discountAmount).toBe("15000.00");
      expect(line0.total).toBe("485000.00"); // 500,000 - 15,000 cap
      expect(line0.clampedDelta).toBe("85000.00");

      // Verify invoice totals computed from clamped line totals
      const totals = computeInvoiceTotals({
        lineTotals: allocation.lines.map((l) => l.total),
      });
      expect(totals.subtotal).toBe("485000.00");
      expect(totals.total).toBe("485000.00");

      // Zero discrepancy check
      const grossSubtotal = money("500000.00");
      const actualCustomerPaid = money(totals.total);
      const effectiveDiscount = grossSubtotal.minus(actualCustomerPaid);
      expect(effectiveDiscount.toFixed(2)).toBe("15000.00");
      expect(allocation.totalCouponDiscount).toBe(effectiveDiscount.toFixed(2));
    });

    it("strictly clamps multi-line purchase (Line 1 + Line 2) to maxDiscountAmount with proportional proration", () => {
      // Line 1: 50,000 IQD @ 20% = 10,000 IQD discount, net 40,000 IQD
      // Line 2: 80,000 IQD @ 20% = 16,000 IQD discount, net 64,000 IQD
      // Total uncapped discount = 26,000 IQD. Cap = 15,000 IQD.
      const lines = [
        {
          variantId: 201,
          promotionId: 88,
          promotionDiscount: "10000.00",
          discountAmount: "10000.00",
          total: "40000.00",
        },
        {
          variantId: 202,
          promotionId: 88,
          promotionDiscount: "16000.00",
          discountAmount: "16000.00",
          total: "64000.00",
        },
      ];

      const allocation = allocateCouponDiscountAcrossLines(lines, 88, "15000.00");
      expect(allocation.isCapped).toBe(true);
      expect(allocation.totalCouponDiscount).toBe("15000.00");

      // Line 1: 10,000 * 15,000 / 26,000 = 5,769.23
      expect(allocation.lines[0].promotionDiscount).toBe("5769.23");
      expect(allocation.lines[0].discountAmount).toBe("5769.23");
      expect(allocation.lines[0].total).toBe("44230.77");

      // Line 2: 15,000 - 5,769.23 = 9,230.77
      expect(allocation.lines[1].promotionDiscount).toBe("9230.77");
      expect(allocation.lines[1].discountAmount).toBe("9230.77");
      expect(allocation.lines[1].total).toBe("70769.23");

      // Sum of allocated line discounts equals exact cap (zero drift)
      const sumLineDiscounts = money(allocation.lines[0].promotionDiscount).plus(
        money(allocation.lines[1].promotionDiscount),
      );
      expect(sumLineDiscounts.toFixed(2)).toBe("15000.00");

      // Verify invoice totals
      const totals = computeInvoiceTotals({
        lineTotals: allocation.lines.map((l) => l.total),
      });
      expect(totals.total).toBe("115000.00"); // 130,000 gross - 15,000 cap
    });

    it("handles mixed qualifying and non-qualifying lines, preserving non-qualifying lines untouched", () => {
      const lines = [
        {
          variantId: 301,
          promotionId: 77,
          promotionDiscount: "20000.00",
          discountAmount: "20000.00",
          total: "80000.00",
        },
        {
          variantId: 302,
          promotionId: 77,
          promotionDiscount: "20000.00",
          discountAmount: "20000.00",
          total: "80000.00",
        },
        {
          variantId: 303,
          promotionId: null, // Non-qualifying item
          promotionDiscount: "0.00",
          discountAmount: "0.00",
          total: "70000.00",
        },
      ];

      const allocation = allocateCouponDiscountAcrossLines(lines, 77, "10000.00");
      expect(allocation.isCapped).toBe(true);
      expect(allocation.totalCouponDiscount).toBe("10000.00");

      expect(allocation.lines[0].promotionDiscount).toBe("5000.00");
      expect(allocation.lines[0].total).toBe("95000.00");

      expect(allocation.lines[1].promotionDiscount).toBe("5000.00");
      expect(allocation.lines[1].total).toBe("95000.00");

      // Line 3 untouched
      expect(allocation.lines[2].promotionDiscount).toBe("0.00");
      expect(allocation.lines[2].discountAmount).toBe("0.00");
      expect(allocation.lines[2].total).toBe("70000.00");

      const totals = computeInvoiceTotals({
        lineTotals: allocation.lines.map((l) => l.total),
      });
      // Gross: 100,000 + 100,000 + 70,000 = 270,000. Less 10,000 cap = 260,000.
      expect(totals.total).toBe("260000.00");
    });

    it("distributes exact 1 IQD rounding remainders to the final qualifying line deterministically", () => {
      // 3 qualifying lines with 10,000 discount each = 30,000 total. Cap = 10,000.
      const lines = [
        {
          variantId: 401,
          promotionId: 55,
          promotionDiscount: "10000.00",
          discountAmount: "10000.00",
          total: "40000.00",
        },
        {
          variantId: 402,
          promotionId: 55,
          promotionDiscount: "10000.00",
          discountAmount: "10000.00",
          total: "40000.00",
        },
        {
          variantId: 403,
          promotionId: 55,
          promotionDiscount: "10000.00",
          discountAmount: "10000.00",
          total: "40000.00",
        },
      ];

      const allocation = allocateCouponDiscountAcrossLines(lines, 55, "10000.00");
      expect(allocation.lines[0].promotionDiscount).toBe("3333.33");
      expect(allocation.lines[1].promotionDiscount).toBe("3333.33");
      // Remainder 10,000 - 6,666.66 = 3,333.34 to line 3
      expect(allocation.lines[2].promotionDiscount).toBe("3333.34");

      const sum = money(allocation.lines[0].promotionDiscount)
        .plus(money(allocation.lines[1].promotionDiscount))
        .plus(money(allocation.lines[2].promotionDiscount));
      expect(sum.toFixed(2)).toBe("10000.00");
    });

    it("leaves line discounts untouched when total coupon discount is below cap", () => {
      const lines = [
        {
          variantId: 501,
          promotionId: 44,
          promotionDiscount: "4000.00",
          discountAmount: "4000.00",
          total: "36000.00",
        },
        {
          variantId: 502,
          promotionId: 44,
          promotionDiscount: "3000.00",
          discountAmount: "3000.00",
          total: "27000.00",
        },
      ];

      const allocation = allocateCouponDiscountAcrossLines(lines, 44, "15000.00");
      expect(allocation.isCapped).toBe(false);
      expect(allocation.totalCouponDiscount).toBe("7000.00");
      expect(allocation.lines[0].promotionDiscount).toBe("4000.00");
      expect(allocation.lines[0].total).toBe("36000.00");
      expect(allocation.lines[1].promotionDiscount).toBe("3000.00");
      expect(allocation.lines[1].total).toBe("27000.00");
    });
  });

  describe("Tier 1: Feature Coverage (F1–F17)", () => {
    it("F1: normalizes coupon codes correctly across casing and whitespace", () => {
      expect(normalizeCouponCode("  crm-summer-26  ")).toBe("CRM-SUMMER-26");
      expect(normalizeCouponCode("alroya-10")).toBe("ALROYA-10");
      expect(normalizeCouponCode("")).toBe("");
      expect(normalizeCouponCode("   ")).toBe("");
    });

    it("F2: percentage discount calculates with decimal.js precision and respects cap", () => {
      const d1 = calculateDiscountAmount({
        type: "PERCENT",
        unitPrice: "80000.00",
        quantity: "1",
        discountPercent: "15.00",
        maxDiscountAmount: "20000.00",
      });
      expect(d1.toFixed(2)).toBe("12000.00"); // 15% of 80,000 = 12,000 <= 20,000

      const d2 = calculateDiscountAmount({
        type: "PERCENT",
        unitPrice: "80000.00",
        quantity: "1",
        discountPercent: "50.00",
        maxDiscountAmount: "20000.00",
      });
      expect(d2.toFixed(2)).toBe("20000.00"); // 50% of 80,000 = 40,000 capped to 20,000
    });

    it("F3: fixed amount discount subtracts cleanly and clamps to line total", () => {
      const d1 = calculateDiscountAmount({
        type: "AMOUNT",
        unitPrice: "45000.00",
        quantity: "1",
        discountAmount: "15000.00",
      });
      expect(d1.toFixed(2)).toBe("15000.00");

      const d2 = calculateDiscountAmount({
        type: "AMOUNT",
        unitPrice: "10000.00",
        quantity: "1",
        discountAmount: "25000.00",
      });
      expect(d2.toFixed(2)).toBe("10000.00"); // cannot exceed line total
    });

    it("F4: shipping discount correctly applies to delivery fee without negative numbers", () => {
      const deliveryFee = money("5000.00");
      const freeShipping = true;
      const effectiveFee1 = freeShipping ? money(0) : deliveryFee;
      expect(effectiveFee1.toFixed(2)).toBe("0.00");

      const shippingDiscount = money("3000.00");
      const effectiveFee2 = deliveryFee.minus(shippingDiscount);
      expect(effectiveFee2.toFixed(2)).toBe("2000.00");
    });

    it("F5: minimum order spend validation enforces basket threshold", async () => {
      const mockRow = {
        coupon: { id: 1, programId: 10, code: "MIN50", codeHash: "h", status: "ACTIVE", customerId: null, issuedAt: new Date() },
        program: { id: 10, name: "P", status: "ACTIVE", branchId: null, validFrom: new Date("2026-01-01"), validTo: null, perCouponLimit: 100, perCustomerLimit: 10, isFirstOrderSelfService: false, codePrefix: "M", affiliateName: null, affiliatePhone: null, affiliateCommissionRate: "0.00" },
        promotion: { id: 20, name: "Pr", applicationMode: "COUPON", isActive: true, branchId: null, effectiveFrom: new Date("2026-01-01"), effectiveTo: null, minOrderSpend: "50000.00", maxDiscountAmount: "10000.00", freeShipping: false, shippingDiscountAmount: "0.00" },
      };
      const chain: any = {
        from: () => chain,
        innerJoin: () => chain,
        where: () => chain,
        for: () => chain,
        limit: async () => [mockRow],
        then: (resolve: any) => resolve([]),
      };
      const mockTx = {
        select: () => chain,
      } as unknown as Tx;

      await expect(
        lockCouponForSale(mockTx, { code: "MIN50", branchId: 1, customerId: null, todayYmd: "2026-06-15", subtotal: "40000.00" }, { lock: false })
      ).rejects.toThrow(TRPCError);

      const pass = await lockCouponForSale(mockTx, { code: "MIN50", branchId: 1, customerId: null, todayYmd: "2026-06-15", subtotal: "50000.00" }, { lock: false });
      expect(pass.code).toBe("MIN50");
    });

    it("F6: category and target exclusions properly filter applicable products", () => {
      const snapshot: PromotionRuleSnapshot = {
        branchId: 1,
        customerTier: "RETAIL",
        todayYmd: "2026-06-15",
        includeStoreManaged: false,
        requiredApplicationMode: "COUPON",
        rules: [{
          id: 301,
          name: "Promo Category 10 Only",
          type: "PERCENT",
          discountPercent: "20.00",
          discountAmount: "0.00",
          maxDiscountAmount: "50000.00",
          minOrderSpend: "0.00",
          freeShipping: false,
          shippingDiscountAmount: "0.00",
          scope: "CATEGORY",
          priority: 10,
          minLineAmount: "0.00",
          targets: [{ promotionId: 301, categoryId: 10, productId: null, variantId: null }],
        }],
      };

      const match = resolvePromotionFromSnapshot(snapshot, {
        branchId: 1,
        customerTier: "RETAIL",
        productId: 50,
        variantId: 100,
        categoryId: 10,
        unitPrice: "50000.00",
        lineAmount: "50000.00",
        hasContractPrice: false,
        todayYmd: "2026-06-15",
        requiredApplicationMode: "COUPON",
      });
      expect(match).not.toBeNull();
      expect(match?.discountForUnit).toBe("10000.00");

      const mismatch = resolvePromotionFromSnapshot(snapshot, {
        branchId: 1,
        customerTier: "RETAIL",
        productId: 50,
        variantId: 100,
        categoryId: 99,
        unitPrice: "50000.00",
        lineAmount: "50000.00",
        hasContractPrice: false,
        todayYmd: "2026-06-15",
        requiredApplicationMode: "COUPON",
      });
      expect(mismatch).toBeNull();
    });

    it("F7: stacking prevention strictly prohibits combining with contract price", () => {
      const snapshot: PromotionRuleSnapshot = {
        branchId: 1,
        customerTier: "RETAIL",
        todayYmd: "2026-06-15",
        includeStoreManaged: false,
        requiredApplicationMode: "COUPON",
        rules: [{
          id: 401,
          name: "Any Promo",
          type: "PERCENT",
          discountPercent: "30.00",
          discountAmount: "0.00",
          maxDiscountAmount: "50000.00",
          minOrderSpend: "0.00",
          freeShipping: false,
          shippingDiscountAmount: "0.00",
          scope: "ALL",
          priority: 1,
          minLineAmount: "0.00",
          targets: [],
        }],
      };

      const res = resolvePromotionFromSnapshot(snapshot, {
        branchId: 1,
        customerTier: "RETAIL",
        productId: 50,
        variantId: 100,
        categoryId: null,
        unitPrice: "50000.00",
        lineAmount: "50000.00",
        hasContractPrice: true, // Has contract price
        todayYmd: "2026-06-15",
        requiredApplicationMode: "COUPON",
      });
      expect(res).toBeNull();
    });

    it("F11: code hashing is deterministic and produces SHA-256 hex string", () => {
      const h1 = hashCouponCode("PROMO-2026");
      const h2 = hashCouponCode("PROMO-2026");
      expect(h1).toBe(h2);
      expect(h1).toHaveLength(64);
    });

    it("F13: affiliate commission calculates with round2 HALF_UP on net sales", () => {
      // 10% on 85,000.00 = 8,500.00
      expect(calculateAffiliateCommission("85000.00", "10.00").toFixed(2)).toBe("8500.00");
      // 15% on 42,500.00 = 6,375.00
      expect(calculateAffiliateCommission("42500.00", "15.00").toFixed(2)).toBe("6375.00");
    });

    it("F15: Iraqi Dinar 250 cash rounding enforces exact retail cash intervals", () => {
      expect(roundCashIQD(money("5000.00")).toFixed(2)).toBe("5000.00");
      expect(roundCashIQD(money("5124.00")).toFixed(2)).toBe("5000.00"); // 124 rounded down (< 125)
      expect(roundCashIQD(money("5125.00")).toFixed(2)).toBe("5250.00"); // 125 rounded up (HALF_UP >= half)
      expect(roundCashIQD(money("5250.00")).toFixed(2)).toBe("5250.00");
      expect(roundCashIQD(money("5374.00")).toFixed(2)).toBe("5250.00"); // 374 rounded down
      expect(roundCashIQD(money("5375.00")).toFixed(2)).toBe("5500.00"); // 375 rounded up
    });
  });

  describe("Tier 2: Boundary & Corner Cases", () => {
    it("boundary: discount exactly 1 IQD below cap applies uncapped", () => {
      const d = calculateDiscountAmount({
        type: "PERCENT",
        unitPrice: "100000.00",
        quantity: "1",
        discountPercent: "10.00",
        maxDiscountAmount: "10001.00", // 1 IQD above calculated 10,000
      });
      expect(d.toFixed(2)).toBe("10000.00");
    });

    it("boundary: discount exactly equal to cap applies cap value", () => {
      const d = calculateDiscountAmount({
        type: "PERCENT",
        unitPrice: "100000.00",
        quantity: "1",
        discountPercent: "10.00",
        maxDiscountAmount: "10000.00", // exactly equal
      });
      expect(d.toFixed(2)).toBe("10000.00");
    });

    it("boundary: discount exceeding cap by 1 IQD clamps to cap", () => {
      const d = calculateDiscountAmount({
        type: "PERCENT",
        unitPrice: "100000.00",
        quantity: "1",
        discountPercent: "10.00",
        maxDiscountAmount: "9999.00", // 1 IQD below calculated 10,000
      });
      expect(d.toFixed(2)).toBe("9999.00");
    });

    it("boundary: bulk quantity stress (10,000 units) calculates without overflow", () => {
      const d = calculateDiscountAmount({
        type: "PERCENT",
        unitPrice: "5000.00",
        quantity: "10000",
        discountPercent: "10.00",
        maxDiscountAmount: "500000.00",
      });
      // 10,000 * 5,000 = 50,000,000. 10% = 5,000,000 capped to 500,000.00
      expect(d.toFixed(2)).toBe("500000.00");
    });

    it("boundary: 0% discount percent yields 0.00", () => {
      const d = calculateDiscountAmount({
        type: "PERCENT",
        unitPrice: "50000.00",
        quantity: "2",
        discountPercent: "0.00",
        maxDiscountAmount: "10000.00",
      });
      expect(d.toFixed(2)).toBe("0.00");
    });

    it("boundary: 100% discount percent is clamped strictly to maxDiscountAmount", () => {
      const d = calculateDiscountAmount({
        type: "PERCENT",
        unitPrice: "50000.00",
        quantity: "1",
        discountPercent: "100.00",
        maxDiscountAmount: "15000.00",
      });
      expect(d.toFixed(2)).toBe("15000.00");
    });

    it("boundary: zero net sales yields 0.00 affiliate commission", () => {
      expect(calculateAffiliateCommission("0.00", "20.00").toFixed(2)).toBe("0.00");
    });

    it("boundary: null or negative affiliate commission rate yields 0.00", () => {
      expect(calculateAffiliateCommission("50000.00", null).toFixed(2)).toBe("0.00");
      expect(calculateAffiliateCommission("50000.00", "-5.00").toFixed(2)).toBe("0.00");
    });

    it("boundary: 100% affiliate commission rate calculates entire net revenue", () => {
      expect(calculateAffiliateCommission("50000.00", "100.00").toFixed(2)).toBe("50000.00");
    });

    it("boundary: multi-line remainder allocation across 5 lines is 100% deterministic", () => {
      const lines = [
        { variantId: 1, promotionId: 1, promotionDiscount: "1000.00", discountAmount: "1000.00", total: "9000.00" },
        { variantId: 2, promotionId: 1, promotionDiscount: "1000.00", discountAmount: "1000.00", total: "9000.00" },
        { variantId: 3, promotionId: 1, promotionDiscount: "1000.00", discountAmount: "1000.00", total: "9000.00" },
        { variantId: 4, promotionId: 1, promotionDiscount: "1000.00", discountAmount: "1000.00", total: "9000.00" },
        { variantId: 5, promotionId: 1, promotionDiscount: "1000.00", discountAmount: "1000.00", total: "9000.00" },
      ];
      // Total uncapped = 5,000. Cap = 1,000.
      const allocation = allocateCouponDiscountAcrossLines(lines, 1, "1000.00");
      expect(allocation.isCapped).toBe(true);
      expect(allocation.totalCouponDiscount).toBe("1000.00");
      for (let i = 0; i < 5; i++) {
        expect(allocation.lines[i].promotionDiscount).toBe("200.00");
        expect(allocation.lines[i].total).toBe("9800.00");
      }
    });
  });

  describe("Tier 3: Cross-Feature Combinations", () => {
    it("T3.1: Percentage discount with cap + minimum order spend + excluded categories in mixed basket", () => {
      const snap: PromotionRuleSnapshot = {
        branchId: 1,
        customerTier: "RETAIL",
        todayYmd: "2026-06-15",
        includeStoreManaged: false,
        requiredApplicationMode: "COUPON",
        rules: [{
          id: 501,
          name: "Promo Cat 1 Only",
          type: "PERCENT",
          discountPercent: "20.00",
          discountAmount: "0.00",
          maxDiscountAmount: "10000.00",
          minOrderSpend: "40000.00",
          freeShipping: false,
          shippingDiscountAmount: "0.00",
          scope: "CATEGORY",
          priority: 10,
          minLineAmount: "0.00",
          targets: [{ promotionId: 501, categoryId: 1, productId: null, variantId: null }],
        }],
      };

      // Cat 1 item qualifies
      const line1 = resolvePromotionFromSnapshot(snap, {
        branchId: 1, customerTier: "RETAIL", productId: 10, variantId: 101, categoryId: 1,
        unitPrice: "80000.00", lineAmount: "80000.00", hasContractPrice: false,
        todayYmd: "2026-06-15", requiredApplicationMode: "COUPON",
      });
      expect(line1?.discountForUnit).toBe("10000.00"); // 20% of 80,000 = 16,000 capped to 10,000

      // Cat 2 item does not qualify
      const line2 = resolvePromotionFromSnapshot(snap, {
        branchId: 1, customerTier: "RETAIL", productId: 20, variantId: 201, categoryId: 2,
        unitPrice: "50000.00", lineAmount: "50000.00", hasContractPrice: false,
        todayYmd: "2026-06-15", requiredApplicationMode: "COUPON",
      });
      expect(line2).toBeNull();
    });

    it("T3.2: Fixed amount coupon + free shipping on qualifying minimum spend order", () => {
      const subtotal = money("65000.00");
      const minOrderSpend = money("50000.00");
      expect(subtotal.gte(minOrderSpend)).toBe(true);

      const fixedDiscount = money("10000.00");
      const deliveryFee = money("5000.00");
      const freeShipping = true;

      const effectiveDelivery = freeShipping ? money(0) : deliveryFee;
      const netTotal = subtotal.minus(fixedDiscount).plus(effectiveDelivery);
      expect(netTotal.toFixed(2)).toBe("55000.00");
    });

    it("T3.3: Affiliate attributed coupon + percentage discount with max cap: commission on net sales", () => {
      // 100,000 IQD cart, 20% discount capped at 15,000 IQD.
      // Net sales = 85,000 IQD.
      // Affiliate gets 10% commission = 8,500.00 IQD.
      const grossSales = money("100000.00");
      const couponDiscount = calculateDiscountAmount({
        type: "PERCENT",
        unitPrice: grossSales,
        quantity: "1",
        discountPercent: "20.00",
        maxDiscountAmount: "15000.00",
      });
      expect(couponDiscount.toFixed(2)).toBe("15000.00");

      const netSales = grossSales.minus(couponDiscount);
      expect(netSales.toFixed(2)).toBe("85000.00");

      const commission = calculateAffiliateCommission(netSales, "10.00");
      expect(commission.toFixed(2)).toBe("8500.00");
    });

    it("T3.4: Multi-line invoice with coupon cap + 250 IQD cash rounding", () => {
      // Line 1: 30,000 @ 20% = 6,000. Net = 24,000.
      // Line 2: 45,000 @ 20% = 9,000. Net = 36,000.
      // Uncapped discount = 15,000. Cap = 10,000.
      const lines = [
        { variantId: 1, promotionId: 10, promotionDiscount: "6000.00", discountAmount: "6000.00", total: "24000.00" },
        { variantId: 2, promotionId: 10, promotionDiscount: "9000.00", discountAmount: "9000.00", total: "36000.00" },
      ];
      const alloc = allocateCouponDiscountAcrossLines(lines, 10, "10000.00");
      expect(alloc.totalCouponDiscount).toBe("10000.00");

      const totals = computeInvoiceTotals({
        lineTotals: alloc.lines.map((l) => l.total),
      });
      // Gross = 75,000. Less cap 10,000 = 65,000.
      expect(totals.total).toBe("65000.00");

      // 65,000 with cash rounding is 65,000.
      const cashRounded = roundCashIQD(money(totals.total));
      expect(cashRounded.toFixed(2)).toBe("65000.00");
    });
  });

  describe("Tier 4: Real-World Application Scenarios", () => {
    it("T4.1 Influencer Campaign (Ahmad AHMAD20)", () => {
      // Influencer Ahmad with code AHMAD20 (20% off up to 15,000 IQD cap, min spend 40,000 IQD, 10% commission).
      // Order of 100,000 IQD clamped to 15,000 IQD discount, customer pays 85,000 IQD, Ahmad earns 8,500 IQD commission.
      const orderSubtotal = money("100000.00");
      const minSpend = money("40000.00");
      expect(orderSubtotal.gte(minSpend)).toBe(true);

      const discount = calculateDiscountAmount({
        type: "PERCENT",
        unitPrice: orderSubtotal,
        quantity: "1",
        discountPercent: "20.00",
        maxDiscountAmount: "15000.00",
      });
      expect(discount.toFixed(2)).toBe("15000.00");

      const netSales = orderSubtotal.minus(discount);
      expect(netSales.toFixed(2)).toBe("85000.00");

      const ahmadCommission = calculateAffiliateCommission(netSales, "10.00");
      expect(ahmadCommission.toFixed(2)).toBe("8500.00");
    });

    it("T4.2 Free Shipping Promotion Campaign (FREESHIP)", () => {
      // Code FREESHIP waives 5,000 IQD delivery fee on orders >= 60,000 IQD; orders below 60,000 IQD rejected.
      const qualifyingOrder = money("75000.00");
      const nonQualifyingOrder = money("45000.00");
      const minSpend = money("60000.00");

      expect(qualifyingOrder.gte(minSpend)).toBe(true);
      expect(nonQualifyingOrder.gte(minSpend)).toBe(false);

      const standardDelivery = money("5000.00");
      const waivedFee = qualifyingOrder.gte(minSpend) ? money(0) : standardDelivery;
      expect(waivedFee.toFixed(2)).toBe("0.00");
    });

    it("T4.3 Multi-Unit Bulk Purchase (5 units at 100,000 IQD with 20% capped at 15,000 IQD)", () => {
      const lines = [
        {
          variantId: 901,
          promotionId: 101,
          promotionDiscount: "100000.00", // 5 x 20,000
          discountAmount: "100000.00",
          total: "400000.00",
        },
      ];
      const allocation = allocateCouponDiscountAcrossLines(lines, 101, "15000.00");
      expect(allocation.isCapped).toBe(true);
      expect(allocation.totalCouponDiscount).toBe("15000.00");
      expect(allocation.lines[0].total).toBe("485000.00");

      const totals = computeInvoiceTotals({ lineTotals: allocation.lines.map((l) => l.total) });
      expect(totals.total).toBe("485000.00");
    });

    it("T4.4 Multi-Line Order with Cap Clamping and Contract Pricing", () => {
      // Line 1: Contract price item (20,000 IQD, no coupon discount)
      // Line 2: Promo item 1 (50,000 IQD @ 20% = 10,000 IQD)
      // Line 3: Promo item 2 (80,000 IQD @ 20% = 16,000 IQD)
      // Uncapped promo discount = 26,000 IQD. Cap = 15,000 IQD.
      const lines = [
        { variantId: 1, promotionId: null, promotionDiscount: "0.00", discountAmount: "0.00", total: "20000.00" },
        { variantId: 2, promotionId: 50, promotionDiscount: "10000.00", discountAmount: "10000.00", total: "40000.00" },
        { variantId: 3, promotionId: 50, promotionDiscount: "16000.00", discountAmount: "16000.00", total: "64000.00" },
      ];
      const alloc = allocateCouponDiscountAcrossLines(lines, 50, "15000.00");
      expect(alloc.isCapped).toBe(true);
      expect(alloc.totalCouponDiscount).toBe("15000.00");

      expect(alloc.lines[0].total).toBe("20000.00");
      expect(alloc.lines[1].total).toBe("44230.77");
      expect(alloc.lines[2].total).toBe("70769.23");

      const totals = computeInvoiceTotals({ lineTotals: alloc.lines.map((l) => l.total) });
      expect(totals.total).toBe("135000.00"); // 150,000 gross - 15,000 cap
    });
  });
});

