/**
 * tests/e2e/promotions/tier2_boundaries/below_cost_and_gates_boundaries.test.ts
 *
 * Tier 2 Boundary & Corner Cases: Below-Cost Sales, Manager H6 Gate & Digital Card Isolation
 * Covers F03 (allowBelowCost), F19 (H6 Gate Fix), F20 (Below-Cost Gate Exemption), F21 (Digital Cards Isolation).
 * Minimum 40 tests required.
 */

import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import {
  assertBelowCostAllowed,
  assertDecimalEqual,
  assertDigitalCardIsolation,
  assertH6GateBypassForPromo,
  assertNoGiftFlagOnPromoDiscount,
} from "../infra/assertions";
import {
  ADMIN_MUSTAFA,
  CARD_ASIA_5K,
  CARD_ZAIN_10K,
  CASHIER_AHMED,
  CASHIER_SALWA,
  MANAGER_HAIDER,
  PRD_CHEAP_PEN,
  PRD_CRYSTAL_SHIELD,
  PRD_GRAD_SASH,
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
  cart,
  evaluatePromotions,
  EvaluationContext,
  SimulatedSaleLineInput,
  simulateSaleCreation,
} from "../infra/testHarness";

const CONTEXT_POS: EvaluationContext = {
  channel: "POS",
  todayYmd: "2026-06-15",
};

