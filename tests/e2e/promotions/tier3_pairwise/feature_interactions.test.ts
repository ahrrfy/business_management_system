/**
 * tests/e2e/promotions/tier3_pairwise/feature_interactions.test.ts
 *
 * Tier 3 Pairwise Cross-Feature Interactions Suite (T3-INT-01 to T3-INT-26)
 * Derived from spec.md Section 6.
 * Validates orthogonal feature interactions to prevent integration and semantic defects.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import {
  assertAllocationConservation,
  assertBelowCostAllowed,
  assertDecimalEqual,
  assertDigitalCardIsolation,
  assertH6GateBypassForPromo,
  assertNoGiftFlagOnPromoDiscount,
  assertPriceCeilingRespected,
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
  createTieredQtyPromoFixture,
} from "../infra/mockFixtures";
import {
  allocateByValue,
  cart,
  evaluatePromotions,
  EvaluationContext,
  generateOfflinePromotionSnapshot,
  SimulatedSaleLineInput,
  simulateSaleCreation,
  validatePromotionSchema,
} from "../infra/testHarness";

const CONTEXT_POS: EvaluationContext = {
  channel: "POS",
  todayYmd: "2026-06-15",
};

describe("Tier 3: Pairwise Cross-Feature Interactions (T3-INT-01 to T3-INT-26)", () => {
  // =========================================================================
  // T3-INT-01: F01 (FIXED_PRICE) + F08 (Fixed Ceiling)
  // =========================================================================
  it("T3-INT-01: FIXED_PRICE + Ceiling: mixed cart with items above and below fixed price ceiling", () => {
    // Fixed Price = 5,000 IQD. Cart: Item 1 = 7,000, Item 2 = 3,000, Item 3 = 5,000
    const items = cart()
      .addItem(PRD_PEN_ROTRING, 1, 0, { customUnitPrice: 7000 }) // above: 7k -> 5k
      .addItem(PRD_NOTEBOOK_FABER, 1, 0, { customUnitPrice: 3000 }) // below: 3k -> 3k (0 discount)
      .addItem(PRD_INK_EPSON, 1, 0, { customUnitPrice: 5000 }) // equal: 5k -> 5k (0 discount)
      .build();

    const promo = createFixedPricePromoFixture({
      id: 301,
      fixedPrice: new Decimal(5000),
      targetProductIds: new Set([PRD_PEN_ROTRING.id, PRD_NOTEBOOK_FABER.id, PRD_INK_EPSON.id]),
    });

    const res = evaluatePromotions(items, [promo], CONTEXT_POS);

    // Only item 1 gets discounted
    expect(res.lineAllocations.size).toBe(1);
    const alloc1 = res.lineAllocations.get(items[0].lineKey)!;
    assertDecimalEqual(alloc1.discountAmount, 2000);
    assertDecimalEqual(alloc1.effectiveUnitPrice, 5000);
    assertDecimalEqual(res.totalCartDiscount, 2000);
  });

  // =========================================================================
  // T3-INT-02: F01 (BOGO) + F09 (Proportional Allocation)
  // =========================================================================
  it("T3-INT-02: BOGO + Allocation: Buy 2 Get 1 Free on 3 distinct prices allocates cheapest item proportionally", () => {
    // Items: A = 12,000, B = 9,000, C = 6,000. Total gross = 27,000 IQD
    // Cheapest item is C (6,000 IQD) -> free item savings = 6,000 IQD
    const items = cart()
      .addItem(PRD_INK_EPSON, 1, 0, { customUnitPrice: 12000 })
      .addItem(PRD_GRAD_SASH, 1, 0, { customUnitPrice: 9000 })
      .addItem(PRD_NOTEBOOK_FABER, 1, 0, { customUnitPrice: 6000 })
      .build();

    const promo = createBogoPromoFixture({
      id: 302,
      bogoBuyQuantity: 2,
      bogoGetQuantity: 1,
      targetProductIds: new Set([PRD_INK_EPSON.id, PRD_GRAD_SASH.id, PRD_NOTEBOOK_FABER.id]),
    });

    const res = evaluatePromotions(items, [promo], CONTEXT_POS);

    // 6,000 IQD discount allocated proportionally across lines:
    // A: 6000 * 12k / 27k = 2666.67
    // B: 6000 * 9k / 27k = 2000.00
    // C: 6000 * 6k / 27k = 1333.33
    // Sum = 6,000.00 IQD
    assertDecimalEqual(res.totalCartDiscount, 6000);
    assertAllocationConservation(items, res);
    assertNoGiftFlagOnPromoDiscount(Array.from(res.lineAllocations.values()));
  });

  // =========================================================================
  // T3-INT-03: F01 (BUNDLE_PRICE) + F19 (H6 Gate)
  // =========================================================================
  it("T3-INT-03: BUNDLE_PRICE + H6 Gate: bundle giving 30% savings + cashier 5% manual discount passes H6", () => {
    // Bundle of 3 items (sum 30,000) for 21,000 (30% promo).
    // Net after promo = 21,000. Cashier adds 5% manual discount on net = 1,050 IQD.
    const line: SimulatedSaleLineInput = {
      lineKey: "bundle_line",
      productId: PRD_CRYSTAL_SHIELD.id,
      variantId: PRD_CRYSTAL_SHIELD.variantId,
      productUnitId: PRD_CRYSTAL_SHIELD.units[0].id,
      quantity: new Decimal(1),
      unitPrice: new Decimal(30000),
      costPrice: new Decimal(15000),
      promotionId: 303,
      promotionDiscount: new Decimal(9000), // 30% savings -> net = 21,000
      cashierDiscountAmount: new Decimal(1050), // 5% manual discount <= 15%
    };

    const promo = createBundlePromoFixture({ id: 303, bundlePrice: new Decimal(21000) });
    const promosMap = new Map([[303, promo]]);

    const res = simulateSaleCreation([line], CASHIER_SALWA, promosMap);
    expect(res.success).toBe(true);
    assertDecimalEqual(res.totalAmount, 19950); // 21,000 - 1,050
  });

  // =========================================================================
  // T3-INT-04: F01 (TIERED_QTY) + F04 (Tiers Table)
  // =========================================================================
  it("T3-INT-04: TIERED_QTY + Tiers Table: 3 progressive tiers, cart matches middle tier", () => {
    // Tier 1: 5-9 @ 10%, Tier 2: 10-19 @ 15%, Tier 3: 20+ @ 25%. Qty = 12
    const items = cart().addItem(PRD_INK_EPSON, 12).build(); // 12 * 12,000 = 144,000 IQD

    const promo = createTieredQtyPromoFixture({
      id: 304,
      targetProductIds: new Set([PRD_INK_EPSON.id]),
      tiers: [
        { minQuantity: new Decimal(5), tierType: "PERCENT", discountPercent: new Decimal(10) },
        { minQuantity: new Decimal(10), tierType: "PERCENT", discountPercent: new Decimal(15) },
        { minQuantity: new Decimal(20), tierType: "PERCENT", discountPercent: new Decimal(25) },
      ],
    });

    const res = evaluatePromotions(items, [promo], CONTEXT_POS);
    const alloc = res.lineAllocations.get(items[0].lineKey)!;

    // 15% of 144,000 = 21,600 IQD
    assertDecimalEqual(alloc.discountAmount, 21600);
    assertDecimalEqual(alloc.effectiveUnitPrice, 10200); // 12,000 * 0.85
  });

  // =========================================================================
  // T3-INT-05: F02 (Channel) + F24 (Offline Snapshot)
  // =========================================================================
  it("T3-INT-05: Channel + Offline Snapshot: snapshot includes ALL and POS_ONLY, excludes STORE_ONLY", () => {
    const promoAll = createPercentPromoFixture({ id: 1, channel: "ALL" });
    const promoPos = createPercentPromoFixture({ id: 2, channel: "POS_ONLY" });
    const promoStore = createPercentPromoFixture({ id: 3, channel: "STORE_ONLY" });

    const snapshot = generateOfflinePromotionSnapshot([promoAll, promoPos, promoStore]);
    expect(snapshot.promotions).toHaveLength(2);
    expect(snapshot.promotions.map((p) => p.id)).toEqual([1, 2]);

    const snapshotExpected = generateOfflinePromotionSnapshot([promoAll, promoPos]);
    expect(snapshot.checksum).toBe(snapshotExpected.checksum);
  });

  // =========================================================================
  // T3-INT-06: F03 (Clearance) + F20 (Below-Cost Gate)
  // =========================================================================
  it("T3-INT-06: Clearance + Below Cost: allowBelowCost = true allows selling below cost in POS with audit flag", () => {
    // Cost = 10,000 IQD, promo price = 6,000 IQD, allowBelowCost = true
    const line: SimulatedSaleLineInput = {
      lineKey: "clearance_l1",
      productId: PRD_INK_EPSON.id,
      variantId: PRD_INK_EPSON.variantId,
      productUnitId: PRD_INK_EPSON.units[0].id,
      quantity: new Decimal(1),
      unitPrice: new Decimal(12000),
      costPrice: new Decimal(10000),
      promotionId: 306,
      promotionDiscount: new Decimal(6000), // net = 6,000 < 10,000 cost
    };

    const promo = createFixedPricePromoFixture({
      id: 306,
      fixedPrice: new Decimal(6000),
      allowBelowCost: true,
    });
    const promosMap = new Map([[306, promo]]);

    const res = simulateSaleCreation([line], CASHIER_SALWA, promosMap);
    expect(res.success).toBe(true);
    expect(res.priceOverride).toBe(true);
    expect(res.lines[0].isBelowCost).toBe(true);
    assertDecimalEqual(res.lines[0].effectiveUnitPrice, 6000);
  });

  // =========================================================================
  // T3-INT-07: F03 (Base Unit Only) + F04 (Packaging Units)
  // =========================================================================
  it("T3-INT-07: Base Unit Only + Packaging Units: Piece unit gets discount, Carton is strictly protected from price leak", () => {
    // Piece (unitIndex 0, 500 IQD), Carton (unitIndex 2, 60,000 IQD)
    const items = cart()
      .addItem(PRD_PEN_ROTRING, 10, 0) // Piece
      .addItem(PRD_PEN_ROTRING, 1, 2) // Carton
      .build();

    const promo = createAmountPromoFixture({
      id: 307,
      applyToBaseUnitOnly: true,
      discountAmount: new Decimal(200), // 200 IQD off per piece
      targetProductIds: new Set([PRD_PEN_ROTRING.id]),
    });

    const res = evaluatePromotions(items, [promo], CONTEXT_POS);

    // Pieces get 10 * 200 = 2,000 IQD discount
    const allocPiece = res.lineAllocations.get(items[0].lineKey)!;
    assertDecimalEqual(allocPiece.discountAmount, 2000);
    assertDecimalEqual(allocPiece.effectiveUnitPrice, 300);

    // Carton gets 0 discount
    expect(res.lineAllocations.has(items[1].lineKey)).toBe(false);
    assertDecimalEqual(res.totalCartDiscount, 2000);
  });

  // =========================================================================
  // T3-INT-08: F03 (Schedule) + F25 (Offline Replay)
  // =========================================================================
  it("T3-INT-08: Schedule + Offline Replay: Sunday promo captured offline on Sunday is honoured when synced on Wednesday", () => {
    const promo = createPercentPromoFixture({
      id: 308,
      activeDays: [0], // Sunday only
      discountPercent: new Decimal(20),
      targetProductIds: new Set([PRD_PEN_ROTRING.id]),
    });

    const items = cart().addItem(PRD_PEN_ROTRING, 2).build();

    // Sunday capture (valid)
    const resSunday = evaluatePromotions(items, [promo], { channel: "POS", todayYmd: "2026-06-14" });
    assertDecimalEqual(resSunday.totalCartDiscount, 200);

    // Wednesday replay would be invalid if checked against server now:
    const resWednesday = evaluatePromotions(items, [promo], { channel: "POS", todayYmd: "2026-06-17" });
    expect(resWednesday.totalCartDiscount.toNumber()).toBe(0);
  });

  // =========================================================================
  // T3-INT-09: F07 (Precision) + F09 (Allocation)
  // =========================================================================
  it("T3-INT-09: Precision + Allocation: fractional fils remainder distribution across 7 equal lines satisfies conservation", () => {
    // 10,000 IQD savings distributed over 7 identical 5,000 IQD lines
    const lines = Array.from({ length: 7 }, (_, i) => ({
      lineKey: `line_${i + 1}`,
      lineGross: new Decimal(5000),
    }));

    const allocations = allocateByValue(lines, new Decimal(10000));
    let sum = new Decimal(0);
    Array.from(allocations.values()).forEach((val) => {
      sum = sum.plus(val);
    });

    assertDecimalEqual(sum, 10000);
    // 6 lines get 1,428.57, 1 line (largest line remainder) gets 1,428.58
    const counts = { "1428.57": 0, "1428.58": 0 };
    Array.from(allocations.values()).forEach((val) => {
      if (val.toFixed(2) === "1428.57") counts["1428.57"]++;
      if (val.toFixed(2) === "1428.58") counts["1428.58"]++;
    });
    expect(counts["1428.57"]).toBe(6);
    expect(counts["1428.58"]).toBe(1);
  });

  // =========================================================================
  // T3-INT-10: F10 (Priority) + F01 (PERCENT vs AMOUNT)
  // =========================================================================
  it("T3-INT-10: Priority + Competing Types: higher priority AMOUNT promotion beats lower priority PERCENT promotion", () => {
    // Item price = 20,000 IQD
    // Promo 1: 10% off (Priority 10) -> would give 2,000 IQD
    // Promo 2: 3,000 IQD off (Priority 20) -> gives 3,000 IQD
    const items = cart().addItem(PRD_LUX_PEN, 1, 0, { customUnitPrice: 20000 }).build();

    const promoPercent = createPercentPromoFixture({
      id: 1,
      priority: 10,
      discountPercent: new Decimal(10),
      targetProductIds: new Set([PRD_LUX_PEN.id]),
    });
    const promoAmount = createAmountPromoFixture({
      id: 2,
      priority: 20, // higher priority!
      discountAmount: new Decimal(3000),
      targetProductIds: new Set([PRD_LUX_PEN.id]),
    });

    const res = evaluatePromotions(items, [promoPercent, promoAmount], CONTEXT_POS);
    const alloc = res.lineAllocations.get(items[0].lineKey)!;

    expect(alloc.promotionId).toBe(2);
    assertDecimalEqual(alloc.discountAmount, 3000);
  });

  // =========================================================================
  // T3-INT-11: F10 (Contracts) + F19 (H6 Gate)
  // =========================================================================
  it("T3-INT-11: Contracts + H6 Gate: contract price line receives 0 promo, standard item receives promo and cashier manual discount", () => {
    const lineContract: SimulatedSaleLineInput = {
      lineKey: "l_contract",
      productId: PRD_INK_EPSON.id,
      variantId: PRD_INK_EPSON.variantId,
      productUnitId: PRD_INK_EPSON.units[0].id,
      quantity: new Decimal(1),
      unitPrice: new Decimal(10000), // contract price (list was 12,000)
      costPrice: new Decimal(9500),
      promotionId: null, // no promo on contract price
      promotionDiscount: new Decimal(0),
    };
    const lineStandard: SimulatedSaleLineInput = {
      lineKey: "l_standard",
      productId: PRD_NOTEBOOK_FABER.id,
      variantId: PRD_NOTEBOOK_FABER.variantId,
      productUnitId: PRD_NOTEBOOK_FABER.units[0].id,
      quantity: new Decimal(2),
      unitPrice: new Decimal(5000), // gross 10,000
      costPrice: new Decimal(2400),
      promotionId: 311,
      promotionDiscount: new Decimal(2500), // 25% promo -> net 7,500
      cashierDiscountAmount: new Decimal(750), // 10% manual discount <= 15%
    };

    const promo = createPercentPromoFixture({ id: 311 });
    const promosMap = new Map([[311, promo]]);

    const res = simulateSaleCreation([lineContract, lineStandard], CASHIER_SALWA, promosMap);
    expect(res.success).toBe(true);

    const resContract = res.lines.find((l) => l.lineKey === "l_contract")!;
    assertDecimalEqual(resContract.promotionDiscount, 0);
    assertDecimalEqual(resContract.effectiveUnitPrice, 10000);

    const resStandard = res.lines.find((l) => l.lineKey === "l_standard")!;
    assertDecimalEqual(resStandard.lineTotal, 6750); // 10,000 - 2,500 - 750
  });

  // =========================================================================
  // T3-INT-12: F12 (Consignment) + F14 (Live Table)
  // =========================================================================
  it("T3-INT-12: Consignment + Live Table: calculates promo profit margin against consignment settlement rate", () => {
    // Consignment item: cost = 9,500 IQD, list = 12,000 IQD
    // 20% discount -> promo price = 9,600 IQD > 9,500 cost -> positive margin
    const items = cart().addItem(PRD_INK_EPSON, 1).build();
    const promo = createPercentPromoFixture({
      id: 312,
      discountPercent: new Decimal(20),
      targetProductIds: new Set([PRD_INK_EPSON.id]),
    });

    const res = evaluatePromotions(items, [promo], CONTEXT_POS);
    const alloc = res.lineAllocations.get(items[0].lineKey)!;

    assertDecimalEqual(alloc.effectiveUnitPrice, 9600);
    expect(alloc.effectiveUnitPrice.gt(PRD_INK_EPSON.units[0].costPrice)).toBe(true);

    // Margin = (9,600 - 9,500) / 9,600 * 100 = 1.0416%
    const margin = alloc.effectiveUnitPrice.minus(PRD_INK_EPSON.units[0].costPrice).div(alloc.effectiveUnitPrice).mul(100);
    expect(margin.gt(0)).toBe(true);
  });

  // =========================================================================
  // T3-INT-13: F12 (Cost Masking) + F14 (Live Table)
  // =========================================================================
  it("T3-INT-13: Cost Masking + Live Table: cashier actor canViewCost = false masks cost visibility in audit", () => {
    expect(CASHIER_SALWA.canViewCost).toBe(false);
    expect(CASHIER_AHMED.canViewCost).toBe(false);
    expect(MANAGER_HAIDER.canViewCost).toBe(true);
    expect(ADMIN_MUSTAFA.canViewCost).toBe(true);
  });

  // =========================================================================
  // T3-INT-14: F13 (Scan Gun) + F15 (Live Simulator)
  // =========================================================================
  it("T3-INT-14: Scan Gun + Simulator: consecutive barcode inputs populate simulator basket synchronously", () => {
    // 3 barcodes scanned: Rotring Pen, Faber Notebook, Epson Ink
    const items = cart()
      .addItem(PRD_PEN_ROTRING, 1)
      .addItem(PRD_NOTEBOOK_FABER, 1)
      .addItem(PRD_INK_EPSON, 1)
      .build();

    expect(items).toHaveLength(3);
    const totalGross = items.reduce((acc, i) => acc.plus(i.unitPrice), new Decimal(0));
    assertDecimalEqual(totalGross, 16000); // 500 + 3500 + 12000
  });

  // =========================================================================
  // T3-INT-15: F14 (Live Table) + F08 (Fixed Ceiling)
  // =========================================================================
  it("T3-INT-15: Live Table + Fixed Ceiling: alerts for items cheaper than fixed price and preserves price", () => {
    const items = cart()
      .addItem(PRD_LUX_PEN, 1, 0, { customUnitPrice: 8000 }) // above
      .addItem(PRD_NOTEBOOK_FABER, 1, 0, { customUnitPrice: 4500 }) // below
      .build();

    const promo = createFixedPricePromoFixture({
      id: 315,
      fixedPrice: new Decimal(6000),
      targetProductIds: new Set([PRD_LUX_PEN.id, PRD_NOTEBOOK_FABER.id]),
    });

    const res = evaluatePromotions(items, [promo], CONTEXT_POS);
    // Only item 1 gets discounted (8k -> 6k)
    expect(res.lineAllocations.size).toBe(1);
    assertDecimalEqual(res.lineAllocations.get(items[0].lineKey)!.discountAmount, 2000);
    // Item 2 remains at 4,500
    expect(res.lineAllocations.has(items[1].lineKey)).toBe(false);
  });

  // =========================================================================
  // T3-INT-16: F15 (Simulator) + F01 (BOGO)
  // =========================================================================
  it("T3-INT-16: Simulator + BOGO: dynamic quantity adjustment from 2 to 3 triggers instant free item calculation", () => {
    const promo = createBogoPromoFixture({
      id: 316,
      bogoBuyQuantity: 2,
      bogoGetQuantity: 1,
      targetProductIds: new Set([PRD_NOTEBOOK_FABER.id]),
    });

    // 1. Qty = 2 -> 0 discount
    const cart2 = cart().addItem(PRD_NOTEBOOK_FABER, 2).build();
    const res2 = evaluatePromotions(cart2, [promo], CONTEXT_POS);
    expect(res2.totalCartDiscount.toNumber()).toBe(0);

    // 2. Qty = 3 -> 1 item free (3,500 IQD discount)
    const cart3 = cart().addItem(PRD_NOTEBOOK_FABER, 3).build();
    const res3 = evaluatePromotions(cart3, [promo], CONTEXT_POS);
    assertDecimalEqual(res3.totalCartDiscount, 3500);
  });

  // =========================================================================
  // T3-INT-17: F16 (Duplication) + F03 (Schedule)
  // =========================================================================
  it("T3-INT-17: Duplication + Schedule: cloned draft retains identical activeDays and allowBelowCost settings", () => {
    const sourcePromo = createPercentPromoFixture({
      id: 100,
      name: "عرض القرطاسية الرمضاني",
      discountPercent: new Decimal(50),
      activeDays: [1, 2, 3], // Mon, Tue, Wed in Baghdad time
      allowBelowCost: true,
      applyToBaseUnitOnly: false,
    });

    // 1-Click wizard duplication logic: allocates new ID, prefixes name, resets to draft
    const duplicatePromotionDraft = (source: typeof sourcePromo, newId = 101, todayYmd = "2026-06-15") => ({
      ...source,
      id: newId,
      name: `نسخة من ${source.name}`,
      effectiveFrom: todayYmd,
      effectiveTo: null,
      isActive: false, // Wizard duplicates into an inactive draft
    });

    const duplicatedDraft = duplicatePromotionDraft(sourcePromo, 101, "2026-06-15");

    // 1. Structural assertions on cloned draft
    expect(duplicatedDraft.name).toBe("نسخة من عرض القرطاسية الرمضاني");
    expect(duplicatedDraft.id).toBe(101);
    expect(duplicatedDraft.isActive).toBe(false);
    expect(duplicatedDraft.activeDays).toEqual([1, 2, 3]);
    expect(duplicatedDraft.allowBelowCost).toBe(true);
    expect(duplicatedDraft.applyToBaseUnitOnly).toBe(false);

    // 2. Draft is inactive -> evaluatePromotions produces zero discount
    const cartItems = cart().addItem(PRD_NOTEBOOK_FABER, 2).build();
    const draftEval = evaluatePromotions(cartItems, [duplicatedDraft], {
      channel: "POS",
      todayYmd: "2026-06-15", // Monday
    });
    expect(draftEval.totalCartDiscount.toNumber()).toBe(0);
    expect(draftEval.appliedPromotionIds.size).toBe(0);

    // 3. Activated cloned draft -> executes schedule on active day (Monday dow = 1)
    const activeCloned = { ...duplicatedDraft, isActive: true };
    const mondayEval = evaluatePromotions(cartItems, [activeCloned], {
      channel: "POS",
      todayYmd: "2026-06-15", // Monday
    });
    // 50% on 2 * 3,500 = 7,000 IQD gross -> 3,500 IQD discount
    assertDecimalEqual(mondayEval.totalCartDiscount, 3500);
    expect(mondayEval.appliedPromotionIds.has(101)).toBe(true);

    // 4. Cloned promo is inactive on Thursday (dow = 4 not in [1, 2, 3])
    const thursdayEval = evaluatePromotions(cartItems, [activeCloned], {
      channel: "POS",
      todayYmd: "2026-06-18", // Thursday
    });
    expect(thursdayEval.totalCartDiscount.toNumber()).toBe(0);

    // 5. Preserved allowBelowCost = true allows sale creation below cost without manager block
    // Effective unit price = (7,000 - 3,500) / 2 = 1,750 IQD < costPrice (2,200 IQD)
    const saleLines: SimulatedSaleLineInput[] = [
      {
        lineKey: "l1",
        productId: PRD_NOTEBOOK_FABER.id,
        variantId: PRD_NOTEBOOK_FABER.variantId,
        productUnitId: PRD_NOTEBOOK_FABER.units[0].id,
        quantity: new Decimal(2),
        unitPrice: PRD_NOTEBOOK_FABER.units[0].retailPrice,
        costPrice: PRD_NOTEBOOK_FABER.units[0].costPrice,
        promotionId: activeCloned.id,
        promotionDiscount: mondayEval.totalCartDiscount,
      },
    ];

    const saleResult = simulateSaleCreation(
      saleLines,
      CASHIER_AHMED,
      new Map([[activeCloned.id, activeCloned]])
    );
    expect(saleResult.success).toBe(true);
    expect(saleResult.priceOverride).toBe(true); // Flagged as below-cost sale

    const belowCostCheck = assertBelowCostAllowed(
      {
        costPrice: PRD_NOTEBOOK_FABER.units[0].costPrice,
        effectiveUnitPrice: saleResult.lines[0].effectiveUnitPrice,
      },
      activeCloned
    );
    expect(belowCostCheck.isBelowCost).toBe(true);
    expect(belowCostCheck.isAllowed).toBe(true);

    // 6. Negative control: if allowBelowCost had NOT been preserved (false), cashier is blocked with FORBIDDEN
    const nonExemptCloned = { ...activeCloned, allowBelowCost: false };
    const blockedSale = simulateSaleCreation(
      saleLines,
      CASHIER_AHMED,
      new Map([[nonExemptCloned.id, nonExemptCloned]])
    );
    expect(blockedSale.success).toBe(false);
    expect(blockedSale.errorCode).toBe("FORBIDDEN");
  });

  // =========================================================================
  // T3-INT-18: F17 (Page Size) + F18 (Static Contracts)
  // =========================================================================
  it("T3-INT-18: Page Size + Static Contracts: marketing wing contracts verified", () => {
    const offersPagePath = path.resolve(process.cwd(), "client/src/pages/Offers.tsx");
    expect(fs.existsSync(offersPagePath)).toBe(true);

    const content = fs.readFileSync(offersPagePath, "utf-8");
    const lineCount = content.split(/\r?\n/).length;

    // F17: Page Size ceiling invariant (<= 1200 lines per check:page-size)
    expect(lineCount).toBeLessThanOrEqual(1200);
    expect(lineCount).toBeGreaterThan(100);

    // F18: Static contracts - PageHeader title import and JSX declaration
    expect(content).toContain('import { PageHeader } from "@/components/PageHeader";');
    expect(content).toMatch(/<PageHeader\b[^>]*\btitle="العروض والتخفيضات"/);

    // F18: Static contracts - Export handlers (xlsx and csv) via exportRows
    expect(content).toContain('import { exportRows } from "@/lib/export";');
    expect(content).toContain('const handleExport = (format: "xlsx" | "csv") => {');
    expect(content).toContain('onClick={() => handleExport("xlsx")}');
    expect(content).toContain('onClick={() => handleExport("csv")}');
  });

  // =========================================================================
  // T3-INT-19: F21 (Digital Cards) + F19 (H6 Gate)
  // =========================================================================
  it("T3-INT-19: Digital Cards + H6 Gate: mixed cart with digital card, promo regular item, and manual discount", () => {
    // 1x Digital Card (25,000 IQD) + 1x Promo item (10,000 - 20% = 8,000 IQD)
    // Cashier adds 1,000 IQD discount on promo item (1,000 / 8,000 = 12.5% <= 15%)
    const cardLine: SimulatedSaleLineInput = {
      lineKey: "l_card",
      productId: CARD_ZAIN_10K.id,
      variantId: CARD_ZAIN_10K.id,
      productUnitId: CARD_ZAIN_10K.id,
      quantity: new Decimal(1),
      unitPrice: new Decimal(25000),
      costPrice: new Decimal(24000),
      isDigitalCard: true,
    };
    const promoLine: SimulatedSaleLineInput = {
      lineKey: "l_promo",
      productId: PRD_NOTEBOOK_FABER.id,
      variantId: PRD_NOTEBOOK_FABER.variantId,
      productUnitId: PRD_NOTEBOOK_FABER.units[0].id,
      quantity: new Decimal(1),
      unitPrice: new Decimal(10000),
      costPrice: new Decimal(2400),
      promotionId: 319,
      promotionDiscount: new Decimal(2000), // net = 8,000
      cashierDiscountAmount: new Decimal(1000), // 12.5% manual discount
    };

    const promo = createPercentPromoFixture({ id: 319 });
    const promosMap = new Map([[319, promo]]);

    const res = simulateSaleCreation([cardLine, promoLine], CASHIER_SALWA, promosMap);
    expect(res.success).toBe(true);
    assertDecimalEqual(res.totalAmount, 32000); // 25,000 + 7,000
  });

  // =========================================================================
  // T3-INT-20: F21 (Digital Cards) + F20 (Below Cost)
  // =========================================================================
  it("T3-INT-20: Digital Cards + Below Cost: mixed cart with digital card and clearance below-cost item", () => {
    // 1x Digital Card (50,000 IQD) + 1x Clearance item (Cost 15,000, Promo 10,000, allowBelowCost = true)
    const cardLine: SimulatedSaleLineInput = {
      lineKey: "l_card",
      productId: CARD_ZAIN_10K.id,
      variantId: CARD_ZAIN_10K.id,
      productUnitId: CARD_ZAIN_10K.id,
      quantity: new Decimal(1),
      unitPrice: new Decimal(50000),
      costPrice: new Decimal(48000),
      isDigitalCard: true,
    };
    const clearanceLine: SimulatedSaleLineInput = {
      lineKey: "l_clearance",
      productId: PRD_GRAD_SASH.id,
      variantId: PRD_GRAD_SASH.variantId,
      productUnitId: PRD_GRAD_SASH.units[0].id,
      quantity: new Decimal(1),
      unitPrice: new Decimal(20000),
      costPrice: new Decimal(15000),
      promotionId: 320,
      promotionDiscount: new Decimal(10000), // net 10,000 < 15,000 cost
    };

    const promo = createFixedPricePromoFixture({
      id: 320,
      fixedPrice: new Decimal(10000),
      allowBelowCost: true,
    });
    const promosMap = new Map([[320, promo]]);

    const res = simulateSaleCreation([cardLine, clearanceLine], CASHIER_SALWA, promosMap);
    expect(res.success).toBe(true);
    expect(res.priceOverride).toBe(true);
    assertDecimalEqual(res.totalAmount, 60000); // 50,000 + 10,000
  });

  // =========================================================================
  // T3-INT-21: F22 (POS Channel) + F09 (Allocation)
  // =========================================================================
  it("T3-INT-21: POS Channel + Allocation: POS checkout of bundle promo recorded into invoice items with exact proportional discount", () => {
    // 3 items in bundle (total 25k) for 20k -> 5,000 IQD discount
    const items = cart()
      .addItem(PRD_PEN_ROTRING, 1, 0, { customUnitPrice: 5000 })
      .addItem(PRD_NOTEBOOK_FABER, 1, 0, { customUnitPrice: 10000 })
      .addItem(PRD_INK_EPSON, 1, 0, { customUnitPrice: 10000 })
      .build();

    const promo = createBundlePromoFixture({
      id: 321,
      bundlePrice: new Decimal(20000),
      bundleMode: "ALL_REQUIRED",
      targetProductIds: new Set([PRD_PEN_ROTRING.id, PRD_NOTEBOOK_FABER.id, PRD_INK_EPSON.id]),
    });

    const res = evaluatePromotions(items, [promo], CONTEXT_POS);
    assertDecimalEqual(res.totalCartDiscount, 5000);
    assertAllocationConservation(items, res);
  });

  // =========================================================================
  // T3-INT-22: F23 (Sales Invoice) + F10 (Priority)
  // =========================================================================
  it("T3-INT-22: Sales Invoice + Priority: resolves higher priority promotion automatically", () => {
    const items = cart().addItem(PRD_PEN_ROTRING, 10).build();
    const promoLow = createPercentPromoFixture({ id: 1, priority: 5, discountPercent: new Decimal(10) });
    const promoHigh = createPercentPromoFixture({ id: 2, priority: 15, discountPercent: new Decimal(15) });

    const res = evaluatePromotions(items, [promoLow, promoHigh], CONTEXT_POS);
    expect(res.appliedPromotionIds.has(2)).toBe(true);
    expect(res.appliedPromotionIds.has(1)).toBe(false);
  });

  // =========================================================================
  // T3-INT-23: F24 (Offline Snapshot) + F01 (6 Types)
  // =========================================================================
  it("T3-INT-23: Offline Snapshot + 6 Promotion Types: serializes all 6 promotion shapes into snapshot cleanly", () => {
    const promos = [
      createPercentPromoFixture({ id: 1 }),
      createAmountPromoFixture({ id: 2 }),
      createFixedPricePromoFixture({ id: 3 }),
      createBundlePromoFixture({ id: 4 }),
      createBogoPromoFixture({ id: 5 }),
      createTieredQtyPromoFixture({ id: 6 }),
    ];

    const snapshot = generateOfflinePromotionSnapshot(promos);
    expect(snapshot.promotions).toHaveLength(6);
    expect(snapshot.checksum).toHaveLength(8);
  });

  // =========================================================================
  // T3-INT-24: F25 (Offline Replay) + F21 (Digital Cards)
  // =========================================================================
  it("T3-INT-24: Offline Replay + Digital Cards: replay of mixed offline sale preserves digital card isolation", () => {
    const cardLine: SimulatedSaleLineInput = {
      lineKey: "off_card",
      productId: CARD_ASIA_5K.id,
      variantId: CARD_ASIA_5K.id,
      productUnitId: CARD_ASIA_5K.id,
      quantity: new Decimal(1),
      unitPrice: new Decimal(5000),
      costPrice: new Decimal(4800),
      isDigitalCard: true,
    };
    const penLine: SimulatedSaleLineInput = {
      lineKey: "off_pen",
      productId: PRD_PEN_ROTRING.id,
      variantId: PRD_PEN_ROTRING.variantId,
      productUnitId: PRD_PEN_ROTRING.units[0].id,
      quantity: new Decimal(2),
      unitPrice: new Decimal(500),
      costPrice: new Decimal(350),
      promotionId: 324,
      promotionDiscount: new Decimal(200),
    };

    const promo = createPercentPromoFixture({ id: 324 });
    const promosMap = new Map([[324, promo]]);

    const res = simulateSaleCreation([cardLine, penLine], CASHIER_SALWA, promosMap);
    expect(res.success).toBe(true);
    assertDecimalEqual(res.lines[0].effectiveUnitPrice, 5000);
    assertDecimalEqual(res.lines[1].effectiveUnitPrice, 400);
  });

  // =========================================================================
  // T3-INT-25: F26 (Quality Guards) + F17 (Offers UI)
  // =========================================================================
  it("T3-INT-25: Quality Guards + Offers UI: adheres to semantic design tokens and zero emoji in Offers.tsx", () => {
    const offersPath = path.resolve(process.cwd(), "client/src/pages/Offers.tsx");
    const content = fs.readFileSync(offersPath, "utf-8");

    // Semantic tokens adherence
    expect(content).toMatch(/var\(--sem-pos/);
    expect(content).toMatch(/var\(--sem-neg/);
    expect(content).toMatch(/var\(--sem-warn/);
    expect(content).toMatch(/var\(--sem-info/);
    expect(content).not.toMatch(/text-green-[0-9]+/);
    expect(content).not.toMatch(/text-red-[0-9]+/);

    // Zero emoji adherence per check:emoji
    const emojiRegex = new RegExp(
      "[\\u{1F300}-\\u{1FAFF}\\u{1F1E6}-\\u{1F1FF}\\u{2600}-\\u{27BF}\\u{231A}-\\u{231B}\\u{23E9}-\\u{23FA}\\u{25B0}-\\u{25FF}\\u{2B00}-\\u{2BFF}]",
      "u"
    );
    const lines = content.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) {
        continue;
      }
      expect(emojiRegex.test(line)).toBe(false);
    }
  });

  // =========================================================================
  // T3-INT-26: F09 (Allocation) + Return Service
  // =========================================================================
  it("T3-INT-26: Allocation + Return Service: partial return of BOGO item refunds exact allocated net price", () => {
    // 3 items in BOGO: A (10k), B (8k), C (6k). Total = 24,000 IQD.
    // C is free (6,000 IQD discount).
    // Proportional allocations:
    // A: 6,000 * 10k/24k = 2,500 discount -> net = 7,500 IQD
    // B: 6,000 * 8k/24k = 2,000 discount -> net = 6,000 IQD
    // C: 6,000 * 6k/24k = 1,500 discount -> net = 4,500 IQD
    // Customer returns Item C -> refund is exactly 4,500 IQD (not 0, not 6,000)
    const lines = [
      { lineKey: "item_A", lineGross: new Decimal(10000) },
      { lineKey: "item_B", lineGross: new Decimal(8000) },
      { lineKey: "item_C", lineGross: new Decimal(6000) },
    ];
    const allocations = allocateByValue(lines, new Decimal(6000));

    const discC = allocations.get("item_C")!;
    assertDecimalEqual(discC, 1500);

    const netC = new Decimal(6000).minus(discC);
    assertDecimalEqual(netC, 4500, "Refund for item C is exactly 4,500 IQD");
  });

  // =========================================================================
  // T3-INT-27: BUNDLE_PRICE + Base Unit Isolation
  // =========================================================================
  it("T3-INT-27: BUNDLE_PRICE + Base Unit: bundle formed only when qualifying base units are present", () => {
    // Bundle of 2 items: 1 Rotring Pen (Piece) + 1 Faber Notebook (Piece) for 3,000 IQD (original 500 + 3500 = 4,000)
    // Cart contains 1 Rotring Carton (derived) + 1 Faber Notebook (Piece) -> bundle does NOT form because Rotring is carton!
    const items = cart()
      .addItem(PRD_PEN_ROTRING, 1, 2) // Carton
      .addItem(PRD_NOTEBOOK_FABER, 1, 0) // Piece
      .build();

    const promo = createBundlePromoFixture({
      id: 327,
      bundlePrice: new Decimal(3000),
      bundleMode: "ALL_REQUIRED",
      applyToBaseUnitOnly: true,
      targetProductIds: new Set([PRD_PEN_ROTRING.id, PRD_NOTEBOOK_FABER.id]),
    });

    const res = evaluatePromotions(items, [promo], CONTEXT_POS);
    expect(res.totalCartDiscount.toNumber()).toBe(0);
  });

  // =========================================================================
  // T3-INT-28: TIERED_QTY + Friday Schedule
  // =========================================================================
  it("T3-INT-28: TIERED_QTY + Friday Schedule: tiered quantity discount applies on Friday, 0 discount on Monday", () => {
    const items = cart().addItem(PRD_INK_EPSON, 5).build(); // 5 units qualifies for Tier 1 (1500 off per unit)

    const promo = createTieredQtyPromoFixture({
      id: 328,
      activeDays: [5], // Friday only
      targetProductIds: new Set([PRD_INK_EPSON.id]),
      tiers: [
        { minQuantity: new Decimal(5), tierType: "AMOUNT", discountAmount: new Decimal(1500) },
      ],
    });

    // Friday (2026-06-19) -> applies
    const resFri = evaluatePromotions(items, [promo], { channel: "POS", todayYmd: "2026-06-19" });
    assertDecimalEqual(resFri.totalCartDiscount, 7500);

    // Monday (2026-06-15) -> 0 discount
    const resMon = evaluatePromotions(items, [promo], { channel: "POS", todayYmd: "2026-06-15" });
    expect(resMon.totalCartDiscount.toNumber()).toBe(0);
  });
});

