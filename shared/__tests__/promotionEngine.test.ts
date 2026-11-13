/**
 * shared/__tests__/promotionEngine.test.ts
 *
 * Exhaustive unit tests for the deterministic promotion engine core.
 * Tests financial conservation, decimal precision, fixed price ceiling,
 * proportional allocation, contract price protection, base unit protection,
 * and all 6 promotion types.
 */

import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { simulateBasketPreview } from "../../client/src/components/offers/offersTypes";
import {
  allocateByValue,
  applyBaseUnitGuard,
  applyFixedPriceCeiling,
  calculateLinePromotionSavings,
  evaluateCartPromotions,
  formatPromotionSummary,
  isPromotionApplicableToItem,
  protectContractPrice,
  resolvePriorityAndStacking,
  type EvaluationContext,
  type EvaluationItem,
  type PromotionRule,
} from "../promotionEngine";

const CONTEXT_POS: EvaluationContext = {
  channel: "POS",
  todayYmd: "2026-06-15", // Monday (getBaghdadDayOfWeek for 2026-06-15 is 1)
};

const CONTEXT_STORE: EvaluationContext = {
  channel: "STORE",
  todayYmd: "2026-06-15",
};

describe("shared/promotionEngine", () => {
  describe("allocateByValue (Proportional Value Allocation)", () => {
    it("allocates discount proportionally down to 0.01 fils across multiple lines", () => {
      const lines = [
        { lineKey: "line_1", lineGross: new Decimal(8000) },
        { lineKey: "line_2", lineGross: new Decimal(4000) },
      ];
      // Total gross = 12,000. Total savings = 2,000.
      // line_1 share = 2,000 * 8,000 / 12,000 = 1,333.333... -> 1,333.33
      // line_2 share = 2,000 * 4,000 / 12,000 = 666.666... -> 666.67
      const alloc = allocateByValue(lines, new Decimal(2000));

      expect(alloc.get("line_1")?.toString()).toBe("1333.33");
      expect(alloc.get("line_2")?.toString()).toBe("666.67");
      const sum = (alloc.get("line_1") ?? new Decimal(0)).plus(alloc.get("line_2") ?? new Decimal(0));
      expect(sum.toString()).toBe("2000");
    });

    it("supports flexible argument ordering: (savings, lines)", () => {
      const lines = [
        { lineKey: "a", lineGross: new Decimal(5000) },
        { lineKey: "b", lineGross: new Decimal(5000) },
      ];
      const alloc = allocateByValue(1000, lines);
      expect(alloc.get("a")?.toString()).toBe("500");
      expect(alloc.get("b")?.toString()).toBe("500");
    });

    it("routes remainder fils to the line with the largest gross value", () => {
      // 100 IQD discount across 3 lines of 1,000, 1,000, 1,000 IQD
      // Raw shares: 33.333... -> 33.33 each, sum = 99.99, remainder = 0.01
      // Line 1 is largest (or first max), so receives 33.34
      const lines = [
        { lineKey: "l1", lineGross: new Decimal(1000) },
        { lineKey: "l2", lineGross: new Decimal(1000) },
        { lineKey: "l3", lineGross: new Decimal(1000) },
      ];
      const alloc = allocateByValue(lines, 100);
      expect(alloc.get("l1")?.toString()).toBe("33.34");
      expect(alloc.get("l2")?.toString()).toBe("33.33");
      expect(alloc.get("l3")?.toString()).toBe("33.33");

      const total = Array.from(alloc.values()).reduce((acc, v) => acc.plus(v), new Decimal(0));
      expect(total.toString()).toBe("100");
    });

    it("caps allocation if total savings exceed total gross", () => {
      const lines = [
        { lineKey: "l1", lineGross: new Decimal(1000) },
        { lineKey: "l2", lineGross: new Decimal(500) },
      ];
      // Total gross = 1,500. Requested savings = 2,000. Capped at 1,500.
      const alloc = allocateByValue(lines, 2000);
      expect(alloc.get("l1")?.toString()).toBe("1000");
      expect(alloc.get("l2")?.toString()).toBe("500");
    });

    it("returns empty map on empty lines, zero savings, or non-positive total gross", () => {
      expect(allocateByValue([], 500).size).toBe(0);
      expect(allocateByValue([{ lineKey: "l1", lineGross: 0 }], 500).size).toBe(0);
      expect(allocateByValue([{ lineKey: "l1", lineGross: 1000 }], 0).size).toBe(0);
      expect(allocateByValue([{ lineKey: "l1", lineGross: 1000 }], -50).size).toBe(0);
    });

    it("allocates micro-savings without negative discounts under Hare-Niemeyer method", () => {
      // 10 lines of 100 IQD gross, total savings = 0.05 IQD.
      // Under Hare-Niemeyer, floor share is 0.00, remainder 0.05 (5 cents) is given to top 5 lines.
      // Every line has 0 <= discount <= lineGross and sum === 0.05. Price never inflates!
      const lines = Array.from({ length: 10 }, (_, i) => ({
        lineKey: `line_${i}`,
        lineGross: new Decimal(100),
      }));
      const alloc = allocateByValue(lines, "0.05");

      let sum = new Decimal(0);
      let negativeCount = 0;
      const entries = Array.from(alloc.entries());
      for (let i = 0; i < entries.length; i++) {
        const val = entries[i][1];
        if (val.lt(0)) negativeCount++;
        sum = sum.plus(val);
      }

      expect(negativeCount).toBe(0);
      expect(sum.toString()).toBe("0.05");
      expect(alloc.get("line_0")?.toString()).toBe("0.01");
      expect(alloc.get("line_4")?.toString()).toBe("0.01");
      expect(alloc.get("line_5")?.toString()).toBe("0");
      expect(alloc.get("line_9")?.toString()).toBe("0");
    });
  });

  describe("applyFixedPriceCeiling (Iron Ceiling Invariant)", () => {
    it("returns discount = 0 and preserves original price when original price <= fixed price", () => {
      const res1 = applyFixedPriceCeiling(3500, 4000);
      expect(res1.discountPerUnit.toString()).toBe("0");
      expect(res1.effectiveUnitPrice.toString()).toBe("3500");

      const res2 = applyFixedPriceCeiling(4000, 4000);
      expect(res2.discountPerUnit.toString()).toBe("0");
      expect(res2.effectiveUnitPrice.toString()).toBe("4000");

      const res3 = applyFixedPriceCeiling(1, 10000);
      expect(res3.discountPerUnit.toString()).toBe("0");
      expect(res3.effectiveUnitPrice.toString()).toBe("1");
    });

    it("discounts item down to fixed price when original price > fixed price", () => {
      const res = applyFixedPriceCeiling(6000, 4000);
      expect(res.discountPerUnit.toString()).toBe("2000");
      expect(res.effectiveUnitPrice.toString()).toBe("4000");
    });
  });

  describe("applyBaseUnitGuard & protectContractPrice", () => {
    it("blocks discount on derived unit when applyToBaseUnitOnly = true", () => {
      const pieceItem = { isBaseUnit: true, productUnitId: 101 };
      const cartonItem = { isBaseUnit: false, productUnitId: 102 };
      const rule = { applyToBaseUnitOnly: true };

      expect(applyBaseUnitGuard(pieceItem, rule)).toBe(true);
      expect(applyBaseUnitGuard(cartonItem, rule)).toBe(false);
    });

    it("permits derived units when applyToBaseUnitOnly = false", () => {
      const cartonItem = { isBaseUnit: false, productUnitId: 102 };
      const rule = { applyToBaseUnitOnly: false };

      expect(applyBaseUnitGuard(cartonItem, rule)).toBe(true);
    });

    it("matches specific targetUnitIds regardless of applyToBaseUnitOnly flag", () => {
      const cartonItem = { isBaseUnit: false, productUnitId: 102 };
      const rule = { applyToBaseUnitOnly: true, targetUnitIds: new Set([102]) };

      expect(applyBaseUnitGuard(cartonItem, rule)).toBe(true);
    });

    it("protectContractPrice returns true only when hasContractPrice = true", () => {
      expect(protectContractPrice({ hasContractPrice: true })).toBe(true);
      expect(protectContractPrice({ hasContractPrice: false })).toBe(false);
      expect(protectContractPrice({})).toBe(false);
    });
  });

  describe("evaluateCartPromotions (All 6 Promotion Types & Business Invariants)", () => {
    it("F07: PERCENT promo applies correctly and calculates effective unit price", () => {
      const items: EvaluationItem[] = [
        {
          lineKey: "line_1",
          productId: 1,
          variantId: 1,
          isBaseUnit: true,
          unitPrice: 500,
          quantity: 20, // gross = 10,000
        },
      ];
      const rule: PromotionRule = {
        id: 701,
        name: "20% Off",
        type: "PERCENT",
        channel: "ALL",
        discountPercent: 20,
        targetProductIds: new Set([1]),
      };

      const res = evaluateCartPromotions(items, [rule], CONTEXT_POS);
      const alloc = res.lineAllocations.get("line_1");

      expect(alloc).toBeDefined();
      expect(alloc?.discountAmount.toString()).toBe("2000");
      expect(alloc?.effectiveUnitPrice.toString()).toBe("400");
      expect(res.totalCartDiscount.toString()).toBe("2000");
      expect(res.appliedPromotionIds.has(701)).toBe(true);
    });

    it("F07: AMOUNT promo multiplies discount by line quantity", () => {
      const items: EvaluationItem[] = [
        {
          lineKey: "line_1",
          productId: 2,
          variantId: 2,
          isBaseUnit: true,
          unitPrice: 5000,
          quantity: 3, // gross = 15,000
        },
      ];
      const rule: PromotionRule = {
        id: 702,
        name: "1,500 IQD per unit",
        type: "AMOUNT",
        channel: "ALL",
        discountAmount: 1500,
        targetProductIds: new Set([2]),
      };

      const res = evaluateCartPromotions(items, [rule], CONTEXT_POS);
      const alloc = res.lineAllocations.get("line_1");

      expect(alloc).toBeDefined();
      expect(alloc?.discountAmount.toString()).toBe("4500");
      expect(alloc?.effectiveUnitPrice.toString()).toBe("3500");
      expect(res.totalCartDiscount.toString()).toBe("4500");
    });

    it("F08: FIXED_PRICE enforces ceiling: cheap items receive 0 discount, expensive items discounted", () => {
      const items: EvaluationItem[] = [
        {
          lineKey: "line_cheap",
          productId: 10,
          variantId: 10,
          isBaseUnit: true,
          unitPrice: 2500,
          quantity: 1,
        },
        {
          lineKey: "line_exact",
          productId: 11,
          variantId: 11,
          isBaseUnit: true,
          unitPrice: 4000,
          quantity: 1,
        },
        {
          lineKey: "line_exp",
          productId: 12,
          variantId: 12,
          isBaseUnit: true,
          unitPrice: 6500,
          quantity: 2, // gross = 13,000, expected discount = (6500 - 4000) * 2 = 5,000
        },
      ];
      const rule: PromotionRule = {
        id: 703,
        name: "Fixed 4,000 IQD",
        type: "FIXED_PRICE",
        channel: "ALL",
        fixedPrice: 4000,
        targetProductIds: new Set([10, 11, 12]),
      };

      const res = evaluateCartPromotions(items, [rule], CONTEXT_POS);
      expect(res.lineAllocations.has("line_cheap")).toBe(false);
      expect(res.lineAllocations.has("line_exact")).toBe(false);

      const expAlloc = res.lineAllocations.get("line_exp");
      expect(expAlloc).toBeDefined();
      expect(expAlloc?.discountAmount.toString()).toBe("5000");
      expect(expAlloc?.effectiveUnitPrice.toString()).toBe("4000");
      expect(res.totalCartDiscount.toString()).toBe("5000");
    });

    it("F09: BUNDLE_PRICE ALL_REQUIRED distributes savings proportionally by gross value", () => {
      const items: EvaluationItem[] = [
        {
          lineKey: "line_a",
          productId: 201,
          variantId: 201,
          isBaseUnit: true,
          unitPrice: 8000,
          quantity: 1,
        },
        {
          lineKey: "line_b",
          productId: 202,
          variantId: 202,
          isBaseUnit: true,
          unitPrice: 4000,
          quantity: 1,
        },
      ];
      // Total original = 12,000. Bundle price = 10,000. Savings = 2,000.
      // Line a: 1,333.33 discount. Effective = 6,666.67.
      // Line b: 666.67 discount. Effective = 3,333.33.
      const rule: PromotionRule = {
        id: 704,
        name: "Stationery Combo",
        type: "BUNDLE_PRICE",
        channel: "ALL",
        bundlePrice: 10000,
        bundleMode: "ALL_REQUIRED",
        targetProductIds: new Set([201, 202]),
      };

      const res = evaluateCartPromotions(items, [rule], CONTEXT_POS);
      expect(res.totalCartDiscount.toString()).toBe("2000");

      const allocA = res.lineAllocations.get("line_a");
      const allocB = res.lineAllocations.get("line_b");
      expect(allocA?.discountAmount.toString()).toBe("1333.33");
      expect(allocB?.discountAmount.toString()).toBe("666.67");
      expect(allocA?.effectiveUnitPrice.toString()).toBe("6666.67");
      expect(allocB?.effectiveUnitPrice.toString()).toBe("3333.33");
    });

    it("F09: BUNDLE_PRICE PICK_ANY_N qualifies on total quantity", () => {
      const items: EvaluationItem[] = [
        {
          lineKey: "line_1",
          productId: 301,
          variantId: 301,
          isBaseUnit: true,
          unitPrice: 5000,
          quantity: 3, // gross = 15,000
        },
      ];
      // Bundle of any 3 items for 12,000 IQD. Savings = 3,000.
      const rule: PromotionRule = {
        id: 705,
        name: "Pick Any 3 for 12k",
        type: "BUNDLE_PRICE",
        channel: "ALL",
        bundlePrice: 12000,
        bundleMode: "PICK_ANY_N",
        bundleQuantity: 3,
        targetProductIds: new Set([301]),
      };

      const res = evaluateCartPromotions(items, [rule], CONTEXT_POS);
      const alloc = res.lineAllocations.get("line_1");
      expect(alloc?.discountAmount.toString()).toBe("3000");
      expect(alloc?.effectiveUnitPrice.toString()).toBe("4000");
      expect(res.totalCartDiscount.toString()).toBe("3000");
    });

    it("F09: BOGO Buy 2 Get 1 Free discounts cheapest items and allocates proportionally", () => {
      const items: EvaluationItem[] = [
        {
          lineKey: "line_expensive",
          productId: 401,
          variantId: 401,
          isBaseUnit: true,
          unitPrice: 6000,
          quantity: 1,
        },
        {
          lineKey: "line_mid",
          productId: 402,
          variantId: 402,
          isBaseUnit: true,
          unitPrice: 4000,
          quantity: 1,
        },
        {
          lineKey: "line_cheap",
          productId: 403,
          variantId: 403,
          isBaseUnit: true,
          unitPrice: 2000,
          quantity: 1,
        },
      ];
      // Total 3 units: Buy 2 Get 1 Free -> 1 free item.
      // Cheapest item is 2,000 IQD. Total BOGO savings = 2,000 IQD.
      // Total gross = 6,000 + 4,000 + 2,000 = 12,000 IQD.
      // Allocated: expensive (6k/12k * 2k) = 1,000. mid (4k/12k * 2k) = 666.67. cheap (2k/12k * 2k) = 333.33.
      const rule: PromotionRule = {
        id: 706,
        name: "Buy 2 Get 1 Free",
        type: "BOGO",
        channel: "ALL",
        bogoBuyQuantity: 2,
        bogoGetQuantity: 1,
        bogoGetDiscountPercent: 100,
        targetProductIds: new Set([401, 402, 403]),
      };

      const res = evaluateCartPromotions(items, [rule], CONTEXT_POS);
      expect(res.totalCartDiscount.toString()).toBe("2000");
      expect(res.lineAllocations.get("line_expensive")?.discountAmount.toString()).toBe("1000");
      expect(res.lineAllocations.get("line_mid")?.discountAmount.toString()).toBe("666.67");
      expect(res.lineAllocations.get("line_cheap")?.discountAmount.toString()).toBe("333.33");
    });

    it("F10: TIERED_QTY PER_ITEM triggers matched tier threshold", () => {
      const items: EvaluationItem[] = [
        {
          lineKey: "line_1",
          productId: 501,
          variantId: 501,
          isBaseUnit: true,
          unitPrice: 6000,
          quantity: 120, // 120 reams
        },
      ];
      const rule: PromotionRule = {
        id: 707,
        name: "Volume Ream Paper",
        type: "TIERED_QTY",
        channel: "ALL",
        tieredMode: "PER_ITEM",
        targetProductIds: new Set([501]),
        tiers: [
          { minQuantity: 10, tierType: "FIXED_PRICE", fixedPrice: 5500 },
          { minQuantity: 50, tierType: "FIXED_PRICE", fixedPrice: 5200 },
          { minQuantity: 100, tierType: "FIXED_PRICE", fixedPrice: 5000 },
        ],
      };

      const res = evaluateCartPromotions(items, [rule], CONTEXT_POS);
      const alloc = res.lineAllocations.get("line_1");
      // 120 units at fixed price 5,000 (regular 6,000 -> 1,000 discount per unit * 120 = 120,000)
      expect(alloc?.discountAmount.toString()).toBe("120000");
      expect(alloc?.effectiveUnitPrice.toString()).toBe("5000");
      expect(res.totalCartDiscount.toString()).toBe("120000");
    });

    it("F10: Deterministic Priority: higher priority strictly wins over lower priority", () => {
      const items: EvaluationItem[] = [
        {
          lineKey: "line_1",
          productId: 601,
          variantId: 601,
          isBaseUnit: true,
          unitPrice: 10000,
          quantity: 1,
        },
      ];
      const promoLow: PromotionRule = {
        id: 1001,
        name: "Low Priority 30%",
        type: "PERCENT",
        channel: "ALL",
        priority: 10,
        discountPercent: 30, // 3,000 savings
        targetProductIds: new Set([601]),
      };
      const promoHigh: PromotionRule = {
        id: 1002,
        name: "High Priority 10%",
        type: "PERCENT",
        channel: "ALL",
        priority: 20,
        discountPercent: 10, // 1,000 savings
        targetProductIds: new Set([601]),
      };

      // Even though promoLow offers 3,000 vs 1,000, promoHigh (priority 20) wins!
      const res = evaluateCartPromotions(items, [promoLow, promoHigh], CONTEXT_POS);
      const alloc = res.lineAllocations.get("line_1");
      expect(alloc?.promotionId).toBe(1002);
      expect(alloc?.discountAmount.toString()).toBe("1000");
    });

    it("F10: Equal priority tie-breaker prefers lower ID deterministically", () => {
      const items: EvaluationItem[] = [
        {
          lineKey: "line_1",
          productId: 601,
          variantId: 601,
          isBaseUnit: true,
          unitPrice: 10000,
          quantity: 1,
        },
      ];
      const promo2002: PromotionRule = {
        id: 2002,
        name: "Promo 2002",
        type: "PERCENT",
        channel: "ALL",
        priority: 10,
        discountPercent: 20,
        targetProductIds: new Set([601]),
      };
      const promo2001: PromotionRule = {
        id: 2001,
        name: "Promo 2001",
        type: "PERCENT",
        channel: "ALL",
        priority: 10,
        discountPercent: 20,
        targetProductIds: new Set([601]),
      };

      const res = evaluateCartPromotions(items, [promo2002, promo2001], CONTEXT_POS);
      expect(res.lineAllocations.get("line_1")?.promotionId).toBe(2001);
    });

    it("F10: Contract price protection completely isolates line item", () => {
      const items: EvaluationItem[] = [
        {
          lineKey: "line_contract",
          productId: 701,
          variantId: 701,
          isBaseUnit: true,
          unitPrice: 2800,
          quantity: 1,
          hasContractPrice: true,
        },
        {
          lineKey: "line_retail",
          productId: 702,
          variantId: 702,
          isBaseUnit: true,
          unitPrice: 500,
          quantity: 2, // 1,000 gross
          hasContractPrice: false,
        },
      ];
      const promo: PromotionRule = {
        id: 708,
        name: "Storewide 20%",
        type: "PERCENT",
        channel: "ALL",
        discountPercent: 20,
      };

      const res = evaluateCartPromotions(items, [promo], CONTEXT_POS);
      expect(res.lineAllocations.has("line_contract")).toBe(false);

      const alloc = res.lineAllocations.get("line_retail");
      expect(alloc).toBeDefined();
      expect(alloc?.discountAmount.toString()).toBe("200");
      expect(res.totalCartDiscount.toString()).toBe("200");
    });

    it("Channel separation: POS_ONLY promo does not apply in STORE context", () => {
      const items: EvaluationItem[] = [
        {
          lineKey: "line_1",
          productId: 801,
          variantId: 801,
          isBaseUnit: true,
          unitPrice: 1000,
          quantity: 1,
        },
      ];
      const promo: PromotionRule = {
        id: 801,
        name: "POS Exclusive",
        type: "PERCENT",
        channel: "POS_ONLY",
        discountPercent: 50,
      };

      const resStore = evaluateCartPromotions(items, [promo], CONTEXT_STORE);
      expect(resStore.totalCartDiscount.toString()).toBe("0");

      const resPos = evaluateCartPromotions(items, [promo], CONTEXT_POS);
      expect(resPos.totalCartDiscount.toString()).toBe("500");
    });

    it("Day of week scheduling: active only on configured activeDays", () => {
      const items: EvaluationItem[] = [
        {
          lineKey: "line_1",
          productId: 901,
          variantId: 901,
          isBaseUnit: true,
          unitPrice: 2000,
          quantity: 1,
        },
      ];
      // Monday = day 1. Friday = day 5.
      const fridayFlashPromo: PromotionRule = {
        id: 901,
        name: "Friday Only",
        type: "PERCENT",
        channel: "ALL",
        discountPercent: 25,
        activeDays: [5], // Friday only
      };

      // In CONTEXT_POS today is 2026-06-15 (Monday) -> should NOT apply
      const resMon = evaluateCartPromotions(items, [fridayFlashPromo], CONTEXT_POS);
      expect(resMon.totalCartDiscount.toString()).toBe("0");

      // On 2026-06-19 (Friday) -> should apply
      const resFri = evaluateCartPromotions(items, [fridayFlashPromo], { channel: "POS", todayYmd: "2026-06-19" });
      expect(resFri.totalCartDiscount.toString()).toBe("500");
    });

    it("Digital cards in mixed carts receive 0 promotional discount", () => {
      const items: EvaluationItem[] = [
        {
          lineKey: "line_card",
          productId: 999,
          variantId: 999,
          isBaseUnit: true,
          unitPrice: 10000,
          quantity: 1,
          isDigitalCard: true,
        },
        {
          lineKey: "line_book",
          productId: 100,
          variantId: 100,
          isBaseUnit: true,
          unitPrice: 5000,
          quantity: 1,
          isDigitalCard: false,
        },
      ];
      const promo: PromotionRule = {
        id: 902,
        name: "Storewide 20%",
        type: "PERCENT",
        channel: "ALL",
        discountPercent: 20,
      };

      const res = evaluateCartPromotions(items, [promo], CONTEXT_POS);
      expect(res.lineAllocations.has("line_card")).toBe(false);
      expect(res.lineAllocations.get("line_book")?.discountAmount.toString()).toBe("1000");
      expect(res.totalCartDiscount.toString()).toBe("1000");
    });
  });

  describe("resolvePriorityAndStacking", () => {
    it("exports resolvePriorityAndStacking and sorts rules deterministically by priority DESC, savings DESC, id ASC", () => {
      const cart: EvaluationItem[] = [
        {
          lineKey: "item_1",
          productId: 501,
          variantId: 501,
          isBaseUnit: true,
          unitPrice: new Decimal("10000"),
          quantity: new Decimal(1),
        },
      ];

      const ruleA: PromotionRule = {
        id: 10,
        name: "Promo Low ID Small Savings",
        type: "PERCENT",
        channel: "ALL",
        priority: 10,
        discountPercent: new Decimal(10), // 1,000 IQD savings
        targetProductIds: new Set([501]),
      };

      const ruleB: PromotionRule = {
        id: 99,
        name: "Promo High ID Big Savings",
        type: "PERCENT",
        channel: "ALL",
        priority: 10,
        discountPercent: new Decimal(50), // 5,000 IQD savings
        targetProductIds: new Set([501]),
      };

      const ruleC: PromotionRule = {
        id: 5,
        name: "Promo High Priority",
        type: "PERCENT",
        channel: "ALL",
        priority: 20,
        discountPercent: new Decimal(5), // 500 IQD savings
        targetProductIds: new Set([501]),
      };

      const sorted = resolvePriorityAndStacking([ruleA, ruleB, ruleC], cart);
      // Priority 20 first (ruleC), then Priority 10 with 5,000 savings (ruleB), then Priority 10 with 1,000 savings (ruleA)
      expect(sorted[0].id).toBe(5);
      expect(sorted[1].id).toBe(99);
      expect(sorted[2].id).toBe(10);
    });

    it("resolves equal priority tie-breaking by savings DESC before id ASC in evaluateCartPromotions", () => {
      const cart: EvaluationItem[] = [
        {
          lineKey: "item_1",
          productId: 501,
          variantId: 501,
          isBaseUnit: true,
          unitPrice: new Decimal("10000"),
          quantity: new Decimal(1),
        },
      ];

      const promoSmallSavingsLowId: PromotionRule = {
        id: 10,
        name: "Promo Low ID Small Savings",
        type: "PERCENT",
        channel: "ALL",
        priority: 10,
        discountPercent: new Decimal(10), // 1,000 IQD savings
        targetProductIds: new Set([501]),
      };

      const promoBigSavingsHighId: PromotionRule = {
        id: 99,
        name: "Promo High ID Big Savings",
        type: "PERCENT",
        channel: "ALL",
        priority: 10,
        discountPercent: new Decimal(50), // 5,000 IQD savings
        targetProductIds: new Set([501]),
      };

      const out = evaluateCartPromotions(cart, [promoSmallSavingsLowId, promoBigSavingsHighId], CONTEXT_POS);
      const applied = Array.from(out.appliedPromotionIds);
      expect(applied).toEqual([99]);
      expect(out.totalCartDiscount.toString()).toBe("5000");
    });

    it("caps PICK_ANY_N bundle savings to complete bundle sets and leaves excess units unbundled", () => {
      const rule: PromotionRule = {
        id: 810,
        name: "3 Notebooks for 8,000 IQD",
        type: "BUNDLE_PRICE",
        bundleMode: "PICK_ANY_N",
        bundleQuantity: 3,
        bundlePrice: 8000,
        channel: "ALL",
        scope: "PRODUCTS",
        targetProductIds: new Set([301]),
      };

      // 4 units @ 3,500 = 14,000 IQD -> 1 bundle (3 units = 10,500 -> 8,000 => 2,500 savings) + 1 unbundled @ 3,500 => net 11,500
      const cart4: EvaluationItem[] = [
        {
          lineKey: "nb_4",
          productId: 301,
          variantId: 301,
          isBaseUnit: true,
          unitPrice: 3500,
          quantity: 4,
        },
      ];
      const out4 = evaluateCartPromotions(cart4, [rule], CONTEXT_POS);
      expect(out4.totalCartDiscount.toFixed(2)).toBe("2500.00");

      // 7 units @ 3,500 = 24,500 IQD -> 2 bundles (6 units = 21,000 -> 16,000 => 5,000 savings) + 1 unbundled @ 3,500 => net 19,500
      const cart7: EvaluationItem[] = [{ ...cart4[0], lineKey: "nb_7", quantity: 7 }];
      const out7 = evaluateCartPromotions(cart7, [rule], CONTEXT_POS);
      expect(out7.totalCartDiscount.toFixed(2)).toBe("5000.00");
    });

    it("supports multiple ALL_REQUIRED bundle sets when customer buys 2+ of every required target", () => {
      const rule: PromotionRule = {
        id: 811,
        name: "Pen + Notebook Bundle for 4,000",
        type: "BUNDLE_PRICE",
        bundleMode: "ALL_REQUIRED",
        bundlePrice: 4000,
        channel: "ALL",
        scope: "PRODUCTS",
        targetProductIds: new Set([201, 202]),
      };

      // 2 sets: (3000 + 2000) * 2 = 10,000 -> 8,000 => 2,000 savings
      const cart2Sets: EvaluationItem[] = [
        { lineKey: "a", productId: 201, variantId: 201, isBaseUnit: true, unitPrice: 3000, quantity: 2 },
        { lineKey: "b", productId: 202, variantId: 202, isBaseUnit: true, unitPrice: 2000, quantity: 2 },
      ];
      const out2 = evaluateCartPromotions(cart2Sets, [rule], CONTEXT_POS);
      expect(out2.totalCartDiscount.toFixed(2)).toBe("2000.00");
      expect(out2.lineAllocations.get("a")?.discountAmount.toFixed(2)).toBe("1200.00");
      expect(out2.lineAllocations.get("b")?.discountAmount.toFixed(2)).toBe("800.00");

      // Asymmetric: 2 of A + 1 of B -> only 1 complete bundle => 1,000 savings
      const cartAsym: EvaluationItem[] = [
        { lineKey: "a", productId: 201, variantId: 201, isBaseUnit: true, unitPrice: 3000, quantity: 2 },
        { lineKey: "b", productId: 202, variantId: 202, isBaseUnit: true, unitPrice: 2000, quantity: 1 },
      ];
      const outAsym = evaluateCartPromotions(cartAsym, [rule], CONTEXT_POS);
      expect(outAsym.totalCartDiscount.toFixed(2)).toBe("1000.00");
    });

    it("excludes pre-packaged bundles (isBundle=true) from ALL scope offers and rejects empty PRODUCTS/CATEGORIES scopes", () => {
      const storeWideRule: PromotionRule = {
        id: 812,
        name: "Storewide 10% Off",
        type: "PERCENT",
        scope: "ALL",
        channel: "ALL",
        discountPercent: 10,
      };
      const emptyProductsRule: PromotionRule = {
        id: 813,
        name: "Misconfigured Empty Products Rule",
        type: "PERCENT",
        scope: "PRODUCTS",
        channel: "ALL",
        discountPercent: 50,
        targetProductIds: new Set(),
      };

      const items: EvaluationItem[] = [
        { lineKey: "regular", productId: 1, variantId: 1, isBaseUnit: true, unitPrice: 5000, quantity: 1, isBundle: false },
        { lineKey: "prebundle", productId: 2, variantId: 2, isBaseUnit: true, unitPrice: 12000, quantity: 1, isBundle: true },
      ];

      const out = evaluateCartPromotions(items, [storeWideRule, emptyProductsRule], CONTEXT_POS);
      expect(out.lineAllocations.get("regular")?.discountAmount.toFixed(2)).toBe("500.00");
      expect(out.lineAllocations.has("prebundle")).toBe(false);
      expect(out.appliedPromotionIds.has(813)).toBe(false);
    });

    it("tie-breaks BOGO / BUNDLE_PRICE against PERCENT at equal priority using true cart savings", () => {
      const items: EvaluationItem[] = [
        { lineKey: "item_1", productId: 901, variantId: 901, isBaseUnit: true, unitPrice: 4000, quantity: 3 },
      ];
      const pctLowId: PromotionRule = {
        id: 1,
        name: "10% Off",
        type: "PERCENT",
        channel: "ALL",
        priority: 5,
        discountPercent: 10, // 1,200 savings
        targetProductIds: new Set([901]),
      };
      const bogoHighId: PromotionRule = {
        id: 50,
        name: "Buy 2 Get 1 Free",
        type: "BOGO",
        channel: "ALL",
        priority: 5,
        bogoBuyQuantity: 2,
        bogoGetQuantity: 1,
        bogoGetDiscountPercent: 100, // 4,000 savings
        targetProductIds: new Set([901]),
      };

      const out = evaluateCartPromotions(items, [pctLowId, bogoHighId], CONTEXT_POS);
      expect(Array.from(out.appliedPromotionIds)).toEqual([50]);
      expect(out.totalCartDiscount.toFixed(2)).toBe("4000.00");
    });

    it("formats human-readable Arabic summaries for all 6 promotion types with Latin numerals", () => {
      expect(formatPromotionSummary({ type: "PERCENT", discountPercent: "15.00" })).toBe("15٪");
      expect(formatPromotionSummary({ type: "PERCENT", discountPercent: "20", maxDiscountAmount: "5000" })).toBe("20٪ (سقف 5,000 د.ع)");
      expect(formatPromotionSummary({ type: "AMOUNT", discountAmount: "1500" })).toBe("1,500 د.ع / وحدة");
      expect(formatPromotionSummary({ type: "FIXED_PRICE", fixedPrice: "2500" })).toBe("سعر موحد 2,500 د.ع");
      expect(formatPromotionSummary({ type: "BUNDLE_PRICE", bundleMode: "PICK_ANY_N", bundleQuantity: 3, bundlePrice: "8000" })).toBe("أي 3 قطع بـ 8,000 د.ع");
      expect(formatPromotionSummary({ type: "BOGO", bogoBuyQuantity: 2, bogoGetQuantity: 1, bogoGetDiscountPercent: "100" })).toBe("اشتر 2 واحصل على 1 مجاناً");
      expect(formatPromotionSummary({ type: "TIERED_QTY", tiers: [{ minQuantity: 5 }, { minQuantity: 3 }] })).toBe("شرائح كميات (2 شرائح — من 3+)");
    });

    it("supports mixed product-grain (base unit) + explicit packaging-unit-grain targets in a single offer", () => {
      const rule: PromotionRule = {
        id: 820,
        name: "Mixed Product + Carton Offer",
        type: "PERCENT",
        scope: "PRODUCTS",
        channel: "ALL",
        applyToBaseUnitOnly: true,
        discountPercent: 20,
        targetProductIds: new Set([10]), // Product 10 base unit
        targetUnitIds: new Set([55]), // Product 20 carton unit
      };

      const items: EvaluationItem[] = [
        { lineKey: "p10_piece", productId: 10, variantId: 10, productUnitId: 11, isBaseUnit: true, unitPrice: 1000, quantity: 2 },
        { lineKey: "p10_carton", productId: 10, variantId: 10, productUnitId: 12, isBaseUnit: false, unitPrice: 10000, quantity: 1 },
        { lineKey: "p20_piece", productId: 20, variantId: 20, productUnitId: 54, isBaseUnit: true, unitPrice: 2000, quantity: 1 },
        { lineKey: "p20_carton", productId: 20, variantId: 20, productUnitId: 55, isBaseUnit: false, unitPrice: 20000, quantity: 1 },
      ];

      const out = evaluateCartPromotions(items, [rule], CONTEXT_POS);
      expect(out.lineAllocations.get("p10_piece")?.discountAmount.toFixed(2)).toBe("400.00");
      expect(out.lineAllocations.has("p10_carton")).toBe(false);
      expect(out.lineAllocations.has("p20_piece")).toBe(false);
      expect(out.lineAllocations.get("p20_carton")?.discountAmount.toFixed(2)).toBe("4000.00");
    });

    it("enforces per-set ceiling on BUNDLE_PRICE so cheap items never surcharge or erode a qualifying set's discount", () => {
      const pick3For9k: PromotionRule = {
        id: 821,
        name: "Any 3 for 9,000 IQD",
        type: "BUNDLE_PRICE",
        bundleMode: "PICK_ANY_N",
        bundleQuantity: 3,
        bundlePrice: 9000,
        scope: "PRODUCTS",
        channel: "ALL",
        targetProductIds: new Set([1, 2]),
      };

      // Set 1: 3 @ 5,000 = 15,000 -> 9,000 (6,000 savings). Set 2: 3 @ 2,500 = 7,500 <= 9,000 (0 savings, NO +1,500 surcharge!)
      const items: EvaluationItem[] = [
        { lineKey: "cheap", productId: 1, variantId: 1, isBaseUnit: true, unitPrice: 2500, quantity: 3 },
        { lineKey: "regular", productId: 2, variantId: 2, isBaseUnit: true, unitPrice: 5000, quantity: 3 },
      ];
      const out = evaluateCartPromotions(items, [pick3For9k], CONTEXT_POS);
      expect(out.totalCartDiscount.toFixed(2)).toBe("6000.00");
      expect(out.lineAllocations.has("cheap")).toBe(false);
      expect(out.lineAllocations.get("regular")?.discountAmount.toFixed(2)).toBe("6000.00");

      // Adding a 4th cheap item (2,000) to [4,000 x 3] must NOT reduce the 3,000 savings on [4,000 x 3]
      const items4: EvaluationItem[] = [
        { lineKey: "extra_cheap", productId: 1, variantId: 1, isBaseUnit: true, unitPrice: 2000, quantity: 1 },
        { lineKey: "three_4k", productId: 2, variantId: 2, isBaseUnit: true, unitPrice: 4000, quantity: 3 },
      ];
      const out4 = evaluateCartPromotions(items4, [pick3For9k], CONTEXT_POS);
      expect(out4.totalCartDiscount.toFixed(2)).toBe("3000.00");
      expect(out4.lineAllocations.has("extra_cheap")).toBe(false);
    });

    it("rejects customerTier-restricted and branch-restricted offers when context lacks matching tier or branch", () => {
      const items: EvaluationItem[] = [
        { lineKey: "l1", productId: 1, variantId: 1, isBaseUnit: true, unitPrice: 10000, quantity: 1 },
      ];
      const wholesaleRule: PromotionRule = {
        id: 822,
        name: "Wholesale Only",
        type: "PERCENT",
        channel: "ALL",
        customerTier: "WHOLESALE",
        discountPercent: 25,
      };
      const branch2Rule: PromotionRule = {
        id: 823,
        name: "Branch 2 Only",
        type: "PERCENT",
        channel: "ALL",
        branchId: 2,
        discountPercent: 25,
      };

      // Null/omitted tier & branch must NOT match restricted rules
      const anonOut = evaluateCartPromotions(items, [wholesaleRule, branch2Rule], {
        channel: "POS",
        todayYmd: "2026-06-15",
        branchId: null,
        customerTier: null,
      });
      expect(anonOut.totalCartDiscount.toFixed(2)).toBe("0.00");

      // Matching tier & branch applies
      const matchOut = evaluateCartPromotions(items, [wholesaleRule], {
        channel: "POS",
        todayYmd: "2026-06-15",
        customerTier: "WHOLESALE",
      });
      expect(matchOut.totalCartDiscount.toFixed(2)).toBe("2500.00");
    });

    it("computes true effectiveUnitPrice when FIXED_PRICE is capped by maxDiscountAmount", () => {
      const items: EvaluationItem[] = [
        { lineKey: "l1", productId: 1, variantId: 1, isBaseUnit: true, unitPrice: 6000, quantity: 2 },
      ];
      const cappedFixed: PromotionRule = {
        id: 824,
        name: "Fixed 4000 capped at 2000 total discount",
        type: "FIXED_PRICE",
        channel: "ALL",
        fixedPrice: 4000,
        maxDiscountAmount: 2000,
        targetProductIds: new Set([1]),
      };
      const out = evaluateCartPromotions(items, [cappedFixed], CONTEXT_POS);
      expect(out.lineAllocations.get("l1")?.discountAmount.toFixed(2)).toBe("2000.00");
      expect(out.lineAllocations.get("l1")?.effectiveUnitPrice.toFixed(2)).toBe("5000.00");
    });

    it("simulateBasketPreview delegates to evaluateCartPromotions across TIERED_QTY, BUNDLE_PRICE, and BOGO", () => {
      const tieredOut = simulateBasketPreview(
        [
          { productId: 1, variantId: 1, unitPrice: "1000", quantity: 2 },
          { productId: 2, variantId: 2, unitPrice: "2000", quantity: 1 },
        ],
        {
          type: "TIERED_QTY",
          tieredMode: "POOL_ACROSS_TARGETS",
          tiers: [{ minQuantity: "3", tierType: "PERCENT", discountPercent: "20" }],
        },
      );
      expect(tieredOut.grossTotal.toFixed(2)).toBe("4000.00");
      expect(tieredOut.discount.toFixed(2)).toBe("800.00");
      expect(tieredOut.netTotal.toFixed(2)).toBe("3200.00");

      const pickAnyOut = simulateBasketPreview(
        [{ productId: 1, variantId: 1, unitPrice: "1500", quantity: 3 }],
        {
          type: "BUNDLE_PRICE",
          bundleMode: "PICK_ANY_N",
          bundleQuantity: 3,
          bundlePrice: new Decimal("3500"),
          targetProductIds: [1],
        },
      );
      expect(pickAnyOut.discount.toFixed(2)).toBe("1000.00");
      expect(pickAnyOut.netTotal.toFixed(2)).toBe("3500.00");

      const bogoOut = simulateBasketPreview(
        [
          { productId: 1, variantId: 1, unitPrice: "1000", quantity: 1 },
          { productId: 2, variantId: 2, unitPrice: "3000", quantity: 2 },
        ],
        {
          type: "BOGO",
          bogoBuyQuantity: 2,
          bogoGetQuantity: 1,
          bogoGetDiscountPercent: new Decimal("100"),
        },
      );
      expect(bogoOut.discount.toFixed(2)).toBe("1000.00");
      expect(bogoOut.netTotal.toFixed(2)).toBe("6000.00");
    });

    it("evaluates FREE_SHIPPING standalone, respects minOrderSpend, and stacks with merchandise rules", () => {
      const items: EvaluationItem[] = [
        { lineKey: "l1", productId: 501, variantId: 501, isBaseUnit: true, unitPrice: 10000, quantity: 3 },
      ];
      const freeShipRule: PromotionRule = {
        id: 901,
        name: "توصيل مجاني للطلبات فوق 25 ألف",
        type: "FREE_SHIPPING",
        channel: "ALL",
        minOrderSpend: 25000,
        priority: 10,
      };
      const bundleRule: PromotionRule = {
        id: 902,
        name: "بكج 3 قطع بـ 24,000",
        type: "BUNDLE_PRICE",
        bundleMode: "PICK_ANY_N",
        bundleQuantity: 3,
        bundlePrice: 24000,
        channel: "ALL",
        targetProductIds: new Set([501]),
        priority: 20,
      };

      // Qualifies for BOTH bundle discount (6,000 IQD) AND free shipping simultaneously
      const stacked = evaluateCartPromotions(items, [freeShipRule, bundleRule], CONTEXT_POS);
      expect(stacked.totalCartDiscount.toFixed(2)).toBe("6000.00");
      expect(stacked.freeShippingPromotion).toEqual({
        promotionId: 901,
        promotionName: "توصيل مجاني للطلبات فوق 25 ألف",
      });

      // Below minOrderSpend (gross = 20,000 < 25,000) -> does NOT trigger free shipping
      const smallCart: EvaluationItem[] = [
        { lineKey: "l1", productId: 501, variantId: 501, isBaseUnit: true, unitPrice: 10000, quantity: 2 },
      ];
      const belowThreshold = evaluateCartPromotions(smallCart, [freeShipRule], CONTEXT_POS);
      expect(belowThreshold.freeShippingPromotion).toBeNull();
    });

    it("prevents double-counting a single physical unit across overlapping ALL_REQUIRED targets and supports category targets", () => {
      const overlappingRule: PromotionRule = {
        id: 903,
        name: "بكج منتج 10 + متغير 101 بـ 8,000",
        type: "BUNDLE_PRICE",
        bundleMode: "ALL_REQUIRED",
        bundlePrice: 8000,
        scope: "PRODUCTS",
        channel: "ALL",
        targetProductIds: new Set([10]),
        targetVariantIds: new Set([101]),
      };

      // Only 1 physical unit of variant 101 (product 10): must NOT satisfy both slots
      const singleUnit = evaluateCartPromotions(
        [{ lineKey: "l1", productId: 10, variantId: 101, isBaseUnit: true, unitPrice: 5000, quantity: 1 }],
        [overlappingRule],
        CONTEXT_POS,
      );
      expect(singleUnit.totalCartDiscount.toFixed(2)).toBe("0.00");

      // 2 distinct physical units (variant 101 + variant 102 of product 10): forms 1 complete set
      const twoDistinctUnits = evaluateCartPromotions(
        [
          { lineKey: "l1", productId: 10, variantId: 101, isBaseUnit: true, unitPrice: 5000, quantity: 1 },
          { lineKey: "l2", productId: 10, variantId: 102, isBaseUnit: true, unitPrice: 6000, quantity: 1 },
        ],
        [overlappingRule],
        CONTEXT_POS,
      );
      expect(twoDistinctUnits.totalCartDiscount.toFixed(2)).toBe("3000.00");

      // Category-scoped ALL_REQUIRED bundle (1 item from cat 10 + 1 item from cat 20)
      const categoryBundleRule: PromotionRule = {
        id: 904,
        name: "بكج دفتر + قلم من التصنيفين بـ 4,000",
        type: "BUNDLE_PRICE",
        bundleMode: "ALL_REQUIRED",
        bundlePrice: 4000,
        scope: "CATEGORIES",
        channel: "ALL",
        targetCategoryIds: new Set([10, 20]),
      };
      const catOut = evaluateCartPromotions(
        [
          { lineKey: "c1", productId: 1, variantId: 1, categoryId: 10, isBaseUnit: true, unitPrice: 3000, quantity: 1 },
          { lineKey: "c2", productId: 2, variantId: 2, categoryId: 20, isBaseUnit: true, unitPrice: 2000, quantity: 1 },
        ],
        [categoryBundleRule],
        CONTEXT_POS,
      );
      expect(catOut.totalCartDiscount.toFixed(2)).toBe("1000.00");
    });

    it("applies maxDiscountAmount per unit for AUTO PERCENT and across the cart for COUPON PERCENT", () => {
      const items: EvaluationItem[] = [
        { lineKey: "l1", productId: 200, variantId: 200, categoryId: 10, isBaseUnit: true, unitPrice: 3000, quantity: 3 },
      ];
      const autoPercent: PromotionRule = {
        id: 905,
        name: "خصم تلقائي 10% بسقف 250 للقطعة",
        type: "PERCENT",
        applicationMode: "AUTO",
        channel: "ALL",
        discountPercent: 10,
        maxDiscountAmount: 250,
        scope: "CATEGORIES",
        targetCategoryIds: new Set([10]),
      };
      const autoRes = evaluateCartPromotions(items, [autoPercent], CONTEXT_POS);
      expect(autoRes.totalCartDiscount.toFixed(2)).toBe("750.00");

      const couponPercent: PromotionRule = {
        ...autoPercent,
        id: 906,
        applicationMode: "COUPON",
      };
      const couponRes = evaluateCartPromotions(items, [couponPercent], CONTEXT_POS);
      expect(couponRes.totalCartDiscount.toFixed(2)).toBe("250.00");
    });

    it("evaluates 100,000-unit bulk lines in O(L) time for ALL_REQUIRED, PICK_ANY_N, and BOGO without quadratic rescanning", () => {
      const bulkAllRequired: PromotionRule = {
        id: 907,
        name: "باقة جملة إلزامية",
        type: "BUNDLE_PRICE",
        bundleMode: "ALL_REQUIRED",
        bundlePrice: 1500,
        channel: "ALL",
        scope: "PRODUCTS",
        targetProductIds: new Set([1, 2]),
      };
      const t0 = Date.now();
      const resAllReq = evaluateCartPromotions(
        [
          { lineKey: "b1", productId: 1, variantId: 1, isBaseUnit: true, unitPrice: 1000, quantity: 100_000 },
          { lineKey: "b2", productId: 2, variantId: 2, isBaseUnit: true, unitPrice: 1000, quantity: 100_000 },
        ],
        [bulkAllRequired],
        CONTEXT_POS,
      );
      const elapsedAllReq = Date.now() - t0;
      expect(elapsedAllReq).toBeLessThan(200);
      // 100,000 sets * (2000 - 1500) = 50,000,000.00
      expect(resAllReq.totalCartDiscount.toFixed(2)).toBe("50000000.00");
      expect(resAllReq.lineAllocations.get("b1")?.discountAmount.toFixed(2)).toBe("25000000.00");
      expect(resAllReq.lineAllocations.get("b2")?.discountAmount.toFixed(2)).toBe("25000000.00");

      const bulkPickAny: PromotionRule = {
        id: 908,
        name: "اختر 3 بـ 2400",
        type: "BUNDLE_PRICE",
        bundleMode: "PICK_ANY_N",
        bundleQuantity: 3,
        bundlePrice: 2400,
        channel: "ALL",
        scope: "PRODUCTS",
        targetProductIds: new Set([1, 2]),
      };
      const t1 = Date.now();
      const resPickAny = evaluateCartPromotions(
        [
          { lineKey: "p1", productId: 1, variantId: 1, isBaseUnit: true, unitPrice: 1000, quantity: 100_000 },
          { lineKey: "p2", productId: 2, variantId: 2, isBaseUnit: true, unitPrice: 900, quantity: 2 },
        ],
        [bulkPickAny],
        CONTEXT_POS,
      );
      expect(Date.now() - t1).toBeLessThan(200);
      // 33,333 pure 1000-IQD bundles (savings 600 each = 19,999,800) + 1 straddling bundle (1000 + 900 + 900 = 2800 -> savings 400) = 20,000,200.00
      expect(resPickAny.totalCartDiscount.toFixed(2)).toBe("20000200.00");

      const bulkBogo: PromotionRule = {
        id: 909,
        name: "اشتري 2 واحصل على 1 مجاناً",
        type: "BOGO",
        bogoBuyQuantity: 2,
        bogoGetQuantity: 1,
        bogoGetDiscountPercent: 100,
        channel: "ALL",
        scope: "PRODUCTS",
        targetProductIds: new Set([1]),
      };
      const t2 = Date.now();
      const resBogo = evaluateCartPromotions(
        [{ lineKey: "g1", productId: 1, variantId: 1, isBaseUnit: true, unitPrice: 1000, quantity: 99_999 }],
        [bulkBogo],
        CONTEXT_POS,
      );
      expect(Date.now() - t2).toBeLessThan(200);
      expect(resBogo.totalCartDiscount.toFixed(2)).toBe("33333000.00");
    });
  });
});
