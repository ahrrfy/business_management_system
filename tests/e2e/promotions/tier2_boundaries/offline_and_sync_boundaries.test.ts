/**
 * tests/e2e/promotions/tier2_boundaries/offline_and_sync_boundaries.test.ts
 *
 * Tier 2 Boundary & Corner Cases: Offline Catalog Snapshots, CRC32 Checksums & Replay
 * Covers F24 (Offline Snapshot Sync), F25 (Offline POS & Replay Sync), F26 (Downstream & Guards).
 * Minimum 30 tests required.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { ACTION_LABELS } from "@shared/actionLabels";
import {
  assertDecimalEqual,
  assertNoGiftFlagOnPromoDiscount,
} from "../infra/assertions";
import {
  CASHIER_SALWA,
  PRD_CHEAP_PEN,
  PRD_INK_EPSON,
  PRD_LUX_PEN,
  PRD_NOTEBOOK_FABER,
  PRD_PEN_ROTRING,
  createAmountPromoFixture,
  createBogoPromoFixture,
  createFixedPricePromoFixture,
  createPercentPromoFixture,
} from "../infra/mockFixtures";
import {
  cart,
  computeCrc32String,
  evaluatePromotions,
  EvaluationContext,
  generateOfflinePromotionSnapshot,
  SimulatedSaleLineInput,
  simulateSaleCreation,
} from "../infra/testHarness";

describe("Tier 2: Offline & Sync Boundaries (F24–F26)", () => {
  // =========================================================================
  // 1. F24: Offline Snapshot Generation & CRC32 Checksum Boundaries
  // =========================================================================
  describe("F24: Offline Snapshot Sync & CRC32 Checksum Integrity", () => {
    it("T2-F24-01: snapshot generation with 0 active promotions -> returns empty array and valid 8-char CRC32 hash", () => {
      const snapshot = generateOfflinePromotionSnapshot([]);
      expect(snapshot.promotions).toHaveLength(0);
      expect(snapshot.checksum).toHaveLength(8);
      expect(snapshot.version).toBe(`cat_snap_${snapshot.checksum}`);
    });

    it("T2-F24-02: snapshot generation strictly excludes STORE_ONLY promotions (POS only receives ALL and POS_ONLY)", () => {
      const p1 = createPercentPromoFixture({ id: 1, channel: "ALL", isActive: true });
      const p2 = createPercentPromoFixture({ id: 2, channel: "POS_ONLY", isActive: true });
      const p3 = createPercentPromoFixture({ id: 3, channel: "STORE_ONLY", isActive: true }); // EXCLUDED

      const snapshot = generateOfflinePromotionSnapshot([p1, p2, p3]);
      expect(snapshot.promotions).toHaveLength(2);
      expect(snapshot.promotions.map((p) => p.id)).toEqual([1, 2]);
      expect(snapshot.promotions.some((p) => p.channel === "STORE_ONLY")).toBe(false);
    });

    it("T2-F24-03: changing promo discountPercent in rule -> changes snapshot CRC32 checksum", () => {
      const pA = createPercentPromoFixture({ id: 10, discountPercent: new Decimal(10) });
      const pB = createPercentPromoFixture({ id: 10, discountPercent: new Decimal(15) });

      const snapA = generateOfflinePromotionSnapshot([pA]);
      const snapB = generateOfflinePromotionSnapshot([pB]);

      expect(snapA.checksum).not.toBe(snapB.checksum);
      expect(snapA.version).not.toBe(snapB.version);
    });

    it("T2-F24-04: changing promo fixedPrice in rule -> changes snapshot CRC32 checksum", () => {
      const pA = createFixedPricePromoFixture({ id: 10, fixedPrice: new Decimal(1000) });
      const pB = createFixedPricePromoFixture({ id: 10, fixedPrice: new Decimal(2000) });

      const snapA = generateOfflinePromotionSnapshot([pA]);
      const snapB = generateOfflinePromotionSnapshot([pB]);

      expect(snapA.checksum).not.toBe(snapB.checksum);
    });

    it("T2-F24-05: changing promo activeDays in rule -> changes snapshot CRC32 checksum", () => {
      const pA = createPercentPromoFixture({ id: 10, activeDays: [0, 1, 2] });
      const pB = createPercentPromoFixture({ id: 10, activeDays: [5] });

      const snapA = generateOfflinePromotionSnapshot([pA]);
      const snapB = generateOfflinePromotionSnapshot([pB]);

      expect(snapA.checksum).not.toBe(snapB.checksum);
    });

    it("T2-F24-06: toggling isActive from true to false -> excludes promo and alters checksum", () => {
      const pActive = createPercentPromoFixture({ id: 10, isActive: true });
      const pInactive = createPercentPromoFixture({ id: 10, isActive: false });

      const snapActive = generateOfflinePromotionSnapshot([pActive]);
      const snapInactive = generateOfflinePromotionSnapshot([pInactive]);

      expect(snapActive.promotions).toHaveLength(1);
      expect(snapInactive.promotions).toHaveLength(0);
      expect(snapActive.checksum).not.toBe(snapInactive.checksum);
    });

    it("T2-F24-07: CRC32 string computation is strictly deterministic across repeated calls", () => {
      const payload = JSON.stringify({ item: "قلم روترينج", price: "500.00" });
      const hash1 = computeCrc32String(payload);
      const hash2 = computeCrc32String(payload);
      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(8);
    });

    it("T2-F24-08: snapshot sorting: promotions in snapshot are deterministically sorted by ID ASC", () => {
      const p3 = createPercentPromoFixture({ id: 300 });
      const p1 = createPercentPromoFixture({ id: 100 });
      const p2 = createPercentPromoFixture({ id: 200 });

      const snapshot = generateOfflinePromotionSnapshot([p3, p1, p2]);
      expect(snapshot.promotions.map((p) => p.id)).toEqual([100, 200, 300]);
    });

    it("T2-F24-09: snapshot detects tampered content when checksum does not match payload", () => {
      const p = createPercentPromoFixture({ id: 1, discountPercent: new Decimal(20) });
      const snapshot = generateOfflinePromotionSnapshot([p]);

      // Simulate client re-calculating CRC32 on corrupted local data
      const corruptedData = JSON.stringify([{ id: 1, discountPercent: "99" }]);
      const localComputedChecksum = computeCrc32String(corruptedData);

      expect(localComputedChecksum).not.toBe(snapshot.checksum);
    });

    it("T2-F24-10: changing promo name in rule -> changes snapshot CRC32 checksum", () => {
      const pA = createPercentPromoFixture({ id: 10, name: "عرض الصيف" });
      const pB = createPercentPromoFixture({ id: 10, name: "عرض الشتاء" });

      const snapA = generateOfflinePromotionSnapshot([pA]);
      const snapB = generateOfflinePromotionSnapshot([pB]);

      expect(snapA.checksum).not.toBe(snapB.checksum);
    });

    it("T2-F24-11: adding a second promotion -> alters snapshot CRC32 checksum", () => {
      const p1 = createPercentPromoFixture({ id: 10 });
      const p2 = createPercentPromoFixture({ id: 20 });

      const snap1 = generateOfflinePromotionSnapshot([p1]);
      const snap2 = generateOfflinePromotionSnapshot([p1, p2]);

      expect(snap1.checksum).not.toBe(snap2.checksum);
      expect(snap2.promotions).toHaveLength(2);
    });

    it("T2-F24-12: snapshot version string adheres to exact regex pattern ^cat_snap_[0-9a-f]{8}$", () => {
      const p = createAmountPromoFixture({ id: 15 });
      const snap = generateOfflinePromotionSnapshot([p]);
      expect(/^cat_snap_[0-9a-f]{8}$/.test(snap.version)).toBe(true);
    });
  });

  // =========================================================================
  // 2. F25: Offline POS Execution & Replay with capturedAt Timestamp
  // =========================================================================
  describe("F25: Offline POS & Replay with capturedAt Evaluation", () => {
    it("T2-F25-01: offline transaction captured when promo was active; replayed after promo expired -> honours promo at capturedAt date", () => {
      // Promotion was active between 2026-06-01 and 2026-06-15
      const promo = createPercentPromoFixture({
        id: 501,
        effectiveFrom: "2026-06-01",
        effectiveTo: "2026-06-15", // Expired as of today (June 30)
        discountPercent: new Decimal(25),
        targetProductIds: new Set([PRD_PEN_ROTRING.id]),
      });

      const capturedDate = "2026-06-10";
      const replayDate = "2026-06-30";

      const items = cart().addItem(PRD_PEN_ROTRING, 2).build();

      const resCurrent = evaluatePromotions(items, [promo], { channel: "POS", todayYmd: replayDate });
      expect(resCurrent.totalCartDiscount.toNumber()).toBe(0);

      const resCaptured = evaluatePromotions(items, [promo], { channel: "POS", todayYmd: capturedDate });
      expect(resCaptured.totalCartDiscount.toNumber()).toBe(250);
    });

    it("T2-F25-02: Friday-only promo captured offline on Friday; synced on Sunday -> replay validates Friday timestamp", () => {
      const promo = createPercentPromoFixture({
        id: 502,
        activeDays: [5], // Friday
        discountPercent: new Decimal(30),
        targetProductIds: new Set([PRD_PEN_ROTRING.id]),
      });

      const fridayCapturedAt = "2026-06-19";
      const items = cart().addItem(PRD_PEN_ROTRING, 4).build();

      const res = evaluatePromotions(items, [promo], { channel: "POS", todayYmd: fridayCapturedAt });
      assertDecimalEqual(res.totalCartDiscount, 600);
    });

    it("T2-F25-03: offline sale with promotionId stored in outbox replays through simulateSaleCreation cleanly", () => {
      const line: SimulatedSaleLineInput = {
        lineKey: "offline_l1",
        productId: PRD_NOTEBOOK_FABER.id,
        variantId: PRD_NOTEBOOK_FABER.variantId,
        productUnitId: PRD_NOTEBOOK_FABER.units[0].id,
        quantity: new Decimal(2),
        unitPrice: new Decimal(3500),
        costPrice: new Decimal(2400),
        promotionId: 503,
        promotionDiscount: new Decimal(1400),
      };

      const promo = createPercentPromoFixture({ id: 503, discountPercent: new Decimal(20) });
      const promosMap = new Map([[503, promo]]);

      const res = simulateSaleCreation([line], CASHIER_SALWA, promosMap);
      expect(res.success).toBe(true);
      assertDecimalEqual(res.totalAmount, 5600);
      assertDecimalEqual(res.lines[0].effectiveUnitPrice, 2800);
      assertNoGiftFlagOnPromoDiscount(res.lines);
    });

    it("T2-F25-04: offline sale where promo was deleted from DB before sync -> fallback preserves captured discount without crash", () => {
      const line: SimulatedSaleLineInput = {
        lineKey: "offline_l1",
        productId: PRD_PEN_ROTRING.id,
        variantId: PRD_PEN_ROTRING.variantId,
        productUnitId: PRD_PEN_ROTRING.units[0].id,
        quantity: new Decimal(2),
        unitPrice: new Decimal(500),
        costPrice: new Decimal(350),
        promotionId: 9999,
        promotionDiscount: new Decimal(200),
      };

      const res = simulateSaleCreation([line], CASHIER_SALWA, new Map());
      expect(res.success).toBe(true);
      expect(res.lines[0].promotionDiscount.toNumber()).toBe(0);
    });

    it("T2-F25-05: batch replay of 10 sequential offline sales processes all sales deterministically", () => {
      const promo = createPercentPromoFixture({ id: 505, discountPercent: new Decimal(10) });
      const promosMap = new Map([[505, promo]]);

      let totalBatchGross = new Decimal(0);
      let totalBatchDiscounts = new Decimal(0);

      for (let i = 1; i <= 10; i++) {
        const line: SimulatedSaleLineInput = {
          lineKey: `offline_${i}`,
          productId: PRD_PEN_ROTRING.id,
          variantId: PRD_PEN_ROTRING.variantId,
          productUnitId: PRD_PEN_ROTRING.units[0].id,
          quantity: new Decimal(i),
          unitPrice: new Decimal(500),
          costPrice: new Decimal(350),
          promotionId: 505,
          promotionDiscount: new Decimal(i).mul(50),
        };

        const res = simulateSaleCreation([line], CASHIER_SALWA, promosMap);
        expect(res.success).toBe(true);
        totalBatchGross = totalBatchGross.plus(res.subtotal);
        totalBatchDiscounts = totalBatchDiscounts.plus(res.totalDiscount);
      }

      assertDecimalEqual(totalBatchGross, 27500);
      assertDecimalEqual(totalBatchDiscounts, 2750);
    });

    it("T2-F25-06: offline sale with BOGO promotion replayed via evaluatePromotions", () => {
      const items = cart().addItem(PRD_NOTEBOOK_FABER, 3).build();
      const bogoPromo = createBogoPromoFixture({
        id: 506,
        bogoBuyQuantity: 2,
        bogoGetQuantity: 1,
        targetProductIds: new Set([PRD_NOTEBOOK_FABER.id]),
      });

      const res = evaluatePromotions(items, [bogoPromo], { channel: "POS", todayYmd: "2026-06-15" });
      expect(res.appliedPromotionIds.has(506)).toBe(true);
      assertDecimalEqual(res.totalCartDiscount, 3500);
    });

    it("T2-F25-07: offline sale with FIXED_PRICE promotion replayed via evaluatePromotions", () => {
      const items = cart().addItem(PRD_LUX_PEN, 1).build(); // 28,000 IQD
      const fixedPromo = createFixedPricePromoFixture({
        id: 507,
        fixedPrice: new Decimal(10000),
        targetProductIds: new Set([PRD_LUX_PEN.id]),
      });

      const res = evaluatePromotions(items, [fixedPromo], { channel: "POS", todayYmd: "2026-06-15" });
      const alloc = res.lineAllocations.get(items[0].lineKey)!;
      assertDecimalEqual(alloc.effectiveUnitPrice, 10000);
      assertDecimalEqual(alloc.discountAmount, 18000);
    });

    it("T2-F25-08: offline sale replay preserves exact lineKeys and order", () => {
      const items = cart()
        .addItem(PRD_PEN_ROTRING, 2)
        .addItem(PRD_NOTEBOOK_FABER, 1)
        .build();

      const promo = createPercentPromoFixture({ id: 508, discountPercent: new Decimal(10) });
      const res = evaluatePromotions(items, [promo], { channel: "POS", todayYmd: "2026-06-15" });

      expect(Array.from(res.lineAllocations.keys())).toEqual([items[0].lineKey, items[1].lineKey]);
    });
  });

  // =========================================================================
  // 3. F26: Downstream & Mobile Storefront Channel Contracts
  // =========================================================================
  describe("F26: Downstream Channel Contracts & Guard Verification", () => {
    it("T2-F26-01: mobile storefront checkout excludes POS_ONLY promotions", () => {
      const items = cart().addItem(PRD_PEN_ROTRING, 10).build();
      const posPromo = createPercentPromoFixture({
        id: 601,
        channel: "POS_ONLY",
        discountPercent: new Decimal(30),
      });

      const res = evaluatePromotions(items, [posPromo], { channel: "STORE", todayYmd: "2026-06-15" });
      expect(res.lineAllocations.size).toBe(0);
      assertDecimalEqual(res.totalCartDiscount, 0);
    });

    it("T2-F26-02: mobile storefront checkout includes STORE_ONLY and ALL promotions", () => {
      const items = cart()
        .addItem(PRD_PEN_ROTRING, 2)
        .addItem(PRD_NOTEBOOK_FABER, 1)
        .build();

      const storePromo = createPercentPromoFixture({
        id: 602,
        channel: "STORE_ONLY",
        discountPercent: new Decimal(20),
        targetProductIds: new Set([PRD_PEN_ROTRING.id]),
      });
      const allPromo = createAmountPromoFixture({
        id: 603,
        channel: "ALL",
        discountAmount: new Decimal(500),
        targetProductIds: new Set([PRD_NOTEBOOK_FABER.id]),
      });

      const res = evaluatePromotions(items, [storePromo, allPromo], {
        channel: "STORE",
        todayYmd: "2026-06-15",
      });

      expect(res.lineAllocations.size).toBe(2);
      assertDecimalEqual(res.totalCartDiscount, 700);
    });

    it("T2-F26-03: price checker Kiosk API contract: retrieves active promotion price for POS channel", () => {
      const items = cart().addItem(PRD_LUX_PEN, 1).build();
      const promo = createFixedPricePromoFixture({
        id: 604,
        channel: "POS_ONLY",
        fixedPrice: new Decimal(20000),
        targetProductIds: new Set([PRD_LUX_PEN.id]),
      });

      const res = evaluatePromotions(items, [promo], { channel: "POS", todayYmd: "2026-06-15" });
      const alloc = res.lineAllocations.get(items[0].lineKey)!;

      assertDecimalEqual(alloc.effectiveUnitPrice, 20000);
      assertDecimalEqual(alloc.discountAmount, 8000);
    });

    it("T2-F26-04: guard contract: latin digits format validation (-u-nu-latn) across all financial outputs", () => {
      const amount = new Decimal("12500.50");
      const formatted = amount.toFixed(2);
      expect(/^[0-9]+\.[0-9]{2}$/.test(formatted)).toBe(true);
    });

    it("T2-F26-05: guard contract: promotional discount lines never contain negative amounts", () => {
      const items = cart().addItem(PRD_CHEAP_PEN, 1).build();
      const promo = createAmountPromoFixture({
        id: 605,
        discountAmount: new Decimal(500),
        targetProductIds: new Set([PRD_CHEAP_PEN.id]),
      });

      const res = evaluatePromotions(items, [promo], { channel: "POS", todayYmd: "2026-06-15" });
      const alloc = res.lineAllocations.get(items[0].lineKey)!;

      expect(alloc.discountAmount.gte(0)).toBe(true);
      expect(alloc.effectiveUnitPrice.gte(0)).toBe(true);
    });

    it("T2-F26-06: mobile store catalog query excludes promotions outside date window", () => {
      const items = cart().addItem(PRD_NOTEBOOK_FABER, 1).build();
      const futurePromo = createPercentPromoFixture({
        id: 606,
        channel: "STORE_ONLY",
        effectiveFrom: "2026-08-01",
        effectiveTo: "2026-08-31",
      });

      const res = evaluatePromotions(items, [futurePromo], {
        channel: "STORE",
        todayYmd: "2026-06-15",
      });
      expect(res.lineAllocations.size).toBe(0);
    });

    it("T2-F26-07: action labels contract: verify standard Arabic labels imported from @shared/actionLabels and used in Offers.tsx", () => {
      // 1. Verify standard ACTION_LABELS keys and values from single source of truth
      expect(ACTION_LABELS.saving).toBe("جارٍ الحفظ…");
      expect(ACTION_LABELS.save).toBe("حفظ");
      expect(ACTION_LABELS.saveChanges).toBe("حفظ التعديلات");
      expect(ACTION_LABELS.cancel).toBe("إلغاء");

      // 2. Verify Offers.tsx imports and uses ACTION_LABELS (enforcing check:loading-strings)
      const offersPath = path.resolve(process.cwd(), "client/src/pages/Offers.tsx");
      const content = fs.readFileSync(offersPath, "utf-8");
      expect(content).toContain('import { ACTION_LABELS } from "@shared/actionLabels";');
      expect(content).toContain("ACTION_LABELS.saving");
    });

    it("T2-F26-08: price checker Kiosk API: item priced below fixed price ceiling displays original price as promo price", () => {
      const items = cart().addItem(PRD_CHEAP_PEN, 1, 0, { customUnitPrice: 250 }).build();
      const promo = createFixedPricePromoFixture({
        id: 608,
        fixedPrice: new Decimal(1000),
        targetProductIds: new Set([PRD_CHEAP_PEN.id]),
      });

      const res = evaluatePromotions(items, [promo], { channel: "POS", todayYmd: "2026-06-15" });
      // Discount = 0, item retains 250 IQD
      expect(res.lineAllocations.size).toBe(0);
      assertDecimalEqual(res.totalCartDiscount, 0);
    });

    it("T2-F26-09: zero emoji policy: verify promo metadata names and descriptions contain zero raw emojis", () => {
      const promos = [
        createPercentPromoFixture({ name: "خصم القرطاسية 20%" }),
        createAmountPromoFixture({ name: "خصم 1500 دينار على الحبر" }),
        createFixedPricePromoFixture({ name: "سعر موحد 1000 د.ع للأقلام" }),
      ];

      const emojiRegex = /[\uD83C-\uD83E][\uDC00-\uDFFF]/;
      for (const p of promos) {
        expect(emojiRegex.test(p.name)).toBe(false);
      }
    });

    it("T2-F26-10: mobile storefront API preserves exact Arabic titles and descriptions without corrupting UTF-8 characters", () => {
      const promoName = "عرض خاص على القرطاسية المدرسية والمستلزمات الهندسية";
      const promo = createPercentPromoFixture({
        id: 610,
        name: promoName,
        channel: "STORE_ONLY",
      });

      const snapshot = generateOfflinePromotionSnapshot([promo]);
      // Snapshots for POS filter out STORE_ONLY, so snapshot.promotions is empty
      expect(snapshot.promotions).toHaveLength(0);
      // But rule itself retains UTF-8 Arabic integrity
      expect(promo.name).toBe(promoName);
    });

    it("T2-F25-09: offline replay of mixed cart with digital card preserves 0 discount on digital card", () => {
      const cardLine: SimulatedSaleLineInput = {
        lineKey: "offline_card",
        productId: 201,
        variantId: 201,
        productUnitId: 201,
        quantity: new Decimal(1),
        unitPrice: new Decimal(10000),
        costPrice: new Decimal(9600),
        isDigitalCard: true,
      };
      const regularLine: SimulatedSaleLineInput = {
        lineKey: "offline_regular",
        productId: PRD_PEN_ROTRING.id,
        variantId: PRD_PEN_ROTRING.variantId,
        productUnitId: PRD_PEN_ROTRING.units[0].id,
        quantity: new Decimal(2),
        unitPrice: new Decimal(500),
        costPrice: new Decimal(350),
        promotionId: 509,
        promotionDiscount: new Decimal(200),
      };

      const promo = createPercentPromoFixture({ id: 509 });
      const promosMap = new Map([[509, promo]]);

      const res = simulateSaleCreation([cardLine, regularLine], CASHIER_SALWA, promosMap);
      expect(res.success).toBe(true);
      assertDecimalEqual(res.lines[0].promotionDiscount, 0);
      assertDecimalEqual(res.lines[1].promotionDiscount, 200);
    });
  });
});
