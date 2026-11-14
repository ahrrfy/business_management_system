/**
 * tests/e2e/promotions/tier1_features/pricing_engine_core.test.ts
 *
 * Tier 1 Feature Coverage: Pricing Engine Core & Precision (F07–F10)
 * Deterministic decimal.js calculations, fixed-price ceiling rule,
 * proportional value allocation, priority ordering, and contract price protection.
 */

import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import {
  assertAllocationConservation,
  assertDecimalEqual,
  assertPriceCeilingRespected,
} from "../infra/assertions";
import {
  PRD_CHEAP_PEN,
  PRD_CRYSTAL_SHIELD,
  PRD_INK_EPSON,
  PRD_LUX_PEN,
  PRD_NOTEBOOK_FABER,
  PRD_PEN_ROTRING,
  createAmountPromoFixture,
  createBogoPromoFixture,
  createBundlePromoFixture,
  createFixedPricePromoFixture,
  createPercentPromoFixture,
} from "../infra/mockFixtures";
import {
  allocateByValue,
  cart,
  evaluatePromotions,
  EvaluationContext,
} from "../infra/testHarness";

const CONTEXT_POS: EvaluationContext = {
  channel: "POS",
  todayYmd: "2026-06-15", // Monday
};

describe("Tier 1: Pricing Engine Core (F07–F10)", () => {
  // =========================================================================
  // F07: Pricing Engine: Core & Precision
  // =========================================================================
  describe("F07: Pricing Engine: Core & Precision", () => {
    it("T1-F07-01: evaluates PERCENT promo (20% off 10,000 IQD) -> line discount = 2,000.00 IQD, effective = 8,000.00 IQD", () => {
      const items = cart()
        .addItem(PRD_PEN_ROTRING, 20) // 20 units @ 500 = 10,000 IQD
        .build();

      const promo = createPercentPromoFixture({
        id: 701,
        discountPercent: new Decimal(20),
        targetProductIds: new Set([PRD_PEN_ROTRING.id]),
      });

      const res = evaluatePromotions(items, [promo], CONTEXT_POS);
      const alloc = res.lineAllocations.get(items[0].lineKey);

      expect(alloc).toBeDefined();
      assertDecimalEqual(alloc!.discountAmount, 2000, "20% of 10,000 IQD");
      assertDecimalEqual(alloc!.effectiveUnitPrice, 400, "500 - (2000/20) = 400 IQD");
      assertDecimalEqual(res.totalCartDiscount, 2000);
    });

    it("T1-F07-02: evaluates AMOUNT promo (1,500 IQD off 5,000 IQD) -> line discount = 1,500.00 IQD, effective = 3,500.00 IQD", () => {
      const items = cart()
        .addItem(PRD_NOTEBOOK_FABER, 1, 0, { customUnitPrice: 5000 })
        .build();

      const promo = createAmountPromoFixture({
        id: 702,
        discountAmount: new Decimal(1500),
        targetProductIds: new Set([PRD_NOTEBOOK_FABER.id]),
      });

      const res = evaluatePromotions(items, [promo], CONTEXT_POS);
      const alloc = res.lineAllocations.get(items[0].lineKey);

      expect(alloc).toBeDefined();
      assertDecimalEqual(alloc!.discountAmount, 1500);
      assertDecimalEqual(alloc!.effectiveUnitPrice, 3500);
      assertDecimalEqual(res.totalCartDiscount, 1500);
    });

    it("T1-F07-03: precision: 15.5% off 3,333 IQD item -> exact rounding to 516.62 IQD discount, effective = 2,816.38 IQD", () => {
      const items = cart()
        .addItem(PRD_NOTEBOOK_FABER, 1, 0, { customUnitPrice: 3333 })
        .build();

      const promo = createPercentPromoFixture({
        id: 703,
        discountPercent: new Decimal("15.5"),
        targetProductIds: new Set([PRD_NOTEBOOK_FABER.id]),
      });

      const res = evaluatePromotions(items, [promo], CONTEXT_POS);
      const alloc = res.lineAllocations.get(items[0].lineKey);

      expect(alloc).toBeDefined();
      assertDecimalEqual(alloc!.discountAmount, "516.62", "15.5% of 3,333 rounded to half-up");
      assertDecimalEqual(alloc!.effectiveUnitPrice, "2816.38");
      assertDecimalEqual(res.totalCartDiscount, "516.62");
    });

    it("T1-F07-04: verifies decimal.js arithmetic avoids float drift: sum of three 3,333.33 IQD items strictly equals 9,999.99 IQD", () => {
      const p1 = new Decimal("3333.33");
      const p2 = new Decimal("3333.33");
      const p3 = new Decimal("3333.33");
      const sum = p1.plus(p2).plus(p3);

      expect(sum.toString()).toBe("9999.99");
      expect(sum.toNumber()).not.toBe(10000);
    });

    it("T1-F07-05: multi-item cart: verifies totalCartDiscount matches exact sum of individual lineAllocations", () => {
      const items = cart()
        .addItem(PRD_PEN_ROTRING, 4) // 4 * 500 = 2,000
        .addItem(PRD_NOTEBOOK_FABER, 2) // 2 * 3,500 = 7,000
        .build();

      const promo = createPercentPromoFixture({
        id: 705,
        discountPercent: new Decimal(10), // 10%
        targetProductIds: new Set([PRD_PEN_ROTRING.id, PRD_NOTEBOOK_FABER.id]),
      });

      const res = evaluatePromotions(items, [promo], CONTEXT_POS);

      assertAllocationConservation(items, res);
      // 10% of 2,000 = 200, 10% of 7,000 = 700. Total = 900
      assertDecimalEqual(res.totalCartDiscount, 900);
    });

    it("T1-F07-06: minimum spend guard: cart below minOrderSpend receives 0 discount", () => {
      const items = cart()
        .addItem(PRD_PEN_ROTRING, 2) // 2 * 500 = 1,000 IQD
        .build();

      const promo = createPercentPromoFixture({
        id: 706,
        discountPercent: new Decimal(20),
        minOrderSpend: new Decimal(5000), // requires 5,000 IQD
        targetProductIds: new Set([PRD_PEN_ROTRING.id]),
      });

      const res = evaluatePromotions(items, [promo], CONTEXT_POS);
      expect(res.totalCartDiscount.toNumber()).toBe(0);
      expect(res.lineAllocations.size).toBe(0);
    });

    it("T1-F07-07: cart meeting exact minOrderSpend receives discount", () => {
      const items = cart()
        .addItem(PRD_PEN_ROTRING, 10) // 10 * 500 = 5,000 IQD
        .build();

      const promo = createPercentPromoFixture({
        id: 707,
        discountPercent: new Decimal(20),
        minOrderSpend: new Decimal(5000),
        targetProductIds: new Set([PRD_PEN_ROTRING.id]),
      });

      const res = evaluatePromotions(items, [promo], CONTEXT_POS);
      assertDecimalEqual(res.totalCartDiscount, 1000, "20% of 5,000 IQD");
    });

    it("T1-F07-08: amount promo with quantity > 1 multiplies discount per unit correctly", () => {
      const items = cart()
        .addItem(PRD_INK_EPSON, 3) // 3 units @ 12,000 = 36,000 IQD
        .build();

      const promo = createAmountPromoFixture({
        id: 708,
        discountAmount: new Decimal(2000), // 2,000 off per unit
        targetProductIds: new Set([PRD_INK_EPSON.id]),
      });

      const res = evaluatePromotions(items, [promo], CONTEXT_POS);
      const alloc = res.lineAllocations.get(items[0].lineKey);

      expect(alloc).toBeDefined();
      assertDecimalEqual(alloc!.discountAmount, 6000, "2,000 * 3 units");
      assertDecimalEqual(alloc!.effectiveUnitPrice, 10000, "12,000 - 2,000 = 10,000");
    });

    it("T1-F07-09: cart with 50 items: sum of allocations strictly matches totalCartDiscount without 1 fils loss", () => {
      const c = cart();
      for (let i = 0; i < 50; i++) {
        c.addItem(PRD_PEN_ROTRING, 1, 0, { customUnitPrice: 333 + i });
      }
      const items = c.build();

      const promo = createPercentPromoFixture({
        id: 709,
        discountPercent: new Decimal("12.5"),
        targetProductIds: new Set([PRD_PEN_ROTRING.id]),
      });

      const res = evaluatePromotions(items, [promo], CONTEXT_POS);
      assertAllocationConservation(items, res);
      expect(res.totalCartDiscount.gt(0)).toBe(true);
    });
  });

  // =========================================================================
  // F08: Pricing Engine: Fixed Price Ceiling
  // =========================================================================
  describe("F08: Pricing Engine: Fixed Price Ceiling", () => {
    it("T1-F08-01: fixed price promo = 4,000 IQD on item priced at 6,000 IQD -> discount = 2,000.00 IQD, effective = 4,000.00 IQD", () => {
      const items = cart()
        .addItem(PRD_NOTEBOOK_FABER, 1, 0, { customUnitPrice: 6000 })
        .build();

      const promo = createFixedPricePromoFixture({
        id: 801,
        fixedPrice: new Decimal(4000),
        targetProductIds: new Set([PRD_NOTEBOOK_FABER.id]),
      });

      const res = evaluatePromotions(items, [promo], CONTEXT_POS);
      const alloc = res.lineAllocations.get(items[0].lineKey);

      expect(alloc).toBeDefined();
      assertDecimalEqual(alloc!.discountAmount, 2000);
      assertDecimalEqual(alloc!.effectiveUnitPrice, 4000);
    });

    it("T1-F08-02: fixed price promo = 4,000 IQD on item priced at 3,500 IQD -> discount = 0.00 IQD, effective = 3,500.00 IQD (ceiling preserved)", () => {
      const items = cart()
        .addItem(PRD_NOTEBOOK_FABER, 1, 0, { customUnitPrice: 3500 }) // price < 4,000
        .build();

      const promo = createFixedPricePromoFixture({
        id: 802,
        fixedPrice: new Decimal(4000),
        targetProductIds: new Set([PRD_NOTEBOOK_FABER.id]),
      });

      const res = evaluatePromotions(items, [promo], CONTEXT_POS);
      const alloc = res.lineAllocations.get(items[0].lineKey);

      // Must NOT be discounted and price must NEVER increase to 4,000
      expect(alloc).toBeUndefined();
      assertDecimalEqual(res.totalCartDiscount, 0);

      assertPriceCeilingRespected(
        [
          {
            originalUnitPrice: new Decimal(3500),
            effectiveUnitPrice: new Decimal(3500),
            discountAmount: new Decimal(0),
          },
        ],
        new Decimal(4000)
      );
    });

    it("T1-F08-03: fixed price promo = 4,000 IQD on item priced exactly at 4,000 IQD -> discount = 0.00 IQD, effective = 4,000.00 IQD", () => {
      const items = cart()
        .addItem(PRD_NOTEBOOK_FABER, 1, 0, { customUnitPrice: 4000 })
        .build();

      const promo = createFixedPricePromoFixture({
        id: 803,
        fixedPrice: new Decimal(4000),
        targetProductIds: new Set([PRD_NOTEBOOK_FABER.id]),
      });

      const res = evaluatePromotions(items, [promo], CONTEXT_POS);
      expect(res.totalCartDiscount.toNumber()).toBe(0);
    });

    it("T1-F08-04: target includes multiple items (prices: 2,500, 4,000, 6,500 IQD) with fixed price = 4,000 IQD -> only the 6,500 IQD item is discounted", () => {
      const items = cart()
        .addItem(PRD_CHEAP_PEN, 1, 0, { customUnitPrice: 2500 })
        .addItem(PRD_PEN_ROTRING, 1, 0, { customUnitPrice: 4000 })
        .addItem(PRD_NOTEBOOK_FABER, 1, 0, { customUnitPrice: 6500 })
        .build();

      const promo = createFixedPricePromoFixture({
        id: 804,
        fixedPrice: new Decimal(4000),
        targetProductIds: new Set([PRD_CHEAP_PEN.id, PRD_PEN_ROTRING.id, PRD_NOTEBOOK_FABER.id]),
      });

      const res = evaluatePromotions(items, [promo], CONTEXT_POS);

      // Line 1: 2,500 <= 4,000 -> 0 discount
      expect(res.lineAllocations.get(items[0].lineKey)).toBeUndefined();
      // Line 2: 4,000 <= 4,000 -> 0 discount
      expect(res.lineAllocations.get(items[1].lineKey)).toBeUndefined();
      // Line 3: 6,500 > 4,000 -> 2,500 discount
      const alloc3 = res.lineAllocations.get(items[2].lineKey);
      expect(alloc3).toBeDefined();
      assertDecimalEqual(alloc3!.discountAmount, 2500);
      assertDecimalEqual(alloc3!.effectiveUnitPrice, 4000);
      assertDecimalEqual(res.totalCartDiscount, 2500);
    });

    it("T1-F08-05: multi-quantity line: 5 units @ 5,000 IQD with fixed price 4,000 IQD -> line discount = 5,000.00 IQD (1,000 per unit)", () => {
      const items = cart()
        .addItem(PRD_NOTEBOOK_FABER, 5, 0, { customUnitPrice: 5000 })
        .build();

      const promo = createFixedPricePromoFixture({
        id: 805,
        fixedPrice: new Decimal(4000),
        targetProductIds: new Set([PRD_NOTEBOOK_FABER.id]),
      });

      const res = evaluatePromotions(items, [promo], CONTEXT_POS);
      const alloc = res.lineAllocations.get(items[0].lineKey);

      expect(alloc).toBeDefined();
      assertDecimalEqual(alloc!.discountAmount, 5000, "1,000 * 5 units");
      assertDecimalEqual(alloc!.effectiveUnitPrice, 4000);
    });

    it("T1-F08-06: mixed pen cart: cheap pen (250 IQD) and Rotring pen (500 IQD) under 1,000 IQD fixed promo receive 0 discount", () => {
      const items = cart()
        .addItem(PRD_CHEAP_PEN, 2) // 2 * 250 IQD
        .addItem(PRD_PEN_ROTRING, 2) // 2 * 500 IQD
        .build();

      const promo = createFixedPricePromoFixture({
        id: 806,
        fixedPrice: new Decimal(1000),
        targetProductIds: new Set([PRD_CHEAP_PEN.id, PRD_PEN_ROTRING.id]),
      });

      const res = evaluatePromotions(items, [promo], CONTEXT_POS);
      expect(res.totalCartDiscount.toNumber()).toBe(0);
      expect(res.lineAllocations.size).toBe(0);
    });

    it("T1-F08-07: luxury pen (28,000 IQD) under 1,000 IQD fixed promo discounted to 1,000 IQD with 27,000 IQD savings", () => {
      const items = cart()
        .addItem(PRD_LUX_PEN, 1) // 28,000 IQD
        .build();

      const promo = createFixedPricePromoFixture({
        id: 807,
        fixedPrice: new Decimal(1000),
        targetProductIds: new Set([PRD_LUX_PEN.id]),
      });

      const res = evaluatePromotions(items, [promo], CONTEXT_POS);
      const alloc = res.lineAllocations.get(items[0].lineKey);

      expect(alloc).toBeDefined();
      assertDecimalEqual(alloc!.discountAmount, 27000);
      assertDecimalEqual(alloc!.effectiveUnitPrice, 1000);
    });

    it("T1-F08-08: multi-quantity cheap pen line (10 units @ 250 IQD) receives 0 discount under 1,000 IQD fixed promo", () => {
      const items = cart()
        .addItem(PRD_CHEAP_PEN, 10) // 10 * 250 = 2,500 IQD
        .build();

      const promo = createFixedPricePromoFixture({
        id: 808,
        fixedPrice: new Decimal(1000),
        targetProductIds: new Set([PRD_CHEAP_PEN.id]),
      });

      const res = evaluatePromotions(items, [promo], CONTEXT_POS);
      expect(res.totalCartDiscount.toNumber()).toBe(0);
      expect(res.lineAllocations.size).toBe(0);
    });
  });

  // =========================================================================
  // F09: Pricing Engine: Proportional Allocation
  // =========================================================================
  describe("F09: Pricing Engine: Proportional Allocation", () => {
    it("T1-F09-01: BOGO Buy 2 Get 1 Free on 3 identical items (each 3,000 IQD) -> total discount = 3,000 IQD allocated as 1,000 IQD per item", () => {
      const items = cart()
        .addItem(PRD_NOTEBOOK_FABER, 3, 0, { customUnitPrice: 3000 })
        .build();

      const promo = createBogoPromoFixture({
        id: 901,
        bogoBuyQuantity: 2,
        bogoGetQuantity: 1,
        bogoGetDiscountPercent: new Decimal(100),
        targetProductIds: new Set([PRD_NOTEBOOK_FABER.id]),
      });

      const res = evaluatePromotions(items, [promo], CONTEXT_POS);
      const alloc = res.lineAllocations.get(items[0].lineKey);

      expect(alloc).toBeDefined();
      assertDecimalEqual(alloc!.discountAmount, 3000, "1 free notebook = 3,000 IQD");
      assertDecimalEqual(alloc!.effectiveUnitPrice, 2000, "(9000 - 3000) / 3 = 2000 IQD");
      assertDecimalEqual(res.totalCartDiscount, 3000);
    });

    it("T1-F09-02: BOGO Buy 2 Get 1 Free on items with different prices (6k, 4k, 2k) -> cheapest item (2k) is free, 2k discount allocated by value", () => {
      const items = cart()
        .addItem(PRD_NOTEBOOK_FABER, 1, 0, { customUnitPrice: 6000 })
        .addItem(PRD_CRYSTAL_SHIELD, 1, 0, { customUnitPrice: 4000 })
        .addItem(PRD_PEN_ROTRING, 1, 0, { customUnitPrice: 2000 })
        .build();

      const promo = createBogoPromoFixture({
        id: 902,
        bogoBuyQuantity: 2,
        bogoGetQuantity: 1,
        bogoGetDiscountPercent: new Decimal(100),
        targetProductIds: new Set([
          PRD_NOTEBOOK_FABER.id,
          PRD_CRYSTAL_SHIELD.id,
          PRD_PEN_ROTRING.id,
        ]),
      });

      const res = evaluatePromotions(items, [promo], CONTEXT_POS);

      // Total savings = 2,000 IQD (cheapest item is 2,000 IQD)
      assertDecimalEqual(res.totalCartDiscount, 2000);

      // Proportional allocation across 6k, 4k, 2k (total 12k):
      // 6k line gets 2000 * (6/12) = 1,000
      // 4k line gets 2000 * (4/12) = 666.67
      // 2k line gets 2000 * (2/12) = 333.33
      const alloc1 = res.lineAllocations.get(items[0].lineKey);
      const alloc2 = res.lineAllocations.get(items[1].lineKey);
      const alloc3 = res.lineAllocations.get(items[2].lineKey);

      assertDecimalEqual(alloc1!.discountAmount, 1000);
      assertDecimalEqual(alloc2!.discountAmount, "666.67");
      assertDecimalEqual(alloc3!.discountAmount, "333.33");

      assertAllocationConservation(items, res);
    });

    it("T1-F09-03: bundle of 2 items for 10,000 IQD (Item A = 8,000, Item B = 4,000, Total = 12,000) -> 2,000 IQD discount allocated: A = 1333.33, B = 666.67", () => {
      const items = cart()
        .addItem(PRD_NOTEBOOK_FABER, 1, 0, { customUnitPrice: 8000 })
        .addItem(PRD_PEN_ROTRING, 1, 0, { customUnitPrice: 4000 })
        .build();

      const promo = createBundlePromoFixture({
        id: 903,
        bundlePrice: new Decimal(10000),
        bundleMode: "ALL_REQUIRED",
        targetProductIds: new Set([PRD_NOTEBOOK_FABER.id, PRD_PEN_ROTRING.id]),
      });

      const res = evaluatePromotions(items, [promo], CONTEXT_POS);

      assertDecimalEqual(res.totalCartDiscount, 2000);

      const allocA = res.lineAllocations.get(items[0].lineKey);
      const allocB = res.lineAllocations.get(items[1].lineKey);

      assertDecimalEqual(allocA!.discountAmount, "1333.33");
      assertDecimalEqual(allocB!.discountAmount, "666.67");

      assertAllocationConservation(items, res);
    });

    it("T1-F09-04: verifies allocateByValue helper distributes cents and remainder strictly down to 0.01 fils", () => {
      const lines = [
        { lineKey: "L1", lineGross: new Decimal("5000.00") },
        { lineKey: "L2", lineGross: new Decimal("5000.00") },
        { lineKey: "L3", lineGross: new Decimal("5000.00") },
      ];
      // Split 1,000 IQD among three equal 5,000 lines (333.333...)
      const alloc = allocateByValue(lines, new Decimal(1000));

      const sum = Array.from(alloc.values()).reduce((a, b) => a.plus(b), new Decimal(0));
      expect(sum.toString()).toBe("1000");

      // One line gets 333.34 and two lines get 333.33
      const values = Array.from(alloc.values()).map((v) => v.toString());
      expect(values).toContain("333.34");
      expect(values.filter((v) => v === "333.33")).toHaveLength(2);
    });

    it("T1-F09-05: BOGO Buy 2 Get 1 with 5 items gives exactly 1 free item (requires 6 for second)", () => {
      const items = cart()
        .addItem(PRD_PEN_ROTRING, 5) // 5 units @ 500 = 2,500 IQD
        .build();

      const promo = createBogoPromoFixture({
        id: 905,
        bogoBuyQuantity: 2,
        bogoGetQuantity: 1,
        targetProductIds: new Set([PRD_PEN_ROTRING.id]),
      });

      const res = evaluatePromotions(items, [promo], CONTEXT_POS);
      const alloc = res.lineAllocations.get(items[0].lineKey);

      // floor(5 / 3) = 1 free item @ 500 IQD
      assertDecimalEqual(alloc!.discountAmount, 500);
      assertDecimalEqual(res.totalCartDiscount, 500);
    });

    it("T1-F09-06: bundle PICK_ANY_N of 3 items for 12,000 IQD saves 3,000 IQD on 15,000 IQD gross", () => {
      const items = cart()
        .addItem(PRD_NOTEBOOK_FABER, 3, 0, { customUnitPrice: 5000 })
        .build();

      const promo = createBundlePromoFixture({
        id: 906,
        bundlePrice: new Decimal(12000),
        bundleMode: "PICK_ANY_N",
        bundleQuantity: 3,
        targetProductIds: new Set([PRD_NOTEBOOK_FABER.id]),
      });

      const res = evaluatePromotions(items, [promo], CONTEXT_POS);
      assertDecimalEqual(res.totalCartDiscount, 3000);
    });

    it("T1-F09-07: BOGO Buy 3 Get 1 Free on 4 items (each 1,000 IQD) yields exactly 1,000 IQD savings", () => {
      const items = cart()
        .addItem(PRD_PEN_ROTRING, 4, 0, { customUnitPrice: 1000 })
        .build();

      const promo = createBogoPromoFixture({
        id: 907,
        bogoBuyQuantity: 3,
        bogoGetQuantity: 1,
        targetProductIds: new Set([PRD_PEN_ROTRING.id]),
      });

      const res = evaluatePromotions(items, [promo], CONTEXT_POS);
      assertDecimalEqual(res.totalCartDiscount, 1000);
      assertAllocationConservation(items, res);
    });
  });

  // =========================================================================
  // F10: Pricing Engine: Priority & Stacking
  // =========================================================================
  describe("F10: Pricing Engine: Priority & Stacking", () => {
    it("T1-F10-01: two competing promos (Priority 20 vs Priority 10) on same item -> Priority 20 promo is applied", () => {
      const items = cart()
        .addItem(PRD_NOTEBOOK_FABER, 1) // 3,500 IQD
        .build();

      const promoLow = createPercentPromoFixture({
        id: 1001,
        name: "Low Priority Promo (25% off)",
        priority: 10,
        discountPercent: new Decimal(25),
        targetProductIds: new Set([PRD_NOTEBOOK_FABER.id]),
      });

      const promoHigh = createPercentPromoFixture({
        id: 1002,
        name: "High Priority Promo (10% off)",
        priority: 20,
        discountPercent: new Decimal(10),
        targetProductIds: new Set([PRD_NOTEBOOK_FABER.id]),
      });

      const res = evaluatePromotions(items, [promoLow, promoHigh], CONTEXT_POS);

      // Higher priority (20) applies even though it offers lower percentage
      expect(res.appliedPromotionIds.has(1002)).toBe(true);
      expect(res.appliedPromotionIds.has(1001)).toBe(false);
      assertDecimalEqual(res.totalCartDiscount, 350, "10% of 3,500 IQD");
    });

    it("T1-F10-02: two competing promos with equal priority -> first promo in evaluation applies", () => {
      const items = cart()
        .addItem(PRD_NOTEBOOK_FABER, 1)
        .build();

      const promoA = createPercentPromoFixture({
        id: 1003,
        priority: 10,
        discountPercent: new Decimal(15),
        targetProductIds: new Set([PRD_NOTEBOOK_FABER.id]),
      });

      const promoB = createPercentPromoFixture({
        id: 1004,
        priority: 10,
        discountPercent: new Decimal(10),
        targetProductIds: new Set([PRD_NOTEBOOK_FABER.id]),
      });

      const res = evaluatePromotions(items, [promoA, promoB], CONTEXT_POS);
      expect(res.appliedPromotionIds.has(1003)).toBe(true);
    });

    it("T1-F10-03: item has hasContractPrice = true -> returns promo = null, discount = 0 (contract price strictly protected)", () => {
      const items = cart()
        .addItem(PRD_NOTEBOOK_FABER, 1, 0, { hasContractPrice: true })
        .build();

      const promo = createPercentPromoFixture({
        id: 1005,
        discountPercent: new Decimal(20),
        targetProductIds: new Set([PRD_NOTEBOOK_FABER.id]),
      });

      const res = evaluatePromotions(items, [promo], CONTEXT_POS);
      expect(res.totalCartDiscount.toNumber()).toBe(0);
      expect(res.lineAllocations.size).toBe(0);
    });

    it("T1-F10-04: cart with 2 items: 1 contract price item, 1 standard item -> promo applies exclusively to standard item", () => {
      const items = cart()
        .addItem(PRD_NOTEBOOK_FABER, 1, 0, { hasContractPrice: true, customUnitPrice: 2800 })
        .addItem(PRD_PEN_ROTRING, 2, 0, { hasContractPrice: false }) // 2 * 500 = 1,000 IQD
        .build();

      const promo = createPercentPromoFixture({
        id: 1006,
        discountPercent: new Decimal(20),
        targetProductIds: new Set([PRD_NOTEBOOK_FABER.id, PRD_PEN_ROTRING.id]),
      });

      const res = evaluatePromotions(items, [promo], CONTEXT_POS);

      // Contract item receives 0
      expect(res.lineAllocations.get(items[0].lineKey)).toBeUndefined();

      // Standard item receives 20% of 1,000 = 200 IQD
      const allocPen = res.lineAllocations.get(items[1].lineKey);
      expect(allocPen).toBeDefined();
      assertDecimalEqual(allocPen!.discountAmount, 200);
      assertDecimalEqual(res.totalCartDiscount, 200);
    });

    it("T1-F10-05: non-stacking verification: item already discounted by one promo does not receive second promo", () => {
      const items = cart()
        .addItem(PRD_NOTEBOOK_FABER, 1) // 3,500 IQD
        .build();

      const promoCategory = createPercentPromoFixture({
        id: 1007,
        priority: 15,
        discountPercent: new Decimal(10), // 350 discount
        targetCategoryIds: new Set([PRD_NOTEBOOK_FABER.categoryId]),
      });

      const promoStore = createPercentPromoFixture({
        id: 1008,
        priority: 10,
        discountPercent: new Decimal(5), // 175 discount
        targetProductIds: new Set(), // store-wide
      });

      const res = evaluatePromotions(items, [promoCategory, promoStore], CONTEXT_POS);

      expect(res.appliedPromotionIds.size).toBe(1);
      expect(res.appliedPromotionIds.has(1007)).toBe(true);
      assertDecimalEqual(res.totalCartDiscount, 350);
    });

    it("T1-F10-06: base unit isolation: applyToBaseUnitOnly = true ignores carton unit lines", () => {
      const items = cart()
        .addCartonItem(PRD_PEN_ROTRING, 1) // 1 carton @ 60,000 IQD
        .build();

      const promo = createFixedPricePromoFixture({
        id: 1009,
        fixedPrice: new Decimal(400), // Promo meant for piece (500 -> 400)
        applyToBaseUnitOnly: true,
        targetProductIds: new Set([PRD_PEN_ROTRING.id]),
      });

      const res = evaluatePromotions(items, [promo], CONTEXT_POS);

      // Carton must NOT be discounted to 400 IQD!
      expect(res.totalCartDiscount.toNumber()).toBe(0);
      expect(res.lineAllocations.size).toBe(0);
    });

    it("T1-F10-07: tiered quantity promo applies higher discount tier for volume >= 10 units", () => {
      const items = cart()
        .addItem(PRD_INK_EPSON, 12) // 12 units @ 12,000 IQD
        .build();

      const promo = {
        ...createPercentPromoFixture({ id: 1010 }),
        type: "TIERED_QTY" as const,
        tieredMode: "PER_ITEM" as const,
        tiers: [
          { minQuantity: new Decimal(5), tierType: "AMOUNT" as const, discountAmount: new Decimal(1000) },
          { minQuantity: new Decimal(10), tierType: "AMOUNT" as const, discountAmount: new Decimal(2500) },
        ],
        targetProductIds: new Set([PRD_INK_EPSON.id]),
      };

      const res = evaluatePromotions(items, [promo], CONTEXT_POS);
      const alloc = res.lineAllocations.get(items[0].lineKey);

      expect(alloc).toBeDefined();
      // 12 units >= 10 -> Tier 2 applies: 2,500 * 12 = 30,000 IQD discount
      assertDecimalEqual(alloc!.discountAmount, 30000);
      assertDecimalEqual(alloc!.effectiveUnitPrice, 9500);
    });
  });
});
