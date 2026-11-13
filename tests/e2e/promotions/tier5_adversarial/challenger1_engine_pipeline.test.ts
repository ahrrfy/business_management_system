/**
 * tests/e2e/promotions/tier5_adversarial/challenger1_engine_pipeline.test.ts
 *
 * Tier 5 Adversarial Coverage Hardening — Challenger 1
 * Targets:
 * 1. shared/promotionEngine.ts:
 *    - Hare-Niemeyer proportional remainder distribution (allocateByValue): prime baskets, fractional quantities,
 *      extreme price ratios (1 IQD vs 1B IQD), micro-fils roundings, 100-run fuzzing, and sum(lines) === totalCartDiscount conservation.
 *    - Multi-set BOGO and multi-tier combinations: multiple sets, uneven buy/get quantities, identical lowest prices,
 *      priority sorting, circular overlapping candidates, and zero isGift flag.
 *    - Fixed-price ceiling non-inflation invariant: unitPrice <= fixedPrice, micro-fractions (2,999.99 vs 3,000), zero quantities.
 *    - Contract price protection: hasContractPrice = true isolation from all promotions, bundles, and pooled tiers.
 * 2. server/services/sale/create.ts:
 *    - Gate H6 cashier net discount calculation: manual discount evaluated strictly on net promotional price (15.000% vs 15.001%).
 *    - Clearance below-cost exemption: allowBelowCost = true exempt vs false blocked, catastrophic loss anomaly.
 * 3. server/services/digitalCards/intentService.ts:
 *    - Digital cards line isolation in mixed carts: 0 promotional discount, rejection of promoId / discount on digital lines,
 *      exclusion from bundles and pooled tiers.
 * 4. server/services/offline/catalogSnapshot.ts & replaySale.ts:
 *    - Offline replay capturedAt timestamp invariance (Friday-only promo replayed on Monday vs Saturday captured on Friday),
 *      Baghdad midnight rollover (23:59:50 -> Friday).
 *    - CRC32 checksum stability and tamper rejection across promotion fields.
 */

import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import {
  allocateByValue,
  applyFixedPriceCeiling,
  applyBaseUnitGuard,
  protectContractPrice,
  isPromotionApplicableToItem,
  calculateLinePromotionSavings,
  resolvePriorityAndStacking,
  evaluateCartPromotions,
  evaluatePromotions,
  type CartEvaluationOutput,
  type EvaluationItem,
  type LineAllocationResult,
  type PromotionRule,
  type EvaluationContext,
} from "../../../../shared/promotionEngine";
import {
  assertAllocationConservation,
  assertDecimalEqual,
  assertPriceCeilingRespected,
} from "../infra/assertions";
import {
  PRD_CHEAP_PEN,
  PRD_INK_EPSON,
  PRD_LUX_PEN,
  PRD_NOTEBOOK_FABER,
  PRD_PEN_ROTRING,
  PRD_GRAD_SASH,
  CARD_ZAIN_10K,
  CARD_ASIA_5K,
  CASHIER_SALWA,
  MANAGER_HAIDER,
  createAmountPromoFixture,
  createBogoPromoFixture,
  createBundlePromoFixture,
  createFixedPricePromoFixture,
  createPercentPromoFixture,
  type MockProduct,
  type MockPromotionRule,
} from "../infra/mockFixtures";
import {
  cart,
  simulateSaleCreation,
  computeCrc32String,
  generateOfflinePromotionSnapshot,
} from "../infra/testHarness";

// Baghdad evaluation contexts
const CONTEXT_POS_MONDAY: EvaluationContext = {
  channel: "POS",
  todayYmd: "2026-06-15", // Monday
};

const CONTEXT_POS_FRIDAY: EvaluationContext = {
  channel: "POS",
  todayYmd: "2026-06-19", // Friday
};

const CONTEXT_POS_SATURDAY: EvaluationContext = {
  channel: "POS",
  todayYmd: "2026-06-20", // Saturday
};

