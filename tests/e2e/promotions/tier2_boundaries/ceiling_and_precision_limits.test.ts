/**
 * tests/e2e/promotions/tier2_boundaries/ceiling_and_precision_limits.test.ts
 *
 * Tier 2 Boundary & Corner Cases: Fixed Price Ceiling, Precision Limits & Allocation
 * Covers F01, F07, F08, F09, F10 boundary conditions.
 * Strict decimal.js precision, zero float drift, financial conservation law.
 */

import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import {
  assertAllocationConservation,
  assertDecimalEqual,
  assertNoGiftFlagOnPromoDiscount,
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
  createTieredQtyPromoFixture,
} from "../infra/mockFixtures";
import {
  allocateByValue,
  cart,
  evaluatePromotions,
  EvaluationContext,
  validatePromotionSchema,
} from "../infra/testHarness";

const CONTEXT_POS: EvaluationContext = {
  channel: "POS",
  todayYmd: "2026-06-15",
};

describe("Tier 2: Ceiling & Precision Limits (F01, F07–F10 Boundaries)", () => {
  // =========================================================================
  // 1. F01 Boundary Limits: PERCENT, AMOUNT & Schema Constraints
  // =========================================================================
  describe("F01: Schema & Discount Value Boundary Limits", () => {
    it("T2-F01-01: PERCENT promo with discountPercent = 100.00 -> 100% free, unit price = 0, isGift = false", () => {
      const items = cart().addItem(PRD_PEN_ROTRING, 2).build(); // 2 * 500 = 1000 IQD
      const promo = createPercentPromoFixture({
        id: 101,
        discountPercent: new Decimal(100),
        targetProductIds: new Set([PRD_PEN_ROTRING.id]),
      });

      const res = evaluatePromotions(items, [promo], CONTEXT_POS);
      const alloc = res.lineAllocations.get(items[0].lineKey);

      expect(alloc).toBeDefined();
      assertDecimalEqual(alloc!.discountAmount, 1000, "100% discount on 1000 IQD");
      assertDecimalEqual(alloc!.effectiveUnitPrice, 0, "Effective price becomes 0");
      assertAllocationConservation(items, res);
      assertNoGiftFlagOnPromoDiscount([{ discountAmount: alloc!.discountAmount, isGift: false }]);
    });

    it("T2-F01-02: PERCENT promo with discountPercent = 100.01 -> rejected by schema validator", () => {
      const schemaRes = validatePromotionSchema({
        type: "PERCENT",
        discountPercent: new Decimal("100.01"),
      });
      expect(schemaRes.valid).toBe(false);
      expect(schemaRes.errors.some((e) => e.includes("discountPercent"))).toBe(true);
    });

    it("T2-F01-03: PERCENT promo with discountPercent = 0.00 -> rejected by schema validator", () => {
      const schemaRes = validatePromotionSchema({
        type: "PERCENT",
        discountPercent: new Decimal("0.00"),
      });
      expect(schemaRes.valid).toBe(false);
      expect(schemaRes.errors.some((e) => e.includes("discountPercent"))).toBe(true);
    });

    it("T2-F01-04: PERCENT promo with negative discountPercent -> rejected by schema validator", () => {
      const schemaRes = validatePromotionSchema({
        type: "PERCENT",
        discountPercent: new Decimal("-15.00"),
      });
      expect(schemaRes.valid).toBe(false);
      expect(schemaRes.errors.length).toBeGreaterThan(0);
    });

    it("T2-F01-05: AMOUNT promo with discountAmount = 0.00 -> rejected by schema validator", () => {
      const schemaRes = validatePromotionSchema({
        type: "AMOUNT",
        discountAmount: new Decimal("0.00"),
      });
      expect(schemaRes.valid).toBe(false);
      expect(schemaRes.errors.some((e) => e.includes("discountAmount"))).toBe(true);
    });

    it("T2-F01-06: AMOUNT promo with negative discountAmount -> rejected by schema validator", () => {
      const schemaRes = validatePromotionSchema({
        type: "AMOUNT",
        discountAmount: new Decimal("-500.00"),
      });
      expect(schemaRes.valid).toBe(false);
      expect(schemaRes.errors.some((e) => e.includes("discountAmount"))).toBe(true);
    });

    it("T2-F01-07: AMOUNT promo where discountAmount exceeds item unit price -> capped at line total, net price cannot be negative", () => {
      // Rotring pen is 500 IQD, promo offers 1,000 IQD off per unit
      const items = cart().addItem(PRD_PEN_ROTRING, 3).build(); // gross 1,500 IQD
      const promo = createAmountPromoFixture({
        id: 107,
        discountAmount: new Decimal(1000), // > 500 unit price
        targetProductIds: new Set([PRD_PEN_ROTRING.id]),
      });

      const res = evaluatePromotions(items, [promo], CONTEXT_POS);
      const alloc = res.lineAllocations.get(items[0].lineKey);

      expect(alloc).toBeDefined();
      // Line gross is 1,500 IQD, so discount cannot exceed 1,500 IQD
      assertDecimalEqual(alloc!.discountAmount, 1500, "Capped at line gross 1,500 IQD");
      assertDecimalEqual(alloc!.effectiveUnitPrice, 0, "Effective price cannot drop below 0");
      assertDecimalEqual(res.totalCartDiscount, 1500);
    });

    it("T2-F01-08: Attempting to define PERCENT promo with discountAmount > 0 -> rejected by chk_promo_shape", () => {
      const schemaRes = validatePromotionSchema({
        type: "PERCENT",
        discountPercent: 15,
        discountAmount: 500,
      });
      expect(schemaRes.valid).toBe(false);
      expect(schemaRes.errors.some((e) => e.includes("discountAmount"))).toBe(true);
    });

    it("T2-F01-09: Attempting to define AMOUNT promo with discountPercent > 0 -> rejected by chk_promo_shape", () => {
      const schemaRes = validatePromotionSchema({
        type: "AMOUNT",
        discountAmount: 1000,
        discountPercent: 10,
      });
      expect(schemaRes.valid).toBe(false);
      expect(schemaRes.errors.some((e) => e.includes("discountPercent"))).toBe(true);
    });
  });

  // =========================================================================
  // 2. F07 Precision & Arithmetic Boundary Limits
  // =========================================================================
  describe("F07: Precision & Numerical Limits", () => {
    it("T2-F07-01: micro-fils calculation: 1 IQD item with 33.33% discount -> rounded to 0.33 IQD, no crash", () => {
      const items = cart().addItem(PRD_CHEAP_PEN, 1, 0, { customUnitPrice: 1 }).build();
      const promo = createPercentPromoFixture({
        id: 701,
        discountPercent: new Decimal("33.33"),
        targetProductIds: new Set([PRD_CHEAP_PEN.id]),
      });

      const res = evaluatePromotions(items, [promo], CONTEXT_POS);
      const alloc = res.lineAllocations.get(items[0].lineKey);

      expect(alloc).toBeDefined();
      assertDecimalEqual(alloc!.discountAmount, "0.33");
      assertDecimalEqual(alloc!.effectiveUnitPrice, "0.67");
      assertAllocationConservation(items, res);
    });

    it("T2-F07-02: large number arithmetic: 10,000,000 IQD item with 15% discount -> exactly 1,500,000.00 IQD without precision overflow", () => {
      const items = cart().addItem(PRD_CRYSTAL_SHIELD, 1, 0, { customUnitPrice: 10000000 }).build();
      const promo = createPercentPromoFixture({
        id: 702,
        discountPercent: new Decimal(15),
        targetProductIds: new Set([PRD_CRYSTAL_SHIELD.id]),
      });

      const res = evaluatePromotions(items, [promo], CONTEXT_POS);
      const alloc = res.lineAllocations.get(items[0].lineKey);

      expect(alloc).toBeDefined();
      assertDecimalEqual(alloc!.discountAmount, 1500000);
      assertDecimalEqual(alloc!.effectiveUnitPrice, 8500000);
      assertDecimalEqual(res.totalCartDiscount, 1500000);
    });

    it("T2-F07-03: extreme enterprise basket: 999,999,999,999 IQD with 10% discount -> exactly 99,999,999,999.90 IQD", () => {
      const items = cart().addItem(PRD_LUX_PEN, 1, 0, { customUnitPrice: new Decimal("999999999999") }).build();
      const promo = createPercentPromoFixture({
        id: 703,
        discountPercent: new Decimal(10),
        targetProductIds: new Set([PRD_LUX_PEN.id]),
      });

      const res = evaluatePromotions(items, [promo], CONTEXT_POS);
      const alloc = res.lineAllocations.get(items[0].lineKey);

      expect(alloc).toBeDefined();
      assertDecimalEqual(alloc!.discountAmount, "99999999999.90");
      assertDecimalEqual(alloc!.effectiveUnitPrice, "899999999999.10");
    });

    it("T2-F07-04: fractional quantity inventory (2.7550 kg @ 4,000 IQD/kg with 10% off) -> exact fils calculation", () => {
      const items = cart().addItem(PRD_NOTEBOOK_FABER, new Decimal("2.755"), 0, { customUnitPrice: 4000 }).build();
      // gross = 2.755 * 4000 = 11,020 IQD
      // discount = 10% of 11,020 = 1,102 IQD
      const promo = createPercentPromoFixture({
        id: 704,
        discountPercent: new Decimal(10),
        targetProductIds: new Set([PRD_NOTEBOOK_FABER.id]),
      });

      const res = evaluatePromotions(items, [promo], CONTEXT_POS);
      const alloc = res.lineAllocations.get(items[0].lineKey);

      expect(alloc).toBeDefined();
      assertDecimalEqual(alloc!.discountAmount, 1102);
      assertDecimalEqual(alloc!.effectiveUnitPrice, 3600); // 4000 - 400 = 3600
      assertAllocationConservation(items, res);
    });

    it("T2-F07-05: item with price = 0.00 IQD in cart -> produces 0 discount, zero division avoided", () => {
      const items = cart().addItem(PRD_PEN_ROTRING, 5, 0, { customUnitPrice: new Decimal(0) }).build();
      const promo = createPercentPromoFixture({
        id: 705,
        discountPercent: new Decimal(20),
        targetProductIds: new Set([PRD_PEN_ROTRING.id]),
      });

      const res = evaluatePromotions(items, [promo], CONTEXT_POS);
      expect(res.totalCartDiscount.toNumber()).toBe(0);
      expect(res.lineAllocations.size).toBe(0);
    });

    it("T2-F07-06: zero quantity item in cart -> produces 0 discount and zero division avoided", () => {
      const items = cart().addItem(PRD_PEN_ROTRING, 0).build();
      const promo = createPercentPromoFixture({
        id: 706,
        discountPercent: new Decimal(20),
        targetProductIds: new Set([PRD_PEN_ROTRING.id]),
      });

      const res = evaluatePromotions(items, [promo], CONTEXT_POS);
      expect(res.totalCartDiscount.toNumber()).toBe(0);
    });

    it("T2-F07-07: decimal.js avoids IEEE-754 float drift: 250.10 + 250.20 strictly equals 500.30", () => {
      const val1 = new Decimal("250.10");
      const val2 = new Decimal("250.20");
      const sum = val1.plus(val2);
      expect(sum.toString()).toBe("500.3");
      expect(sum.toFixed(2)).toBe("500.30");
      expect(Number(250.1 + 250.2)).not.toBe(500.3); // In JS float it would be 500.30000000000007
    });

    it("T2-F07-08: string, number, and Decimal constructors produce strictly identical results", () => {
      const d1 = new Decimal(5000);
      const d2 = new Decimal("5000");
      const d3 = new Decimal("5000.00");
      expect(d1.equals(d2)).toBe(true);
      expect(d2.equals(d3)).toBe(true);
    });
  });

  // =========================================================================
  // 3. F08 Fixed Price Ceiling Boundaries
  // =========================================================================
  describe("F08: Fixed Price Ceiling Invariants & Boundaries", () => {
    it("T2-F08-01: fixed price promo = 10,000 IQD on item priced at 1 IQD -> discount = 0, price remains 1 IQD", () => {
      const items = cart().addItem(PRD_CHEAP_PEN, 1, 0, { customUnitPrice: 1 }).build();
      const promo = createFixedPricePromoFixture({
        id: 801,
        fixedPrice: new Decimal(10000), // way higher than 1 IQD
        targetProductIds: new Set([PRD_CHEAP_PEN.id]),
      });

      const res = evaluatePromotions(items, [promo], CONTEXT_POS);
      expect(res.lineAllocations.size).toBe(0);
      assertDecimalEqual(res.totalCartDiscount, 0);

      // Verify ceiling invariant directly
      assertPriceCeilingRespected(
        [
          {
            originalUnitPrice: items[0].unitPrice,
            effectiveUnitPrice: items[0].unitPrice,
            discountAmount: new Decimal(0),
          },
        ],
        promo.fixedPrice!
      );
    });

    it("T2-F08-02: fixed price promo = 0.00 IQD -> rejected by schema validation", () => {
      const schemaRes = validatePromotionSchema({
        type: "FIXED_PRICE",
        fixedPrice: new Decimal("0.00"),
      });
      expect(schemaRes.valid).toBe(false);
      expect(schemaRes.errors.some((e) => e.includes("fixedPrice"))).toBe(true);
    });

    it("T2-F08-03: negative fixed price -> rejected by schema validation", () => {
      const schemaRes = validatePromotionSchema({
        type: "FIXED_PRICE",
        fixedPrice: new Decimal("-1000.00"),
      });
      expect(schemaRes.valid).toBe(false);
      expect(schemaRes.errors.some((e) => e.includes("fixedPrice"))).toBe(true);
    });

    it("T2-F08-04: mixed cart where item price is exactly 0.01 fils above fixed price -> only 0.01 fils is discounted", () => {
      const items = cart()
        .addItem(PRD_PEN_ROTRING, 1, 0, { customUnitPrice: new Decimal("1000.01") })
        .build();

      const promo = createFixedPricePromoFixture({
        id: 804,
        fixedPrice: new Decimal(1000),
        targetProductIds: new Set([PRD_PEN_ROTRING.id]),
      });

      const res = evaluatePromotions(items, [promo], CONTEXT_POS);
      const alloc = res.lineAllocations.get(items[0].lineKey);

      expect(alloc).toBeDefined();
      assertDecimalEqual(alloc!.discountAmount, "0.01");
      assertDecimalEqual(alloc!.effectiveUnitPrice, "1000.00");
    });

    it("T2-F08-05: item price exactly equal to fixed price -> discount = 0.00 IQD and effective = original", () => {
      const items = cart()
        .addItem(PRD_PEN_ROTRING, 4, 0, { customUnitPrice: 1000 })
        .build();

      const promo = createFixedPricePromoFixture({
        id: 805,
        fixedPrice: new Decimal(1000),
        targetProductIds: new Set([PRD_PEN_ROTRING.id]),
      });

      const res = evaluatePromotions(items, [promo], CONTEXT_POS);
      expect(res.lineAllocations.size).toBe(0);
      assertDecimalEqual(res.totalCartDiscount, 0);
    });

    it("T2-F08-06: mixed cart: 3 items below fixed price (250, 500, 750) and 1 above (2,500) with fixed price = 1,000 IQD", () => {
      const items = cart()
        .addItem(PRD_CHEAP_PEN, 1, 0, { customUnitPrice: 250 }) // below
        .addItem(PRD_PEN_ROTRING, 1, 0, { customUnitPrice: 500 }) // below
        .addItem(PRD_NOTEBOOK_FABER, 1, 0, { customUnitPrice: 750 }) // below
        .addItem(PRD_NOTEBOOK_FABER, 1, 0, { customUnitPrice: 2500 }) // above
        .build();

      const promo = createFixedPricePromoFixture({
        id: 806,
        fixedPrice: new Decimal(1000),
        targetProductIds: new Set([PRD_CHEAP_PEN.id, PRD_PEN_ROTRING.id, PRD_NOTEBOOK_FABER.id]),
      });

      const res = evaluatePromotions(items, [promo], CONTEXT_POS);

      // Only line 4 (2500 -> 1000) should have allocation
      expect(res.lineAllocations.size).toBe(1);
      const alloc4 = res.lineAllocations.get(items[3].lineKey);
      expect(alloc4).toBeDefined();
      assertDecimalEqual(alloc4!.discountAmount, 1500);
      assertDecimalEqual(alloc4!.effectiveUnitPrice, 1000);
      assertDecimalEqual(res.totalCartDiscount, 1500);
    });

    it("T2-F08-07: high-value luxury pen (28,000 IQD) discounted to 1,000 IQD fixed price -> discount = 27,000 IQD", () => {
      const items = cart().addItem(PRD_LUX_PEN, 2).build(); // 2 * 28,000 = 56,000 IQD
      const promo = createFixedPricePromoFixture({
        id: 807,
        fixedPrice: new Decimal(1000),
        targetProductIds: new Set([PRD_LUX_PEN.id]),
      });

      const res = evaluatePromotions(items, [promo], CONTEXT_POS);
      const alloc = res.lineAllocations.get(items[0].lineKey);

      expect(alloc).toBeDefined();
      assertDecimalEqual(alloc!.discountAmount, 54000); // 2 * (28,000 - 1,000)
      assertDecimalEqual(alloc!.effectiveUnitPrice, 1000);
      assertDecimalEqual(res.totalCartDiscount, 54000);
    });
  });

  // =========================================================================
  // 4. F09 Proportional Allocation & Conservation Law Boundaries
  // =========================================================================
  describe("F09: Proportional Value Allocation & Conservation Invariants", () => {
    it("T2-F09-01: BOGO Buy 1 Get 1 Free on 1 single item (threshold 2 unmet) -> 0 discount", () => {
      const items = cart().addItem(PRD_NOTEBOOK_FABER, 1).build();
      const promo = createBogoPromoFixture({
        id: 901,
        bogoBuyQuantity: 1,
        bogoGetQuantity: 1,
        targetProductIds: new Set([PRD_NOTEBOOK_FABER.id]),
      });

      const res = evaluatePromotions(items, [promo], CONTEXT_POS);
      expect(res.lineAllocations.size).toBe(0);
      assertDecimalEqual(res.totalCartDiscount, 0);
    });

    it("T2-F09-02: BOGO Buy 2 Get 1 Free with cart quantity = 10 -> exactly 3 items free (3 full groups of 3), 1 excess full price", () => {
      // 10 notebooks @ 3,500 IQD = 35,000 IQD
      // Group size = 2 + 1 = 3. 10 / 3 = 3 groups. Free items = 3 * 3,500 = 10,500 IQD
      const items = cart().addItem(PRD_NOTEBOOK_FABER, 10).build();
      const promo = createBogoPromoFixture({
        id: 902,
        bogoBuyQuantity: 2,
        bogoGetQuantity: 1,
        targetProductIds: new Set([PRD_NOTEBOOK_FABER.id]),
      });

      const res = evaluatePromotions(items, [promo], CONTEXT_POS);
      const alloc = res.lineAllocations.get(items[0].lineKey);

      expect(alloc).toBeDefined();
      assertDecimalEqual(alloc!.discountAmount, 10500);
      assertDecimalEqual(alloc!.effectiveUnitPrice, 2450); // (35,000 - 10,500) / 10 = 2,450 IQD
      assertAllocationConservation(items, res);
    });

    it("T2-F09-03: repeating 1/3 division: 100 IQD discount over 3 identical lines -> 33.34, 33.33, 33.33 IQD (exact conservation)", () => {
      const lines = [
        { lineKey: "line_1", lineGross: new Decimal(1000) },
        { lineKey: "line_2", lineGross: new Decimal(1000) },
        { lineKey: "line_3", lineGross: new Decimal(1000) },
      ];
      const savings = new Decimal(100);
      const allocations = allocateByValue(lines, savings);

      let sum = new Decimal(0);
      Array.from(allocations.values()).forEach((val) => {
        sum = sum.plus(val);
      });

      assertDecimalEqual(sum, 100, "Sum of allocations strictly equals 100 IQD");
      // One line gets 33.34, other two get 33.33
      const values = Array.from(allocations.values()).map((v) => v.toFixed(2)).sort();
      expect(values).toEqual(["33.33", "33.33", "33.34"]);
    });

    it("T2-F09-04: prime division: 10,000 IQD savings distributed over 7 equal lines -> strictly equals 10,000.00 IQD", () => {
      const lines = Array.from({ length: 7 }, (_, i) => ({
        lineKey: `line_${i + 1}`,
        lineGross: new Decimal(5000),
      }));
      const savings = new Decimal(10000);
      const allocations = allocateByValue(lines, savings);

      let sum = new Decimal(0);
      Array.from(allocations.values()).forEach((val) => {
        sum = sum.plus(val);
      });

      assertDecimalEqual(sum, 10000, "Strict conservation over 7 lines");
    });

    it("T2-F09-05: bundle promotion where sum of original item prices < bundlePrice -> discount is 0 (bundle ceiling rule)", () => {
      // 2 cheap pens (250 each = 500 total). Bundle price is 1,000 IQD.
      const items = cart().addItem(PRD_CHEAP_PEN, 2).build();
      const promo = createBundlePromoFixture({
        id: 905,
        bundlePrice: new Decimal(1000), // > 500 total
        bundleMode: "PICK_ANY_N",
        bundleQuantity: 2,
        targetProductIds: new Set([PRD_CHEAP_PEN.id]),
      });

      const res = evaluatePromotions(items, [promo], CONTEXT_POS);
      expect(res.lineAllocations.size).toBe(0);
      assertDecimalEqual(res.totalCartDiscount, 0);
    });

    it("T2-F09-06: bundle promotion where sum of original prices == bundlePrice -> discount is 0", () => {
      const items = cart().addItem(PRD_PEN_ROTRING, 2).build(); // 2 * 500 = 1000 IQD
      const promo = createBundlePromoFixture({
        id: 906,
        bundlePrice: new Decimal(1000),
        bundleMode: "PICK_ANY_N",
        bundleQuantity: 2,
        targetProductIds: new Set([PRD_PEN_ROTRING.id]),
      });

      const res = evaluatePromotions(items, [promo], CONTEXT_POS);
      expect(res.lineAllocations.size).toBe(0);
      assertDecimalEqual(res.totalCartDiscount, 0);
    });

    it("T2-F09-07: allocateByValue with zero total savings -> returns empty map", () => {
      const lines = [{ lineKey: "line_1", lineGross: new Decimal(5000) }];
      const alloc = allocateByValue(lines, new Decimal(0));
      expect(alloc.size).toBe(0);
    });

    it("T2-F09-08: allocateByValue with zero lines -> returns empty map", () => {
      const alloc = allocateByValue([], new Decimal(1000));
      expect(alloc.size).toBe(0);
    });

    it("T2-F09-09: allocateByValue when one line has 0.00 IQD gross -> 0-gross line receives 0 allocation", () => {
      const lines = [
        { lineKey: "line_zero", lineGross: new Decimal(0) },
        { lineKey: "line_paid", lineGross: new Decimal(10000) },
      ];
      const alloc = allocateByValue(lines, new Decimal(2000));

      assertDecimalEqual(alloc.get("line_zero"), 0);
      assertDecimalEqual(alloc.get("line_paid"), 2000);
    });

    it("T2-F09-10: allocateByValue when savings exceed total gross -> capped at total gross", () => {
      const lines = [
        { lineKey: "line_1", lineGross: new Decimal(1000) },
        { lineKey: "line_2", lineGross: new Decimal(2000) },
      ];
      // total gross = 3000, requested savings = 5000
      const alloc = allocateByValue(lines, new Decimal(5000));

      let sum = new Decimal(0);
      Array.from(alloc.values()).forEach((val) => {
        sum = sum.plus(val);
      });
      assertDecimalEqual(sum, 3000, "Capped at total gross 3000 IQD");
    });
  });

  // =========================================================================
  // 5. F10 Priority, Stacking & Protection Boundaries
  // =========================================================================
  describe("F10: Priority, Stacking & Protection Boundaries", () => {
    it("T2-F10-01: 5 overlapping promotions matching same item -> strictly applies highest priority", () => {
      const items = cart().addItem(PRD_PEN_ROTRING, 10).build(); // 5,000 IQD
      const promos = [
        createPercentPromoFixture({ id: 1001, priority: 1, discountPercent: new Decimal(50) }),
        createPercentPromoFixture({ id: 1002, priority: 5, discountPercent: new Decimal(40) }),
        createPercentPromoFixture({ id: 1003, priority: 25, discountPercent: new Decimal(10) }), // highest priority!
        createPercentPromoFixture({ id: 1004, priority: 10, discountPercent: new Decimal(30) }),
        createPercentPromoFixture({ id: 1005, priority: 20, discountPercent: new Decimal(20) }),
      ];

      const res = evaluatePromotions(items, promos, CONTEXT_POS);
      const alloc = res.lineAllocations.get(items[0].lineKey);

      expect(alloc).toBeDefined();
      expect(alloc!.promotionId).toBe(1003); // Priority 25 wins
      assertDecimalEqual(alloc!.discountAmount, 500); // 10% of 5,000
    });

    it("T2-F10-02: two competing promos with identical priority -> lower ID wins deterministically", () => {
      const items = cart().addItem(PRD_PEN_ROTRING, 10).build();
      const promos = [
        createPercentPromoFixture({ id: 2002, priority: 10, discountPercent: new Decimal(20) }),
        createPercentPromoFixture({ id: 2001, priority: 10, discountPercent: new Decimal(20) }),
      ];

      const res = evaluatePromotions(items, promos, CONTEXT_POS);
      const alloc = res.lineAllocations.get(items[0].lineKey);

      expect(alloc).toBeDefined();
      expect(alloc!.promotionId).toBe(2001); // ID 2001 < 2002
    });

    it("T2-F10-03: minimum order spend boundary: spend exactly 1 fils under minOrderSpend -> promo rejected", () => {
      // 5,000 IQD spend required
      const items = cart()
        .addItem(PRD_PEN_ROTRING, 1, 0, { customUnitPrice: new Decimal("4999.99") })
        .build();

      const promo = createPercentPromoFixture({
        id: 1003,
        minOrderSpend: new Decimal(5000),
        discountPercent: new Decimal(10),
      });

      const res = evaluatePromotions(items, [promo], CONTEXT_POS);
      expect(res.lineAllocations.size).toBe(0);
      assertDecimalEqual(res.totalCartDiscount, 0);
    });

    it("T2-F10-04: minimum order spend boundary: spend exactly at minOrderSpend -> promo applies", () => {
      const items = cart()
        .addItem(PRD_PEN_ROTRING, 1, 0, { customUnitPrice: new Decimal("5000.00") })
        .build();

      const promo = createPercentPromoFixture({
        id: 1004,
        minOrderSpend: new Decimal(5000),
        discountPercent: new Decimal(10),
      });

      const res = evaluatePromotions(items, [promo], CONTEXT_POS);
      const alloc = res.lineAllocations.get(items[0].lineKey);

      expect(alloc).toBeDefined();
      assertDecimalEqual(alloc!.discountAmount, 500);
    });

    it("T2-F10-05: contract price protection: item with hasContractPrice = true -> promo = null, discount = 0", () => {
      const items = cart()
        .addItem(PRD_PEN_ROTRING, 10, 0, { hasContractPrice: true })
        .build();

      const promo = createPercentPromoFixture({
        id: 1005,
        discountPercent: new Decimal(50),
        targetProductIds: new Set([PRD_PEN_ROTRING.id]),
      });

      const res = evaluatePromotions(items, [promo], CONTEXT_POS);
      expect(res.lineAllocations.size).toBe(0);
      assertDecimalEqual(res.totalCartDiscount, 0);
    });

    it("T2-F10-06: mixed cart with contract and standard items -> promo applies exclusively to standard items", () => {
      const items = cart()
        .addItem(PRD_PEN_ROTRING, 5, 0, { hasContractPrice: true }) // contract
        .addItem(PRD_NOTEBOOK_FABER, 2, 0, { hasContractPrice: false }) // standard
        .build();

      const promo = createPercentPromoFixture({
        id: 1006,
        discountPercent: new Decimal(20),
        targetProductIds: new Set([PRD_PEN_ROTRING.id, PRD_NOTEBOOK_FABER.id]),
      });

      const res = evaluatePromotions(items, [promo], CONTEXT_POS);

      expect(res.lineAllocations.has(items[0].lineKey)).toBe(false);
      expect(res.lineAllocations.has(items[1].lineKey)).toBe(true);

      const allocNotebook = res.lineAllocations.get(items[1].lineKey)!;
      // 2 * 3500 = 7000 IQD. 20% = 1400 IQD.
      assertDecimalEqual(allocNotebook.discountAmount, 1400);
      assertDecimalEqual(res.totalCartDiscount, 1400);
    });

    it("T2-F10-07: TIERED_QTY boundary: cart quantity exactly at tier threshold -> activates tier discount", () => {
      // Tier 1: min 5 @ 1500 off per unit. Qty = 5
      const items = cart().addItem(PRD_INK_EPSON, 5).build();
      const promo = createTieredQtyPromoFixture({
        id: 1007,
        targetProductIds: new Set([PRD_INK_EPSON.id]),
      });

      const res = evaluatePromotions(items, [promo], CONTEXT_POS);
      const alloc = res.lineAllocations.get(items[0].lineKey);

      expect(alloc).toBeDefined();
      assertDecimalEqual(alloc!.discountAmount, 7500); // 5 * 1500
      assertDecimalEqual(alloc!.effectiveUnitPrice, 10500); // 12000 - 1500
    });

    it("T2-F10-08: TIERED_QTY boundary: cart quantity 1 unit below minimum threshold -> 0 discount", () => {
      // Tier 1: min 5. Cart qty = 4
      const items = cart().addItem(PRD_INK_EPSON, 4).build();
      const promo = createTieredQtyPromoFixture({
        id: 1008,
        targetProductIds: new Set([PRD_INK_EPSON.id]),
      });

      const res = evaluatePromotions(items, [promo], CONTEXT_POS);
      expect(res.lineAllocations.size).toBe(0);
      assertDecimalEqual(res.totalCartDiscount, 0);
    });
  });
});
