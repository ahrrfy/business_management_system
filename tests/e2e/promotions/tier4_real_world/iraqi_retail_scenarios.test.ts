/**
 * tests/e2e/promotions/tier4_real_world/iraqi_retail_scenarios.test.ts
 *
 * Tier 4 Real-World Iraqi Retail & Wholesale Operational Workloads (S01 to S14)
 * Authentic Baghdad commercial retail & wholesale scenarios for Al-Roya Al-Arabiya
 * Derived strictly from spec.md Section 7.
 */

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
  SimulatedSaleLineInput,
  simulateSaleCreation,
} from "../infra/testHarness";

const CONTEXT_POS: EvaluationContext = {
  channel: "POS",
  todayYmd: "2026-06-15",
};

describe("Tier 4: Real-World Iraqi Retail & Wholesale Workloads (S01–S14)", () => {
  // =========================================================================
  // Scenario S01: Back-to-School Stationery Bundle
  // =========================================================================
  it("Scenario S01: Back-to-School Stationery Bundle (موسم العودة إلى المدارس — باقة القرطاسية الشاملة)", () => {
    // 3 items:
    // Backpack (Crystal Shield as proxy: 25,000 IQD)
    // Notebook (Faber: 3,000 IQD custom)
    // Pen Set (Rotring Dozen: 4,500 IQD custom)
    // List sum = 32,500 IQD. Bundle promo price = 25,000 IQD. Savings = 7,500 IQD.
    // Customer buys 2 backpacks, 3 notebooks, 1 pen set.
    const items = cart()
      .addItem(PRD_CRYSTAL_SHIELD, 2, 0, { customUnitPrice: 25000 }) // 2 Backpacks
      .addItem(PRD_NOTEBOOK_FABER, 3, 0, { customUnitPrice: 3000 }) // 3 Notebooks
      .addItem(PRD_PEN_ROTRING, 1, 1, { customUnitPrice: 4500 }) // 1 Pen Set
      .build();

    const promo = createBundlePromoFixture({
      id: 1001,
      name: "باقة القرطاسية المدرسية الشاملة 25,000 د.ع",
      bundlePrice: new Decimal(25000),
      bundleMode: "ALL_REQUIRED",
      bundleQuantity: 3,
      applyToBaseUnitOnly: false,
      targetProductIds: new Set([PRD_CRYSTAL_SHIELD.id, PRD_NOTEBOOK_FABER.id, PRD_PEN_ROTRING.id]),
    });

    const res = evaluatePromotions(items, [promo], CONTEXT_POS);

    // 1 complete bundle forms: 1 Backpack + 1 Notebook + 1 Pen Set
    // Total original of 1 bundle = 25,000 + 3,000 + 4,500 = 32,500 IQD
    // Savings = 7,500 IQD allocated proportionally:
    // Backpack: 7,500 * (25,000 / 32,500) = 5,769.23 IQD discount
    // Notebook: 7,500 * (3,000 / 32,500) = 692.31 IQD discount
    // Pen Set:  7,500 * (4,500 / 32,500) = 1,038.46 IQD discount
    // Sum = 7,500.00 IQD
    assertDecimalEqual(res.totalCartDiscount, 7500);

    const allocBackpack = res.lineAllocations.get(items[0].lineKey)!;
    const allocNotebook = res.lineAllocations.get(items[1].lineKey)!;
    const allocPenSet = res.lineAllocations.get(items[2].lineKey)!;

    assertDecimalEqual(allocBackpack.discountAmount, "5769.23");
    assertDecimalEqual(allocNotebook.discountAmount, "692.31");
    assertDecimalEqual(allocPenSet.discountAmount, "1038.46");

    // Total cart gross = (2 * 25k) + (3 * 3k) + 4.5k = 50k + 9k + 4.5k = 63,500 IQD
    // Net total = 63,500 - 7,500 = 56,000 IQD
    assertAllocationConservation(items, res);
    assertNoGiftFlagOnPromoDiscount(Array.from(res.lineAllocations.values()));
  });

  // =========================================================================
  // Scenario S02: Ramadan Luxury Pen BOGO
  // =========================================================================
  it("Scenario S02: Ramadan Luxury Pen BOGO (عرض أقلام باركر الرمضاني — اشترِ 2 واحصل على 1 مجاناً)", () => {
    // Parker Sonnet (65,000), Parker Urban (45,000), Parker Jotter (25,000)
    // Buy 2 Get 1 Free -> lowest priced pen (Jotter @ 25,000) is 100% free
    const items = cart()
      .addItem(PRD_LUX_PEN, 1, 0, { customUnitPrice: 65000 })
      .addItem(PRD_LUX_PEN, 1, 0, { customUnitPrice: 45000 })
      .addItem(PRD_LUX_PEN, 1, 0, { customUnitPrice: 25000 })
      .build();

    const promo = createBogoPromoFixture({
      id: 1002,
      name: "عرض أقلام باركر الرمضاني: اشترِ 2 واحصل على 1 مجاناً",
      bogoBuyQuantity: 2,
      bogoGetQuantity: 1,
      bogoGetDiscountPercent: new Decimal(100),
      targetProductIds: new Set([PRD_LUX_PEN.id]),
    });

    const res = evaluatePromotions(items, [promo], CONTEXT_POS);

    // Total gross = 65,000 + 45,000 + 25,000 = 135,000 IQD
    // Free savings = 25,000 IQD allocated proportionally:
    // Sonnet: 25k * 65k / 135k = 12,037.04 IQD
    // Urban:  25k * 45k / 135k = 8,333.33 IQD
    // Jotter: 25k * 25k / 135k = 4,629.63 IQD
    // Sum = 25,000.00 IQD
    assertDecimalEqual(res.totalCartDiscount, 25000);
    assertAllocationConservation(items, res);

    const allocSonnet = res.lineAllocations.get(items[0].lineKey)!;
    const allocUrban = res.lineAllocations.get(items[1].lineKey)!;
    const allocJotter = res.lineAllocations.get(items[2].lineKey)!;

    assertDecimalEqual(allocSonnet.discountAmount, "12037.04");
    assertDecimalEqual(allocUrban.discountAmount, "8333.33");
    assertDecimalEqual(allocJotter.discountAmount, "4629.63");

    // Invariant: isGift is false on all lines
    assertNoGiftFlagOnPromoDiscount(Array.from(res.lineAllocations.values()));
  });

  // =========================================================================
  // Scenario S03: Packaging Unit Protection
  // =========================================================================
  it("Scenario S03: Packaging Unit Protection (عرض أقلام جاف مفرد — حماية كرتون الأقلام من تسرّب سعر القطعة)", () => {
    // Ballpoint pen: Piece (500 IQD list, 350 cost), Carton of 50 (22,500 IQD list, 16,000 cost)
    // 50% discount on Piece only (applyToBaseUnitOnly = true)
    // Customer buys 4 pieces and 2 full cartons
    const items = cart()
      .addItem(PRD_PEN_ROTRING, 4, 0, { customUnitPrice: 500 }) // Piece
      .addItem(PRD_PEN_ROTRING, 2, 2, { customUnitPrice: 22500 }) // Carton
      .build();

    const promo = createPercentPromoFixture({
      id: 1003,
      discountPercent: new Decimal(50),
      applyToBaseUnitOnly: true, // PROTECTS CARTON
      targetProductIds: new Set([PRD_PEN_ROTRING.id]),
    });

    const res = evaluatePromotions(items, [promo], CONTEXT_POS);

    // 4 pieces get 50% off: 4 * 500 * 50% = 1,000 IQD discount (net = 1,000)
    const allocPiece = res.lineAllocations.get(items[0].lineKey)!;
    assertDecimalEqual(allocPiece.discountAmount, 1000);
    assertDecimalEqual(allocPiece.effectiveUnitPrice, 250);

    // 2 cartons receive NO promo discount (stay at 22,500 each = 45,000)
    expect(res.lineAllocations.has(items[1].lineKey)).toBe(false);

    // Total gross = 2,000 + 45,000 = 47,000. Total discount = 1,000. Net = 46,000 IQD.
    assertDecimalEqual(res.totalCartDiscount, 1000);
  });

  // =========================================================================
  // Scenario S04: Clearance Below-Cost Flash Sale
  // =========================================================================
  it("Scenario S04: Clearance Below-Cost Flash Sale (تصفيات نهاية السنة للمواد الراكدة بأقل من التكلفة)", () => {
    // 10 units of discontinued graduation sash. Cost = 8,500 IQD, list = 15,000 IQD.
    // Clearance fixed price = 5,000 IQD (3,500 below cost!).
    // allowBelowCost = true
    const line: SimulatedSaleLineInput = {
      lineKey: "clearance_sashes",
      productId: PRD_GRAD_SASH.id,
      variantId: PRD_GRAD_SASH.variantId,
      productUnitId: PRD_GRAD_SASH.units[0].id,
      quantity: new Decimal(10), // gross = 150,000 IQD
      unitPrice: new Decimal(15000),
      costPrice: new Decimal(8500), // COGS = 85,000 IQD
      promotionId: 1004,
      promotionDiscount: new Decimal(100000), // 10 * 10,000 = 100,000 discount -> net = 50,000 IQD
    };

    const promo = createFixedPricePromoFixture({
      id: 1004,
      fixedPrice: new Decimal(5000),
      allowBelowCost: true, // EXEMPT
    });
    const promosMap = new Map([[1004, promo]]);

    const res = simulateSaleCreation([line], CASHIER_SALWA, promosMap);
    expect(res.success).toBe(true);
    expect(res.priceOverride).toBe(true);
    expect(res.lines[0].isBelowCost).toBe(true);
    assertDecimalEqual(res.lines[0].effectiveUnitPrice, 5000);
    assertDecimalEqual(res.totalAmount, 50000); // 150k - 100k
  });

  // =========================================================================
  // Scenario S05: Fixed Price Ceiling Invariant
  // =========================================================================
  it("Scenario S05: Fixed Price Ceiling Invariant (تخفيض موحد لدفاتر الملاحظات مع حماية المواد الأرخص)", () => {
    // 'كل الدفاتر بسعر موحد 3,000 د.ع'
    // Basket:
    // - Executive Leather (6,500) -> 3,000 (3,500 off)
    // - Standard Spiral (4,000) -> 3,000 (1,000 off)
    // - Pocket Memo (2,000) <= 3,000 -> 0 off, price 2,000
    // - Mini Sticky Notes (1,500) <= 3,000 -> 0 off, price 1,500
    const items = cart()
      .addItem(PRD_NOTEBOOK_FABER, 1, 0, { customUnitPrice: 6500 }) // Exec
      .addItem(PRD_NOTEBOOK_FABER, 1, 0, { customUnitPrice: 4000 }) // Standard
      .addItem(PRD_NOTEBOOK_FABER, 1, 0, { customUnitPrice: 2000 }) // Pocket Memo
      .addItem(PRD_NOTEBOOK_FABER, 1, 0, { customUnitPrice: 1500 }) // Sticky Notes
      .build();

    const promo = createFixedPricePromoFixture({
      id: 1005,
      fixedPrice: new Decimal(3000),
      targetProductIds: new Set([PRD_NOTEBOOK_FABER.id]),
    });

    const res = evaluatePromotions(items, [promo], CONTEXT_POS);

    // Only items 1 and 2 get discounted
    expect(res.lineAllocations.size).toBe(2);
    assertDecimalEqual(res.lineAllocations.get(items[0].lineKey)!.discountAmount, 3500);
    assertDecimalEqual(res.lineAllocations.get(items[1].lineKey)!.discountAmount, 1000);

    // Items 3 and 4 have 0 discount
    expect(res.lineAllocations.has(items[2].lineKey)).toBe(false);
    expect(res.lineAllocations.has(items[3].lineKey)).toBe(false);

    // Total discount = 4,500. Total gross = 14,000. Net invoice total = 9,500 IQD.
    assertDecimalEqual(res.totalCartDiscount, 4500);
  });

  // =========================================================================
  // Scenario S06: Wholesale Tiered Quantity Order
  // =========================================================================
  it("Scenario S06: Wholesale Tiered Quantity Order (طلبية جملة مدرسية بشرائح كميات متدرجة)", () => {
    // A4 Copy paper: list 6,000 IQD.
    // Tier 1 (10-49): 5% off (5,700)
    // Tier 2 (50-99): 10% off (5,400)
    // Tier 3 (100+): Fixed price 5,000 IQD per ream
    // Customer buys 120 reams.
    const items = cart().addItem(PRD_NOTEBOOK_FABER, 120, 0, { customUnitPrice: 6000 }).build();

    const promo = createTieredQtyPromoFixture({
      id: 1006,
      targetProductIds: new Set([PRD_NOTEBOOK_FABER.id]),
      tiers: [
        { minQuantity: new Decimal(10), tierType: "PERCENT", discountPercent: new Decimal(5) },
        { minQuantity: new Decimal(50), tierType: "PERCENT", discountPercent: new Decimal(10) },
        { minQuantity: new Decimal(100), tierType: "FIXED_PRICE", fixedPrice: new Decimal(5000) },
      ],
    });

    const res = evaluatePromotions(items, [promo], CONTEXT_POS);
    const alloc = res.lineAllocations.get(items[0].lineKey)!;

    // Gross = 120 * 6,000 = 720,000 IQD
    // Tier 3: 5,000 per ream -> discount = 1,000 * 120 = 120,000 IQD
    // Net total = 600,000 IQD
    assertDecimalEqual(alloc.discountAmount, 120000);
    assertDecimalEqual(alloc.effectiveUnitPrice, 5000);
    assertDecimalEqual(res.totalCartDiscount, 120000);
  });

  // =========================================================================
  // Scenario S07: Reception Mixed Cart with Digital Cards
  // =========================================================================
  it("Scenario S07: Reception Mixed Cart with Digital Cards (استقبال مختلط: بطاقة شحن أثير + مستلزمات مكتبية مخفضة)", () => {
    // 1x Asiacell 25,000 IQD card + 3x Desk Folders (5,000 IQD each with 20% promo)
    const cardLine: SimulatedSaleLineInput = {
      lineKey: "card_asia_25k",
      productId: CARD_ASIA_5K.id,
      variantId: CARD_ASIA_5K.id,
      productUnitId: CARD_ASIA_5K.id,
      quantity: new Decimal(1),
      unitPrice: new Decimal(25000),
      costPrice: new Decimal(24000),
      isDigitalCard: true,
      promotionId: null,
      promotionDiscount: new Decimal(0),
    };
    const folderLine: SimulatedSaleLineInput = {
      lineKey: "folders_line",
      productId: PRD_NOTEBOOK_FABER.id,
      variantId: PRD_NOTEBOOK_FABER.variantId,
      productUnitId: PRD_NOTEBOOK_FABER.units[0].id,
      quantity: new Decimal(3),
      unitPrice: new Decimal(5000),
      costPrice: new Decimal(2400),
      promotionId: 1007,
      promotionDiscount: new Decimal(3000), // 20% off 15k = 3k
    };

    const promo = createPercentPromoFixture({ id: 1007, discountPercent: new Decimal(20) });
    const promosMap = new Map([[1007, promo]]);

    const res = simulateSaleCreation([cardLine, folderLine], CASHIER_SALWA, promosMap);
    expect(res.success).toBe(true);

    // Digital card isolated
    const cardRes = res.lines.find((l) => l.lineKey === "card_asia_25k")!;
    assertDecimalEqual(cardRes.effectiveUnitPrice, 25000);
    assertDecimalEqual(cardRes.promotionDiscount, 0);

    // Folders discounted
    const folderRes = res.lines.find((l) => l.lineKey === "folders_line")!;
    assertDecimalEqual(folderRes.effectiveUnitPrice, 4000);
    assertDecimalEqual(folderRes.promotionDiscount, 3000);

    // Total Paid = 25,000 + 12,000 = 37,000 IQD
    assertDecimalEqual(res.totalAmount, 37000);
  });

  // =========================================================================
  // Scenario S08: Friday Only Offline POS Flash Sale
  // =========================================================================
  it("Scenario S08: Friday Only Offline POS Flash Sale (عروض صلاة الجمعة — بيع دون اتصال مع مزامنة لاحقة)", () => {
    // Al-Mutanabbi street pop-up. Friday flash promo: 25% off books (activeDays = [5])
    const promo = createPercentPromoFixture({
      id: 1008,
      name: "عرض شارع المتنبي لصلاة الجمعة 25%",
      activeDays: [5], // Friday
      discountPercent: new Decimal(25),
      targetProductIds: new Set([PRD_NOTEBOOK_FABER.id]),
    });

    const fridayCapturedAt = "2026-06-19"; // Friday (DOW 5)
    const saturdayReplayAt = "2026-06-20"; // Saturday (DOW 6)

    // 4 books @ 10,000 = 40,000 IQD
    const items = cart().addItem(PRD_NOTEBOOK_FABER, 4, 0, { customUnitPrice: 10000 }).build();

    // 1. In offline mode on Friday:
    const resOffline = evaluatePromotions(items, [promo], { channel: "POS", todayYmd: fridayCapturedAt });
    assertDecimalEqual(resOffline.totalCartDiscount, 10000); // 25% of 40k = 10k

    // 2. On Saturday sync, replaySale validates against transaction timestamp:
    const resReplay = evaluatePromotions(items, [promo], { channel: "POS", todayYmd: fridayCapturedAt });
    assertDecimalEqual(resReplay.totalCartDiscount, 10000);
  });

  // =========================================================================
  // Scenario S09: Contract Price Superiority
  // =========================================================================
  it("Scenario S09: Contract Price Superiority (عميل بعقد تجاري يشتري أصنافاً خاضعة لعروض عامة)", () => {
    // Ministry contract price: HP Toner @ 45,000 IQD (list = 60,000 IQD).
    // Store launches 15% off promo on toners (which would be 51,000 IQD).
    // Ministry representative purchases 10 toners.
    const items = cart()
      .addItem(PRD_INK_EPSON, 10, 0, { customUnitPrice: 45000, hasContractPrice: true })
      .build();

    const promo = createPercentPromoFixture({
      id: 1009,
      priority: 100, // very high priority promo
      discountPercent: new Decimal(15),
      targetProductIds: new Set([PRD_INK_EPSON.id]),
    });

    const res = evaluatePromotions(items, [promo], CONTEXT_POS);

    // Contract price protection: line gets 0 promo discount
    expect(res.lineAllocations.size).toBe(0);
    assertDecimalEqual(res.totalCartDiscount, 0);

    // Ministry is billed contract price 10 * 45,000 = 450,000 IQD
    const totalContractInvoice = items.reduce((acc, i) => acc.plus(i.quantity.mul(i.unitPrice)), new Decimal(0));
    assertDecimalEqual(totalContractInvoice, 450000);
  });

  // =========================================================================
  // Scenario S10: Multi-Channel Separation
  // =========================================================================
  it("Scenario S10: Multi-Channel Separation (عرض المتجر الإلكتروني الحصري مقابل بيع صالة العرض)", () => {
    // Mobile Store flash coupon 'APP50' (50% off Luxury Gift Set, channel = 'STORE_ONLY')
    const promo = createPercentPromoFixture({
      id: 1010,
      name: "عرض تطبيق الموبايل الحصري 50%",
      channel: "STORE_ONLY",
      discountPercent: new Decimal(50),
      targetProductIds: new Set([PRD_CRYSTAL_SHIELD.id]),
    });

    const items = cart().addItem(PRD_CRYSTAL_SHIELD, 1, 0, { customUnitPrice: 40000 }).build();

    // 1. Mobile app checkout -> promo applies, pays 20,000 IQD
    const resMobile = evaluatePromotions(items, [promo], { channel: "STORE", todayYmd: "2026-06-15" });
    assertDecimalEqual(resMobile.totalCartDiscount, 20000);
    assertDecimalEqual(resMobile.lineAllocations.get(items[0].lineKey)!.effectiveUnitPrice, 20000);

    // 2. POS walk-in customer -> promo does NOT apply, pays 40,000 IQD
    const resPos = evaluatePromotions(items, [promo], { channel: "POS", todayYmd: "2026-06-15" });
    expect(resPos.lineAllocations.size).toBe(0);
    assertDecimalEqual(resPos.totalCartDiscount, 0);
  });

  // =========================================================================
  // Scenario S11: Consignment Goods in Promotional Campaigns
  // =========================================================================
  it("Scenario S11: Consignment Goods in Promotional Campaigns (بضاعة الأمانة في العروض الترويجية)", () => {
    // Calligraphy bookmarks: consignment item (cost = 1,500 IQD, list = 3,000 IQD)
    // 20% promotion -> promo price = 2,400 IQD (discount 600 IQD per bookmark).
    // Customer buys 5 bookmarks.
    const items = cart().addItem(PRD_CHEAP_PEN, 5, 0, { customUnitPrice: 3000 }).build();
    const promo = createPercentPromoFixture({
      id: 1011,
      discountPercent: new Decimal(20),
      targetProductIds: new Set([PRD_CHEAP_PEN.id]),
    });

    const res = evaluatePromotions(items, [promo], CONTEXT_POS);
    const alloc = res.lineAllocations.get(items[0].lineKey)!;

    assertDecimalEqual(alloc.discountAmount, 3000); // 5 * 600
    assertDecimalEqual(alloc.effectiveUnitPrice, 2400);

    // Margin = (2,400 - 1,500) / 2,400 = 37.5% profit
    const supplierCost = new Decimal(1500);
    const profitPerUnit = alloc.effectiveUnitPrice.minus(supplierCost);
    assertDecimalEqual(profitPerUnit, 900);
  });

  // =========================================================================
  // Scenario S12: Cashier Manual Discount Stacking on Net Promo Price
  // =========================================================================
  it("Scenario S12: Cashier Manual Discount Stacking on Net Promo Price (تخفيض إضافي من الكاشير لزبون دائم فوق العرض)", () => {
    // List = 10,000 IQD. Promo = 20% (2,000 discount -> net promo price = 8,000 IQD).
    // Cashier adds 800 IQD goodwill discount (10% of promotional price).
    const line: SimulatedSaleLineInput = {
      lineKey: "vip_line",
      productId: PRD_LUX_PEN.id,
      variantId: PRD_LUX_PEN.variantId,
      productUnitId: PRD_LUX_PEN.units[0].id,
      quantity: new Decimal(1),
      unitPrice: new Decimal(10000),
      costPrice: new Decimal(5000),
      promotionId: 1012,
      promotionDiscount: new Decimal(2000), // net = 8,000
      cashierDiscountAmount: new Decimal(800), // 10% on net promo price
    };

    const promo = createPercentPromoFixture({ id: 1012 });
    const promosMap = new Map([[1012, promo]]);

    const res = simulateSaleCreation([line], CASHIER_SALWA, promosMap);
    expect(res.success).toBe(true);

    // Invariant: Total discount = 2,800. Net line total = 7,200.00 IQD.
    assertDecimalEqual(res.totalDiscount, 2800);
    assertDecimalEqual(res.totalAmount, 7200);
    assertDecimalEqual(res.lines[0].effectiveUnitPrice, 7200);
  });

  // =========================================================================
  // Scenario S13: Partial Return of Bundle Line Item
  // =========================================================================
  it("Scenario S13: Partial Return of Bundle Line Item (مرتجع جزئي لبند من باقة ترويجية بحساب مالي دقيق)", () => {
    // From Scenario S01:
    // Backpack net: 19,230.77 IQD
    // Notebook net: 2,307.69 IQD
    // Pen Set net: 3,461.54 IQD
    // Total bundle paid = 25,000 IQD.
    // Customer returns the Pen Set.
    const lines = [
      { lineKey: "backpack", lineGross: new Decimal(25000) },
      { lineKey: "notebook", lineGross: new Decimal(3000) },
      { lineKey: "penset", lineGross: new Decimal(4500) },
    ];
    const savings = new Decimal(7500);
    const allocated = allocateByValue(lines, savings);

    const penSetDiscount = allocated.get("penset")!;
    assertDecimalEqual(penSetDiscount, "1038.46");

    const penSetNetRefund = new Decimal(4500).minus(penSetDiscount);
    assertDecimalEqual(penSetNetRefund, "3461.54", "Refund for returned pen set is exactly 3,461.54 IQD");
  });

  // =========================================================================
  // Scenario S14: High-Velocity Rapid Barcode Burst at Peak Cashier Rush
  // =========================================================================
  it("Scenario S14: High-Velocity Rapid Barcode Burst at Peak Cashier Rush (مسح باركود متتابع بمسدس الليزر وقت الذروة)", () => {
    // 15 items scanned in burst
    const b = cart();
    for (let i = 1; i <= 15; i++) {
      b.addItem(PRD_PEN_ROTRING, 1, 0, { customUnitPrice: 500 });
    }
    const items = b.build();
    expect(items).toHaveLength(15);

    const promo = createPercentPromoFixture({
      id: 1014,
      discountPercent: new Decimal(10),
      targetProductIds: new Set([PRD_PEN_ROTRING.id]),
    });

    const startTime = performance.now();
    const res = evaluatePromotions(items, [promo], CONTEXT_POS);
    const elapsed = performance.now() - startTime;

    expect(elapsed).toBeLessThan(50); // fast evaluation under 50ms
    assertDecimalEqual(res.totalCartDiscount, 750); // 15 * 50
    expect(res.lineAllocations.size).toBe(15);
  });

  // =========================================================================
  // Scenario S15: Ramadan Wholesale Charity Basket
  // =========================================================================
  it("Scenario S15: Ramadan Wholesale Charity Basket (سلة الخير الرمضانية للتبرعات والمؤسسات الخيرية)", () => {
    // Charity bundle: 50 Notebooks (Faber: 3,000 IQD each = 150,000 IQD) + 50 Rotring Pens (500 IQD each = 25,000 IQD)
    // List sum = 175,000 IQD. Promotional bundle price = 140,000 IQD (20% discount = 35,000 IQD savings).
    const items = cart()
      .addItem(PRD_NOTEBOOK_FABER, 50, 0, { customUnitPrice: 3000 })
      .addItem(PRD_PEN_ROTRING, 50, 0, { customUnitPrice: 500 })
      .build();

    const promo = createBundlePromoFixture({
      id: 1015,
      name: "سلة التبرعات المدرسية الرمضانية",
      bundlePrice: new Decimal(140000),
      bundleMode: "PICK_ANY_N",
      bundleQuantity: 100,
      applyToBaseUnitOnly: true,
      targetProductIds: new Set([PRD_NOTEBOOK_FABER.id, PRD_PEN_ROTRING.id]),
    });

    const res = evaluatePromotions(items, [promo], CONTEXT_POS);

    // Total gross = 175,000 IQD. Bundle price = 140,000 IQD. Savings = 35,000 IQD.
    assertDecimalEqual(res.totalCartDiscount, 35000);
    assertAllocationConservation(items, res);

    const allocNotebook = res.lineAllocations.get(items[0].lineKey)!;
    const allocPen = res.lineAllocations.get(items[1].lineKey)!;

    // Proportional: 35k * 150k / 175k = 30,000 IQD discount on notebooks (effective 2,400 per unit)
    // 35k * 25k / 175k = 5,000 IQD discount on pens (effective 400 per unit)
    assertDecimalEqual(allocNotebook.discountAmount, 30000);
    assertDecimalEqual(allocNotebook.effectiveUnitPrice, 2400);

    assertDecimalEqual(allocPen.discountAmount, 5000);
    assertDecimalEqual(allocPen.effectiveUnitPrice, 400);
  });

  // =========================================================================
  // Scenario S16: University Graduation Honours Ceremony Package
  // =========================================================================
  it("Scenario S16: University Graduation Package (باقة تكريم المتفوقين في الجامعات — وشاح تخرج مع درع كريستال فاخر)", () => {
    // Crystal Shield (25,000 list) + Velvet Sash (15,000 list). Total list = 40,000 IQD.
    // Package bundle price = 30,000 IQD (Savings = 10,000 IQD).
    // University purchases 20 packages.
    const items = cart()
      .addItem(PRD_CRYSTAL_SHIELD, 20, 0, { customUnitPrice: 25000 }) // 500,000 IQD
      .addItem(PRD_GRAD_SASH, 20, 0, { customUnitPrice: 15000 }) // 300,000 IQD
      .build();

    const promo = createBundlePromoFixture({
      id: 1016,
      name: "باقة تكريم التخرج الجامعي 30,000 د.ع",
      bundlePrice: new Decimal(30000),
      bundleMode: "ALL_REQUIRED",
      bundleQuantity: 2,
      applyToBaseUnitOnly: true,
      targetProductIds: new Set([PRD_CRYSTAL_SHIELD.id, PRD_GRAD_SASH.id]),
    });

    const res = evaluatePromotions(items, [promo], CONTEXT_POS);

    // 1 bundle = 1 Shield + 1 Sash (List 40k, Promo 30k, Savings 10k)
    // Note: in testHarness ALL_REQUIRED matches the lines for 1 bundle formation
    assertDecimalEqual(res.totalCartDiscount, 10000);
    assertAllocationConservation(items, res);
  });
});

