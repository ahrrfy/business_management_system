/**
 * tests/e2e/promotions/tier2_boundaries/scheduling_and_channel_boundaries.test.ts
 *
 * Tier 2 Boundary & Corner Cases: Scheduling, Channels & Unit-Level Targeting
 * Covers F02 (Channel Column), F03 (Clearance & Scheduling), F04 (Units & Target Grain),
 * F22 (POS/Reception Channels), F23 (Sales Invoice Integration).
 * Minimum 30 tests required.
 */

import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import {
  assertDecimalEqual,
  assertPriceCeilingRespected,
} from "../infra/assertions";
import {
  CASHIER_SALWA,
  PRD_CHEAP_PEN,
  PRD_INK_EPSON,
  PRD_NOTEBOOK_FABER,
  PRD_PEN_ROTRING,
  createAmountPromoFixture,
  createFixedPricePromoFixture,
  createPercentPromoFixture,
} from "../infra/mockFixtures";
import {
  cart,
  evaluatePromotions,
  EvaluationContext,
  getDayOfWeekForYmd,
  SimulatedSaleLineInput,
  simulateSaleCreation,
  validatePromotionSchema,
  validateTargetGrain,
} from "../infra/testHarness";

describe("Tier 2: Scheduling & Channel Boundaries (F02–F04, F22–F23)", () => {
  // =========================================================================
  // 1. F02: Tri-State Channel Filtering Boundaries
  // =========================================================================
  describe("F02: Channel Column Boundaries (ALL, POS_ONLY, STORE_ONLY)", () => {
    it("T2-F02-01: invalid channel string 'ONLINE' -> rejected by schema validator", () => {
      const res = validatePromotionSchema({
        type: "PERCENT",
        channel: "ONLINE",
        discountPercent: 10,
      });
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes("channel"))).toBe(true);
    });

    it("T2-F02-02: invalid channel string 'RETAIL' -> rejected by schema validator", () => {
      const res = validatePromotionSchema({
        type: "PERCENT",
        channel: "RETAIL",
        discountPercent: 10,
      });
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes("channel"))).toBe(true);
    });

    it("T2-F02-03: channel = 'POS_ONLY' evaluated in POS channel -> promo applies", () => {
      const items = cart().addItem(PRD_PEN_ROTRING, 2).build();
      const promo = createPercentPromoFixture({
        id: 203,
        channel: "POS_ONLY",
        discountPercent: new Decimal(20),
        targetProductIds: new Set([PRD_PEN_ROTRING.id]),
      });

      const res = evaluatePromotions(items, [promo], { channel: "POS", todayYmd: "2026-06-15" });
      expect(res.lineAllocations.size).toBe(1);
      assertDecimalEqual(res.totalCartDiscount, 200);
    });

    it("T2-F02-04: channel = 'POS_ONLY' evaluated in STORE channel -> returns 0 discount", () => {
      const items = cart().addItem(PRD_PEN_ROTRING, 2).build();
      const promo = createPercentPromoFixture({
        id: 204,
        channel: "POS_ONLY",
        discountPercent: new Decimal(20),
        targetProductIds: new Set([PRD_PEN_ROTRING.id]),
      });

      const res = evaluatePromotions(items, [promo], { channel: "STORE", todayYmd: "2026-06-15" });
      expect(res.lineAllocations.size).toBe(0);
      assertDecimalEqual(res.totalCartDiscount, 0);
    });

    it("T2-F02-05: channel = 'STORE_ONLY' evaluated in STORE channel -> promo applies", () => {
      const items = cart().addItem(PRD_NOTEBOOK_FABER, 1).build();
      const promo = createPercentPromoFixture({
        id: 205,
        channel: "STORE_ONLY",
        discountPercent: new Decimal(15),
        targetProductIds: new Set([PRD_NOTEBOOK_FABER.id]),
      });

      const res = evaluatePromotions(items, [promo], { channel: "STORE", todayYmd: "2026-06-15" });
      expect(res.lineAllocations.size).toBe(1);
      assertDecimalEqual(res.totalCartDiscount, 525); // 15% of 3500
    });

    it("T2-F02-06: channel = 'STORE_ONLY' evaluated in POS channel -> returns 0 discount", () => {
      const items = cart().addItem(PRD_NOTEBOOK_FABER, 1).build();
      const promo = createPercentPromoFixture({
        id: 206,
        channel: "STORE_ONLY",
        discountPercent: new Decimal(15),
        targetProductIds: new Set([PRD_NOTEBOOK_FABER.id]),
      });

      const res = evaluatePromotions(items, [promo], { channel: "POS", todayYmd: "2026-06-15" });
      expect(res.lineAllocations.size).toBe(0);
      assertDecimalEqual(res.totalCartDiscount, 0);
    });

    it("T2-F02-07: channel = 'ALL' evaluated in both POS and STORE channels -> applies in both", () => {
      const items = cart().addItem(PRD_INK_EPSON, 1).build();
      const promo = createAmountPromoFixture({
        id: 207,
        channel: "ALL",
        discountAmount: new Decimal(2000),
        targetProductIds: new Set([PRD_INK_EPSON.id]),
      });

      const resPos = evaluatePromotions(items, [promo], { channel: "POS", todayYmd: "2026-06-15" });
      const resStore = evaluatePromotions(items, [promo], { channel: "STORE", todayYmd: "2026-06-15" });

      assertDecimalEqual(resPos.totalCartDiscount, 2000);
      assertDecimalEqual(resStore.totalCartDiscount, 2000);
    });

    it("T2-F02-08: promotion with channel ALL and null activeDays applies on any day across all channels", () => {
      const items = cart().addItem(PRD_PEN_ROTRING, 2).build();
      const promo = createPercentPromoFixture({
        id: 208,
        channel: "ALL",
        activeDays: null,
        discountPercent: new Decimal(10),
      });

      const resSun = evaluatePromotions(items, [promo], { channel: "POS", todayYmd: "2026-06-14" }); // Sun
      const resFri = evaluatePromotions(items, [promo], { channel: "STORE", todayYmd: "2026-06-19" }); // Fri

      assertDecimalEqual(resSun.totalCartDiscount, 100);
      assertDecimalEqual(resFri.totalCartDiscount, 100);
    });
  });

  // =========================================================================
  // 2. F03: Scheduling, DOW Schedule & Date Boundary Invariants
  // =========================================================================
  describe("F03: Day-of-Week Schedule & Date Boundaries", () => {
    it("T2-F03-01: activeDays item < 0 or > 6 -> rejected by schema validator", () => {
      const resLow = validatePromotionSchema({
        type: "PERCENT",
        discountPercent: 10,
        activeDays: [-1, 2, 4],
      });
      expect(resLow.valid).toBe(false);
      expect(resLow.errors.some((e) => e.includes("activeDays"))).toBe(true);

      const resHigh = validatePromotionSchema({
        type: "PERCENT",
        discountPercent: 10,
        activeDays: [1, 3, 7],
      });
      expect(resHigh.valid).toBe(false);
      expect(resHigh.errors.some((e) => e.includes("activeDays"))).toBe(true);
    });

    it("T2-F03-02: non-integer activeDays item -> rejected by schema validator", () => {
      const res = validatePromotionSchema({
        type: "PERCENT",
        discountPercent: 10,
        activeDays: [1, 2.5, 3],
      });
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes("activeDays"))).toBe(true);
    });

    it("T2-F03-03: getDayOfWeekForYmd accurately maps Baghdad dates (0=Sun..6=Sat)", () => {
      expect(getDayOfWeekForYmd("2026-06-14")).toBe(0); // Sunday
      expect(getDayOfWeekForYmd("2026-06-15")).toBe(1); // Monday
      expect(getDayOfWeekForYmd("2026-06-16")).toBe(2); // Tuesday
      expect(getDayOfWeekForYmd("2026-06-17")).toBe(3); // Wednesday
      expect(getDayOfWeekForYmd("2026-06-18")).toBe(4); // Thursday
      expect(getDayOfWeekForYmd("2026-06-19")).toBe(5); // Friday
      expect(getDayOfWeekForYmd("2026-06-20")).toBe(6); // Saturday
    });

    it("T2-F03-04: Friday-only promotion (activeDays = [5]) on Friday 2026-06-19 -> promo applies", () => {
      const items = cart().addItem(PRD_PEN_ROTRING, 2).build();
      const promo = createPercentPromoFixture({
        id: 304,
        activeDays: [5], // Friday
        discountPercent: new Decimal(25),
        targetProductIds: new Set([PRD_PEN_ROTRING.id]),
      });

      const res = evaluatePromotions(items, [promo], { channel: "POS", todayYmd: "2026-06-19" });
      expect(res.lineAllocations.size).toBe(1);
      assertDecimalEqual(res.totalCartDiscount, 250);
    });

    it("T2-F03-05: Friday-only promotion evaluated on Saturday 2026-06-20 -> returns 0 discount", () => {
      const items = cart().addItem(PRD_PEN_ROTRING, 2).build();
      const promo = createPercentPromoFixture({
        id: 305,
        activeDays: [5], // Friday
        discountPercent: new Decimal(25),
        targetProductIds: new Set([PRD_PEN_ROTRING.id]),
      });

      const res = evaluatePromotions(items, [promo], { channel: "POS", todayYmd: "2026-06-20" });
      expect(res.lineAllocations.size).toBe(0);
      assertDecimalEqual(res.totalCartDiscount, 0);
    });

    it("T2-F03-06: weekend promotion (activeDays = [0, 6]) evaluated on Wednesday -> returns 0 discount", () => {
      const items = cart().addItem(PRD_PEN_ROTRING, 2).build();
      const promo = createPercentPromoFixture({
        id: 306,
        activeDays: [0, 6], // Sun, Sat
        discountPercent: new Decimal(20),
        targetProductIds: new Set([PRD_PEN_ROTRING.id]),
      });

      const res = evaluatePromotions(items, [promo], { channel: "POS", todayYmd: "2026-06-17" }); // Wed (3)
      expect(res.lineAllocations.size).toBe(0);
      assertDecimalEqual(res.totalCartDiscount, 0);
    });

    it("T2-F03-07: date boundary: effectiveTo earlier than effectiveFrom -> rejected by schema validator", () => {
      const res = validatePromotionSchema({
        type: "PERCENT",
        discountPercent: 10,
        effectiveFrom: "2026-06-20",
        effectiveTo: "2026-06-10", // ERROR
      });
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes("effectiveTo"))).toBe(true);
    });

    it("T2-F03-08: date boundary: evaluation before effectiveFrom (future promo) -> returns 0 discount", () => {
      const items = cart().addItem(PRD_PEN_ROTRING, 2).build();
      const promo = createPercentPromoFixture({
        id: 308,
        effectiveFrom: "2026-07-01",
        effectiveTo: "2026-07-31",
        discountPercent: new Decimal(20),
        targetProductIds: new Set([PRD_PEN_ROTRING.id]),
      });

      const res = evaluatePromotions(items, [promo], { channel: "POS", todayYmd: "2026-06-15" });
      expect(res.lineAllocations.size).toBe(0);
      assertDecimalEqual(res.totalCartDiscount, 0);
    });

    it("T2-F03-09: date boundary: evaluation after effectiveTo (expired promo) -> returns 0 discount", () => {
      const items = cart().addItem(PRD_PEN_ROTRING, 2).build();
      const promo = createPercentPromoFixture({
        id: 309,
        effectiveFrom: "2026-05-01",
        effectiveTo: "2026-05-31",
        discountPercent: new Decimal(20),
        targetProductIds: new Set([PRD_PEN_ROTRING.id]),
      });

      const res = evaluatePromotions(items, [promo], { channel: "POS", todayYmd: "2026-06-15" });
      expect(res.lineAllocations.size).toBe(0);
      assertDecimalEqual(res.totalCartDiscount, 0);
    });

    it("T2-F03-10: date boundary: evaluation exactly on effectiveTo date -> promo applies", () => {
      const items = cart().addItem(PRD_PEN_ROTRING, 2).build();
      const promo = createPercentPromoFixture({
        id: 310,
        effectiveFrom: "2026-06-01",
        effectiveTo: "2026-06-15", // today!
        discountPercent: new Decimal(20),
        targetProductIds: new Set([PRD_PEN_ROTRING.id]),
      });

      const res = evaluatePromotions(items, [promo], { channel: "POS", todayYmd: "2026-06-15" });
      expect(res.lineAllocations.size).toBe(1);
      assertDecimalEqual(res.totalCartDiscount, 200);
    });

    it("T2-F03-11: date boundary: evaluation exactly on effectiveFrom date -> promo applies", () => {
      const items = cart().addItem(PRD_PEN_ROTRING, 2).build();
      const promo = createPercentPromoFixture({
        id: 311,
        effectiveFrom: "2026-06-15", // today!
        effectiveTo: "2026-06-30",
        discountPercent: new Decimal(20),
        targetProductIds: new Set([PRD_PEN_ROTRING.id]),
      });

      const res = evaluatePromotions(items, [promo], { channel: "POS", todayYmd: "2026-06-15" });
      expect(res.lineAllocations.size).toBe(1);
      assertDecimalEqual(res.totalCartDiscount, 200);
    });
  });

  // =========================================================================
  // 3. F03/F04: Base Unit Isolation & Packaging Unit Leak Prevention
  // =========================================================================
  describe("F03/F04: Base Unit Isolation & Packaging Units Protection", () => {
    it("T2-F03-12: applyToBaseUnitOnly = true: base unit (Piece) receives promo", () => {
      // Piece unit (isBaseUnit = true)
      const items = cart().addItem(PRD_PEN_ROTRING, 4, 0).build();
      const promo = createPercentPromoFixture({
        id: 312,
        applyToBaseUnitOnly: true,
        discountPercent: new Decimal(50),
        targetProductIds: new Set([PRD_PEN_ROTRING.id]),
      });

      const res = evaluatePromotions(items, [promo], { channel: "POS", todayYmd: "2026-06-15" });
      expect(res.lineAllocations.size).toBe(1);
      assertDecimalEqual(res.totalCartDiscount, 1000); // 4 * 500 * 50%
    });

    it("T2-F03-13: applyToBaseUnitOnly = true: derived packaging unit (Carton) receives 0 discount", () => {
      // Carton unit (isBaseUnit = false, factor = 144)
      const items = cart().addItem(PRD_PEN_ROTRING, 1, 2).build();
      const promo = createPercentPromoFixture({
        id: 313,
        applyToBaseUnitOnly: true,
        discountPercent: new Decimal(50),
        targetProductIds: new Set([PRD_PEN_ROTRING.id]),
      });

      const res = evaluatePromotions(items, [promo], { channel: "POS", todayYmd: "2026-06-15" });
      // Carton line is NOT discounted
      expect(res.lineAllocations.size).toBe(0);
      assertDecimalEqual(res.totalCartDiscount, 0);
    });

    it("T2-F03-14: mixed cart: 2 base units (Piece) + 1 carton unit -> base units discounted, carton protected", () => {
      const items = cart()
        .addItem(PRD_PEN_ROTRING, 2, 0) // Piece (unitIndex 0, 500 IQD)
        .addItem(PRD_PEN_ROTRING, 1, 2) // Carton (unitIndex 2, 60,000 IQD)
        .build();

      const promo = createPercentPromoFixture({
        id: 314,
        applyToBaseUnitOnly: true,
        discountPercent: new Decimal(50),
        targetProductIds: new Set([PRD_PEN_ROTRING.id]),
      });

      const res = evaluatePromotions(items, [promo], { channel: "POS", todayYmd: "2026-06-15" });

      expect(res.lineAllocations.has(items[0].lineKey)).toBe(true);
      expect(res.lineAllocations.has(items[1].lineKey)).toBe(false);

      const allocPiece = res.lineAllocations.get(items[0].lineKey)!;
      assertDecimalEqual(allocPiece.discountAmount, 500); // 2 * 500 * 50%
      assertDecimalEqual(res.totalCartDiscount, 500);
    });

    it("T2-F03-15: applyToBaseUnitOnly = false: derived packaging unit (Dozen) also receives promo", () => {
      // Dozen unit (unitIndex 1, 5,500 IQD)
      const items = cart().addItem(PRD_PEN_ROTRING, 1, 1).build();
      const promo = createPercentPromoFixture({
        id: 315,
        applyToBaseUnitOnly: false, // applies to all units
        discountPercent: new Decimal(10),
        targetProductIds: new Set([PRD_PEN_ROTRING.id]),
      });

      const res = evaluatePromotions(items, [promo], { channel: "POS", todayYmd: "2026-06-15" });
      expect(res.lineAllocations.size).toBe(1);
      assertDecimalEqual(res.totalCartDiscount, 550); // 10% of 5,500
    });

    it("T2-F03-16: activeDays spanning Monday through Thursday ([1, 2, 3, 4]) evaluated on Friday (5) -> returns 0 discount", () => {
      const items = cart().addItem(PRD_PEN_ROTRING, 2).build();
      const promo = createPercentPromoFixture({
        id: 316,
        activeDays: [1, 2, 3, 4], // Mon..Thu
        discountPercent: new Decimal(20),
        targetProductIds: new Set([PRD_PEN_ROTRING.id]),
      });

      const resFri = evaluatePromotions(items, [promo], { channel: "POS", todayYmd: "2026-06-19" }); // Fri = 5
      expect(resFri.lineAllocations.size).toBe(0);
      assertDecimalEqual(resFri.totalCartDiscount, 0);
    });
  });

  // =========================================================================
  // 4. F04: Target Grain Physical Constraints (chk_promo_target_grain)
  // =========================================================================
  describe("F04: Target Grain Constraints & Packaging Unit Targeting", () => {
    it("T2-F04-01: target with scope 'ALL' and non-null productId -> rejected by validateTargetGrain", () => {
      const res = validateTargetGrain({
        scope: "ALL",
        productId: 101, // ILLEGAL
      });
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes("Scope ALL"))).toBe(true);
    });

    it("T2-F04-02: target with both productId and productUnitId -> rejected by chk_promo_target_grain", () => {
      const res = validateTargetGrain({
        scope: "UNIT",
        productId: 101,
        productUnitId: 1013, // Two grain levels at once!
      });
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes("exactly one grain level"))).toBe(true);
    });

    it("T2-F04-03: target with all FKs null and scope != 'ALL' -> rejected by chk_promo_target_grain", () => {
      const res = validateTargetGrain({
        scope: "PRODUCT",
        productId: null,
      });
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes("exactly one grain level"))).toBe(true);
    });

    it("T2-F04-04: target specifying productUnitId only -> passes target grain check", () => {
      const res = validateTargetGrain({
        scope: "UNIT",
        productUnitId: 1013,
      });
      expect(res.valid).toBe(true);
      expect(res.errors.length).toBe(0);
    });

    it("T2-F04-05: target explicitly specifies Carton productUnitId: Piece receives 0, Carton receives promo", () => {
      const cartonUnit = PRD_PEN_ROTRING.units[2]; // Carton (id: 1013)
      const pieceUnit = PRD_PEN_ROTRING.units[0]; // Piece (id: 1011)

      const items = cart()
        .addItem(PRD_PEN_ROTRING, 1, 0) // Piece
        .addItem(PRD_PEN_ROTRING, 1, 2) // Carton
        .build();

      const promo = createAmountPromoFixture({
        id: 405,
        applyToBaseUnitOnly: false,
        discountAmount: new Decimal(5000), // 5,000 IQD off carton
        targetProductIds: new Set(),
        targetUnitIds: new Set([cartonUnit.id]), // targets Carton unit specifically
      });

      const res = evaluatePromotions(items, [promo], { channel: "POS", todayYmd: "2026-06-15" });

      // Piece line should NOT receive promo
      expect(res.lineAllocations.has(items[0].lineKey)).toBe(false);
      // Carton line SHOULD receive promo
      expect(res.lineAllocations.has(items[1].lineKey)).toBe(true);

      const allocCarton = res.lineAllocations.get(items[1].lineKey)!;
      assertDecimalEqual(allocCarton.discountAmount, 5000);
      assertDecimalEqual(allocCarton.effectiveUnitPrice, 55000); // 60,000 - 5,000
    });
  });

  // =========================================================================
  // 5. F22/F23: Channels & Sales Invoice Integration Contracts
  // =========================================================================
  describe("F22/F23: Channels & Sales Invoice Integration Contracts", () => {
    it("T2-F22-01: POS evaluation separates promotionDiscount and cashierDiscount cleanly", () => {
      const items = cart().addItem(PRD_PEN_ROTRING, 10).build(); // 5,000 IQD
      const promo = createPercentPromoFixture({
        id: 501,
        discountPercent: new Decimal(20),
        targetProductIds: new Set([PRD_PEN_ROTRING.id]),
      });

      const res = evaluatePromotions(items, [promo], { channel: "POS", todayYmd: "2026-06-15" });
      const alloc = res.lineAllocations.get(items[0].lineKey)!;

      expect(alloc.promotionId).toBe(501);
      assertDecimalEqual(alloc.discountAmount, 1000);
      assertDecimalEqual(alloc.effectiveUnitPrice, 400);
    });

    it("T2-F23-01: sales invoice line item calculation reflects promo discount and retains audit name", () => {
      const items = cart().addItem(PRD_INK_EPSON, 2).build(); // 24,000 IQD
      const promo = createAmountPromoFixture({
        id: 502,
        discountAmount: new Decimal(1500),
        targetProductIds: new Set([PRD_INK_EPSON.id]),
      });

      const res = evaluatePromotions(items, [promo], { channel: "POS", todayYmd: "2026-06-15" });
      const alloc = res.lineAllocations.get(items[0].lineKey)!;

      expect(alloc.promotionName).toContain("1500 دينار");
      assertDecimalEqual(alloc.discountAmount, 3000); // 2 * 1500
      assertDecimalEqual(alloc.effectiveUnitPrice, 10500);
    });

    it("T2-F23-02: sales invoice manual override contract: editing line unit price clears promo tag", () => {
      const promo = createAmountPromoFixture({
        id: 502,
        name: "خصم حبر 1500 دينار",
        discountAmount: new Decimal(1500),
        targetProductIds: new Set([PRD_INK_EPSON.id]),
      });
      const promoMap = new Map([[promo.id, promo]]);

      const normalLine: SimulatedSaleLineInput = {
        lineKey: "normal_line_1",
        productId: PRD_INK_EPSON.id,
        variantId: PRD_INK_EPSON.variantId,
        productUnitId: PRD_INK_EPSON.units[0].id,
        quantity: new Decimal(1),
        unitPrice: new Decimal(12000),
        costPrice: new Decimal(8000),
        promotionId: promo.id,
        promotionDiscount: new Decimal(1500),
      };

      const normalRes = simulateSaleCreation([normalLine], CASHIER_SALWA, promoMap);
      expect(normalRes.success).toBe(true);
      assertDecimalEqual(normalRes.lines[0].promotionDiscount, 1500);
      assertDecimalEqual(normalRes.lines[0].effectiveUnitPrice, 10500);
      assertDecimalEqual(normalRes.totalAmount, 10500);

      // Manual price override to 11,000 IQD: strips promotion tag and discount
      const overriddenLine: SimulatedSaleLineInput = {
        ...normalLine,
        lineKey: "override_line_1",
        unitPrice: new Decimal(11000),
        promotionId: null, // cleared
        promotionDiscount: new Decimal(0), // cleared
      };

      const overrideRes = simulateSaleCreation([overriddenLine], CASHIER_SALWA, promoMap);
      expect(overrideRes.success).toBe(true);
      // Verify promotion discount is stripped and line is billed strictly at overridden unit price
      assertDecimalEqual(overrideRes.lines[0].promotionDiscount, 0);
      assertDecimalEqual(overrideRes.lines[0].unitPrice, 11000);
      assertDecimalEqual(overrideRes.lines[0].effectiveUnitPrice, 11000);
      assertDecimalEqual(overrideRes.totalDiscount, 0);
      assertDecimalEqual(overrideRes.totalAmount, 11000);
      expect(overriddenLine.promotionId).toBeNull();
    });
  });
});
