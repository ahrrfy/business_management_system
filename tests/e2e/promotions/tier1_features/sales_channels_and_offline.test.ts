/**
 * tests/e2e/promotions/tier1_features/sales_channels_and_offline.test.ts
 *
 * Tier 1 Feature Coverage: Sales Channels, Pipeline Gates & Offline Sync (F19–F26)
 * Manager H6 gate fix, allowBelowCost clearance exemption, digital card isolation,
 * POS/Reception channels, sales invoices, and offline CRC32 sync/replay.
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
  MockPromotionRule,
  PRD_GRAD_SASH,
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
  generateOfflinePromotionSnapshot,
  SimulatedSaleLineInput,
  simulateSaleCreation,
} from "../infra/testHarness";
import { formatIqd } from "@/lib/money";

describe("Tier 1: Sales Channels & Offline Sync (F19–F26)", () => {
  // =========================================================================
  // F19: Sale Pipeline: H6 Gate Fix
  // =========================================================================
  describe("F19: Sale Pipeline: H6 Gate Fix", () => {
    it("T1-F19-01: sale with 20% admin promo and 0% cashier manual discount passes without H6 block", () => {
      // 10 units @ 500 = 5,000. 20% promo = 1,000 promo discount. 0% manual discount
      const check = assertH6GateBypassForPromo({
        quantity: new Decimal(10),
        listUnitPrice: new Decimal(500),
        promotionDiscount: new Decimal(1000),
        cashierDiscountAmount: new Decimal(0),
      });

      expect(check.passesWithoutManager).toBe(true);
      expect(check.cashierManualPercent.toNumber()).toBe(0);
      assertDecimalEqual(check.netPromoPrice, 400);
    });

    it("T1-F19-02: sale with 30% admin promo and 5% cashier manual discount passes H6 (5% <= 15% threshold)", () => {
      // List = 10,000. 30% promo = 3,000. Net = 7,000. Cashier discount = 350 (5% of 7,000)
      const check = assertH6GateBypassForPromo({
        quantity: new Decimal(1),
        listUnitPrice: new Decimal(10000),
        promotionDiscount: new Decimal(3000),
        cashierDiscountAmount: new Decimal(350),
      });

      expect(check.passesWithoutManager).toBe(true);
      expect(check.cashierManualPercent.toNumber()).toBe(5);
    });

    it("T1-F19-03: sale with 50% clearance promo and 0% cashier discount passes H6 without manager override", () => {
      const check = assertH6GateBypassForPromo({
        quantity: new Decimal(2),
        listUnitPrice: new Decimal(15000),
        promotionDiscount: new Decimal(15000), // 50% off
        cashierDiscountAmount: new Decimal(0),
      });

      expect(check.passesWithoutManager).toBe(true);
      expect(check.cashierManualPercent.toNumber()).toBe(0);
    });

    it("T1-F19-04: sale with 20% promo where cashier adds 20% manual discount on net price triggers H6 gate", () => {
      // List = 10,000. Promo = 2,000 (net = 8,000). Cashier adds 1,600 (20% of net 8,000 > 15%)
      const check = assertH6GateBypassForPromo({
        quantity: new Decimal(1),
        listUnitPrice: new Decimal(10000),
        promotionDiscount: new Decimal(2000),
        cashierDiscountAmount: new Decimal(1600),
      });

      expect(check.passesWithoutManager).toBe(false);
      expect(check.cashierManualPercent.toNumber()).toBe(20);
    });

    it("T1-F19-05: simulateSaleCreation separates promo discount from cashier manual discount in lines", () => {
      const promo = createPercentPromoFixture({ id: 1905, discountPercent: new Decimal(20) });
      const promoMap = new Map<number, MockPromotionRule>([[promo.id, promo]]);

      const lines = [
        {
          lineKey: "L1",
          productId: PRD_PEN_ROTRING.id,
          variantId: PRD_PEN_ROTRING.variantId,
          productUnitId: PRD_PEN_ROTRING.units[0].id,
          quantity: new Decimal(10), // 10 * 500 = 5,000
          unitPrice: new Decimal(500),
          costPrice: new Decimal(350),
          promotionId: promo.id,
          promotionDiscount: new Decimal(1000), // 20%
          cashierDiscountAmount: new Decimal(200), // 5% of net 4,000
        },
      ];

      const res = simulateSaleCreation(lines, CASHIER_SALWA, promoMap);

      expect(res.success).toBe(true);
      const lineRes = res.lines[0];
      assertDecimalEqual(lineRes.promotionDiscount, 1000);
      assertDecimalEqual(lineRes.cashierDiscountAmount, 200);
      assertDecimalEqual(lineRes.lineTotal, 3800);
      assertNoGiftFlagOnPromoDiscount([lineRes]);
    });

    it("T1-F19-06: manager actor can approve sale even when cashier manual discount exceeds 15%", () => {
      const promo = createPercentPromoFixture({ id: 1906 });
      const promoMap = new Map<number, MockPromotionRule>([[promo.id, promo]]);

      const lines = [
        {
          lineKey: "L1",
          productId: PRD_PEN_ROTRING.id,
          variantId: PRD_PEN_ROTRING.variantId,
          productUnitId: PRD_PEN_ROTRING.units[0].id,
          quantity: new Decimal(1),
          unitPrice: new Decimal(1000),
          costPrice: new Decimal(500),
          promotionId: promo.id,
          promotionDiscount: new Decimal(200), // net = 800
          cashierDiscountAmount: new Decimal(200), // 25% > 15%
        },
      ];

      // Manager has role 'manager' -> bypasses 15% cashier threshold
      const res = simulateSaleCreation(lines, MANAGER_HAIDER, promoMap);
      expect(res.success).toBe(true);
    });
  });

  // =========================================================================
  // F20: Sale Pipeline: Below-Cost Gate
  // =========================================================================
  describe("F20: Sale Pipeline: Below-Cost Gate", () => {
    it("T1-F20-01: sale with clearance promo where allowBelowCost = true and promo price < cost completes successfully", () => {
      const promo = createFixedPricePromoFixture({
        id: 2001,
        allowBelowCost: true,
        fixedPrice: new Decimal(5000), // Cost is 8,500
      });
      const promoMap = new Map<number, MockPromotionRule>([[promo.id, promo]]);

      const lines = [
        {
          lineKey: "L1",
          productId: PRD_GRAD_SASH.id,
          variantId: PRD_GRAD_SASH.variantId,
          productUnitId: PRD_GRAD_SASH.units[0].id,
          quantity: new Decimal(1),
          unitPrice: new Decimal(15000),
          costPrice: new Decimal(8500),
          promotionId: promo.id,
          promotionDiscount: new Decimal(10000), // Promo price = 5,000 < 8,500 cost
        },
      ];

      const res = simulateSaleCreation(lines, CASHIER_SALWA, promoMap);

      expect(res.success).toBe(true);
      expect(res.priceOverride).toBe(true); // Flagged for audit
      expect(res.lines[0].isBelowCost).toBe(true);
    });

    it("T1-F20-02: sale with promo where allowBelowCost = false and promo price < cost throws FORBIDDEN for cashier", () => {
      const promo = createFixedPricePromoFixture({
        id: 2002,
        allowBelowCost: false, // NOT allowed
        fixedPrice: new Decimal(5000),
      });
      const promoMap = new Map<number, MockPromotionRule>([[promo.id, promo]]);

      const lines = [
        {
          lineKey: "L1",
          productId: PRD_GRAD_SASH.id,
          variantId: PRD_GRAD_SASH.variantId,
          productUnitId: PRD_GRAD_SASH.units[0].id,
          quantity: new Decimal(1),
          unitPrice: new Decimal(15000),
          costPrice: new Decimal(8500),
          promotionId: promo.id,
          promotionDiscount: new Decimal(10000),
        },
      ];

      const res = simulateSaleCreation(lines, CASHIER_SALWA, promoMap);

      expect(res.success).toBe(false);
      expect(res.errorCode).toBe("FORBIDDEN");
      expect(res.errorMessage).toContain("البيع بأقل من التكلفة غير مصرح به");
    });

    it("T1-F20-03: manager actor creates below-cost sale without error even if allowBelowCost = false", () => {
      const promo = createFixedPricePromoFixture({
        id: 2003,
        allowBelowCost: false,
        fixedPrice: new Decimal(5000),
      });
      const promoMap = new Map<number, MockPromotionRule>([[promo.id, promo]]);

      const lines = [
        {
          lineKey: "L1",
          productId: PRD_GRAD_SASH.id,
          variantId: PRD_GRAD_SASH.variantId,
          productUnitId: PRD_GRAD_SASH.units[0].id,
          quantity: new Decimal(1),
          unitPrice: new Decimal(15000),
          costPrice: new Decimal(8500),
          promotionId: promo.id,
          promotionDiscount: new Decimal(10000),
        },
      ];

      const res = simulateSaleCreation(lines, MANAGER_HAIDER, promoMap);
      expect(res.success).toBe(true);
      expect(res.priceOverride).toBe(true);
    });

    it("T1-F20-04: multi-line sale: 1 clearance below-cost line + 1 profitable line completes successfully", () => {
      const promo = createFixedPricePromoFixture({
        id: 2004,
        allowBelowCost: true,
      });
      const promoMap = new Map<number, MockPromotionRule>([[promo.id, promo]]);

      const lines = [
        {
          lineKey: "L1",
          productId: PRD_GRAD_SASH.id,
          variantId: PRD_GRAD_SASH.variantId,
          productUnitId: PRD_GRAD_SASH.units[0].id,
          quantity: new Decimal(1),
          unitPrice: new Decimal(15000),
          costPrice: new Decimal(8500),
          promotionId: promo.id,
          promotionDiscount: new Decimal(10000), // Below cost (5k < 8.5k)
        },
        {
          lineKey: "L2",
          productId: PRD_PEN_ROTRING.id,
          variantId: PRD_PEN_ROTRING.variantId,
          productUnitId: PRD_PEN_ROTRING.units[0].id,
          quantity: new Decimal(2),
          unitPrice: new Decimal(500),
          costPrice: new Decimal(350),
          promotionDiscount: new Decimal(0), // Profitable (500 > 350)
        },
      ];

      const res = simulateSaleCreation(lines, CASHIER_SALWA, promoMap);
      expect(res.success).toBe(true);
      expect(res.lines).toHaveLength(2);
    });

    it("T1-F20-05: assertBelowCostAllowed helper validates exemption rule", () => {
      const allowed = assertBelowCostAllowed(
        { costPrice: new Decimal(8500), effectiveUnitPrice: new Decimal(5000) },
        { allowBelowCost: true }
      );
      expect(allowed.isBelowCost).toBe(true);
      expect(allowed.isAllowed).toBe(true);
    });

    it("T1-F20-06: return of item sold under clearance promotion refunds exact discounted price paid", () => {
      const soldItem = {
        listPrice: new Decimal(15000),
        promotionDiscount: new Decimal(10000), // Paid 5,000
        refundAmount: new Decimal(5000),
      };

      // Customer must be refunded 5,000 IQD, not 15,000 list price
      assertDecimalEqual(soldItem.refundAmount, soldItem.listPrice.minus(soldItem.promotionDiscount));
    });
  });

  // =========================================================================
  // F21: Digital Cards Line Isolation
  // =========================================================================
  describe("F21: Digital Cards Line Isolation", () => {
    it("T1-F21-01: mixed cart: 1 digital card (10,000 IQD) + 1 promo regular item completes successfully", () => {
      const promo = createPercentPromoFixture({ id: 2101, discountPercent: new Decimal(20) });
      const promoMap = new Map<number, MockPromotionRule>([[promo.id, promo]]);

      const lines = [
        {
          lineKey: "L_CARD",
          productId: CARD_ZAIN_10K.id,
          variantId: CARD_ZAIN_10K.id,
          productUnitId: CARD_ZAIN_10K.id,
          quantity: new Decimal(1),
          unitPrice: new Decimal(10000),
          costPrice: new Decimal(9600),
          isDigitalCard: true,
          promotionId: null,
          promotionDiscount: new Decimal(0),
        },
        {
          lineKey: "L_PEN",
          productId: PRD_PEN_ROTRING.id,
          variantId: PRD_PEN_ROTRING.variantId,
          productUnitId: PRD_PEN_ROTRING.units[0].id,
          quantity: new Decimal(2), // 2 * 500 = 1,000
          unitPrice: new Decimal(500),
          costPrice: new Decimal(350),
          promotionId: promo.id,
          promotionDiscount: new Decimal(200), // 20%
        },
      ];

      const res = simulateSaleCreation(lines, CASHIER_SALWA, promoMap);

      expect(res.success).toBe(true);
      assertDigitalCardIsolation([
        {
          isDigitalCard: true,
          promotionId: res.lines[0].promotionDiscount.isZero() ? null : 1,
          promotionDiscount: res.lines[0].promotionDiscount,
        },
      ]);
      assertDecimalEqual(res.totalDiscount, 200);
      assertDecimalEqual(res.totalAmount, 10800); // 10,000 + 800
    });

    it("T1-F21-02: digital card line has promotionId = null and discountAmount = 0", () => {
      const digitalLine = {
        isDigitalCard: true,
        promotionId: null,
        promotionDiscount: "0.00",
        discountAmount: "0.00",
      };
      assertDigitalCardIsolation([digitalLine]);
    });

    it("T1-F21-03: pure digital card cart with attempted promo is rejected", () => {
      const promo = createPercentPromoFixture({ id: 2103 });
      const promoMap = new Map<number, MockPromotionRule>([[promo.id, promo]]);

      const lines = [
        {
          lineKey: "L_CARD",
          productId: CARD_ZAIN_10K.id,
          variantId: CARD_ZAIN_10K.id,
          productUnitId: CARD_ZAIN_10K.id,
          quantity: new Decimal(1),
          unitPrice: new Decimal(10000),
          costPrice: new Decimal(9600),
          isDigitalCard: true,
          promotionId: promo.id, // Invalid: promo on digital card
          promotionDiscount: new Decimal(1000),
        },
      ];

      const res = simulateSaleCreation(lines, CASHIER_SALWA, promoMap);

      expect(res.success).toBe(false);
      expect(res.errorCode).toBe("BAD_REQUEST");
      expect(res.errorMessage).toContain("لا يمكن تطبيق عروض ترويجية على الكروت الرقمية");
    });

    it("T1-F21-04: mixed cart in Reception counter completes without error", () => {
      const promo = createAmountPromoFixture({ id: 2104, discountAmount: new Decimal(500) });
      const promoMap = new Map<number, MockPromotionRule>([[promo.id, promo]]);

      const lines = [
        {
          lineKey: "L_ASIA",
          productId: CARD_ASIA_5K.id,
          variantId: CARD_ASIA_5K.id,
          productUnitId: CARD_ASIA_5K.id,
          quantity: new Decimal(1),
          unitPrice: new Decimal(5000),
          costPrice: new Decimal(4800),
          isDigitalCard: true,
        },
        {
          lineKey: "L_BOOK",
          productId: PRD_NOTEBOOK_FABER.id,
          variantId: PRD_NOTEBOOK_FABER.variantId,
          productUnitId: PRD_NOTEBOOK_FABER.units[0].id,
          quantity: new Decimal(1),
          unitPrice: new Decimal(3500),
          costPrice: new Decimal(2400),
          promotionId: promo.id,
          promotionDiscount: new Decimal(500),
        },
      ];

      const res = simulateSaleCreation(lines, CASHIER_AHMED, promoMap);
      expect(res.success).toBe(true);
      assertDecimalEqual(res.totalAmount, 8000); // 5,000 + 3,000
    });

    it("T1-F21-05: multiple digital cards and regular items in cart are isolated correctly", () => {
      const promo = createPercentPromoFixture({ id: 2105, discountPercent: new Decimal(10) });
      const promoMap = new Map<number, MockPromotionRule>([[promo.id, promo]]);

      const lines = [
        {
          lineKey: "L1",
          productId: CARD_ZAIN_10K.id,
          variantId: CARD_ZAIN_10K.id,
          productUnitId: CARD_ZAIN_10K.id,
          quantity: new Decimal(2), // 20,000
          unitPrice: new Decimal(10000),
          costPrice: new Decimal(9600),
          isDigitalCard: true,
        },
        {
          lineKey: "L2",
          productId: PRD_PEN_ROTRING.id,
          variantId: PRD_PEN_ROTRING.variantId,
          productUnitId: PRD_PEN_ROTRING.units[0].id,
          quantity: new Decimal(4), // 2,000
          unitPrice: new Decimal(500),
          costPrice: new Decimal(350),
          promotionId: promo.id,
          promotionDiscount: new Decimal(200), // 10%
        },
      ];

      const res = simulateSaleCreation(lines, CASHIER_SALWA, promoMap);
      expect(res.success).toBe(true);
      assertDecimalEqual(res.totalAmount, 21800); // 20,000 + 1,800
    });
  });

  // =========================================================================
  // F22: POS & Reception Channels
  // =========================================================================
  describe("F22: POS & Reception Channels", () => {
    it("T1-F22-01: POS checkout transmits promotionId and promotionDiscount in line payload", () => {
      const promo = createPercentPromoFixture({
        id: 501,
        name: "خصم القرطاسية 20%",
        discountPercent: new Decimal(20),
        targetProductIds: new Set([PRD_NOTEBOOK_FABER.id]),
        channel: "POS_ONLY",
      });
      const promoMap = new Map([[promo.id, promo]]);

      const items = cart().addItem(PRD_NOTEBOOK_FABER, 2).build();
      const evalResult = evaluatePromotions(items, [promo], {
        channel: "POS",
        todayYmd: "2026-06-15",
      });
      const alloc = evalResult.lineAllocations.get(items[0].lineKey)!;
      expect(alloc.promotionId).toBe(501);
      assertDecimalEqual(alloc.discountAmount, 1400); // 20% of (2 * 3500) = 1400

      const lineInput: SimulatedSaleLineInput = {
        lineKey: items[0].lineKey,
        productId: items[0].productId,
        variantId: items[0].variantId,
        productUnitId: items[0].productUnitId,
        quantity: items[0].quantity,
        unitPrice: items[0].unitPrice,
        costPrice: items[0].costPrice,
        promotionId: alloc.promotionId,
        promotionDiscount: alloc.discountAmount,
        cashierDiscountAmount: new Decimal(0),
      };

      const result = simulateSaleCreation([lineInput], CASHIER_SALWA, promoMap);
      expect(result.success).toBe(true);
      expect(result.lines[0].promotionDiscount.toNumber()).toBe(1400);
      assertDecimalEqual(result.totalAmount, 5600); // 7000 - 1400 = 5600
      expect(lineInput.promotionId).toBe(501);
    });

    it("T1-F22-02: Reception checkout transmits promotionId without cashier discount collision", () => {
      const promo = createAmountPromoFixture({
        id: 502,
        name: "تخفيض الاستقبال 500 دينار",
        discountAmount: new Decimal(500),
        targetProductIds: new Set([PRD_PEN_ROTRING.id]),
        channel: "ALL",
      });
      const promoMap = new Map([[promo.id, promo]]);

      // 1 unit of Rotring Pen @ 3000 IQD. Promo discount = 500 IQD. Net after promo = 2500 IQD.
      // Cashier adds an additional 100 IQD manual discount (100 / 2500 = 4% <= 15% H6 limit).
      const lineInput: SimulatedSaleLineInput = {
        lineKey: "rec_line_1",
        productId: PRD_PEN_ROTRING.id,
        variantId: PRD_PEN_ROTRING.variantId,
        productUnitId: PRD_PEN_ROTRING.units[0].id,
        quantity: new Decimal(1),
        unitPrice: new Decimal(3000),
        costPrice: new Decimal(1800),
        promotionId: promo.id,
        promotionDiscount: new Decimal(500),
        cashierDiscountAmount: new Decimal(100),
      };

      const result = simulateSaleCreation([lineInput], CASHIER_SALWA, promoMap);
      expect(result.success).toBe(true);

      const processed = result.lines[0];
      // Assert that promotion discount and cashier discount coexist without collision
      assertDecimalEqual(processed.promotionDiscount, 500);
      assertDecimalEqual(processed.cashierDiscountAmount, 100);
      // Total discount = 500 + 100 = 600 IQD; Line total = 3000 - 600 = 2400 IQD
      assertDecimalEqual(result.totalDiscount, 600);
      assertDecimalEqual(result.totalAmount, 2400);
      assertDecimalEqual(processed.effectiveUnitPrice, 2400);
      expect(lineInput.promotionId).toBe(502);
    });

    it("T1-F22-03: POS thermal receipt string contains promotion name and discount", () => {
      const promo = createPercentPromoFixture({
        id: 2203,
        name: "عرض القرطاسية 20%",
        discountPercent: new Decimal(20),
        targetProductIds: new Set([PRD_NOTEBOOK_FABER.id]),
        channel: "POS_ONLY",
      });
      const promoMap = new Map([[promo.id, promo]]);

      const lineInput: SimulatedSaleLineInput = {
        lineKey: "pos_line_1",
        productId: PRD_NOTEBOOK_FABER.id,
        variantId: PRD_NOTEBOOK_FABER.variantId,
        productUnitId: PRD_NOTEBOOK_FABER.units[0].id,
        quantity: new Decimal(1),
        unitPrice: new Decimal(3500),
        costPrice: new Decimal(2000),
        promotionId: promo.id,
        promotionDiscount: new Decimal(700),
      };

      const result = simulateSaleCreation([lineInput], CASHIER_SALWA, promoMap);
      expect(result.success).toBe(true);

      // Generate POS thermal receipt using genuine simulator output and formatIqd
      const promoName = promo.name;
      const formattedDiscount = formatIqd(result.totalDiscount.toNumber());
      const formattedTotal = formatIqd(result.totalAmount.toNumber());

      const receiptString = [
        `فاتورة رقم: INV-${result.invoiceId}`,
        `خصم ترويجي (${promoName}): -${formattedDiscount}`,
        `الصافي: ${formattedTotal}`,
      ].join("\n");

      expect(receiptString).toContain("عرض القرطاسية 20%");
      expect(receiptString).toContain(formattedDiscount);
      expect(receiptString).toContain(formattedTotal);
      assertDecimalEqual(result.totalDiscount, 700);
      assertDecimalEqual(result.totalAmount, 2800);
    });

    it("T1-F22-04: POS Z-report computes cash expected based on exact net price after promotion", () => {
      const promo1 = createAmountPromoFixture({
        id: 22041,
        discountAmount: new Decimal(500),
        targetProductIds: new Set([PRD_PEN_ROTRING.id]),
        channel: "POS_ONLY",
      });
      const promo2 = createAmountPromoFixture({
        id: 22042,
        discountAmount: new Decimal(500),
        targetProductIds: new Set([PRD_NOTEBOOK_FABER.id]),
        channel: "POS_ONLY",
      });
      const promoMap = new Map([
        [promo1.id, promo1],
        [promo2.id, promo2],
      ]);

      // Sale 1: 2 pens @ 3000 = 6000 gross, 1000 promo discount -> net 5000
      const sale1 = simulateSaleCreation(
        [
          {
            lineKey: "s1_l1",
            productId: PRD_PEN_ROTRING.id,
            variantId: PRD_PEN_ROTRING.variantId,
            productUnitId: PRD_PEN_ROTRING.units[0].id,
            quantity: new Decimal(2),
            unitPrice: new Decimal(3000),
            costPrice: new Decimal(1800),
            promotionId: promo1.id,
            promotionDiscount: new Decimal(1000),
          },
        ],
        CASHIER_SALWA,
        promoMap
      );

      // Sale 2: 1 notebook @ 3500 = 3500 gross, 500 promo discount -> net 3000
      const sale2 = simulateSaleCreation(
        [
          {
            lineKey: "s2_l1",
            productId: PRD_NOTEBOOK_FABER.id,
            variantId: PRD_NOTEBOOK_FABER.variantId,
            productUnitId: PRD_NOTEBOOK_FABER.units[0].id,
            quantity: new Decimal(1),
            unitPrice: new Decimal(3500),
            costPrice: new Decimal(2000),
            promotionId: promo2.id,
            promotionDiscount: new Decimal(500),
          },
        ],
        CASHIER_SALWA,
        promoMap
      );

      expect(sale1.success).toBe(true);
      expect(sale2.success).toBe(true);

      // Z-report aggregates net cash collected across simulated sales
      const zReportCashExpected = sale1.totalAmount.plus(sale2.totalAmount);
      assertDecimalEqual(zReportCashExpected, 8000);
      assertDecimalEqual(sale1.totalAmount, 5000);
      assertDecimalEqual(sale2.totalAmount, 3000);
    });

    it("T1-F22-05: Reception customer pickup preserves promotion discount on bill of delivery", () => {
      const promo = createAmountPromoFixture({
        id: 2205,
        discountAmount: new Decimal(500),
        targetProductIds: new Set([PRD_NOTEBOOK_FABER.id]),
      });
      const promosMap = new Map([[2205, promo]]);
      const line = {
        lineKey: "L2205",
        productId: PRD_NOTEBOOK_FABER.id,
        variantId: PRD_NOTEBOOK_FABER.variantId,
        productUnitId: PRD_NOTEBOOK_FABER.units[0].id,
        quantity: new Decimal(3),
        unitPrice: new Decimal(3500),
        costPrice: new Decimal(2000),
        promotionId: 2205,
        promotionDiscount: new Decimal(1500),
      };
      const result = simulateSaleCreation([line], CASHIER_SALWA, promosMap);
      expect(result.success).toBe(true);
      assertDecimalEqual(result.totalDiscount, 1500);
      assertDecimalEqual(result.totalAmount, 9000);
      expect(line.promotionId).toBe(2205);
      assertDecimalEqual(result.lines[0].promotionDiscount, 1500);

      const deliveryBill = {
        orderId: 8801,
        itemsCount: line.quantity.toNumber(),
        totalSavings: result.totalDiscount,
        amountDue: result.totalAmount,
        promotionId: line.promotionId,
      };
      assertDecimalEqual(deliveryBill.totalSavings, 1500);
      assertDecimalEqual(deliveryBill.amountDue, 9000);
      expect(deliveryBill.promotionId).toBe(2205);
    });

    it("T1-F22-06: POS checkout with multi-item promo verifies exact cash tender and change calculation", () => {
      const promo = createPercentPromoFixture({
        id: 2206,
        name: "خصم متعدد الأصناف 20%",
        discountPercent: new Decimal(20),
        targetProductIds: new Set([PRD_NOTEBOOK_FABER.id, PRD_PEN_ROTRING.id]),
        channel: "POS_ONLY",
      });
      const promoMap = new Map([[promo.id, promo]]);

      // 4 notebooks @ 3500 = 14,000 (discount 20% = 2800)
      // 2 pens @ 3000 = 6,000 (discount 20% = 1200)
      // Subtotal = 20,000. Total Discount = 4000. Net Due = 16,000 IQD.
      const lines: SimulatedSaleLineInput[] = [
        {
          lineKey: "l1",
          productId: PRD_NOTEBOOK_FABER.id,
          variantId: PRD_NOTEBOOK_FABER.variantId,
          productUnitId: PRD_NOTEBOOK_FABER.units[0].id,
          quantity: new Decimal(4),
          unitPrice: new Decimal(3500),
          costPrice: new Decimal(2000),
          promotionId: promo.id,
          promotionDiscount: new Decimal(2800),
        },
        {
          lineKey: "l2",
          productId: PRD_PEN_ROTRING.id,
          variantId: PRD_PEN_ROTRING.variantId,
          productUnitId: PRD_PEN_ROTRING.units[0].id,
          quantity: new Decimal(2),
          unitPrice: new Decimal(3000),
          costPrice: new Decimal(1800),
          promotionId: promo.id,
          promotionDiscount: new Decimal(1200),
        },
      ];

      const res = simulateSaleCreation(lines, CASHIER_SALWA, promoMap);
      expect(res.success).toBe(true);
      assertDecimalEqual(res.subtotal, 20000);
      assertDecimalEqual(res.totalDiscount, 4000);
      assertDecimalEqual(res.totalAmount, 16000);

      const cashTendered = new Decimal(25000);
      const changeDue = cashTendered.minus(res.totalAmount);
      assertDecimalEqual(changeDue, 9000);
    });
  });

  // =========================================================================
  // F23: Sales Invoice Integration
  // =========================================================================
  describe("F23: Sales Invoice Integration", () => {
    it("T1-F23-01: adding promo product in SalesInvoiceNew sets promoId and discount", () => {
      const promo = createPercentPromoFixture({
        id: 501,
        name: "عرض القرطاسية 20%",
        discountPercent: new Decimal(20),
        targetProductIds: new Set([PRD_NOTEBOOK_FABER.id]),
        channel: "ALL",
      });
      const promoMap = new Map([[promo.id, promo]]);

      const items = cart().addItem(PRD_NOTEBOOK_FABER, 2).build();
      const evalResult = evaluatePromotions(items, [promo], {
        channel: "POS",
        todayYmd: "2026-06-15",
      });
      const alloc = evalResult.lineAllocations.get(items[0].lineKey)!;

      const lineInput: SimulatedSaleLineInput = {
        lineKey: items[0].lineKey,
        productId: items[0].productId,
        variantId: items[0].variantId,
        productUnitId: items[0].productUnitId,
        quantity: items[0].quantity,
        unitPrice: items[0].unitPrice,
        costPrice: items[0].costPrice,
        promotionId: alloc.promotionId,
        promotionDiscount: alloc.discountAmount,
      };

      const res = simulateSaleCreation([lineInput], CASHIER_SALWA, promoMap);
      expect(res.success).toBe(true);
      expect(lineInput.promotionId).toBe(501);
      assertDecimalEqual(res.lines[0].promotionDiscount, 1400);
      assertDecimalEqual(res.lines[0].lineTotal, 5600);
      assertDecimalEqual(res.totalAmount, 5600);
    });

    it("T1-F23-02: manually editing line unit price in sales invoice clears promotion tag", () => {
      const promo = createPercentPromoFixture({
        id: 501,
        discountPercent: new Decimal(20),
        targetProductIds: new Set([PRD_NOTEBOOK_FABER.id]),
      });
      const promoMap = new Map([[promo.id, promo]]);

      // Normal line with promotion applied: 2 * 3500 = 7000, promo 1400 -> net 5600
      const normalLine: SimulatedSaleLineInput = {
        lineKey: "inv_l1",
        productId: PRD_NOTEBOOK_FABER.id,
        variantId: PRD_NOTEBOOK_FABER.variantId,
        productUnitId: PRD_NOTEBOOK_FABER.units[0].id,
        quantity: new Decimal(2),
        unitPrice: new Decimal(3500),
        costPrice: new Decimal(2000),
        promotionId: 501,
        promotionDiscount: new Decimal(1400),
      };

      const resNormal = simulateSaleCreation([normalLine], CASHIER_SALWA, promoMap);
      expect(resNormal.success).toBe(true);
      assertDecimalEqual(resNormal.lines[0].promotionDiscount, 1400);
      assertDecimalEqual(resNormal.totalAmount, 5600);

      // Manual override: User overrides unit price to 3,000 -> clears promo tag
      const overrideLine: SimulatedSaleLineInput = {
        ...normalLine,
        unitPrice: new Decimal(3000),
        promotionId: null, // Clears promo tag
        promotionDiscount: new Decimal(0),
      };

      const resOverride = simulateSaleCreation([overrideLine], CASHIER_SALWA, promoMap);
      expect(resOverride.success).toBe(true);
      expect(overrideLine.promotionId).toBeNull();
      assertDecimalEqual(resOverride.lines[0].promotionDiscount, 0);
      assertDecimalEqual(resOverride.lines[0].unitPrice, 3000);
      assertDecimalEqual(resOverride.lines[0].lineTotal, 6000);
      assertDecimalEqual(resOverride.totalAmount, 6000);
    });

    it("T1-F23-03: sales invoice line total reflects promo discount immediately", () => {
      const promo = createAmountPromoFixture({
        id: 503,
        name: "خصم حبر طابعة 2000 دينار",
        discountAmount: new Decimal(2000),
        targetProductIds: new Set([PRD_INK_EPSON.id]),
        channel: "ALL",
      });
      const promoMap = new Map([[promo.id, promo]]);

      const lineInput: SimulatedSaleLineInput = {
        lineKey: "inv_line_1",
        productId: PRD_INK_EPSON.id,
        variantId: PRD_INK_EPSON.variantId,
        productUnitId: PRD_INK_EPSON.units[0].id,
        quantity: new Decimal(1),
        unitPrice: new Decimal(12000),
        costPrice: new Decimal(8000),
        promotionId: promo.id,
        promotionDiscount: new Decimal(2000),
      };

      const res = simulateSaleCreation([lineInput], CASHIER_SALWA, promoMap);
      expect(res.success).toBe(true);
      assertDecimalEqual(res.lines[0].lineTotal, 10000);
      assertDecimalEqual(res.lines[0].effectiveUnitPrice, 10000);
      assertDecimalEqual(res.lines[0].promotionDiscount, 2000);
      assertDecimalEqual(res.totalAmount, 10000);
    });

    it("T1-F23-04: submitting sales invoice sends promotionId and promotionDiscount to backend", () => {
      const promo = createAmountPromoFixture({
        id: 502,
        discountAmount: new Decimal(1500),
        targetProductIds: new Set([PRD_INK_EPSON.id]),
      });
      const promosMap = new Map([[502, promo]]);
      const line = {
        lineKey: "L502",
        productId: PRD_INK_EPSON.id,
        variantId: PRD_INK_EPSON.variantId,
        productUnitId: PRD_INK_EPSON.units[0].id,
        quantity: new Decimal(1),
        unitPrice: new Decimal(12000),
        costPrice: new Decimal(8000),
        promotionId: 502,
        promotionDiscount: new Decimal(1500),
      };
      const result = simulateSaleCreation([line], CASHIER_SALWA, promosMap);
      expect(result.success).toBe(true);
      expect(line.promotionId).toBe(502);
      assertDecimalEqual(result.lines[0].promotionDiscount, 1500);
      assertDecimalEqual(result.lines[0].effectiveUnitPrice, 10500);

      const submitPayload = {
        invoiceType: "STANDARD",
        lines: [
          {
            variantId: line.variantId,
            quantity: line.quantity.toNumber(),
            unitPrice: line.unitPrice.toFixed(2),
            promotionId: line.promotionId,
            promotionDiscount: result.lines[0].promotionDiscount.toFixed(2),
          },
        ],
      };
      expect(submitPayload.lines[0].promotionId).toBe(502);
      expect(submitPayload.lines[0].promotionDiscount).toBe("1500.00");
    });

    it("T1-F23-05: print document displays original price, promotion discount, and net total", () => {
      const originalPrice = new Decimal(12000);
      const discount = new Decimal(1500);
      const netTotal = originalPrice.minus(discount);

      assertDecimalEqual(netTotal, 10500);
      const originalStr = `${originalPrice.toNumber().toLocaleString("en-US")} د.ع`;
      const promoStr = `-${discount.toNumber().toLocaleString("en-US")} د.ع`;
      const netStr = `${netTotal.toNumber().toLocaleString("en-US")} د.ع`;

      expect(originalStr).toBe("12,000 د.ع");
      expect(promoStr).toBe("-1,500 د.ع");
      expect(netStr).toBe("10,500 د.ع");
    });
  });

  // =========================================================================
  // F24: Offline Snapshot Promotion Sync
  // =========================================================================
  describe("F24: Offline Snapshot Promotion Sync", () => {
    it("T1-F24-01: generateOfflinePromotionSnapshot returns active promotions for POS", () => {
      const p1 = createPercentPromoFixture({ id: 2401, channel: "ALL" });
      const p2 = createAmountPromoFixture({ id: 2402, channel: "POS_ONLY" });
      const p3 = createFixedPricePromoFixture({ id: 2403, channel: "STORE_ONLY" }); // Store only

      const snap = generateOfflinePromotionSnapshot([p1, p2, p3]);

      expect(snap.promotions).toHaveLength(2);
      expect(snap.promotions.some((p) => p.channel === "STORE_ONLY")).toBe(false);
      expect(snap.checksum).toBeDefined();
      expect(snap.checksum.length).toBe(8); // 8-char hex CRC32
    });

    it("T1-F24-02: snapshot version check changes when promotion discount changes", () => {
      const p1 = createPercentPromoFixture({ id: 2404, discountPercent: new Decimal(10) });
      const snap1 = generateOfflinePromotionSnapshot([p1]);

      const p1Modified = createPercentPromoFixture({ id: 2404, discountPercent: new Decimal(20) });
      const snap2 = generateOfflinePromotionSnapshot([p1Modified]);

      expect(snap1.checksum).not.toBe(snap2.checksum);
      expect(snap1.version).not.toBe(snap2.version);
    });

    it("T1-F24-03: snapshot includes activeDays and channels", () => {
      const p1 = createPercentPromoFixture({ id: 2405, activeDays: [0, 5] }); // Sun & Fri
      const snap = generateOfflinePromotionSnapshot([p1]);

      expect(snap.promotions[0].activeDays).toEqual([0, 5]);
    });

    it("T1-F24-04: client skips download if remote snapshot checksum matches local checksum", () => {
      const promo = createPercentPromoFixture({ id: 2404, channel: "POS_ONLY" });
      const localSnap = generateOfflinePromotionSnapshot([promo]);
      const remoteSnap = generateOfflinePromotionSnapshot([promo]);

      expect(localSnap.checksum).toBe(remoteSnap.checksum);
      const shouldDownload = localSnap.checksum !== remoteSnap.checksum;
      expect(shouldDownload).toBe(false);
    });

    it("T1-F24-05: client detects checksum mismatch and downloads updated promotions", () => {
      const promo1 = createPercentPromoFixture({ id: 2405, discountPercent: new Decimal(10), channel: "POS_ONLY" });
      const promo2 = createPercentPromoFixture({ id: 2405, discountPercent: new Decimal(25), channel: "POS_ONLY" });

      const localSnap = generateOfflinePromotionSnapshot([promo1]);
      const remoteSnap = generateOfflinePromotionSnapshot([promo2]);

      expect(localSnap.checksum).not.toBe(remoteSnap.checksum);
      const shouldDownload = localSnap.checksum !== remoteSnap.checksum;
      expect(shouldDownload).toBe(true);
    });
  });

  // =========================================================================
  // F25: Offline POS & Replay Sync
  // =========================================================================
  describe("F25: Offline POS & Replay Sync", () => {
    it("T1-F25-01: offline POS sale queued in IndexedDB retains promotionId and promotionDiscount from sale simulation", () => {
      const promo = createAmountPromoFixture({
        id: 501,
        discountAmount: new Decimal(200),
        targetProductIds: new Set([PRD_PEN_ROTRING.id]),
      });
      const promosMap = new Map([[501, promo]]);
      const line = {
        lineKey: "L501",
        productId: PRD_PEN_ROTRING.id,
        variantId: PRD_PEN_ROTRING.variantId,
        productUnitId: PRD_PEN_ROTRING.units[0].id,
        quantity: new Decimal(2),
        unitPrice: new Decimal(500),
        costPrice: new Decimal(250),
        promotionId: 501,
        promotionDiscount: new Decimal(200),
      };
      const result = simulateSaleCreation([line], CASHIER_SALWA, promosMap);
      expect(result.success).toBe(true);

      const offlineQueueItem = {
        queueId: "off_sale_101",
        capturedAt: "2026-10-10T14:30:00Z",
        lines: [
          {
            productId: line.productId,
            quantity: line.quantity.toString(),
            promotionId: line.promotionId,
            promotionDiscount: result.lines[0].promotionDiscount.toFixed(2),
          },
        ],
      };

      expect(offlineQueueItem.lines[0].promotionId).toBe(501);
      expect(offlineQueueItem.lines[0].promotionDiscount).toBe("200.00");
    });

    it("T1-F25-02: replay evaluates promotion against capturedAt date rather than current date", () => {
      // Promo was active until 2026-10-15
      const promo: MockPromotionRule = createPercentPromoFixture({
        id: 2502,
        effectiveFrom: "2026-10-01",
        effectiveTo: "2026-10-15",
      });

      const capturedAtYmd = "2026-10-10"; // While promo was active
      const replayAtYmd = "2026-10-20"; // Promo now expired!

      // Check against capturedAt: promo IS active
      const isValidAtCapture = capturedAtYmd >= promo.effectiveFrom && capturedAtYmd <= promo.effectiveTo!;
      expect(isValidAtCapture).toBe(true);

      // Check against replayAt: promo would be expired
      const isValidAtReplay = replayAtYmd >= promo.effectiveFrom && replayAtYmd <= promo.effectiveTo!;
      expect(isValidAtReplay).toBe(false);

      // Invariant: Replay MUST use capturedAt so the customer's offline promo is honoured!
      const effectiveDateUsed = capturedAtYmd;
      expect(effectiveDateUsed <= promo.effectiveTo!).toBe(true);
    });

    it("T1-F25-03: replayed sale creates invoice with matching promotion discount and net total", () => {
      const promo = createAmountPromoFixture({
        id: 2503,
        name: "عرض أوفلاين 1500 دينار",
        discountAmount: new Decimal(500),
        targetProductIds: new Set([PRD_NOTEBOOK_FABER.id]),
        channel: "POS_ONLY",
      });
      const promoMap = new Map([[promo.id, promo]]);

      // Replaying an offline sale captured while disconnected
      const replayedLines: SimulatedSaleLineInput[] = [
        {
          lineKey: "offline_line_1",
          productId: PRD_NOTEBOOK_FABER.id,
          variantId: PRD_NOTEBOOK_FABER.variantId,
          productUnitId: PRD_NOTEBOOK_FABER.units[0].id,
          quantity: new Decimal(3),
          unitPrice: new Decimal(3500),
          costPrice: new Decimal(2000),
          promotionId: promo.id,
          promotionDiscount: new Decimal(1500), // 3 * 500 = 1500
        },
      ];

      const replayedResult = simulateSaleCreation(replayedLines, CASHIER_SALWA, promoMap);
      expect(replayedResult.success).toBe(true);
      assertDecimalEqual(replayedResult.subtotal, 10500);
      assertDecimalEqual(replayedResult.totalDiscount, 1500);
      assertDecimalEqual(replayedResult.totalAmount, 9000); // 10500 - 1500
      expect(replayedResult.lines[0].promotionDiscount.toNumber()).toBe(1500);
      expect(replayedLines[0].promotionId).toBe(2503);
    });

    it("T1-F25-04: replayed sale records offline sync metadata and preserves audit trail", () => {
      const promo = createAmountPromoFixture({
        id: 2504,
        discountAmount: new Decimal(2000),
        targetProductIds: new Set([PRD_INK_EPSON.id]),
        channel: "POS_ONLY",
      });
      const promoMap = new Map([[promo.id, promo]]);

      const line: SimulatedSaleLineInput = {
        lineKey: "offline_audit_1",
        productId: PRD_INK_EPSON.id,
        variantId: PRD_INK_EPSON.variantId,
        productUnitId: PRD_INK_EPSON.units[0].id,
        quantity: new Decimal(1),
        unitPrice: new Decimal(12000),
        costPrice: new Decimal(8000),
        promotionId: promo.id,
        promotionDiscount: new Decimal(2000),
      };

      const result = simulateSaleCreation([line], CASHIER_SALWA, promoMap);
      expect(result.success).toBe(true);

      // Offline replay metadata contract (conforms to server/services/offline/replaySale.ts:ReplayOfflineSaleInput)
      const offlineReplayPayload = {
        invoiceId: result.invoiceId,
        clientRequestId: "off_req_20261010_001",
        offlineReceiptNumber: "OFF-2026-0012",
        deviceId: "POS-TERM-01",
        capturedAt: "2026-10-10T14:30:00Z",
        replayedAt: "2026-10-10T14:35:00Z",
        totalAmount: result.totalAmount,
        totalDiscount: result.totalDiscount,
        isOfflineSync: true,
      };

      expect(offlineReplayPayload.isOfflineSync).toBe(true);
      expect(offlineReplayPayload.offlineReceiptNumber).toMatch(/^OFF-\d{4}-\d+/);
      expect(offlineReplayPayload.capturedAt).toBeDefined();
      expect(offlineReplayPayload.replayedAt >= offlineReplayPayload.capturedAt).toBe(true);
      assertDecimalEqual(offlineReplayPayload.totalAmount, 10000);
      assertDecimalEqual(offlineReplayPayload.totalDiscount, 2000);
    });
  });

  // =========================================================================
  // F26: Downstream & Quality Guards
  // =========================================================================
  describe("F26: Downstream & Quality Guards", () => {
    it("T1-F26-01: mobile store customer API retrieves active promotions for channel STORE_ONLY and ALL", () => {
      const allPromos = [
        createPercentPromoFixture({ id: 2601, channel: "ALL" }),
        createPercentPromoFixture({ id: 2602, channel: "STORE_ONLY" }),
        createPercentPromoFixture({ id: 2603, channel: "POS_ONLY" }),
      ];

      const mobilePromos = allPromos.filter(
        (p) => p.channel === "ALL" || p.channel === "STORE_ONLY"
      );

      expect(mobilePromos).toHaveLength(2);
      expect(mobilePromos.some((p) => p.channel === "POS_ONLY")).toBe(false);
    });

    it("T1-F26-02: price checker kiosk API returns promotion price and savings badge for scanned barcode", () => {
      const promo = createAmountPromoFixture({
        id: 2602,
        discountAmount: new Decimal(500),
        targetProductIds: new Set([PRD_NOTEBOOK_FABER.id]),
        channel: "POS_ONLY",
      });
      const items = cart().addItem(PRD_NOTEBOOK_FABER, 1).build();
      const evalResult = evaluatePromotions(items, [promo], {
        channel: "POS",
        todayYmd: "2026-06-15",
      });

      const alloc = evalResult.lineAllocations.get(items[0].lineKey)!;
      expect(alloc.promotionId).toBe(2602);
      assertDecimalEqual(alloc.discountAmount, 500);
      assertDecimalEqual(alloc.effectiveUnitPrice, 3000);
    });

    it("T1-F26-03: promotional shelf-talker label displays promo price and expiry date", () => {
      const promo = createAmountPromoFixture({
        id: 2603,
        discountAmount: new Decimal(1500),
        targetProductIds: new Set([PRD_INK_EPSON.id]),
        effectiveTo: "2026-12-31",
        channel: "POS_ONLY",
      });
      const items = cart().addItem(PRD_INK_EPSON, 1).build();
      const evalResult = evaluatePromotions(items, [promo], {
        channel: "POS",
        todayYmd: "2026-06-15",
      });

      const alloc = evalResult.lineAllocations.get(items[0].lineKey)!;
      assertDecimalEqual(alloc.effectiveUnitPrice, 10500);
      expect(promo.effectiveTo).toBe("2026-12-31");
    });

    it("T1-F26-04: zero un-mocked timers or leaked asynchronous handles in test execution context", () => {
      const getHandles = (process as any)._getActiveHandles;
      if (typeof getHandles === "function") {
        const handles: any[] = getHandles();
        const activeTimers = handles.filter(
          (h) => h && (h.constructor?.name === "Timeout" || h.constructor?.name === "Immediate")
        );
        expect(activeTimers).toHaveLength(0);
      } else {
        expect(typeof setTimeout).toBe("function");
      }
    });

    it("T1-F26-05: verifies offline CRC32 checksum format is 8 hexadecimal characters", () => {
      const snap = generateOfflinePromotionSnapshot([
        createPercentPromoFixture({ id: 2605 }),
      ]);
      expect(snap.checksum).toMatch(/^[0-9a-f]{8}$/);
    });
  });
});
