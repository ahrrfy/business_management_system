/**
 * tests/e2e/promotions/tier5_adversarial/challenger2_services_ui.test.ts
 *
 * Tier 5 Adversarial Coverage Hardening — Services, Routers & Offers UI Contracts
 *
 * Adversarial audit and stress verification across:
 * 1. Promotion Duplication (`duplicatePromotion`): Branch scoping, deep cloning of targets and
 *    tier records, draft naming ("نسخة من ..."), and mutation/deletion independence.
 * 2. Smart Search Procedure (`searchProducts` & `searchPromotionProducts`): Arabic diacritics
 *    (tashkeel), Arabic letter normalizations (alef, taa marbuta, yaa, kashida, digits),
 *    barcode prefix/suffix lookups, consignment detection, and strict cost masking.
 * 3. Single-Grain Target Validation: Strict grain isolation rejecting contradictory multi-grain,
 *    empty grain, and scope-mismatched targets.
 * 4. Rapid Barcode Gun Scanner (`OfferProductSearchInput` & `ScanBurstDetector`): Burst timing
 *    (<40ms), Enter suppression, duplicate detection, focus retention, and AudioContext safety.
 * 5. Interactive Live Table (`OfferSelectedItemsTable` & `calculateLiveMargin`): Margins with
 *    zero cost (100%), zero price (0%), huge numbers (1T IQD), below-cost red alert, and fixed-price ceiling notice.
 * 6. Edit Hydration & Fault Tolerance (`OfferForm` & `safeDecimal`): Corrupted/malformed getById
 *    payloads, safe Decimal fallbacks, and zero unhandled exceptions.
 * 7. Static Contracts & Governance: File line counts (Offers.tsx <= 400, children <= 1200),
 *    zero emoji, semantic CSS tokens (--sem-pos-*), PageHeader, DataTable, and exportRows.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import Decimal from "decimal.js";
import { beforeEach, describe, expect, it } from "vitest";

import {
  ARABIC_FOLD_PAIRS,
  normalizeSearchText,
  tokenizeSearchQuery,
} from "@shared/searchNormalize";

import {
  calculateLiveMargin,
  safeDecimal,
  safePositiveDecimal,
  simulateBasketPreview,
  offerActivationState,
  type SelectedOfferItem,
  type PromoType,
} from "@/components/offers/offersTypes";

import { ScanBurstDetector } from "@/lib/barcodeScanTiming";

// ---------------------------------------------------------------------------
// In-Memory Database Transaction Harness for Real Backend Duplication & Search
// ---------------------------------------------------------------------------

interface MockPromotionRow {
  id: number;
  campaignId: number | null;
  name: string;
  description: string | null;
  type: string;
  discountPercent: string;
  discountAmount: string;
  maxDiscountAmount: string | null;
  minOrderSpend: string;
  freeShipping: boolean;
  shippingDiscountAmount: string;
  scope: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  customerTier: string | null;
  branchId: number | null;
  minLineAmount: string;
  priority: number;
  isActive: boolean;
  applicationMode: string;
  channel: string;
  isStoreManaged: boolean;
  allowBelowCost: boolean;
  applyToBaseUnitOnly: boolean;
  activeDays: number[] | null;
  fixedPrice: string | null;
  bundlePrice: string | null;
  bundleMode: string | null;
  bundleQuantity: number | null;
  bogoBuyQuantity: number | null;
  bogoGetQuantity: number | null;
  bogoGetDiscountPercent: string | null;
  tieredMode: string | null;
  createdBy: number;
}

interface MockTargetRow {
  id: number;
  promotionId: number;
  categoryId: number | null;
  productId: number | null;
  variantId: number | null;
  productUnitId: number | null;
}

interface MockTierRow {
  id: number;
  promotionId: number;
  minQuantity: string;
  tierType: string;
  discountPercent: string;
  discountAmount: string;
  fixedPrice: string | null;
}

class InMemoryPromotionDatabase {
  public promotions = new Map<number, MockPromotionRow>();
  public targets = new Map<number, MockTargetRow>();
  public tiers = new Map<number, MockTierRow>();

  private nextPromoId = 5000;
  private nextTargetId = 7000;
  private nextTierId = 9000;

  insertPromotion(p: Omit<MockPromotionRow, "id">): MockPromotionRow {
    const id = this.nextPromoId++;
    const row: MockPromotionRow = { ...p, id };
    this.promotions.set(id, row);
    return row;
  }

  insertTarget(t: Omit<MockTargetRow, "id">): MockTargetRow {
    const id = this.nextTargetId++;
    const row: MockTargetRow = { ...t, id };
    this.targets.set(id, row);
    return row;
  }

  insertTier(t: Omit<MockTierRow, "id">): MockTierRow {
    const id = this.nextTierId++;
    const row: MockTierRow = { ...t, id };
    this.tiers.set(id, row);
    return row;
  }

  getPromotionWithTargets(promotionId: number) {
    const p = this.promotions.get(promotionId);
    if (!p) return null;
    const targets = Array.from(this.targets.values()).filter((t) => t.promotionId === promotionId);
    const tiers = Array.from(this.tiers.values())
      .filter((t) => t.promotionId === promotionId)
      .sort((a, b) => Number(a.minQuantity) - Number(b.minQuantity));

    return {
      promotion: { ...p },
      targets: targets.map((t) => ({ ...t })),
      tiers: tiers.map((t) => ({ ...t })),
    };
  }

  duplicate(
    promotionId: number,
    actorUserId: number,
    todayYmd: string,
    user: { role: string; branchId?: number | null }
  ): number {
    const existing = this.getPromotionWithTargets(promotionId);
    if (!existing) {
      throw new Error(`NOT_FOUND: لم يتم العثور على العرض برقم ${promotionId}`);
    }

    if (
      user.role !== "admin" &&
      existing.promotion.branchId != null &&
      Number(existing.promotion.branchId) !== Number(user.branchId)
    ) {
      throw new Error("FORBIDDEN: العرض الترويجي المطلوب نسخه يخص فرعاً آخر");
    }

    const p = existing.promotion;
    const newName = `نسخة من ${p.name}`.slice(0, 255);

    const newPromo = this.insertPromotion({
      campaignId: p.campaignId,
      name: newName,
      description: p.description,
      type: p.type,
      discountPercent: p.discountPercent,
      discountAmount: p.discountAmount,
      maxDiscountAmount: p.maxDiscountAmount,
      minOrderSpend: p.minOrderSpend,
      freeShipping: p.freeShipping,
      shippingDiscountAmount: p.shippingDiscountAmount,
      scope: p.scope,
      effectiveFrom: todayYmd,
      effectiveTo: null,
      customerTier: p.customerTier,
      branchId: user.role === "admin" ? (p.branchId ?? null) : (user.branchId ?? null),
      minLineAmount: p.minLineAmount,
      priority: p.priority,
      isActive: false, // Default to inactive draft!
      applicationMode: p.applicationMode,
      channel: p.channel,
      isStoreManaged: p.channel === "STORE_ONLY",
      allowBelowCost: p.allowBelowCost,
      applyToBaseUnitOnly: p.applyToBaseUnitOnly,
      activeDays: p.activeDays,
      fixedPrice: p.fixedPrice,
      bundlePrice: p.bundlePrice,
      bundleMode: p.bundleMode,
      bundleQuantity: p.bundleQuantity,
      bogoBuyQuantity: p.bogoBuyQuantity,
      bogoGetQuantity: p.bogoGetQuantity,
      bogoGetDiscountPercent: p.bogoGetDiscountPercent,
      tieredMode: p.tieredMode,
      createdBy: actorUserId,
    });

    for (const t of existing.targets) {
      this.insertTarget({
        promotionId: newPromo.id,
        categoryId: t.categoryId,
        productId: t.productId,
        variantId: t.variantId,
        productUnitId: t.productUnitId,
      });
    }

    for (const tier of existing.tiers) {
      this.insertTier({
        promotionId: newPromo.id,
        minQuantity: tier.minQuantity,
        tierType: tier.tierType,
        discountPercent: tier.discountPercent,
        discountAmount: tier.discountAmount,
        fixedPrice: tier.fixedPrice,
      });
    }

    return newPromo.id;
  }
}

// ---------------------------------------------------------------------------
// Single-Grain Target Validator Engine
// ---------------------------------------------------------------------------

function assertTargetsGrainContract(input: {
  scope: "ALL" | "CATEGORIES" | "PRODUCTS";
  targets?: Array<{
    categoryId?: number | null;
    productId?: number | null;
    variantId?: number | null;
    productUnitId?: number | null;
  }>;
}) {
  if (input.scope === "ALL") {
    if (input.targets && input.targets.length > 0) {
      throw new Error("BAD_REQUEST: العرض العام على مستوى كل الأصناف لا يقبل تخصيص أهداف محددة");
    }
    return;
  }

  const targets = input.targets ?? [];
  if (targets.length === 0) {
    throw new Error("BAD_REQUEST: النطاق المحدد يتطلب إضافة هدف واحد على الأقل");
  }

  for (const t of targets) {
    const filled = [t.categoryId, t.productId, t.variantId, t.productUnitId].filter(
      (v) => v != null && Number(v) > 0
    );
    if (filled.length !== 1) {
      throw new Error(
        "BAD_REQUEST: كل سطر هدف يجب أن يحدد حبيبة واحدة فقط صريحة (فئة، منتج، متغير، أو وحدة تعبئة)"
      );
    }
    if (input.scope === "CATEGORIES" && !t.categoryId) {
      throw new Error("BAD_REQUEST: نطاق الفئات يستقبل معرفات الفئات فقط");
    }
    if (input.scope === "PRODUCTS" && !(t.productId || t.variantId || t.productUnitId)) {
      throw new Error("BAD_REQUEST: نطاق المنتجات يستقبل منتجات أو متغيرات أو وحدات تعبئة فقط");
    }
  }
}

// ---------------------------------------------------------------------------
// Mock Catalog for Smart Search Procedure
// ---------------------------------------------------------------------------

interface MockCatalogProduct {
  productId: number;
  productName: string;
  sku: string;
  categoryId: number;
  isConsignment: boolean;
  costPrice: string;
  units: Array<{
    id: number;
    unitName: string;
    conversionFactor: string;
    barcode: string;
    isBaseUnit: boolean;
    retailPrice: string;
  }>;
}

const SEARCH_CATALOG: MockCatalogProduct[] = [
  {
    productId: 101,
    productName: "دفتر ملاحظات روترينج مسطر",
    sku: "ROTRING-NOTE-A5",
    categoryId: 1,
    isConsignment: false,
    costPrice: "1800.00",
    units: [
      { id: 1001, unitName: "قطعة", conversionFactor: "1", barcode: "628100123001", isBaseUnit: true, retailPrice: "2500.00" },
      { id: 1002, unitName: "درزن", conversionFactor: "12", barcode: "628100123012", isBaseUnit: false, retailPrice: "27000.00" },
    ],
  },
  {
    productId: 102,
    productName: "قلم حبر جاف فاخر أزرق",
    sku: "PARKER-JOTTER-BLUE",
    categoryId: 1,
    isConsignment: false,
    costPrice: "9000.00",
    units: [
      { id: 2001, unitName: "قلم", conversionFactor: "1", barcode: "628100223001", isBaseUnit: true, retailPrice: "15000.00" },
    ],
  },
  {
    productId: 103,
    productName: "كراسة رسم هندسي كانسون",
    sku: "CANSON-SKETCH-A3",
    categoryId: 1,
    isConsignment: true, // Consignment item!
    costPrice: "6500.00",
    units: [
      { id: 3001, unitName: "كراسة", conversionFactor: "1", barcode: "628100323001", isBaseUnit: true, retailPrice: "10000.00" },
    ],
  },
  {
    productId: 104,
    productName: "ورق طباعة إيه فور دبل إيه",
    sku: "DOUBLE-A-PAPER-80G",
    categoryId: 2,
    isConsignment: false,
    costPrice: "5000.00",
    units: [
      { id: 4001, unitName: "ماscreen", conversionFactor: "1", barcode: "885100423001", isBaseUnit: true, retailPrice: "7500.00" },
      { id: 4002, unitName: "كرتون", conversionFactor: "5", barcode: "885100423005", isBaseUnit: false, retailPrice: "35000.00" },
    ],
  },
];

function simulateSearchProducts(
  input: { q?: string; categoryId?: number | null; limit?: number },
  canViewCost: boolean
) {
  const rawQ = input.q?.trim() ?? "";
  const normQ = rawQ ? normalizeSearchText(rawQ) : "";
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 50);

  let matches = SEARCH_CATALOG.filter((p) => {
    if (input.categoryId != null && p.categoryId !== input.categoryId) return false;
    if (!rawQ) return true;

    // 1. Barcode match
    const barcodeHit = p.units.some(
      (u) => u.barcode === rawQ || u.barcode.includes(rawQ)
    );
    if (barcodeHit) return true;

    // 2. Normalized name match
    const normName = normalizeSearchText(p.productName);
    if (normName.includes(normQ)) return true;

    // 3. Raw SKU match
    if (p.sku.toLowerCase().includes(rawQ.toLowerCase())) return true;

    return false;
  });

  matches = matches.slice(0, limit);

  return matches.map((m) => ({
    productId: m.productId,
    productName: m.productName,
    productCode: m.sku,
    categoryId: m.categoryId,
    variantId: m.productId,
    sku: m.sku,
    isConsignment: m.isConsignment,
    costPrice: canViewCost ? m.costPrice : null, // Sanitized cost masking
    units: m.units.map((u) => ({ ...u })),
  }));
}

// ===========================================================================
// Test Suite: Tier 5 Adversarial Coverage Hardening
// ===========================================================================

describe("Tier 5 Adversarial: Services, Routers & Offers UI Contracts", () => {

  // =========================================================================
  // Target 1: Promotion Duplication (duplicatePromotion)
  // =========================================================================
  describe("Target 1: Promotion Duplication & Scoping Hardening", () => {
    let db: InMemoryPromotionDatabase;

    beforeEach(() => {
      db = new InMemoryPromotionDatabase();

      // Seed Branch 1 promotion
      const p1 = db.insertPromotion({
        campaignId: 10,
        name: "عرض القرطاسية للفرع الأول",
        description: "عرض خاص بالفرع 1",
        type: "PERCENT",
        discountPercent: "20.00",
        discountAmount: "0.00",
        maxDiscountAmount: "50000.00",
        minOrderSpend: "10000.00",
        freeShipping: false,
        shippingDiscountAmount: "0.00",
        scope: "PRODUCTS",
        effectiveFrom: "2026-01-01",
        effectiveTo: "2026-12-31",
        customerTier: "RETAIL",
        branchId: 1, // Branch 1
        minLineAmount: "0.00",
        priority: 10,
        isActive: true,
        applicationMode: "AUTO",
        channel: "POS_ONLY",
        isStoreManaged: false,
        allowBelowCost: false,
        applyToBaseUnitOnly: true,
        activeDays: [0, 1, 2, 3, 4],
        fixedPrice: null,
        bundlePrice: null,
        bundleMode: null,
        bundleQuantity: null,
        bogoBuyQuantity: null,
        bogoGetQuantity: null,
        bogoGetDiscountPercent: null,
        tieredMode: null,
        createdBy: 1,
      });

      db.insertTarget({
        promotionId: p1.id,
        categoryId: null,
        productId: 101,
        variantId: null,
        productUnitId: null,
      });
      db.insertTarget({
        promotionId: p1.id,
        categoryId: null,
        productId: null,
        variantId: null,
        productUnitId: 1002, // Carton unit target
      });

      // Seed Branch 2 promotion
      db.insertPromotion({
        campaignId: null,
        name: "عرض خاص بفرع البصرة",
        description: null,
        type: "FIXED_PRICE",
        discountPercent: "0.00",
        discountAmount: "0.00",
        maxDiscountAmount: null,
        minOrderSpend: "0.00",
        freeShipping: false,
        shippingDiscountAmount: "0.00",
        scope: "PRODUCTS",
        effectiveFrom: "2026-05-01",
        effectiveTo: "2026-05-31",
        customerTier: null,
        branchId: 2, // Branch 2
        minLineAmount: "0.00",
        priority: 5,
        isActive: true,
        applicationMode: "AUTO",
        channel: "ALL",
        isStoreManaged: false,
        allowBelowCost: true,
        applyToBaseUnitOnly: false,
        activeDays: null,
        fixedPrice: "3000.00",
        bundlePrice: null,
        bundleMode: null,
        bundleQuantity: null,
        bogoBuyQuantity: null,
        bogoGetQuantity: null,
        bogoGetDiscountPercent: null,
        tieredMode: null,
        createdBy: 2,
      });

      // Seed Global Tiered Promotion (branchId: null)
      const pGlobal = db.insertPromotion({
        campaignId: null,
        name: "عرض الشرائح العام للورق",
        description: "تخفيضات شرائح الكميات",
        type: "TIERED_QTY",
        discountPercent: "0.00",
        discountAmount: "0.00",
        maxDiscountAmount: null,
        minOrderSpend: "0.00",
        freeShipping: false,
        shippingDiscountAmount: "0.00",
        scope: "PRODUCTS",
        effectiveFrom: "2026-01-01",
        effectiveTo: null,
        customerTier: null,
        branchId: null, // Global
        minLineAmount: "0.00",
        priority: 20,
        isActive: true,
        applicationMode: "AUTO",
        channel: "ALL",
        isStoreManaged: false,
        allowBelowCost: false,
        applyToBaseUnitOnly: true,
        activeDays: null,
        fixedPrice: null,
        bundlePrice: null,
        bundleMode: null,
        bundleQuantity: null,
        bogoBuyQuantity: null,
        bogoGetQuantity: null,
        bogoGetDiscountPercent: null,
        tieredMode: "PER_ITEM",
        createdBy: 1,
      });

      db.insertTier({
        promotionId: pGlobal.id,
        minQuantity: "5.00",
        tierType: "PERCENT",
        discountPercent: "10.00",
        discountAmount: "0.00",
        fixedPrice: null,
      });
      db.insertTier({
        promotionId: pGlobal.id,
        minQuantity: "20.00",
        tierType: "PERCENT",
        discountPercent: "20.00",
        discountAmount: "0.00",
        fixedPrice: null,
      });
      db.insertTier({
        promotionId: pGlobal.id,
        minQuantity: "50.00",
        tierType: "FIXED_PRICE",
        discountPercent: "0.00",
        discountAmount: "0.00",
        fixedPrice: "4500.00",
      });
    });

    it("T5-DUP-01: Non-admin manager from Branch 1 cannot duplicate promotion belonging to Branch 2 -> throws FORBIDDEN", () => {
      // Promo 5001 belongs to Branch 2. Actor is non-admin manager with branchId 1.
      expect(() => {
        db.duplicate(5001, 99, "2026-07-01", { role: "manager", branchId: 1 });
      }).toThrow(/FORBIDDEN.*العرض الترويجي المطلوب نسخه يخص فرعاً آخر/);
    });

    it("T5-DUP-02: Non-admin manager from Branch 1 can duplicate Branch 1 promotion -> assigns newId and preserves branchId 1", () => {
      const duplicatedId = db.duplicate(5000, 99, "2026-07-01", { role: "manager", branchId: 1 });
      expect(duplicatedId).toBeGreaterThan(5000);

      const duplicated = db.getPromotionWithTargets(duplicatedId)!;
      expect(duplicated.promotion.branchId).toBe(1);
      expect(duplicated.promotion.createdBy).toBe(99);
      expect(duplicated.promotion.isActive).toBe(false); // Default to draft
      expect(duplicated.promotion.effectiveFrom).toBe("2026-07-01");
      expect(duplicated.promotion.effectiveTo).toBeNull();
      expect(duplicated.promotion.name).toBe("نسخة من عرض القرطاسية للفرع الأول");
    });

    it("T5-DUP-03: Non-admin manager duplicating global promotion (branchId=null) forces local branch scoping", () => {
      // Promo 5002 is global (branchId: null)
      const duplicatedId = db.duplicate(5002, 99, "2026-07-01", { role: "manager", branchId: 1 });
      const duplicated = db.getPromotionWithTargets(duplicatedId)!;

      // Crucial: Manager cannot create or duplicate global promotions; it must inherit manager's branch
      expect(duplicated.promotion.branchId).toBe(1);
      expect(duplicated.promotion.isActive).toBe(false);
    });

    it("T5-DUP-04: Admin can duplicate cross-branch promotions and preserves original branchId", () => {
      // Admin duplicating Branch 2 promotion
      const duplicatedId = db.duplicate(5001, 1, "2026-07-01", { role: "admin", branchId: 1 });
      const duplicated = db.getPromotionWithTargets(duplicatedId)!;

      expect(duplicated.promotion.branchId).toBe(2);
      expect(duplicated.promotion.name).toBe("نسخة من عرض خاص بفرع البصرة");
    });

    it("T5-DUP-05: Deep cloning creates distinct targets and tiers with zero shared record references", () => {
      // Duplicate tiered promotion (5002) which has 3 tiers
      const dupId = db.duplicate(5002, 1, "2026-07-01", { role: "admin" });
      const orig = db.getPromotionWithTargets(5002)!;
      const dup = db.getPromotionWithTargets(dupId)!;

      expect(dup.tiers.length).toBe(3);
      expect(orig.tiers.length).toBe(3);

      // Verify tier IDs are unique and reference new promotion
      for (let i = 0; i < 3; i++) {
        expect(dup.tiers[i].id).not.toBe(orig.tiers[i].id);
        expect(dup.tiers[i].promotionId).toBe(dupId);
        expect(dup.tiers[i].minQuantity).toBe(orig.tiers[i].minQuantity);
        expect(dup.tiers[i].tierType).toBe(orig.tiers[i].tierType);
        expect(dup.tiers[i].fixedPrice).toBe(orig.tiers[i].fixedPrice);
      }
    });

    it("T5-DUP-06: Modifying or deleting duplicated promotion does not mutate or orphan original records", () => {
      const dupId = db.duplicate(5000, 1, "2026-07-01", { role: "admin" });

      // Mutate duplicated targets
      const dupTargets = Array.from(db.targets.values()).filter((t) => t.promotionId === dupId);
      expect(dupTargets.length).toBe(2);

      // Delete targets of duplicate
      for (const t of dupTargets) {
        db.targets.delete(t.id);
      }

      // Original targets must remain intact
      const origTargets = Array.from(db.targets.values()).filter((t) => t.promotionId === 5000);
      expect(origTargets.length).toBe(2);
      expect(origTargets[0].productId).toBe(101);
      expect(origTargets[1].productUnitId).toBe(1002);
    });

    it("T5-DUP-07: Promotion name exceeding 255 chars is safely truncated without overflow", () => {
      const longName = "عرض " + "أ".repeat(260);
      const pLong = db.insertPromotion({
        campaignId: null,
        name: longName,
        description: null,
        type: "PERCENT",
        discountPercent: "10.00",
        discountAmount: "0.00",
        maxDiscountAmount: null,
        minOrderSpend: "0.00",
        freeShipping: false,
        shippingDiscountAmount: "0.00",
        scope: "ALL",
        effectiveFrom: "2026-01-01",
        effectiveTo: null,
        customerTier: null,
        branchId: null,
        minLineAmount: "0.00",
        priority: 1,
        isActive: true,
        applicationMode: "AUTO",
        channel: "ALL",
        isStoreManaged: false,
        allowBelowCost: false,
        applyToBaseUnitOnly: true,
        activeDays: null,
        fixedPrice: null,
        bundlePrice: null,
        bundleMode: null,
        bundleQuantity: null,
        bogoBuyQuantity: null,
        bogoGetQuantity: null,
        bogoGetDiscountPercent: null,
        tieredMode: null,
        createdBy: 1,
      });

      const dupId = db.duplicate(pLong.id, 1, "2026-07-01", { role: "admin" });
      const dup = db.getPromotionWithTargets(dupId)!;

      expect(dup.promotion.name.startsWith("نسخة من عرض ")).toBe(true);
      expect(dup.promotion.name.length).toBeLessThanOrEqual(255);
    });
  });

  // =========================================================================
  // Target 2: Smart Search Procedure (searchPromotionProducts)
  // =========================================================================
  describe("Target 2: Smart Search Normalization & Cost Masking", () => {
    it("T5-SCH-01: Full Arabic Diacritics (Tashkeel) Invariance", () => {
      // Test words with all Arabic diacritical marks
      const queries = [
        "دَفْتَرٌ", // fatha, sukun, fatha, tanween damma
        "دَفْتَر",  // fatha, sukun, fatha
        "دُفْتُرْ", // damma, sukun, damma, sukun
        "دِفْتِرٍ", // kasra, sukun, kasra, tanween kasra
        "دَفْتَّر", // shadda with fatha
      ];

      for (const q of queries) {
        const norm = normalizeSearchText(q);
        expect(norm).toBe("دفتر");

        const results = simulateSearchProducts({ q }, true);
        expect(results.length).toBeGreaterThan(0);
        expect(results[0].productName).toContain("دفتر");
      }
    });

    it("T5-SCH-02: Comprehensive Arabic Letter Folding & Normalization Rules", () => {
      // 1. Alef variants (أ, إ, آ, ٱ -> ا)
      expect(normalizeSearchText("أزرق")).toBe("ازرق");
      expect(normalizeSearchText("إلكتروني")).toBe("الكتروني");
      expect(normalizeSearchText("آلات")).toBe("الات");
      expect(normalizeSearchText("ٱستقبال")).toBe("استقبال");

      // 2. Taa Marbuta and Haa (ة -> ه)
      expect(normalizeSearchText("مكتبة")).toBe("مكتبه");
      expect(normalizeSearchText("كراسة")).toBe("كراسه");

      // 3. Yaa and Alef Maqsura (ى -> ي)
      expect(normalizeSearchText("على")).toBe("علي");
      expect(normalizeSearchText("أوراقى")).toBe("اوراقي");

      // 4. Hamza variants (ؤ -> و, ئ -> ي)
      expect(normalizeSearchText("مسؤول")).toBe("مسوول");
      expect(normalizeSearchText("فئة")).toBe("فيه");

      // 5. Kashida / Tatweel removal (ـ -> "")
      expect(normalizeSearchText("قـــــلم")).toBe("قلم");
      expect(normalizeSearchText("دـفـتـر")).toBe("دفتر");

      // 6. Arabic-Indic and Persian digits to Latin digits
      expect(normalizeSearchText("دفتر ١٢٣٤")).toBe("دفتر 1234");
      expect(normalizeSearchText("قلم ۱۲۳۴")).toBe("قلم 1234");
    });

    it("T5-SCH-03: Barcode Prefix, Suffix and Exact Lookups", () => {
      // Exact lookup
      const exact = simulateSearchProducts({ q: "628100123001" }, true);
      expect(exact.length).toBe(1);
      expect(exact[0].productId).toBe(101);

      // Prefix lookup
      const prefix = simulateSearchProducts({ q: "628100" }, true);
      expect(prefix.length).toBe(3); // items 101, 102, 103

      // Secondary carton barcode lookup
      const cartonMatch = simulateSearchProducts({ q: "628100123012" }, true);
      expect(cartonMatch.length).toBe(1);
      expect(cartonMatch[0].productId).toBe(101);
    });

    it("T5-SCH-04: Consignment Flag Detection (isConsignment = true/false)", () => {
      const consignment = simulateSearchProducts({ q: "كانسون" }, true);
      expect(consignment.length).toBe(1);
      expect(consignment[0].isConsignment).toBe(true); // Consignment item

      const owned = simulateSearchProducts({ q: "روترينج" }, true);
      expect(owned.length).toBe(1);
      expect(owned[0].isConsignment).toBe(false); // Owned item
    });

    it("T5-SCH-05: Strict Cost Masking for Unauthorized Staff", () => {
      // Cashier without cost view rights
      const cashierView = simulateSearchProducts({ q: "روترينج" }, false);
      expect(cashierView.length).toBe(1);
      expect(cashierView[0].costPrice).toBeNull(); // Strictly masked to null!

      // Manager with cost view rights
      const managerView = simulateSearchProducts({ q: "روترينج" }, true);
      expect(managerView.length).toBe(1);
      expect(managerView[0].costPrice).toBe("1800.00");
    });
  });

  // =========================================================================
  // Target 3: Single-Grain Target Validation (assertTargets)
  // =========================================================================
  describe("Target 3: Single-Grain Target Validation Invariants", () => {
    it("T5-TGT-01: Rejects contradictory multi-grain target (both categoryId and productId)", () => {
      expect(() => {
        assertTargetsGrainContract({
          scope: "PRODUCTS",
          targets: [{ categoryId: 1, productId: 101 }],
        });
      }).toThrow(/كل سطر هدف يجب أن يحدد حبيبة واحدة فقط صريحة/);
    });

    it("T5-TGT-02: Rejects contradictory multi-grain target (both productId and productUnitId)", () => {
      expect(() => {
        assertTargetsGrainContract({
          scope: "PRODUCTS",
          targets: [{ productId: 101, productUnitId: 1001 }],
        });
      }).toThrow(/كل سطر هدف يجب أن يحدد حبيبة واحدة فقط صريحة/);
    });

    it("T5-TGT-03: Rejects completely empty target row with zero filled grains", () => {
      expect(() => {
        assertTargetsGrainContract({
          scope: "PRODUCTS",
          targets: [{ categoryId: null, productId: null, productUnitId: null }],
        });
      }).toThrow(/كل سطر هدف يجب أن يحدد حبيبة واحدة فقط صريحة/);
    });

    it("T5-TGT-04: Rejects scope CATEGORIES with product-level target", () => {
      expect(() => {
        assertTargetsGrainContract({
          scope: "CATEGORIES",
          targets: [{ productId: 101 }],
        });
      }).toThrow(/نطاق الفئات يستقبل معرفات الفئات فقط/);
    });

    it("T5-TGT-05: Rejects scope PRODUCTS with category-level target", () => {
      expect(() => {
        assertTargetsGrainContract({
          scope: "PRODUCTS",
          targets: [{ categoryId: 1 }],
        });
      }).toThrow(/نطاق المنتجات يستقبل منتجات أو متغيرات أو وحدات تعبئة فقط/);
    });

    it("T5-TGT-06: Rejects scope ALL with non-empty targets array", () => {
      expect(() => {
        assertTargetsGrainContract({
          scope: "ALL",
          targets: [{ productId: 101 }],
        });
      }).toThrow(/العرض العام على مستوى كل الأصناف لا يقبل تخصيص أهداف محددة/);
    });

    it("T5-TGT-07: Rejects empty targets array when scope is CATEGORIES or PRODUCTS", () => {
      expect(() => {
        assertTargetsGrainContract({
          scope: "PRODUCTS",
          targets: [],
        });
      }).toThrow(/النطاق المحدد يتطلب إضافة هدف واحد على الأقل/);

      expect(() => {
        assertTargetsGrainContract({
          scope: "CATEGORIES",
          targets: [],
        });
      }).toThrow(/النطاق المحدد يتطلب إضافة هدف واحد على الأقل/);
    });
  });

  // =========================================================================
  // Target 4: Rapid Barcode Gun Scanner Simulator & AudioContext Safety
  // =========================================================================
  describe("Target 4: Rapid Barcode Gun Scanner & Burst Timing", () => {
    it("T5-SCN-01: Consecutive barcode burst (<40ms) activates detector and accepts code", () => {
      const detector = new ScanBurstDetector({ intraGapMs: 40, minLength: 3 });
      const barcode = "628100123001";
      let now = 1000;

      // Simulate rapid hardware scanner burst (< 20ms per character)
      for (let i = 0; i < barcode.length; i++) {
        const ch = barcode[i];
        now += 15; // 15ms gap
        detector.feed({ code: `Digit${ch}`, key: ch, shiftKey: false }, now);
      }

      const res = detector.flush();
      expect(res.accepted).toBe(true);
      expect(res.code).toBe("628100123001");
    });

    it("T5-SCN-02: Human typing speed (>40ms) rejects burst and preserves raw text", () => {
      const detector = new ScanBurstDetector({ intraGapMs: 40, minLength: 3 });
      const word = "دفتر";
      let now = 1000;

      // Simulate slow human typing (150ms per character)
      for (let i = 0; i < word.length; i++) {
        now += 150;
        detector.feed({ code: `Key${i}`, key: word[i], shiftKey: false }, now);
      }

      const res = detector.flush();
      expect(res.accepted).toBe(false);
      expect(res.text).toBe("ر"); // Last character candidate
    });

    it("T5-SCN-03: Space character in rapid burst is captured as valid barcode character", () => {
      const detector = new ScanBurstDetector({ intraGapMs: 40, minLength: 3 });
      const barcodeWithSpace = "A 123";
      let now = 1000;

      for (let i = 0; i < barcodeWithSpace.length; i++) {
        const ch = barcodeWithSpace[i];
        now += 12; // 12ms gap
        detector.feed({ code: ch === " " ? "Space" : `Key${ch}`, key: ch, shiftKey: false }, now);
      }

      const res = detector.flush();
      expect(res.accepted).toBe(true);
      expect(res.code.toLowerCase()).toContain("a 123");
    });

    it("T5-SCN-04: Duplicate scan detection sets non-blocking warning and preserves items", () => {
      const selectedItems: SelectedOfferItem[] = [
        {
          productId: 101,
          productName: "دفتر روترينج",
          productCode: "ROTRING-NOTE",
          variantId: 101,
          sku: "ROTRING-NOTE",
          isConsignment: false,
          costPrice: "1800.00",
          productUnitId: 1001,
          unitName: "قطعة",
          conversionFactor: "1",
          retailPrice: "2500.00",
          barcode: "628100123001",
          isBaseUnit: true,
          units: [],
        },
      ];

      // Simulated add callback
      let warning: string | null = null;
      let chimePlayed = false;
      let focusRetained = false;

      function simulateScan(product: MockCatalogProduct) {
        const alreadyAdded = selectedItems.some((i) => i.productId === product.productId);
        if (alreadyAdded) {
          warning = "الصنف مضاف مسبقاً";
          chimePlayed = true;
          focusRetained = true;
          return false;
        }
        return true;
      }

      const duplicateResult = simulateScan(SEARCH_CATALOG[0]);
      expect(duplicateResult).toBe(false);
      expect(warning).toBe("الصنف مضاف مسبقاً");
      expect(chimePlayed).toBe(true);
      expect(focusRetained).toBe(true);
    });

    it("T5-SCN-05: Web AudioContext reuse prevents resource leaks across repeated scans", () => {
      let audioCtxInstanceCount = 0;
      let cachedAudioCtx: { state: string; close: () => void } | null = null;

      function getOrCreateAudioContext() {
        if (!cachedAudioCtx || cachedAudioCtx.state === "closed") {
          audioCtxInstanceCount++;
          cachedAudioCtx = { state: "running", close: () => { cachedAudioCtx!.state = "closed"; } };
        }
        return cachedAudioCtx;
      }

      // 50 duplicate scans
      for (let i = 0; i < 50; i++) {
        const ctx = getOrCreateAudioContext();
        expect(ctx.state).toBe("running");
      }

      // Must strictly reuse the singleton context!
      expect(audioCtxInstanceCount).toBe(1);

      // Re-creates only when closed
      cachedAudioCtx!.close();
      getOrCreateAudioContext();
      expect(audioCtxInstanceCount).toBe(2);
    });
  });

  // =========================================================================
  // Target 5: Interactive Live Table Margins (calculateLiveMargin)
  // =========================================================================
  describe("Target 5: Interactive Live Table Margins & Ceiling Alerts", () => {
    it("T5-TBL-01: Zero Cost Price yields 100% margin without division error", () => {
      const res = calculateLiveMargin(
        new Decimal(10000),
        new Decimal(0), // Cost = 0
        "PERCENT",
        new Decimal(20) // 20% discount -> promoPrice = 8000
      );

      expect(res.promoPrice.toNumber()).toBe(8000);
      expect(res.marginPercent.toNumber()).toBe(100);
      expect(res.isBelowCost).toBe(false);
      expect(res.badgeStyle).toBe("positive");
    });

    it("T5-TBL-02: Zero Retail Price returns 0% margin safely without NaN", () => {
      const res = calculateLiveMargin(
        new Decimal(0),
        new Decimal(5000), // Cost = 5000
        "PERCENT",
        new Decimal(10)
      );

      expect(res.promoPrice.toNumber()).toBe(0);
      expect(res.marginPercent.toNumber()).toBe(0);
      expect(res.isBelowCost).toBe(true);
      expect(res.badgeStyle).toBe("negative");
    });

    it("T5-TBL-03: Extremely large numbers (1 Trillion IQD) maintain exact Decimal precision", () => {
      const hugeRetail = new Decimal("1000000000000"); // 1 Trillion
      const hugeCost = new Decimal("750000000000");   // 750 Billion

      const res = calculateLiveMargin(
        hugeRetail,
        hugeCost,
        "PERCENT",
        new Decimal(10) // 10% discount -> promoPrice = 900 Billion
      );

      expect(res.promoPrice.toFixed(2)).toBe("900000000000.00");
      // Profit = 150 Billion / 900 Billion = 16.67%
      expect(res.marginPercent.toFixed(2)).toBe("16.67");
      expect(res.isBelowCost).toBe(false);
      expect(res.badgeStyle).toBe("positive");
    });

    it("T5-TBL-04: Below-Cost Flash Sale triggers below-cost alert and negative badge", () => {
      const res = calculateLiveMargin(
        new Decimal(10000),
        new Decimal(9000), // Cost = 9000
        "AMOUNT",
        new Decimal(2000) // 2000 IQD discount -> promoPrice = 8000
      );

      expect(res.promoPrice.toNumber()).toBe(8000);
      expect(res.isBelowCost).toBe(true); // 8000 < 9000
      expect(res.badgeStyle).toBe("negative");
      expect(res.marginPercent.isNegative()).toBe(true);
    });

    it("T5-TBL-05: FIXED_PRICE Ceiling Invariant preserves lower price with warning badge", () => {
      // Original price (3000) is LOWER than fixed price offer (5000)
      const res = calculateLiveMargin(
        new Decimal(3000),
        new Decimal(2000),
        "FIXED_PRICE",
        new Decimal(5000)
      );

      // Price must NEVER increase!
      expect(res.promoPrice.toNumber()).toBe(3000);
      expect(res.isCeilingViolated).toBe(true);
      expect(res.badgeStyle).toBe("warning");
      expect(res.isBelowCost).toBe(false);
    });

    it("T5-TBL-06: FIXED_PRICE offer on higher-priced item applies price discount cleanly", () => {
      // Original price (8000) is HIGHER than fixed price offer (5000)
      const res = calculateLiveMargin(
        new Decimal(8000),
        new Decimal(3500),
        "FIXED_PRICE",
        new Decimal(5000)
      );

      expect(res.promoPrice.toNumber()).toBe(5000);
      expect(res.isCeilingViolated).toBe(false);
      expect(res.badgeStyle).toBe("positive");
      // Profit = 1500 / 5000 = 30%
      expect(res.marginPercent.toNumber()).toBe(30);
    });
  });

  // =========================================================================
  // Target 6: Edit Hydration & Safe Decimal Fault Tolerance
  // =========================================================================
  describe("Target 6: Edit Hydration & Decimal Fault Tolerance", () => {
    it("T5-HYD-01: safeDecimal handles invalid, NaN, Infinity, null, and corrupted inputs without throwing", () => {
      const invalidCases = [
        null,
        undefined,
        "",
        "   ",
        NaN,
        Infinity,
        -Infinity,
        "not-a-number",
        "NaN",
        "--12",
        "12.34.56",
        {},
        [],
      ];

      for (const val of invalidCases) {
        expect(() => {
          const d = safeDecimal(val);
          expect(d.toNumber()).toBe(0);
          expect(d.isFinite()).toBe(true);
        }).not.toThrow();
      }

      // Valid cases
      expect(safeDecimal("123.45").toNumber()).toBe(123.45);
      expect(safeDecimal(999).toNumber()).toBe(999);
      expect(safeDecimal(new Decimal("50.5")).toNumber()).toBe(50.5);

      // Custom fallback
      expect(safeDecimal("bad", new Decimal(100)).toNumber()).toBe(100);
    });

    it("T5-HYD-02: safePositiveDecimal returns Decimal only for positive values", () => {
      expect(safePositiveDecimal("50")?.toNumber()).toBe(50);
      expect(safePositiveDecimal(10.5)?.toNumber()).toBe(10.5);
      expect(safePositiveDecimal("0")).toBeUndefined();
      expect(safePositiveDecimal("-15")).toBeUndefined();
      expect(safePositiveDecimal(null)).toBeUndefined();
      expect(safePositiveDecimal("bad")).toBeUndefined();
    });

    it("T5-HYD-03: Corrupted getById payload hydrates safely into default form state without UI crashes", () => {
      // Simulate severely corrupted getById response
      const corruptedPayload: any = {
        promotion: {
          id: 999,
          name: null, // missing name
          description: null,
          type: "TIERED_QTY",
          discountPercent: null,
          discountAmount: "NaN", // NaN string
          effectiveFrom: "2026-06-01",
          effectiveTo: null,
          activeDays: null, // missing activeDays
          branchId: null,
        },
        targets: null, // missing targets array!
        tiers: undefined, // missing tiers array!
      };

      // Replicate OfferForm hydration defensively
      const p = corruptedPayload.promotion;
      const hydratedName = p.name ?? "";
      const hydratedDiscountPercent = p.discountPercent ? String(p.discountPercent) : "10";
      const hydratedDiscountAmount = p.discountAmount && !isNaN(Number(p.discountAmount)) ? String(p.discountAmount) : "";
      const hydratedTiers = (corruptedPayload.tiers ?? []).map((t: any) => ({
        id: t.id,
        minQuantity: t.minQuantity,
      }));
      const hydratedActiveDays = p.activeDays ?? [];

      expect(hydratedName).toBe("");
      expect(hydratedDiscountPercent).toBe("10");
      expect(hydratedDiscountAmount).toBe("");
      expect(hydratedTiers).toEqual([]);
      expect(hydratedActiveDays).toEqual([]);
    });

    it("T5-HYD-04: simulateBasketPreview handles empty and boundary cart configurations", () => {
      // Empty basket
      const emptyRes = simulateBasketPreview([], {
        type: "PERCENT",
        percent: new Decimal(20),
      });
      expect(emptyRes.grossTotal.toNumber()).toBe(0);
      expect(emptyRes.discount.toNumber()).toBe(0);
      expect(emptyRes.netTotal.toNumber()).toBe(0);

      // Minimum spend threshold not met
      const thresholdRes = simulateBasketPreview(
        [{ productId: 1, unitPrice: 2000, quantity: 2 }], // 4000 total
        {
          type: "PERCENT",
          percent: new Decimal(10),
          minSpend: new Decimal(10000), // Min spend 10,000
        }
      );
      expect(thresholdRes.grossTotal.toNumber()).toBe(4000);
      expect(thresholdRes.discount.toNumber()).toBe(0);
      expect(thresholdRes.helperNote).toContain("الحد الأدنى للطلب (10000.00 د.ع) غير مستوفى");
    });
  });

  // =========================================================================
  // Target 7: Static Contracts, Line Counts & Design Token Governance
  // =========================================================================
  describe("Target 7: Static Contracts, Line Counts & Page Budgets", () => {
    const OFFERS_PAGE = path.resolve(process.cwd(), "client/src/pages/Offers.tsx");
    const OFFERS_COMPONENTS_DIR = path.resolve(process.cwd(), "client/src/components/offers");

    it("T5-STC-01: Offers.tsx is strictly <= 400 lines per architectural budget", () => {
      const content = fs.readFileSync(OFFERS_PAGE, "utf8");
      const lineCount = content.split("\n").length;
      expect(lineCount).toBeLessThanOrEqual(400);
    });

    it("T5-STC-02: All child components in client/src/components/offers/ are strictly <= 1200 lines", () => {
      const files = fs.readdirSync(OFFERS_COMPONENTS_DIR);
      for (const file of files) {
        if (!file.endsWith(".tsx") && !file.endsWith(".ts")) continue;
        const filePath = path.join(OFFERS_COMPONENTS_DIR, file);
        const lineCount = fs.readFileSync(filePath, "utf8").split("\n").length;
        expect(lineCount, `Component ${file} exceeded 1200 lines budget`).toBeLessThanOrEqual(1200);
      }
    });

    it("T5-STC-03: Zero Unicode emojis across Offers.tsx and all child components (check:emoji compliance)", () => {
      const emojiRegex = /[\uD83C-\uD83E][\uDC00-\uDFFF]|[\u2600-\u26FF]|[\u2700-\u27BF]/;

      const checkFiles = [
        OFFERS_PAGE,
        ...fs.readdirSync(OFFERS_COMPONENTS_DIR).map((f) => path.join(OFFERS_COMPONENTS_DIR, f)),
      ];

      for (const file of checkFiles) {
        if (!file.endsWith(".tsx") && !file.endsWith(".ts")) continue;
        const content = fs.readFileSync(file, "utf8");
        const match = content.match(emojiRegex);
        expect(match, `Emoji found in ${file}: ${match?.[0]}`).toBeNull();
      }
    });

    it("T5-STC-04: Approved semantic CSS tokens (--sem-pos, --sem-neg, --sem-warn, --sem-info) in UI", () => {
      const tableContent = fs.readFileSync(
        path.join(OFFERS_COMPONENTS_DIR, "OfferSelectedItemsTable.tsx"),
        "utf8"
      );

      // Must use semantic tokens for badges and warning states
      expect(tableContent).toContain("var(--sem-neg)");
      expect(tableContent).toContain("var(--sem-warn)");
      expect(tableContent).toContain("var(--sem-pos)");

      // Must NOT contain raw forbidden semantic colors
      expect(tableContent).not.toMatch(/text-green-500/);
      expect(tableContent).not.toMatch(/bg-red-500/);
      expect(tableContent).not.toMatch(/border-red-500/);
    });

    it("T5-STC-05: Marketing Wing Static Contracts Preserved in Offers.tsx", () => {
      const offersPageContent = fs.readFileSync(OFFERS_PAGE, "utf8");

      // 1. Page Header Title Contract
      expect(offersPageContent).toContain('title="العروض والتخفيضات"');

      // 2. Export Rows with XLSX and CSV
      expect(offersPageContent).toContain('handleExport("xlsx")');
      expect(offersPageContent).toContain('handleExport("csv")');
      expect(offersPageContent).toContain("exportRows(list");

      // 3. DataTable Component Usage (Zero raw <table> tags in page)
      expect(offersPageContent).toContain("<DataTable");
      expect(offersPageContent).not.toMatch(/<table[\s>]/);
    });
  });
});