describe("Tier 2: Below-Cost & Safety Gates Boundaries (F03, F19–F21)", () => {
  // =========================================================================
  // 1. F19: H6 Manager Gate Threshold Boundaries
  // =========================================================================
  describe("F19: H6 Manager Gate Threshold Boundaries", () => {
    it("T2-F19-01: admin promo 15.00% discount + 0% cashier discount -> passes H6 without manager authorization", () => {
      const line: SimulatedSaleLineInput = {
        lineKey: "l1",
        productId: PRD_PEN_ROTRING.id,
        variantId: PRD_PEN_ROTRING.variantId,
        productUnitId: PRD_PEN_ROTRING.units[0].id,
        quantity: new Decimal(10), // 10 * 500 = 5000 IQD
        unitPrice: new Decimal(500),
        costPrice: new Decimal(350),
        promotionId: 501,
        promotionDiscount: new Decimal(750), // 15% of 5000
        cashierDiscountAmount: new Decimal(0),
      };

      const promo = createPercentPromoFixture({ id: 501, discountPercent: new Decimal(15) });
      const promosMap = new Map([[501, promo]]);

      const res = simulateSaleCreation([line], CASHIER_SALWA, promosMap);
      expect(res.success).toBe(true);
      expect(res.priceOverride).toBe(false);

      const h6Check = assertH6GateBypassForPromo({
        quantity: line.quantity,
        listUnitPrice: line.unitPrice,
        promotionDiscount: line.promotionDiscount!,
        cashierDiscountAmount: line.cashierDiscountAmount,
      });
      expect(h6Check.passesWithoutManager).toBe(true);
      assertDecimalEqual(h6Check.cashierManualPercent, 0);
    });

    it("T2-F19-02: admin promo 15.01% discount + 0% cashier discount -> passes because cashier manual discount is 0", () => {
      const line: SimulatedSaleLineInput = {
        lineKey: "l1",
        productId: PRD_PEN_ROTRING.id,
        variantId: PRD_PEN_ROTRING.variantId,
        productUnitId: PRD_PEN_ROTRING.units[0].id,
        quantity: new Decimal(10),
        unitPrice: new Decimal(500),
        costPrice: new Decimal(350),
        promotionId: 502,
        promotionDiscount: new Decimal("750.50"), // 15.01%
        cashierDiscountAmount: new Decimal(0),
      };

      const promo = createPercentPromoFixture({ id: 502, discountPercent: new Decimal("15.01") });
      const promosMap = new Map([[502, promo]]);

      const res = simulateSaleCreation([line], CASHIER_SALWA, promosMap);
      expect(res.success).toBe(true);
    });

    it("T2-F19-03: admin clearance promo 80.00% discount + 0% cashier discount -> passes H6 without manager block", () => {
      const line: SimulatedSaleLineInput = {
        lineKey: "l1",
        productId: PRD_GRAD_SASH.id,
        variantId: PRD_GRAD_SASH.variantId,
        productUnitId: PRD_GRAD_SASH.units[0].id,
        quantity: new Decimal(1), // 15,000 IQD
        unitPrice: new Decimal(15000),
        costPrice: new Decimal(8500),
        promotionId: 503,
        promotionDiscount: new Decimal(12000), // 80% discount
        cashierDiscountAmount: new Decimal(0),
      };

      const promo = createPercentPromoFixture({
        id: 503,
        discountPercent: new Decimal(80),
        allowBelowCost: true,
      });
      const promosMap = new Map([[503, promo]]);

      const res = simulateSaleCreation([line], CASHIER_SALWA, promosMap);
      expect(res.success).toBe(true);
    });

    it("T2-F19-04: admin promo 20.00% + cashier adds 15.01% discount on net price -> rejected by H6 (FORBIDDEN)", () => {
      // Line gross = 10,000 IQD. Promo = 2,000 IQD. Net after promo = 8,000 IQD.
      // Cashier adds 1,200.80 IQD (15.01% of 8,000)
      const line: SimulatedSaleLineInput = {
        lineKey: "l1",
        productId: PRD_NOTEBOOK_FABER.id,
        variantId: PRD_NOTEBOOK_FABER.variantId,
        productUnitId: PRD_NOTEBOOK_FABER.units[0].id,
        quantity: new Decimal(2),
        unitPrice: new Decimal(5000),
        costPrice: new Decimal(2400),
        promotionId: 504,
        promotionDiscount: new Decimal(2000),
        cashierDiscountAmount: new Decimal("1200.80"), // > 15% of 8000
      };

      const promo = createPercentPromoFixture({ id: 504, discountPercent: new Decimal(20) });
      const promosMap = new Map([[504, promo]]);

      const res = simulateSaleCreation([line], CASHIER_SALWA, promosMap);
      expect(res.success).toBe(false);
      expect(res.errorCode).toBe("FORBIDDEN");
      expect(res.errorMessage).toContain("15٪");
    });

    it("T2-F19-05: cashier manual discount exactly 15.00% on net price -> passes H6 without manager block", () => {
      // Net after promo = 8,000 IQD. Cashier discount = 1,200.00 IQD (exactly 15.00%)
      const line: SimulatedSaleLineInput = {
        lineKey: "l1",
        productId: PRD_NOTEBOOK_FABER.id,
        variantId: PRD_NOTEBOOK_FABER.variantId,
        productUnitId: PRD_NOTEBOOK_FABER.units[0].id,
        quantity: new Decimal(2),
        unitPrice: new Decimal(5000),
        costPrice: new Decimal(2400),
        promotionId: 505,
        promotionDiscount: new Decimal(2000),
        cashierDiscountAmount: new Decimal(1200), // exactly 15%
      };

      const promo = createPercentPromoFixture({ id: 505, discountPercent: new Decimal(20) });
      const promosMap = new Map([[505, promo]]);

      const res = simulateSaleCreation([line], CASHIER_SALWA, promosMap);
      expect(res.success).toBe(true);
      assertDecimalEqual(res.totalDiscount, 3200); // 2000 + 1200
      assertDecimalEqual(res.totalAmount, 6800); // 10000 - 3200
    });

    it("T2-F19-06: cashier manual discount of 0.01 fils over 15% threshold -> triggers H6 rejection", () => {
      // Net after promo = 10,000 IQD. 15% = 1,500.00 IQD. Cashier discount = 1,500.01 IQD.
      const line: SimulatedSaleLineInput = {
        lineKey: "l1",
        productId: PRD_INK_EPSON.id,
        variantId: PRD_INK_EPSON.variantId,
        productUnitId: PRD_INK_EPSON.units[0].id,
        quantity: new Decimal(1),
        unitPrice: new Decimal(12000),
        costPrice: new Decimal(5000),
        promotionId: 506,
        promotionDiscount: new Decimal(2000), // net = 10,000
        cashierDiscountAmount: new Decimal("1500.01"), // 15.0001%
      };

      const promo = createPercentPromoFixture({ id: 506 });
      const promosMap = new Map([[506, promo]]);

      const res = simulateSaleCreation([line], CASHIER_SALWA, promosMap);
      expect(res.success).toBe(false);
      expect(res.errorCode).toBe("FORBIDDEN");
    });

    it("T2-F19-07: cashier manual discount of 0.01 fils under 15% threshold -> passes H6", () => {
      const line: SimulatedSaleLineInput = {
        lineKey: "l1",
        productId: PRD_INK_EPSON.id,
        variantId: PRD_INK_EPSON.variantId,
        productUnitId: PRD_INK_EPSON.units[0].id,
        quantity: new Decimal(1),
        unitPrice: new Decimal(12000),
        costPrice: new Decimal(5000), // Cost safe from below-cost gate
        promotionId: 507,
        promotionDiscount: new Decimal(2000), // net = 10,000
        cashierDiscountAmount: new Decimal("1499.99"), // 14.9999%
      };

      const promo = createPercentPromoFixture({ id: 507 });
      const promosMap = new Map([[507, promo]]);

      const res = simulateSaleCreation([line], CASHIER_SALWA, promosMap);
      expect(res.success).toBe(true);
    });

    it("T2-F19-08: branch manager applying 30% manual discount -> passes H6 because manager has 100% threshold", () => {
      const line: SimulatedSaleLineInput = {
        lineKey: "l1",
        productId: PRD_PEN_ROTRING.id,
        variantId: PRD_PEN_ROTRING.variantId,
        productUnitId: PRD_PEN_ROTRING.units[0].id,
        quantity: new Decimal(10),
        unitPrice: new Decimal(500),
        costPrice: new Decimal(300),
        promotionId: null,
        promotionDiscount: new Decimal(0),
        cashierDiscountAmount: new Decimal(1500), // 30% manual discount
      };

      const res = simulateSaleCreation([line], MANAGER_HAIDER, new Map());
      expect(res.success).toBe(true);
    });

    it("T2-F19-09: super admin applying 50% manual discount -> passes H6 without restriction", () => {
      const line: SimulatedSaleLineInput = {
        lineKey: "l1",
        productId: PRD_NOTEBOOK_FABER.id,
        variantId: PRD_NOTEBOOK_FABER.variantId,
        productUnitId: PRD_NOTEBOOK_FABER.units[0].id,
        quantity: new Decimal(1),
        unitPrice: new Decimal(3500),
        costPrice: new Decimal(1500),
        promotionId: null,
        promotionDiscount: new Decimal(0),
        cashierDiscountAmount: new Decimal(1750), // 50%
      };

      const res = simulateSaleCreation([line], ADMIN_MUSTAFA, new Map());
      expect(res.success).toBe(true);
    });

    it("T2-F19-10: multi-item cart where line 1 is within 15% and line 2 exceeds 15% -> sale rejected by H6", () => {
      const line1: SimulatedSaleLineInput = {
        lineKey: "l1",
        productId: PRD_PEN_ROTRING.id,
        variantId: PRD_PEN_ROTRING.variantId,
        productUnitId: PRD_PEN_ROTRING.units[0].id,
        quantity: new Decimal(10),
        unitPrice: new Decimal(500),
        costPrice: new Decimal(350),
        cashierDiscountAmount: new Decimal(500), // 10% (ok)
      };
      const line2: SimulatedSaleLineInput = {
        lineKey: "l2",
        productId: PRD_NOTEBOOK_FABER.id,
        variantId: PRD_NOTEBOOK_FABER.variantId,
        productUnitId: PRD_NOTEBOOK_FABER.units[0].id,
        quantity: new Decimal(1),
        unitPrice: new Decimal(3500),
        costPrice: new Decimal(2000),
        cashierDiscountAmount: new Decimal(700), // 20% (> 15% violation)
      };

      const res = simulateSaleCreation([line1, line2], CASHIER_SALWA, new Map());
      expect(res.success).toBe(false);
      expect(res.errorCode).toBe("FORBIDDEN");
    });

    it("T2-F19-11: reception clerk actor subject to exact same 15% H6 discount limit as sales cashier", () => {
      const line: SimulatedSaleLineInput = {
        lineKey: "l1",
        productId: PRD_PEN_ROTRING.id,
        variantId: PRD_PEN_ROTRING.variantId,
        productUnitId: PRD_PEN_ROTRING.units[0].id,
        quantity: new Decimal(10),
        unitPrice: new Decimal(500),
        costPrice: new Decimal(300),
        cashierDiscountAmount: new Decimal(800), // 16% manual discount (> 15%)
      };

      const res = simulateSaleCreation([line], CASHIER_AHMED, new Map());
      expect(res.success).toBe(false);
      expect(res.errorCode).toBe("FORBIDDEN");
    });

    it("T2-F19-12: cashier manual discount on 0 IQD net price -> 0 manual discount passes cleanly", () => {
      const line: SimulatedSaleLineInput = {
        lineKey: "l1",
        productId: PRD_PEN_ROTRING.id,
        variantId: PRD_PEN_ROTRING.variantId,
        productUnitId: PRD_PEN_ROTRING.units[0].id,
        quantity: new Decimal(2),
        unitPrice: new Decimal(500),
        costPrice: new Decimal(300),
        promotionId: 512,
        promotionDiscount: new Decimal(1000), // 100% off -> net = 0
        cashierDiscountAmount: new Decimal(0),
      };

      const promo = createPercentPromoFixture({ id: 512, discountPercent: new Decimal(100), allowBelowCost: true });
      const promosMap = new Map([[512, promo]]);

      const res = simulateSaleCreation([line], CASHIER_SALWA, promosMap);
      expect(res.success).toBe(true);
    });

    it("T2-F19-13: assertH6GateBypassForPromo calculates exact netPromoPrice and passesWithoutManager", () => {
      const check = assertH6GateBypassForPromo({
        quantity: new Decimal(4),
        listUnitPrice: new Decimal(10000),
        promotionDiscount: new Decimal(8000), // net = 32,000, price = 8,000
        cashierDiscountAmount: new Decimal(3200), // 10%
      });

      assertDecimalEqual(check.netPromoPrice, 8000);
      assertDecimalEqual(check.cashierManualPercent, 10);
      expect(check.passesWithoutManager).toBe(true);
    });

    it("T2-F19-14: assertH6GateBypassForPromo flags violation when cashierManualPercent > 15", () => {
      const check = assertH6GateBypassForPromo({
        quantity: new Decimal(1),
        listUnitPrice: new Decimal(10000),
        promotionDiscount: new Decimal(2000), // net = 8000
        cashierDiscountAmount: new Decimal(1600), // 20%
      });

      assertDecimalEqual(check.cashierManualPercent, 20);
      expect(check.passesWithoutManager).toBe(false);
    });

    it("T2-F19-15: cashier manual discount on multiple items evaluated independently per line", () => {
      // Line 1: net 10,000, manual discount 1,000 (10% <= 15% - ok)
      // Line 2: net 5,000, manual discount 750 (15% <= 15% - ok)
      const line1: SimulatedSaleLineInput = {
        lineKey: "l1",
        productId: PRD_NOTEBOOK_FABER.id,
        variantId: PRD_NOTEBOOK_FABER.variantId,
        productUnitId: PRD_NOTEBOOK_FABER.units[0].id,
        quantity: new Decimal(2),
        unitPrice: new Decimal(5000),
        costPrice: new Decimal(2000),
        cashierDiscountAmount: new Decimal(1000),
      };
      const line2: SimulatedSaleLineInput = {
        lineKey: "l2",
        productId: PRD_PEN_ROTRING.id,
        variantId: PRD_PEN_ROTRING.variantId,
        productUnitId: PRD_PEN_ROTRING.units[0].id,
        quantity: new Decimal(10),
        unitPrice: new Decimal(500),
        costPrice: new Decimal(200),
        cashierDiscountAmount: new Decimal(750),
      };

      const res = simulateSaleCreation([line1, line2], CASHIER_SALWA, new Map());
      expect(res.success).toBe(true);
      assertDecimalEqual(res.totalDiscount, 1750);
    });
  });

  // =========================================================================
  // 2. F20: Below-Cost Gate & Clearance Exemption Boundaries
  // =========================================================================
  describe("F20: Below-Cost Gate & Clearance Exemption Boundaries", () => {
    it("T2-F20-01: promo price = 9,999.99 IQD on 10,000 IQD cost (0.01 fils below cost), allowBelowCost = false -> rejected", () => {
      const line: SimulatedSaleLineInput = {
        lineKey: "l1",
        productId: PRD_INK_EPSON.id,
        variantId: PRD_INK_EPSON.variantId,
        productUnitId: PRD_INK_EPSON.units[0].id,
        quantity: new Decimal(1),
        unitPrice: new Decimal(12000),
        costPrice: new Decimal(10000),
        promotionId: 601,
        promotionDiscount: new Decimal("2000.01"), // effective unit price = 9,999.99
      };

      const promo = createAmountPromoFixture({
        id: 601,
        allowBelowCost: false, // NOT permitted
      });
      const promosMap = new Map([[601, promo]]);

      const res = simulateSaleCreation([line], CASHIER_SALWA, promosMap);
      expect(res.success).toBe(false);
      expect(res.errorCode).toBe("FORBIDDEN");
      expect(res.errorMessage).toContain("أقل من التكلفة");
    });

    it("T2-F20-02: promo price = 9,999.99 IQD on 10,000 IQD cost, allowBelowCost = true -> passes with priceOverride = true", () => {
      const line: SimulatedSaleLineInput = {
        lineKey: "l1",
        productId: PRD_INK_EPSON.id,
        variantId: PRD_INK_EPSON.variantId,
        productUnitId: PRD_INK_EPSON.units[0].id,
        quantity: new Decimal(1),
        unitPrice: new Decimal(12000),
        costPrice: new Decimal(10000),
        promotionId: 602,
        promotionDiscount: new Decimal("2000.01"),
      };

      const promo = createAmountPromoFixture({
        id: 602,
        allowBelowCost: true, // EXEMPT
      });
      const promosMap = new Map([[602, promo]]);

      const res = simulateSaleCreation([line], CASHIER_SALWA, promosMap);
      expect(res.success).toBe(true);
      expect(res.priceOverride).toBe(true);
      expect(res.lines[0].isBelowCost).toBe(true);

      const check = assertBelowCostAllowed(
        { costPrice: line.costPrice, effectiveUnitPrice: res.lines[0].effectiveUnitPrice },
        promo
      );
      expect(check.isBelowCost).toBe(true);
      expect(check.isAllowed).toBe(true);
    });

    it("T2-F20-03: clearance 100% off (promo price = 0.00 IQD), allowBelowCost = true -> passes with priceOverride = true", () => {
      const line: SimulatedSaleLineInput = {
        lineKey: "l1",
        productId: PRD_PEN_ROTRING.id,
        variantId: PRD_PEN_ROTRING.variantId,
        productUnitId: PRD_PEN_ROTRING.units[0].id,
        quantity: new Decimal(5),
        unitPrice: new Decimal(500),
        costPrice: new Decimal(350),
        promotionId: 603,
        promotionDiscount: new Decimal(2500), // 100% discount
      };

      const promo = createPercentPromoFixture({
        id: 603,
        discountPercent: new Decimal(100),
        allowBelowCost: true,
      });
      const promosMap = new Map([[603, promo]]);

      const res = simulateSaleCreation([line], CASHIER_SALWA, promosMap);
      expect(res.success).toBe(true);
      expect(res.priceOverride).toBe(true);
      assertDecimalEqual(res.totalAmount, 0);
    });

    it("T2-F20-04: clearance 100% off (promo price = 0.00 IQD), allowBelowCost = false -> rejected by below-cost gate", () => {
      const line: SimulatedSaleLineInput = {
        lineKey: "l1",
        productId: PRD_PEN_ROTRING.id,
        variantId: PRD_PEN_ROTRING.variantId,
        productUnitId: PRD_PEN_ROTRING.units[0].id,
        quantity: new Decimal(5),
        unitPrice: new Decimal(500),
        costPrice: new Decimal(350),
        promotionId: 604,
        promotionDiscount: new Decimal(2500),
      };

      const promo = createPercentPromoFixture({
        id: 604,
        discountPercent: new Decimal(100),
        allowBelowCost: false,
      });
      const promosMap = new Map([[604, promo]]);

      const res = simulateSaleCreation([line], CASHIER_SALWA, promosMap);
      expect(res.success).toBe(false);
      expect(res.errorCode).toBe("FORBIDDEN");
    });

    it("T2-F20-05: mixed cart: line 1 has high profit, line 2 is below cost with allowBelowCost = true -> sale succeeds", () => {
      const line1: SimulatedSaleLineInput = {
        lineKey: "l1",
        productId: PRD_CRYSTAL_SHIELD.id, // cost 14k, price 25k
        variantId: PRD_CRYSTAL_SHIELD.variantId,
        productUnitId: PRD_CRYSTAL_SHIELD.units[0].id,
        quantity: new Decimal(1),
        unitPrice: new Decimal(25000),
        costPrice: new Decimal(14000),
      };
      const line2: SimulatedSaleLineInput = {
        lineKey: "l2",
        productId: PRD_GRAD_SASH.id, // cost 8.5k, promo price 5k
        variantId: PRD_GRAD_SASH.variantId,
        productUnitId: PRD_GRAD_SASH.units[0].id,
        quantity: new Decimal(1),
        unitPrice: new Decimal(15000),
        costPrice: new Decimal(8500),
        promotionId: 605,
        promotionDiscount: new Decimal(10000), // net 5,000 < 8,500 cost
      };

      const promo = createFixedPricePromoFixture({
        id: 605,
        fixedPrice: new Decimal(5000),
        allowBelowCost: true,
      });
      const promosMap = new Map([[605, promo]]);

      const res = simulateSaleCreation([line1, line2], CASHIER_SALWA, promosMap);
      expect(res.success).toBe(true);
      expect(res.priceOverride).toBe(true);
    });

    it("T2-F20-06: mixed cart: line 1 has high profit, line 2 is below cost with allowBelowCost = false -> sale rejected", () => {
      const line1: SimulatedSaleLineInput = {
        lineKey: "l1",
        productId: PRD_CRYSTAL_SHIELD.id,
        variantId: PRD_CRYSTAL_SHIELD.variantId,
        productUnitId: PRD_CRYSTAL_SHIELD.units[0].id,
        quantity: new Decimal(1),
        unitPrice: new Decimal(25000),
        costPrice: new Decimal(14000),
      };
      const line2: SimulatedSaleLineInput = {
        lineKey: "l2",
        productId: PRD_GRAD_SASH.id,
        variantId: PRD_GRAD_SASH.variantId,
        productUnitId: PRD_GRAD_SASH.units[0].id,
        quantity: new Decimal(1),
        unitPrice: new Decimal(15000),
        costPrice: new Decimal(8500),
        promotionId: 606,
        promotionDiscount: new Decimal(10000), // net 5k < 8.5k
      };

      const promo = createFixedPricePromoFixture({
        id: 606,
        fixedPrice: new Decimal(5000),
        allowBelowCost: false, // NOT allowed
      });
      const promosMap = new Map([[606, promo]]);

      const res = simulateSaleCreation([line1, line2], CASHIER_SALWA, promosMap);
      expect(res.success).toBe(false);
      expect(res.errorCode).toBe("FORBIDDEN");
    });

    it("T2-F20-07: manager executing sale below cost with allowBelowCost = false -> passes because manager can override cost", () => {
      const line: SimulatedSaleLineInput = {
        lineKey: "l1",
        productId: PRD_GRAD_SASH.id,
        variantId: PRD_GRAD_SASH.variantId,
        productUnitId: PRD_GRAD_SASH.units[0].id,
        quantity: new Decimal(1),
        unitPrice: new Decimal(15000),
        costPrice: new Decimal(8500),
        promotionId: 607,
        promotionDiscount: new Decimal(10000),
      };

      const promo = createFixedPricePromoFixture({
        id: 607,
        allowBelowCost: false,
      });
      const promosMap = new Map([[607, promo]]);

      const res = simulateSaleCreation([line], MANAGER_HAIDER, promosMap);
      expect(res.success).toBe(true);
      expect(res.priceOverride).toBe(true);
    });

    it("T2-F20-08: effective price exactly equal to cost price -> isBelowCost is false, priceOverride is false", () => {
      const line: SimulatedSaleLineInput = {
        lineKey: "l1",
        productId: PRD_PEN_ROTRING.id,
        variantId: PRD_PEN_ROTRING.variantId,
        productUnitId: PRD_PEN_ROTRING.units[0].id,
        quantity: new Decimal(10), // 5,000 IQD gross
        unitPrice: new Decimal(500),
        costPrice: new Decimal(350), // 3,500 IQD total cost
        promotionId: 608,
        promotionDiscount: new Decimal(1500), // net = 3,500 IQD = exact cost!
      };

      const promo = createAmountPromoFixture({ id: 608, allowBelowCost: false });
      const promosMap = new Map([[608, promo]]);

      const res = simulateSaleCreation([line], CASHIER_SALWA, promosMap);
      expect(res.success).toBe(true);
      expect(res.priceOverride).toBe(false);
      expect(res.lines[0].isBelowCost).toBe(false);
    });

    it("T2-F20-09: consignment product sold below cost with allowBelowCost = true -> completes with audit override", () => {
      const line: SimulatedSaleLineInput = {
        lineKey: "l1",
        productId: PRD_INK_EPSON.id, // Consignment item
        variantId: PRD_INK_EPSON.variantId,
        productUnitId: PRD_INK_EPSON.units[0].id,
        quantity: new Decimal(1),
        unitPrice: new Decimal(12000),
        costPrice: new Decimal(9500),
        promotionId: 609,
        promotionDiscount: new Decimal(3000), // net 9,000 < 9,500
      };

      const promo = createAmountPromoFixture({ id: 609, allowBelowCost: true });
      const promosMap = new Map([[609, promo]]);

      const res = simulateSaleCreation([line], CASHIER_SALWA, promosMap);
      expect(res.success).toBe(true);
      expect(res.priceOverride).toBe(true);
    });

    it("T2-F20-10: product cost = 0.00 IQD -> never triggers below cost even with heavy discounts", () => {
      const line: SimulatedSaleLineInput = {
        lineKey: "l1",
        productId: PRD_PEN_ROTRING.id,
        variantId: PRD_PEN_ROTRING.variantId,
        productUnitId: PRD_PEN_ROTRING.units[0].id,
        quantity: new Decimal(1),
        unitPrice: new Decimal(500),
        costPrice: new Decimal(0), // zero cost
        promotionId: 610,
        promotionDiscount: new Decimal(490), // 10 IQD remaining
      };

      const promo = createAmountPromoFixture({ id: 610, allowBelowCost: false });
      const promosMap = new Map([[610, promo]]);

      const res = simulateSaleCreation([line], CASHIER_SALWA, promosMap);
      expect(res.success).toBe(true);
      expect(res.lines[0].isBelowCost).toBe(false);
    });

    it("T2-F20-11: costPrice = 1,000 IQD, effective price = 1,000.01 IQD -> passes without priceOverride", () => {
      const line: SimulatedSaleLineInput = {
        lineKey: "l1",
        productId: PRD_PEN_ROTRING.id,
        variantId: PRD_PEN_ROTRING.variantId,
        productUnitId: PRD_PEN_ROTRING.units[0].id,
        quantity: new Decimal(1),
        unitPrice: new Decimal(2000),
        costPrice: new Decimal(1000),
        promotionId: 611,
        promotionDiscount: new Decimal("999.99"), // net = 1000.01
      };

      const promo = createAmountPromoFixture({ id: 611, allowBelowCost: false });
      const promosMap = new Map([[611, promo]]);

      const res = simulateSaleCreation([line], CASHIER_SALWA, promosMap);
      expect(res.success).toBe(true);
      expect(res.lines[0].isBelowCost).toBe(false);
      expect(res.priceOverride).toBe(false);
    });

    it("T2-F20-12: assertBelowCostAllowed domain assertion correctly validates allowed and rejected conditions", () => {
      // 1. Below cost with allowBelowCost = true -> allowed
      const r1 = assertBelowCostAllowed(
        { costPrice: new Decimal(1000), effectiveUnitPrice: new Decimal(800) },
        { allowBelowCost: true }
      );
      expect(r1.isBelowCost).toBe(true);
      expect(r1.isAllowed).toBe(true);

      // 2. Above cost with allowBelowCost = false -> allowed
      const r2 = assertBelowCostAllowed(
        { costPrice: new Decimal(1000), effectiveUnitPrice: new Decimal(1200) },
        { allowBelowCost: false }
      );
      expect(r2.isBelowCost).toBe(false);
      expect(r2.isAllowed).toBe(true);
    });

    it("T2-F20-13: multiple clearance items where one allows below-cost and another prohibits -> sale fails if prohibited line is below cost", () => {
      const line1: SimulatedSaleLineInput = {
        lineKey: "l1",
        productId: PRD_GRAD_SASH.id,
        variantId: PRD_GRAD_SASH.variantId,
        productUnitId: PRD_GRAD_SASH.units[0].id,
        quantity: new Decimal(1),
        unitPrice: new Decimal(15000),
        costPrice: new Decimal(8500),
        promotionId: 820,
        promotionDiscount: new Decimal(10000), // net 5,000 < 8,500 (allowBelowCost = true)
      };
      const line2: SimulatedSaleLineInput = {
        lineKey: "l2",
        productId: PRD_INK_EPSON.id,
        variantId: PRD_INK_EPSON.variantId,
        productUnitId: PRD_INK_EPSON.units[0].id,
        quantity: new Decimal(1),
        unitPrice: new Decimal(12000),
        costPrice: new Decimal(9500),
        promotionId: 821,
        promotionDiscount: new Decimal(3000), // net 9,000 < 9,500 (allowBelowCost = false)
      };

      const promo1 = createFixedPricePromoFixture({ id: 820, allowBelowCost: true });
      const promo2 = createAmountPromoFixture({ id: 821, allowBelowCost: false });
      const promosMap = new Map([
        [820, promo1],
        [821, promo2],
      ]);

      const res = simulateSaleCreation([line1, line2], CASHIER_SALWA, promosMap);
      expect(res.success).toBe(false);
      expect(res.errorCode).toBe("FORBIDDEN");
    });

    it("T2-F20-14: promo price below cost with allowBelowCost = true passes when quantity is fractional", () => {
      const line: SimulatedSaleLineInput = {
        lineKey: "l1",
        productId: PRD_GRAD_SASH.id,
        variantId: PRD_GRAD_SASH.variantId,
        productUnitId: PRD_GRAD_SASH.units[0].id,
        quantity: new Decimal("1.5"),
        unitPrice: new Decimal(15000), // gross 22,500
        costPrice: new Decimal(8500), // total cost 12,750
        promotionId: 822,
        promotionDiscount: new Decimal(15000), // line total 7,500 -> effective unit price = 5,000 < 8,500
      };

      const promo = createFixedPricePromoFixture({ id: 822, allowBelowCost: true });
      const promosMap = new Map([[822, promo]]);

      const res = simulateSaleCreation([line], CASHIER_SALWA, promosMap);
      expect(res.success).toBe(true);
      expect(res.priceOverride).toBe(true);
      assertDecimalEqual(res.lines[0].effectiveUnitPrice, 5000);
    });
  });

  // =========================================================================
  // 3. F21: Digital Cards Line Isolation Boundaries
  // =========================================================================
  describe("F21: Digital Cards Line Isolation Boundaries", () => {
    it("T2-F21-01: mixed cart with 5 digital cards and 5 promo items -> all cards isolated, all regular items discounted", () => {
      const lines: SimulatedSaleLineInput[] = [];

      // 5 digital cards
      for (let i = 1; i <= 5; i++) {
        lines.push({
          lineKey: `card_${i}`,
          productId: CARD_ZAIN_10K.id,
          variantId: CARD_ZAIN_10K.id,
          productUnitId: CARD_ZAIN_10K.id,
          quantity: new Decimal(1),
          unitPrice: CARD_ZAIN_10K.retailPrice, // 10,000
          costPrice: CARD_ZAIN_10K.costPrice, // 9,600
          isDigitalCard: true,
          promotionId: null,
          promotionDiscount: new Decimal(0),
        });
      }

      // 5 regular items covered by promo
      for (let i = 1; i <= 5; i++) {
        lines.push({
          lineKey: `pen_${i}`,
          productId: PRD_PEN_ROTRING.id,
          variantId: PRD_PEN_ROTRING.variantId,
          productUnitId: PRD_PEN_ROTRING.units[0].id,
          quantity: new Decimal(1),
          unitPrice: new Decimal(500),
          costPrice: new Decimal(350),
          isDigitalCard: false,
          promotionId: 701,
          promotionDiscount: new Decimal(100), // 20% off 500 = 100
        });
      }

      const promo = createPercentPromoFixture({ id: 701, discountPercent: new Decimal(20) });
      const promosMap = new Map([[701, promo]]);

      const res = simulateSaleCreation(lines, CASHIER_SALWA, promosMap);
      expect(res.success).toBe(true);

      // Verify digital card lines received 0 discount
      for (let i = 0; i < 5; i++) {
        const cardLine = res.lines[i];
        assertDecimalEqual(cardLine.promotionDiscount, 0);
        assertDecimalEqual(cardLine.cashierDiscountAmount, 0);
        assertDecimalEqual(cardLine.effectiveUnitPrice, 10000);
      }

      // Verify regular items received promo discount
      for (let i = 5; i < 10; i++) {
        const penLine = res.lines[i];
        assertDecimalEqual(penLine.promotionDiscount, 100);
        assertDecimalEqual(penLine.effectiveUnitPrice, 400);
      }

      assertDecimalEqual(res.totalDiscount, 500); // 5 * 100
      assertDecimalEqual(res.totalAmount, 52000); // 50,000 (cards) + 2,000 (pens)

      assertDigitalCardIsolation(lines);
      assertNoGiftFlagOnPromoDiscount(res.lines);
    });

    it("T2-F21-02: attempt to apply promotionId on a digital card line -> rejected with BAD_REQUEST", () => {
      const line: SimulatedSaleLineInput = {
        lineKey: "card_1",
        productId: CARD_ASIA_5K.id,
        variantId: CARD_ASIA_5K.id,
        productUnitId: CARD_ASIA_5K.id,
        quantity: new Decimal(1),
        unitPrice: new Decimal(5000),
        costPrice: new Decimal(4800),
        isDigitalCard: true,
        promotionId: 702, // ILLEGAL promotion on digital card
        promotionDiscount: new Decimal(500),
      };

      const promo = createPercentPromoFixture({ id: 702 });
      const promosMap = new Map([[702, promo]]);

      const res = simulateSaleCreation([line], CASHIER_SALWA, promosMap);
      expect(res.success).toBe(false);
      expect(res.errorCode).toBe("BAD_REQUEST");
      expect(res.errorMessage).toContain("الكروت الرقمية");
    });

    it("T2-F21-03: attempt to apply promotionDiscount > 0 on digital card without promotionId -> rejected with BAD_REQUEST", () => {
      const line: SimulatedSaleLineInput = {
        lineKey: "card_1",
        productId: CARD_ZAIN_10K.id,
        variantId: CARD_ZAIN_10K.id,
        productUnitId: CARD_ZAIN_10K.id,
        quantity: new Decimal(1),
        unitPrice: new Decimal(10000),
        costPrice: new Decimal(9600),
        isDigitalCard: true,
        promotionDiscount: new Decimal(1000), // ILLEGAL promo discount
      };

      const res = simulateSaleCreation([line], CASHIER_SALWA, new Map());
      expect(res.success).toBe(false);
      expect(res.errorCode).toBe("BAD_REQUEST");
    });

    it("T2-F21-04: mixed cart: cashier adds manual discount to regular item only -> digital card remains full price", () => {
      const cardLine: SimulatedSaleLineInput = {
        lineKey: "card_1",
        productId: CARD_ZAIN_10K.id,
        variantId: CARD_ZAIN_10K.id,
        productUnitId: CARD_ZAIN_10K.id,
        quantity: new Decimal(1),
        unitPrice: new Decimal(10000),
        costPrice: new Decimal(9600),
        isDigitalCard: true,
      };
      const penLine: SimulatedSaleLineInput = {
        lineKey: "pen_1",
        productId: PRD_PEN_ROTRING.id,
        variantId: PRD_PEN_ROTRING.variantId,
        productUnitId: PRD_PEN_ROTRING.units[0].id,
        quantity: new Decimal(10),
        unitPrice: new Decimal(500),
        costPrice: new Decimal(350),
        promotionId: 704,
        promotionDiscount: new Decimal(500), // net = 4,500
        cashierDiscountAmount: new Decimal(450), // 10% manual
      };

      const promo = createPercentPromoFixture({ id: 704 });
      const promosMap = new Map([[704, promo]]);

      const res = simulateSaleCreation([cardLine, penLine], CASHIER_SALWA, promosMap);
      expect(res.success).toBe(true);

      const resCard = res.lines.find((l) => l.lineKey === "card_1")!;
      assertDecimalEqual(resCard.effectiveUnitPrice, 10000);
      assertDecimalEqual(resCard.promotionDiscount, 0);

      const resPen = res.lines.find((l) => l.lineKey === "pen_1")!;
      assertDecimalEqual(resPen.lineTotal, 4050); // 5000 - 500 - 450
    });

    it("T2-F21-05: digital card lines in processed sale have isGift = false", () => {
      const line: SimulatedSaleLineInput = {
        lineKey: "card_1",
        productId: CARD_ASIA_5K.id,
        variantId: CARD_ASIA_5K.id,
        productUnitId: CARD_ASIA_5K.id,
        quantity: new Decimal(2),
        unitPrice: new Decimal(5000),
        costPrice: new Decimal(4800),
        isDigitalCard: true,
      };

      const res = simulateSaleCreation([line], CASHIER_SALWA, new Map());
      expect(res.success).toBe(true);
      expect(res.lines[0].isGift).toBe(false);
    });

    it("T2-F21-06: digital card margin integrity is preserved: 10,000 retail vs 9,600 cost", () => {
      const line: SimulatedSaleLineInput = {
        lineKey: "card_1",
        productId: CARD_ZAIN_10K.id,
        variantId: CARD_ZAIN_10K.id,
        productUnitId: CARD_ZAIN_10K.id,
        quantity: new Decimal(1),
        unitPrice: CARD_ZAIN_10K.retailPrice,
        costPrice: CARD_ZAIN_10K.costPrice,
        isDigitalCard: true,
      };

      const res = simulateSaleCreation([line], CASHIER_SALWA, new Map());
      expect(res.success).toBe(true);
      expect(res.lines[0].isBelowCost).toBe(false);
      assertDecimalEqual(res.lines[0].effectiveUnitPrice, 10000);
    });

    it("T2-F21-07: pure digital card cart with attempted store-wide promotion -> receives 0 discount", () => {
      const items = cart()
        .addDigitalCard(CARD_ZAIN_10K, 2)
        .addDigitalCard(CARD_ASIA_5K, 1)
        .build();

      const promo = createPercentPromoFixture({
        id: 707,
        discountPercent: new Decimal(20),
        targetProductIds: new Set(), // store-wide
      });

      const res = evaluatePromotions(items, [promo], CONTEXT_POS);
      expect(res.totalCartDiscount.toNumber()).toBe(0);
      expect(res.lineAllocations.size).toBe(0);
    });

    it("T2-F21-08: BOGO promotion completely ignores digital cards when determining group size", () => {
      // 1 Notebook + 2 Digital cards (total 3 items). BOGO Buy 2 Get 1 Free needs 3 physical items.
      const items = cart()
        .addItem(PRD_NOTEBOOK_FABER, 1)
        .addDigitalCard(CARD_ZAIN_10K, 2)
        .build();

      const promo = createBogoPromoFixture({
        id: 708,
        bogoBuyQuantity: 2,
        bogoGetQuantity: 1,
      });

      const res = evaluatePromotions(items, [promo], CONTEXT_POS);
      // Group threshold of 3 not met because digital cards do not count
      expect(res.totalCartDiscount.toNumber()).toBe(0);
      expect(res.lineAllocations.size).toBe(0);
    });

    it("T2-F21-09: bundle promotion requires 3 products; digital card cannot substitute a missing physical product", () => {
      // Bundle requires Rotring Pen + Notebook + Crystal Shield
      // Cart contains: Rotring Pen + Notebook + Zain Card
      const items = cart()
        .addItem(PRD_PEN_ROTRING, 1)
        .addItem(PRD_NOTEBOOK_FABER, 1)
        .addDigitalCard(CARD_ZAIN_10K, 1)
        .build();

      const promo = createBundlePromoFixture({
        id: 709,
        targetProductIds: new Set([PRD_PEN_ROTRING.id, PRD_NOTEBOOK_FABER.id, PRD_CRYSTAL_SHIELD.id]),
        bundleMode: "ALL_REQUIRED",
      });

      const res = evaluatePromotions(items, [promo], CONTEXT_POS);
      expect(res.totalCartDiscount.toNumber()).toBe(0);
    });

    it("T2-F21-10: mixed cart with 100% promo regular item and full price digital card -> sale succeeds", () => {
      const cardLine: SimulatedSaleLineInput = {
        lineKey: "card_1",
        productId: CARD_ASIA_5K.id,
        variantId: CARD_ASIA_5K.id,
        productUnitId: CARD_ASIA_5K.id,
        quantity: new Decimal(1),
        unitPrice: new Decimal(5000),
        costPrice: new Decimal(4800),
        isDigitalCard: true,
      };
      const sampleLine: SimulatedSaleLineInput = {
        lineKey: "sample_1",
        productId: PRD_CHEAP_PEN.id,
        variantId: PRD_CHEAP_PEN.variantId,
        productUnitId: PRD_CHEAP_PEN.units[0].id,
        quantity: new Decimal(1),
        unitPrice: new Decimal(250),
        costPrice: new Decimal(150),
        promotionId: 710,
        promotionDiscount: new Decimal(250), // 100% free sample
      };

      const promo = createPercentPromoFixture({
        id: 710,
        discountPercent: new Decimal(100),
        allowBelowCost: true,
      });
      const promosMap = new Map([[710, promo]]);

      const res = simulateSaleCreation([cardLine, sampleLine], CASHIER_SALWA, promosMap);
      expect(res.success).toBe(true);
      assertDecimalEqual(res.totalAmount, 5000); // 5000 card + 0 sample
    });

    it("T2-F21-11: assertDigitalCardIsolation verifies lines correctly", () => {
      expect(() => {
        assertDigitalCardIsolation([
          {
            isDigitalCard: true,
            promotionId: 999, // VIOLATION
            promotionDiscount: new Decimal(100),
          },
        ]);
      }).toThrow();
    });

    it("T2-F21-12: assertNoGiftFlagOnPromoDiscount throws when promotional line has isGift = true", () => {
      expect(() => {
        assertNoGiftFlagOnPromoDiscount([
          {
            promotionDiscount: new Decimal(500),
            isGift: true, // VIOLATION
          },
        ]);
      }).toThrow();
    });

    it("T2-F21-13: cart with multiple digital cards and physical items where physical item receives fixed price promo -> cards strictly isolated", () => {
      const items = cart()
        .addDigitalCard(CARD_ZAIN_10K, 1)
        .addDigitalCard(CARD_ASIA_5K, 2)
        .addItem(PRD_LUX_PEN, 1) // 28,000 IQD
        .build();

      const promo = createFixedPricePromoFixture({
        id: 713,
        fixedPrice: new Decimal(5000),
        targetProductIds: new Set([PRD_LUX_PEN.id]),
      });

      const res = evaluatePromotions(items, [promo], CONTEXT_POS);

      // Only PRD_LUX_PEN gets promo
      expect(res.lineAllocations.size).toBe(1);
      const allocLux = res.lineAllocations.get(items[2].lineKey);
      expect(allocLux).toBeDefined();
      assertDecimalEqual(allocLux!.discountAmount, 23000); // 28k -> 5k

      // Verify digital cards have 0 discount
      expect(res.lineAllocations.has(items[0].lineKey)).toBe(false);
      expect(res.lineAllocations.has(items[1].lineKey)).toBe(false);
      assertDecimalEqual(res.totalCartDiscount, 23000);
    });
  });
});