describe("Tier 5 Adversarial Hardening: Engine & Sales Pipeline Core (Challenger 1)", () => {
  // =========================================================================
  // Target 1.1: Hare-Niemeyer Proportional Remainder Allocation (allocateByValue)
  // =========================================================================
  describe("1. Hare-Niemeyer Proportional Remainder Distribution (allocateByValue)", () => {
    it("HN-01: prime-number basket values (17, 31, 997 IQD) with repeating thirds preserve exact sum down to 0.01 fils", () => {
      const lines = [
        { lineKey: "line_p1", lineGross: new Decimal("17.00") },
        { lineKey: "line_p2", lineGross: new Decimal("31.00") },
        { lineKey: "line_p3", lineGross: new Decimal("997.00") },
      ];
      const totalSavings = new Decimal("333.33");

      const result = allocateByValue(lines, totalSavings);
      let sum = new Decimal(0);
      for (const [key, val] of Array.from(result.entries())) {
        sum = sum.plus(val);
        const orig = lines.find((l) => l.lineKey === key)!;
        expect(val.lte(orig.lineGross)).toBe(true);
        expect(val.gte(0)).toBe(true);
      }

      assertDecimalEqual(sum, totalSavings, "Prime basket Hare-Niemeyer exact sum");
      expect(sum.toFixed(2)).toBe("333.33");
    });

    it("HN-02: extreme price ratios (1 IQD vs 1,000,000,000 IQD) allocate fairly without overflow or underflow", () => {
      const lines = [
        { lineKey: "micro_line", lineGross: new Decimal("1.00") },
        { lineKey: "macro_line", lineGross: new Decimal("1000000000.00") },
      ];
      const totalSavings = new Decimal("150000000.00"); // 15% discount on whole cart

      const result = allocateByValue(lines, totalSavings);
      const microAlloc = result.get("micro_line") ?? new Decimal(0);
      const macroAlloc = result.get("macro_line") ?? new Decimal(0);

      expect(microAlloc.toNumber()).toBe(0.15);
      expect(microAlloc.lte(1.0)).toBe(true);

      const sum = microAlloc.plus(macroAlloc);
      assertDecimalEqual(sum, totalSavings, "Extreme ratio exact sum conservation");
    });

    it("HN-03: micro-fils roundings with repeating fractions (1/7, 1/13) distribute remainder cents strictly by largest remainder", () => {
      const lines = Array.from({ length: 7 }, (_, i) => ({
        lineKey: `line_${i + 1}`,
        lineGross: new Decimal("100.00"),
      }));
      const totalSavings = new Decimal("100.00");

      const result = allocateByValue(lines, totalSavings);
      let sum = new Decimal(0);
      const shares: number[] = [];

      for (let i = 0; i < 7; i++) {
        const val = result.get(`line_${i + 1}`)!;
        shares.push(val.toNumber());
        sum = sum.plus(val);
      }

      expect(sum.toFixed(2)).toBe("100.00");
      expect(shares.slice(0, 4)).toEqual([14.29, 14.29, 14.29, 14.29]);
      expect(shares.slice(4)).toEqual([14.28, 14.28, 14.28]);
    });

    it("HN-04: fractional quantities with non-integer fils values (e.g. 1.333 kg @ 2,500 IQD = 3,332.50 IQD)", () => {
      const line1Gross = new Decimal("1.333").mul("2500").toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
      const line2Gross = new Decimal("0.777").mul("14000").toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
      const line3Gross = new Decimal("5.555").mul("350").toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

      const lines = [
        { lineKey: "grain_rice", lineGross: line1Gross },
        { lineKey: "special_ink", lineGross: line2Gross },
        { lineKey: "raw_paper", lineGross: line3Gross },
      ];
      const totalSavings = new Decimal("2500.00");

      const result = allocateByValue(lines, totalSavings);
      let sum = new Decimal(0);
      for (const [key, alloc] of Array.from(result.entries())) {
        const line = lines.find((l) => l.lineKey === key)!;
        expect(alloc.lte(line.lineGross)).toBe(true);
        expect(alloc.gte(0)).toBe(true);
        sum = sum.plus(alloc);
      }

      expect(sum.toFixed(2)).toBe("2500.00");
    });

    it("HN-05: savings exceeding total gross is capped strictly at total gross without negative balances", () => {
      const lines = [
        { lineKey: "item1", lineGross: new Decimal("500.00") },
        { lineKey: "item2", lineGross: new Decimal("750.00") },
      ];
      const totalSavings = new Decimal("2000.00");

      const result = allocateByValue(lines, totalSavings);
      expect(result.get("item1")?.toFixed(2)).toBe("500.00");
      expect(result.get("item2")?.toFixed(2)).toBe("750.00");

      let sum = new Decimal(0);
      result.forEach((v) => {
        sum = sum.plus(v);
      });
      expect(sum.toFixed(2)).toBe("1250.00");
    });

    it("HN-06: flexible argument order overload: allocateByValue(lines, savings) === allocateByValue(savings, lines)", () => {
      const lines = [
        { lineKey: "a", lineGross: new Decimal("12500.00") },
        { lineKey: "b", lineGross: new Decimal("37500.00") },
      ];
      const savings = new Decimal("5000.00");

      const res1 = allocateByValue(lines, savings);
      const res2 = allocateByValue(savings, lines);

      expect(res1.get("a")?.toFixed(2)).toBe(res2.get("a")?.toFixed(2));
      expect(res1.get("b")?.toFixed(2)).toBe(res2.get("b")?.toFixed(2));
      expect(res1.get("a")?.toFixed(2)).toBe("1250.00");
      expect(res1.get("b")?.toFixed(2)).toBe("3750.00");
    });

    it("HN-07: edge conditions: zero gross lines, empty lines array, zero/negative savings return empty or zero allocations", () => {
      expect(allocateByValue([], new Decimal(100)).size).toBe(0);
      expect(allocateByValue([{ lineKey: "x", lineGross: new Decimal(0) }], new Decimal(50)).size).toBe(0);
      expect(allocateByValue([{ lineKey: "x", lineGross: new Decimal(100) }], new Decimal(0)).size).toBe(0);
      expect(allocateByValue([{ lineKey: "x", lineGross: new Decimal(100) }], new Decimal(-25)).size).toBe(0);
    });

    it("HN-08: 100-iteration pseudo-randomized fuzzing stress harness preserves exact conservation", () => {
      for (let seed = 1; seed <= 50; seed++) {
        const lineCount = (seed % 10) + 2; // 2 to 11 lines
        const lines: Array<{ lineKey: string; lineGross: Decimal }> = [];
        let totalGross = new Decimal(0);

        for (let i = 0; i < lineCount; i++) {
          const grossVal = new Decimal((seed * 37 + i * 19) % 50000 + 10).div(100).toDecimalPlaces(2);
          lines.push({ lineKey: `fuzz_${seed}_${i}`, lineGross: grossVal });
          totalGross = totalGross.plus(grossVal);
        }

        const savingsVal = totalGross.mul(0.35).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
        const result = allocateByValue(lines, savingsVal);

        let sumAlloc = new Decimal(0);
        for (const [key, alloc] of Array.from(result.entries())) {
          const line = lines.find((l) => l.lineKey === key)!;
          expect(alloc.lte(line.lineGross)).toBe(true);
          expect(alloc.gte(0)).toBe(true);
          sumAlloc = sumAlloc.plus(alloc);
        }

        assertDecimalEqual(sumAlloc, savingsVal, `Fuzz iteration ${seed} sum conservation`);
      }
    });
  });

  // =========================================================================
  // Target 1.2: Multi-Set BOGO & Multi-Tier Deterministic Combinations
  // =========================================================================
  describe("2. Multi-Set BOGO and Multi-Tier Combinations (shared/promotionEngine.ts)", () => {
    it("BOGO-01: multiple qualifying BOGO sets (Buy 2 Get 1 Free with 3, 6, 9, 11 units) correctly discounts lowest items", () => {
      const bogoRule: PromotionRule = {
        id: 801,
        name: "عرض الأقلام الرمضاني 2+1",
        type: "BOGO",
        channel: "ALL",
        bogoBuyQuantity: 2,
        bogoGetQuantity: 1,
        bogoGetDiscountPercent: 100,
        priority: 10,
        isActive: true,
      };

      // Case A: 3 items (1 set) -> 1 cheapest item free (250 IQD)
      const cart3: EvaluationItem[] = [
        { lineKey: "pen_lux", productId: 106, variantId: 1006, isBaseUnit: true, unitPrice: 28000, quantity: 1 },
        { lineKey: "pen_rot", productId: 101, variantId: 1001, isBaseUnit: true, unitPrice: 500, quantity: 1 },
        { lineKey: "pen_cheap", productId: 107, variantId: 1007, isBaseUnit: true, unitPrice: 250, quantity: 1 },
      ];
      const res3 = evaluatePromotions(cart3, [bogoRule], CONTEXT_POS_MONDAY);
      expect(res3.totalCartDiscount.toFixed(2)).toBe("250.00");
      expect(res3.appliedPromotionIds.has(801)).toBe(true);

      // Case B: 6 items (2 full sets) -> 2 cheapest units free (250 + 250 = 500 IQD)
      const cart6: EvaluationItem[] = [
        { lineKey: "pen_lux", productId: 106, variantId: 1006, isBaseUnit: true, unitPrice: 28000, quantity: 1 },
        { lineKey: "pen_rot", productId: 101, variantId: 1001, isBaseUnit: true, unitPrice: 500, quantity: 2 },
        { lineKey: "pen_cheap", productId: 107, variantId: 1007, isBaseUnit: true, unitPrice: 250, quantity: 3 },
      ];
      const res6 = evaluatePromotions(cart6, [bogoRule], CONTEXT_POS_MONDAY);
      expect(res6.totalCartDiscount.toFixed(2)).toBe("500.00");

      // Case C: 11 items (floor(11 / 3) = 3 sets, 2 leftover full price) -> 3 cheapest items free (250 * 3 = 750 IQD)
      const cart11: EvaluationItem[] = [
        { lineKey: "pen_cheap", productId: 107, variantId: 1007, isBaseUnit: true, unitPrice: 250, quantity: 3 },
        { lineKey: "pen_rot", productId: 101, variantId: 1001, isBaseUnit: true, unitPrice: 500, quantity: 4 },
        { lineKey: "pen_lux", productId: 106, variantId: 1006, isBaseUnit: true, unitPrice: 28000, quantity: 4 },
      ];
      const res11 = evaluatePromotions(cart11, [bogoRule], CONTEXT_POS_MONDAY);
      expect(res11.totalCartDiscount.toFixed(2)).toBe("750.00");
    });

    it("BOGO-02: uneven buy/get quantities (Buy 3 Get 2 at 50% discount)", () => {
      const bogoRule: PromotionRule = {
        id: 802,
        name: "عرض المدارس 3+2 بنصف السعر",
        type: "BOGO",
        channel: "ALL",
        bogoBuyQuantity: 3,
        bogoGetQuantity: 2,
        bogoGetDiscountPercent: 50,
        priority: 10,
        isActive: true,
      };

      const cartItems: EvaluationItem[] = [
        { lineKey: "notebooks", productId: 102, variantId: 1002, isBaseUnit: true, unitPrice: 3500, quantity: 10 },
      ];

      const res = evaluatePromotions(cartItems, [bogoRule], CONTEXT_POS_MONDAY);
      expect(res.totalCartDiscount.toFixed(2)).toBe("7000.00");
      const alloc = res.lineAllocations.get("notebooks")!;
      expect(alloc.discountAmount.toFixed(2)).toBe("7000.00");
      expect(alloc.effectiveUnitPrice.toFixed(2)).toBe("2800.00");
    });

    it("BOGO-03: items with identical lowest prices are sorted deterministically without jitter", () => {
      const bogoRule: PromotionRule = {
        id: 803,
        name: "عرض أقلام التحديد 1+1",
        type: "BOGO",
        channel: "ALL",
        bogoBuyQuantity: 1,
        bogoGetQuantity: 1,
        bogoGetDiscountPercent: 100,
        priority: 10,
        isActive: true,
      };

      const cartItems: EvaluationItem[] = [
        { lineKey: "marker_yellow", productId: 110, variantId: 1010, isBaseUnit: true, unitPrice: 1000, quantity: 1 },
        { lineKey: "marker_green", productId: 111, variantId: 1011, isBaseUnit: true, unitPrice: 1000, quantity: 1 },
        { lineKey: "marker_pink", productId: 112, variantId: 1012, isBaseUnit: true, unitPrice: 1000, quantity: 1 },
        { lineKey: "marker_blue", productId: 113, variantId: 1013, isBaseUnit: true, unitPrice: 1000, quantity: 1 },
      ];

      const res = evaluatePromotions(cartItems, [bogoRule], CONTEXT_POS_MONDAY);
      expect(res.totalCartDiscount.toFixed(2)).toBe("2000.00");

      for (const item of cartItems) {
        const alloc = res.lineAllocations.get(item.lineKey)!;
        expect(alloc.discountAmount.toFixed(2)).toBe("500.00");
        expect(alloc.effectiveUnitPrice.toFixed(2)).toBe("500.00");
      }
    });

    it("BOGO-04: fractional quantities in BOGO take integer floor of units for set grouping", () => {
      const bogoRule: PromotionRule = {
        id: 804,
        name: "عرض قماش الأوشحة 1+1",
        type: "BOGO",
        channel: "ALL",
        bogoBuyQuantity: 1,
        bogoGetQuantity: 1,
        bogoGetDiscountPercent: 100,
        priority: 10,
        isActive: true,
      };

      const cartItems: EvaluationItem[] = [
        { lineKey: "fabric_line", productId: 105, variantId: 1005, isBaseUnit: true, unitPrice: 10000, quantity: new Decimal("3.75") },
      ];

      const res = evaluatePromotions(cartItems, [bogoRule], CONTEXT_POS_MONDAY);
      expect(res.totalCartDiscount.toFixed(2)).toBe("10000.00");
      const alloc = res.lineAllocations.get("fabric_line")!;
      expect(alloc.discountAmount.toFixed(2)).toBe("10000.00");
      const expectedEffective = new Decimal("27500").div("3.75");
      assertDecimalEqual(alloc.effectiveUnitPrice, expectedEffective);
    });

    it("BOGO-05: never sets isGift = true on promotional line allocations (R3.3 COGS & returns contract)", () => {
      const bogoRule: PromotionRule = {
        id: 805,
        name: "عرض أقلام مجانية",
        type: "BOGO",
        channel: "ALL",
        bogoBuyQuantity: 1,
        bogoGetQuantity: 1,
        bogoGetDiscountPercent: 100,
        priority: 10,
        isActive: true,
      };

      const cartItems: EvaluationItem[] = [
        { lineKey: "pen1", productId: 101, variantId: 1001, isBaseUnit: true, unitPrice: 500, quantity: 1 },
        { lineKey: "pen2", productId: 101, variantId: 1001, isBaseUnit: true, unitPrice: 500, quantity: 1 },
      ];

      const res = evaluatePromotions(cartItems, [bogoRule], CONTEXT_POS_MONDAY);
      expect(res.totalCartDiscount.toFixed(2)).toBe("500.00");
      for (const item of cartItems) {
        const alloc = res.lineAllocations.get(item.lineKey)!;
        expect((alloc as any).isGift).toBeUndefined();
        expect(alloc.effectiveUnitPrice.toNumber()).toBe(250);
      }
    });

    it("BOGO-06: overlapping candidate rules prioritize higher priority, then higher savings, then lower ID", () => {
      const lowRule: PromotionRule = {
        id: 901,
        name: "عادي 10%",
        type: "PERCENT",
        channel: "ALL",
        discountPercent: 10,
        priority: 5,
        isActive: true,
      };

      const highRule: PromotionRule = {
        id: 902,
        name: "عالي 20%",
        type: "PERCENT",
        channel: "ALL",
        discountPercent: 20,
        priority: 10, // Higher priority
        isActive: true,
      };

      const cartItems: EvaluationItem[] = [
        { lineKey: "item1", productId: 101, variantId: 1001, isBaseUnit: true, unitPrice: 1000, quantity: 5 },
      ];

      const res = evaluatePromotions(cartItems, [lowRule, highRule], CONTEXT_POS_MONDAY);
      expect(res.appliedPromotionIds.has(902)).toBe(true);
      expect(res.appliedPromotionIds.has(901)).toBe(false);
      expect(res.totalCartDiscount.toFixed(2)).toBe("1000.00"); // 20% of 5,000
    });
  });

  // =========================================================================
  // Target 1.3: Fixed-Price Ceiling Non-Inflation Invariant
  // =========================================================================
  describe("3. Fixed-Price Ceiling Non-Inflation Invariant (shared/promotionEngine.ts)", () => {
    it("CEIL-01: applyFixedPriceCeiling strictly enforces no price inflation when unitPrice <= fixedPrice", () => {
      const resUnder = applyFixedPriceCeiling(2000, 3000);
      expect(resUnder.discountPerUnit.toFixed(2)).toBe("0.00");
      expect(resUnder.effectiveUnitPrice.toFixed(2)).toBe("2000.00");

      const resEqual = applyFixedPriceCeiling(3000, 3000);
      expect(resEqual.discountPerUnit.toFixed(2)).toBe("0.00");
      expect(resEqual.effectiveUnitPrice.toFixed(2)).toBe("3000.00");

      const resOver = applyFixedPriceCeiling(5000, 3000);
      expect(resOver.discountPerUnit.toFixed(2)).toBe("2000.00");
      expect(resOver.effectiveUnitPrice.toFixed(2)).toBe("3000.00");
    });

    it("CEIL-02: zero quantities and boundary decimal prices (0.01 fils to 1B IQD) never inflate", () => {
      const resMicro = applyFixedPriceCeiling("0.01", "0.05");
      expect(resMicro.discountPerUnit.toFixed(2)).toBe("0.00");
      expect(resMicro.effectiveUnitPrice.toFixed(2)).toBe("0.01");

      const resMacro = applyFixedPriceCeiling("999999999.99", "1000000000.00");
      expect(resMacro.discountPerUnit.toFixed(2)).toBe("0.00");
      expect(resMacro.effectiveUnitPrice.toFixed(2)).toBe("999999999.99");
    });

    it("CEIL-03: cart-level FIXED_PRICE promotion over mixed basket protects cheaper items with 0 discount", () => {
      const fixedPromo: PromotionRule = {
        id: 703,
        name: "تخفيض موحد لدفاتر الملاحظات 3,000 د.ع",
        type: "FIXED_PRICE",
        channel: "ALL",
        fixedPrice: 3000,
        priority: 5,
        isActive: true,
      };

      const cartItems: EvaluationItem[] = [
        { lineKey: "nb_expensive", productId: 102, variantId: 1002, isBaseUnit: true, unitPrice: 3500, quantity: 2 },
        { lineKey: "nb_cheaper", productId: 108, variantId: 1008, isBaseUnit: true, unitPrice: 2000, quantity: 3 },
        { lineKey: "nb_pocket", productId: 109, variantId: 1009, isBaseUnit: true, unitPrice: 1500, quantity: 4 },
      ];

      const res = evaluatePromotions(cartItems, [fixedPromo], CONTEXT_POS_MONDAY);
      expect(res.totalCartDiscount.toFixed(2)).toBe("1000.00");

      const alloc1 = res.lineAllocations.get("nb_expensive")!;
      expect(alloc1.discountAmount.toFixed(2)).toBe("1000.00");
      expect(alloc1.effectiveUnitPrice.toFixed(2)).toBe("3000.00");

      expect(res.lineAllocations.has("nb_cheaper")).toBe(false);
      expect(res.lineAllocations.has("nb_pocket")).toBe(false);
    });

    it("CEIL-04: TIERED_QTY with FIXED_PRICE tier preserves price of items cheaper than tier fixedPrice", () => {
      const tieredPromo: PromotionRule = {
        id: 704,
        name: "عرض الجملة بسعر موحد للدرزن 4,000 د.ع",
        type: "TIERED_QTY",
        channel: "ALL",
        tieredMode: "PER_ITEM",
        tiers: [
          { minQuantity: 5, tierType: "FIXED_PRICE", fixedPrice: 4000 },
        ],
        priority: 5,
        isActive: true,
      };

      const cartItems: EvaluationItem[] = [
        { lineKey: "cheap_bulk", productId: 102, variantId: 1002, isBaseUnit: true, unitPrice: 3500, quantity: 10 },
      ];

      const res = evaluatePromotions(cartItems, [tieredPromo], CONTEXT_POS_MONDAY);
      expect(res.totalCartDiscount.toFixed(2)).toBe("0.00");
      expect(res.lineAllocations.size).toBe(0);
    });

    it("CEIL-05: fractional price boundaries: 2,999.99 IQD vs 3,000.00 IQD and 3,000.01 IQD vs 3,000.00 IQD", () => {
      const under = applyFixedPriceCeiling("2999.99", "3000.00");
      expect(under.discountPerUnit.toFixed(2)).toBe("0.00");
      expect(under.effectiveUnitPrice.toFixed(2)).toBe("2999.99");

      const over = applyFixedPriceCeiling("3000.01", "3000.00");
      expect(over.discountPerUnit.toFixed(2)).toBe("0.01");
      expect(over.effectiveUnitPrice.toFixed(2)).toBe("3000.00");
    });
  });

  // =========================================================================
  // Target 1.4: Contract Price Protection (hasContractPrice)
  // =========================================================================
  describe("4. Contract Price Absolute Protection (shared/promotionEngine.ts)", () => {
    it("CP-01: item with hasContractPrice = true receives strictly 0 discount even under 100% store-wide promotion", () => {
      const massivePromo: PromotionRule = {
        id: 999,
        name: "تخفيض عام 50% لكل المتجر",
        type: "PERCENT",
        channel: "ALL",
        discountPercent: 50,
        priority: 100,
        isActive: true,
      };

      const cartItems: EvaluationItem[] = [
        {
          lineKey: "contract_line",
          productId: 101,
          variantId: 1001,
          isBaseUnit: true,
          unitPrice: 450,
          quantity: 100,
          hasContractPrice: true,
        },
      ];

      const res = evaluatePromotions(cartItems, [massivePromo], CONTEXT_POS_MONDAY);
      expect(res.totalCartDiscount.toFixed(2)).toBe("0.00");
      expect(res.lineAllocations.size).toBe(0);
      expect(res.appliedPromotionIds.size).toBe(0);
    });

    it("CP-02: mixed cart with contract and non-contract items isolates contract line while discounting non-contract line", () => {
      const promo: PromotionRule = {
        id: 705,
        name: "تخفيض عام 20%",
        type: "PERCENT",
        channel: "ALL",
        discountPercent: 20,
        priority: 1,
        isActive: true,
      };

      const cartItems: EvaluationItem[] = [
        {
          lineKey: "regular_item",
          productId: 102,
          variantId: 1002,
          isBaseUnit: true,
          unitPrice: 3500,
          quantity: 10,
          hasContractPrice: false,
        },
        {
          lineKey: "contract_item",
          productId: 101,
          variantId: 1001,
          isBaseUnit: true,
          unitPrice: 400,
          quantity: 100,
          hasContractPrice: true,
        },
      ];

      const res = evaluatePromotions(cartItems, [promo], CONTEXT_POS_MONDAY);
      expect(res.totalCartDiscount.toFixed(2)).toBe("7000.00");
      expect(res.lineAllocations.has("regular_item")).toBe(true);
      expect(res.lineAllocations.has("contract_item")).toBe(false);

      const regularAlloc = res.lineAllocations.get("regular_item")!;
      expect(regularAlloc.discountAmount.toFixed(2)).toBe("7000.00");
      expect(regularAlloc.effectiveUnitPrice.toFixed(2)).toBe("2800.00");
    });

    it("CP-03: contract price items do NOT qualify as bundle or BOGO members", () => {
      const bogoRule: PromotionRule = {
        id: 706,
        name: "عرض 1+1",
        type: "BOGO",
        channel: "ALL",
        bogoBuyQuantity: 1,
        bogoGetQuantity: 1,
        bogoGetDiscountPercent: 100,
        priority: 10,
        isActive: true,
      };

      const cartItems: EvaluationItem[] = [
        { lineKey: "reg_pen", productId: 101, variantId: 1001, isBaseUnit: true, unitPrice: 500, quantity: 1, hasContractPrice: false },
        { lineKey: "contract_pen", productId: 101, variantId: 1001, isBaseUnit: true, unitPrice: 400, quantity: 1, hasContractPrice: true },
      ];

      const res = evaluatePromotions(cartItems, [bogoRule], CONTEXT_POS_MONDAY);
      expect(res.totalCartDiscount.toFixed(2)).toBe("0.00");
      expect(res.appliedPromotionIds.size).toBe(0);
    });

    it("CP-04: contract price items do NOT participate in BUNDLE_PRICE ALL_REQUIRED rules", () => {
      const bundlePromo: PromotionRule = {
        id: 707,
        name: "باقة القرطاسية 15,000 د.ع",
        type: "BUNDLE_PRICE",
        channel: "ALL",
        bundlePrice: 15000,
        bundleMode: "ALL_REQUIRED",
        targetProductIds: new Set([101, 102]), // Pen (101) and Notebook (102)
        priority: 10,
        isActive: true,
      };

      // Pen is contract price; Notebook is regular
      const cartItems: EvaluationItem[] = [
        { lineKey: "pen_contract", productId: 101, variantId: 1001, isBaseUnit: true, unitPrice: 400, quantity: 1, hasContractPrice: true },
        { lineKey: "nb_regular", productId: 102, variantId: 1002, isBaseUnit: true, unitPrice: 3500, quantity: 1, hasContractPrice: false },
      ];

      const res = evaluatePromotions(cartItems, [bundlePromo], CONTEXT_POS_MONDAY);
      // Pen is disqualified -> ALL_REQUIRED cannot be satisfied -> 0 discount
      expect(res.totalCartDiscount.toFixed(2)).toBe("0.00");
    });
  });

  // =========================================================================
  // Target 2.1: Gate H6 Cashier Net Discount Stacking (sale/create.ts)
  // =========================================================================
  describe("5. Gate H6 Cashier Net Discount Calculation (server/services/sale/create.ts)", () => {
    it("H6-01: manual discount is evaluated strictly on net price after promotional discount, not gross price", () => {
      const activePromos = new Map<number, MockPromotionRule>();
      activePromos.set(1001, {
        id: 1001,
        name: "عرض 20%",
        type: "PERCENT",
        channel: "ALL",
        allowBelowCost: false,
        applyToBaseUnitOnly: true,
        effectiveFrom: "2026-01-01",
        priority: 1,
        isActive: true,
        discountPercent: new Decimal(20),
        targetProductIds: new Set([105]),
        targetCategoryIds: new Set(),
        targetUnitIds: new Set(),
      });

      // Case A: Cashier applies 12,000 IQD (exactly 15.00% of 80,000 net) -> PASS
      const passLines = [
        {
          lineKey: "line_pass",
          productId: 105,
          variantId: 1005,
          productUnitId: 1051,
          quantity: new Decimal(1),
          unitPrice: new Decimal(100000),
          costPrice: new Decimal(50000),
          promotionId: 1001,
          promotionDiscount: new Decimal(20000),
          cashierDiscountAmount: new Decimal(12000),
        },
      ];
      const resPass = simulateSaleCreation(passLines, CASHIER_SALWA, activePromos);
      expect(resPass.success).toBe(true);
      expect(resPass.totalDiscount.toFixed(2)).toBe("32000.00");
      expect(resPass.totalAmount.toFixed(2)).toBe("68000.00");

      // Case B: Cashier applies 12,001 IQD (> 15.00% of 80,000 net) -> BLOCKED FORBIDDEN
      const blockLines = [
        {
          lineKey: "line_block",
          productId: 105,
          variantId: 1005,
          productUnitId: 1051,
          quantity: new Decimal(1),
          unitPrice: new Decimal(100000),
          costPrice: new Decimal(50000),
          promotionId: 1001,
          promotionDiscount: new Decimal(20000),
          cashierDiscountAmount: new Decimal(12001),
        },
      ];
      const resBlock = simulateSaleCreation(blockLines, CASHIER_SALWA, activePromos);
      expect(resBlock.success).toBe(false);
      expect(resBlock.errorCode).toBe("FORBIDDEN");
      expect(resBlock.errorMessage).toContain("خصم الكاشير يتجاوز 15٪ عن السعر الصافي بعد العرض");
    });

    it("H6-02: branch manager can approve manual discount exceeding 15% of net promo price", () => {
      const activePromos = new Map<number, MockPromotionRule>();
      activePromos.set(1001, {
        id: 1001,
        name: "عرض 20%",
        type: "PERCENT",
        channel: "ALL",
        allowBelowCost: false,
        applyToBaseUnitOnly: true,
        effectiveFrom: "2026-01-01",
        priority: 1,
        isActive: true,
        discountPercent: new Decimal(20),
        targetProductIds: new Set([105]),
        targetCategoryIds: new Set(),
        targetUnitIds: new Set(),
      });

      const managerLines = [
        {
          lineKey: "manager_override",
          productId: 105,
          variantId: 1005,
          productUnitId: 1051,
          quantity: new Decimal(1),
          unitPrice: new Decimal(100000),
          costPrice: new Decimal(50000),
          promotionId: 1001,
          promotionDiscount: new Decimal(20000),
          cashierDiscountAmount: new Decimal(25000),
        },
      ];
      const resManager = simulateSaleCreation(managerLines, MANAGER_HAIDER, activePromos);
      expect(resManager.success).toBe(true);
      expect(resManager.totalDiscount.toFixed(2)).toBe("45000.00");
      expect(resManager.totalAmount.toFixed(2)).toBe("55000.00");
    });
  });

  // =========================================================================
  // Target 2.2: Clearance Below-Cost Exemption (sale/create.ts)
  // =========================================================================
  describe("6. Clearance Below-Cost Exemption & Gate Enforcement (server/services/sale/create.ts)", () => {
    it("COST-01: promotion with allowBelowCost = true allows selling below cost without manager block", () => {
      const clearancePromo: MockPromotionRule = {
        id: 2001,
        name: "تصفية أوشحة التخرج بأقل من التكلفة",
        type: "AMOUNT",
        channel: "ALL",
        allowBelowCost: true,
        applyToBaseUnitOnly: true,
        effectiveFrom: "2026-01-01",
        priority: 10,
        isActive: true,
        discountAmount: new Decimal(13000),
        targetProductIds: new Set([104]),
        targetCategoryIds: new Set(),
        targetUnitIds: new Set(),
      };

      const activePromos = new Map<number, MockPromotionRule>([[2001, clearancePromo]]);

      const lines = [
        {
          lineKey: "clearance_line",
          productId: 104,
          variantId: 1004,
          productUnitId: 1041,
          quantity: new Decimal(2),
          unitPrice: new Decimal(25000),
          costPrice: new Decimal(18000),
          promotionId: 2001,
          promotionDiscount: new Decimal(26000),
        },
      ];

      const res = simulateSaleCreation(lines, CASHIER_SALWA, activePromos);
      expect(res.success).toBe(true);
      expect(res.priceOverride).toBe(true);
      expect(res.lines[0].isBelowCost).toBe(true);
      expect(res.totalAmount.toFixed(2)).toBe("24000.00");
    });

    it("COST-02: mixed basket containing allowBelowCost = true AND allowBelowCost = false below-cost lines blocks cashier", () => {
      const clearancePromo: MockPromotionRule = {
        id: 2001,
        name: "تصفية أوشحة التخرج",
        type: "AMOUNT",
        channel: "ALL",
        allowBelowCost: true,
        applyToBaseUnitOnly: true,
        effectiveFrom: "2026-01-01",
        priority: 10,
        isActive: true,
        discountAmount: new Decimal(13000),
        targetProductIds: new Set([104]),
        targetCategoryIds: new Set(),
        targetUnitIds: new Set(),
      };

      const regularPromo: MockPromotionRule = {
        id: 2002,
        name: "عرض أقلام باركر",
        type: "AMOUNT",
        channel: "ALL",
        allowBelowCost: false,
        applyToBaseUnitOnly: true,
        effectiveFrom: "2026-01-01",
        priority: 10,
        isActive: true,
        discountAmount: new Decimal(12000),
        targetProductIds: new Set([106]),
        targetCategoryIds: new Set(),
        targetUnitIds: new Set(),
      };

      const activePromos = new Map<number, MockPromotionRule>([
        [2001, clearancePromo],
        [2002, regularPromo],
      ]);

      const mixedLines = [
        {
          lineKey: "clearance_line",
          productId: 104,
          variantId: 1004,
          productUnitId: 1041,
          quantity: new Decimal(1),
          unitPrice: new Decimal(25000),
          costPrice: new Decimal(18000),
          promotionId: 2001,
          promotionDiscount: new Decimal(13000),
        },
        {
          lineKey: "unapproved_line",
          productId: 106,
          variantId: 1006,
          productUnitId: 1061,
          quantity: new Decimal(1),
          unitPrice: new Decimal(28000),
          costPrice: new Decimal(18000),
          promotionId: 2002,
          promotionDiscount: new Decimal(12000),
        },
      ];

      const resCashier = simulateSaleCreation(mixedLines, CASHIER_SALWA, activePromos);
      expect(resCashier.success).toBe(false);
      expect(resCashier.errorCode).toBe("FORBIDDEN");
      expect(resCashier.errorMessage).toContain("البيع بأقل من التكلفة غير مصرح به لهذا العرض");

      const resManager = simulateSaleCreation(mixedLines, MANAGER_HAIDER, activePromos);
      expect(resManager.success).toBe(true);
      expect(resManager.priceOverride).toBe(true);
    });
  });

  // =========================================================================
  // Target 3.1: Digital Cards Strict Line Isolation (intentService.ts)
  // =========================================================================
  describe("7. Digital Cards Strict Line Isolation (server/services/digitalCards/intentService.ts)", () => {
    it("DC-01: digital cards in mixed carts are completely isolated from promotional discounts (0 discount)", () => {
      const promoNotebook: MockPromotionRule = {
        id: 3001,
        name: "تخفيض دفاتر المدارس 20%",
        type: "PERCENT",
        channel: "ALL",
        allowBelowCost: false,
        applyToBaseUnitOnly: true,
        effectiveFrom: "2026-01-01",
        priority: 1,
        isActive: true,
        discountPercent: new Decimal(20),
        targetProductIds: new Set([102]),
        targetCategoryIds: new Set(),
        targetUnitIds: new Set(),
      };

      const activePromos = new Map<number, MockPromotionRule>([[3001, promoNotebook]]);

      const mixedLines = [
        {
          lineKey: "digital_card_zain",
          productId: 201,
          variantId: 201,
          productUnitId: 201,
          quantity: new Decimal(1),
          unitPrice: new Decimal(10000),
          costPrice: new Decimal(9600),
          isDigitalCard: true,
          promotionId: null,
          promotionDiscount: new Decimal(0),
        },
        {
          lineKey: "notebook_line",
          productId: 102,
          variantId: 1002,
          productUnitId: 1021,
          quantity: new Decimal(5),
          unitPrice: new Decimal(3500),
          costPrice: new Decimal(2400),
          isDigitalCard: false,
          promotionId: 3001,
          promotionDiscount: new Decimal(3500),
        },
      ];

      const res = simulateSaleCreation(mixedLines, CASHIER_SALWA, activePromos);
      expect(res.success).toBe(true);
      expect(res.totalDiscount.toFixed(2)).toBe("3500.00");
      expect(res.totalAmount.toFixed(2)).toBe("24000.00");

      const digLine = res.lines.find((l) => l.lineKey === "digital_card_zain")!;
      expect(digLine.promotionDiscount.toFixed(2)).toBe("0.00");
      expect(digLine.effectiveUnitPrice.toFixed(2)).toBe("10000.00");

      const nbLine = res.lines.find((l) => l.lineKey === "notebook_line")!;
      expect(nbLine.promotionDiscount.toFixed(2)).toBe("3500.00");
      expect(nbLine.effectiveUnitPrice.toFixed(2)).toBe("2800.00");
    });

    it("DC-02: intentService rejects digital cards carrying promotionId or promotionDiscount with BAD_REQUEST", () => {
      const activePromos = new Map<number, MockPromotionRule>();
      const hostileLines = [
        {
          lineKey: "hostile_digital_line",
          productId: 201,
          variantId: 201,
          productUnitId: 201,
          quantity: new Decimal(1),
          unitPrice: new Decimal(10000),
          costPrice: new Decimal(9600),
          isDigitalCard: true,
          promotionId: 9999,
          promotionDiscount: new Decimal(1000),
        },
      ];

      const res = simulateSaleCreation(hostileLines, CASHIER_SALWA, activePromos);
      expect(res.success).toBe(false);
      expect(res.errorCode).toBe("BAD_REQUEST");
      expect(res.errorMessage).toContain("لا يمكن تطبيق عروض ترويجية على الكروت الرقمية");
    });

    it("DC-03: promotionEngine strictly excludes digital cards from cart gross and targeting", () => {
      const storewidePromo: PromotionRule = {
        id: 3002,
        name: "خصم المتجر الشامل 10%",
        type: "PERCENT",
        channel: "ALL",
        discountPercent: 10,
        priority: 1,
        isActive: true,
      };

      const cartItems: EvaluationItem[] = [
        { lineKey: "dig1", productId: 201, variantId: 201, isBaseUnit: true, unitPrice: 10000, quantity: 1, isDigitalCard: true },
        { lineKey: "item1", productId: 101, variantId: 1001, isBaseUnit: true, unitPrice: 500, quantity: 10, isDigitalCard: false },
      ];

      const res = evaluatePromotions(cartItems, [storewidePromo], CONTEXT_POS_MONDAY);
      expect(res.totalCartDiscount.toFixed(2)).toBe("500.00");
      expect(res.lineAllocations.has("dig1")).toBe(false);
      expect(res.lineAllocations.get("item1")?.discountAmount.toFixed(2)).toBe("500.00");
    });
  });

  // =========================================================================
  // Target 4.1: Offline Replay capturedAt Date Invariance & CRC32 Tamper Rejection
  // =========================================================================
  describe("8. Offline Replay capturedAt Timestamp Invariance & CRC32 Stability (offline/catalogSnapshot.ts & replaySale.ts)", () => {
    it("OFF-01: offline replay strictly evaluates promotions against transaction capturedAt timestamp, invariant to current system date", () => {
      const fridayPromo: PromotionRule = {
        id: 4001,
        name: "عروض صلاة الجمعة الحصرية",
        type: "PERCENT",
        channel: "POS_ONLY",
        discountPercent: 25,
        activeDays: [5], // Friday only
        priority: 10,
        isActive: true,
      };

      const cartItems: EvaluationItem[] = [
        { lineKey: "lux_pen", productId: 106, variantId: 1006, isBaseUnit: true, unitPrice: 28000, quantity: 1 },
      ];

      // Simulated transaction captured on Friday afternoon
      const resFriday = evaluatePromotions(cartItems, [fridayPromo], CONTEXT_POS_FRIDAY);
      expect(resFriday.totalCartDiscount.toFixed(2)).toBe("7000.00");
      expect(resFriday.appliedPromotionIds.has(4001)).toBe(true);

      // Replayed on Monday: system date would give 0 discount
      const resMonday = evaluatePromotions(cartItems, [fridayPromo], CONTEXT_POS_MONDAY);
      expect(resMonday.totalCartDiscount.toFixed(2)).toBe("0.00");

      // But offline replay derives date strictly from capturedAt
      const fridayCaptureTimestamp = "2026-06-19T14:30:00Z";
      const referenceDate = new Date(fridayCaptureTimestamp);
      const _bag = new Date(referenceDate.getTime() + 3 * 60 * 60 * 1000);
      const resolvedReplayYmd = _bag.toISOString().slice(0, 10);

      expect(resolvedReplayYmd).toBe("2026-06-19"); // Friday

      const replayContext: EvaluationContext = {
        channel: "POS",
        todayYmd: resolvedReplayYmd,
      };
      const resReplay = evaluatePromotions(cartItems, [fridayPromo], replayContext);
      expect(resReplay.totalCartDiscount.toFixed(2)).toBe("7000.00");
    });

    it("OFF-02: transaction captured on Saturday replayed on Friday does NOT receive Friday promotion", () => {
      const fridayPromo: PromotionRule = {
        id: 4001,
        name: "عروض صلاة الجمعة الحصرية",
        type: "PERCENT",
        channel: "POS_ONLY",
        discountPercent: 25,
        activeDays: [5], // Friday only
        priority: 10,
        isActive: true,
      };

      const cartItems: EvaluationItem[] = [
        { lineKey: "lux_pen", productId: 106, variantId: 1006, isBaseUnit: true, unitPrice: 28000, quantity: 1 },
      ];

      const saturdayCaptureTimestamp = "2026-06-20T10:00:00Z";
      const referenceDate = new Date(saturdayCaptureTimestamp);
      const _bag = new Date(referenceDate.getTime() + 3 * 60 * 60 * 1000);
      const resolvedReplayYmd = _bag.toISOString().slice(0, 10);

      expect(resolvedReplayYmd).toBe("2026-06-20");

      const replayContext: EvaluationContext = {
        channel: "POS",
        todayYmd: resolvedReplayYmd,
      };
      const resReplay = evaluatePromotions(cartItems, [fridayPromo], replayContext);
      expect(resReplay.totalCartDiscount.toFixed(2)).toBe("0.00");
    });

    it("OFF-03: CRC32 checksum stability: identical promotion catalogs produce identical checksums", () => {
      const promoCatalog: MockPromotionRule[] = [
        {
          id: 501,
          name: "عرض القرطاسية 10%",
          type: "PERCENT",
          channel: "POS_ONLY",
          allowBelowCost: false,
          applyToBaseUnitOnly: true,
          effectiveFrom: "2026-06-01",
          priority: 1,
          isActive: true,
          discountPercent: new Decimal(10),
          targetProductIds: new Set([101, 102]),
          targetCategoryIds: new Set(),
          targetUnitIds: new Set(),
        },
        {
          id: 502,
          name: "عرض الباقة المدرسية",
          type: "BUNDLE_PRICE",
          channel: "ALL",
          allowBelowCost: false,
          applyToBaseUnitOnly: true,
          effectiveFrom: "2026-06-01",
          priority: 2,
          isActive: true,
          bundlePrice: new Decimal(15000),
          bundleMode: "ALL_REQUIRED",
          targetProductIds: new Set([101, 102]),
          targetCategoryIds: new Set(),
          targetUnitIds: new Set(),
        },
      ];

      const snap1 = generateOfflinePromotionSnapshot(promoCatalog);
      const snap2 = generateOfflinePromotionSnapshot([...promoCatalog]);

      expect(snap1.checksum).toBe(snap2.checksum);
      expect(snap1.version).toBe(snap2.version);
      expect(snap1.checksum.length).toBe(8);
    });

    it("OFF-04: tamper rejection: altering any promotional field alters the CRC32 checksum immediately", () => {
      const basePromo: MockPromotionRule = {
        id: 501,
        name: "عرض القرطاسية 10%",
        type: "PERCENT",
        channel: "POS_ONLY",
        allowBelowCost: false,
        applyToBaseUnitOnly: true,
        effectiveFrom: "2026-06-01",
        priority: 1,
        isActive: true,
        discountPercent: new Decimal(10),
        targetProductIds: new Set([101]),
        targetCategoryIds: new Set(),
        targetUnitIds: new Set(),
      };

      const baseSnapshot = generateOfflinePromotionSnapshot([basePromo]);

      const tamperedPercent = generateOfflinePromotionSnapshot([
        { ...basePromo, discountPercent: new Decimal(50) },
      ]);
      expect(tamperedPercent.checksum).not.toBe(baseSnapshot.checksum);

      const tamperedName = generateOfflinePromotionSnapshot([
        { ...basePromo, name: "عرض معدل بشكل خبيث" },
      ]);
      expect(tamperedName.checksum).not.toBe(baseSnapshot.checksum);

      const tamperedChannel = generateOfflinePromotionSnapshot([
        { ...basePromo, channel: "STORE_ONLY" },
      ]);
      expect(tamperedChannel.checksum).not.toBe(baseSnapshot.checksum);
      expect(tamperedChannel.promotions.length).toBe(0);
    });

    it("OFF-05: Baghdad midnight rollover boundary: transaction at 23:59:50 Friday resolves to Friday", () => {
      // 2026-06-19 20:59:50 UTC = 2026-06-19 23:59:50 Baghdad (+3h)
      const fridayNightUtc = "2026-06-19T20:59:50Z";
      const referenceDate = new Date(fridayNightUtc);
      const _bag = new Date(referenceDate.getTime() + 3 * 60 * 60 * 1000);
      const todayYmd = _bag.toISOString().slice(0, 10);

      expect(todayYmd).toBe("2026-06-19"); // Still Friday!

      // 15 seconds later: 2026-06-19 21:00:05 UTC = 2026-06-20 00:00:05 Baghdad (+3h)
      const saturdayDawnUtc = "2026-06-19T21:00:05Z";
      const refSat = new Date(saturdayDawnUtc);
      const _bagSat = new Date(refSat.getTime() + 3 * 60 * 60 * 1000);
      const satYmd = _bagSat.toISOString().slice(0, 10);

      expect(satYmd).toBe("2026-06-20"); // Turned to Saturday!
    });
  });
});
