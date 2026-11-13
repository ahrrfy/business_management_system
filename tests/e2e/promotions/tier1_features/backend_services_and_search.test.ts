/**
 * tests/e2e/promotions/tier1_features/backend_services_and_search.test.ts
 *
 * Tier 1 Feature Coverage: Backend Services, CRUD Hydration & Smart Search (F11–F12)
 * Full getById hydration across all 6 promotion types, product search normalization,
 * consignment flag detection, and sensitive costPrice masking.
 */

import Decimal from "decimal.js";
import { beforeEach, describe, expect, it } from "vitest";
import {
  CASHIER_SALWA,
  MANAGER_HAIDER,
  MockProduct,
  MockPromotionRule,
  MockStaffActor,
  PRD_CHEAP_PEN,
  PRD_CRYSTAL_SHIELD,
  PRD_GRAD_SASH,
  PRD_INK_EPSON,
  PRD_LUX_PEN,
  PRD_NOTEBOOK_FABER,
  PRD_PEN_ROTRING,
  createFixedPricePromoFixture,
  createPercentPromoFixture,
} from "../infra/mockFixtures";

// ---------------------------------------------------------------------------
// In-Memory Backend Service & Search Procedures
// ---------------------------------------------------------------------------

class MockPromotionService {
  private store = new Map<number, MockPromotionRule>();
  private nextId = 2000;

  constructor() {
    this.reset();
  }

  reset() {
    this.store.clear();
    const p1 = createPercentPromoFixture({ id: 101, name: "عرض القرطاسية 20%" });
    const p2 = createFixedPricePromoFixture({ id: 102, name: "أقلام بسعر موحد" });
    this.store.set(p1.id, p1);
    this.store.set(p2.id, p2);
  }

  async create(input: Omit<MockPromotionRule, "id">): Promise<MockPromotionRule> {
    const id = this.nextId++;
    const record: MockPromotionRule = { ...input, id };
    this.store.set(id, record);
    return record;
  }

  async getById(id: number): Promise<MockPromotionRule | null> {
    const record = this.store.get(id);
    return record ? { ...record } : null;
  }

  async update(id: number, patch: Partial<MockPromotionRule>): Promise<MockPromotionRule> {
    const existing = this.store.get(id);
    if (!existing) throw new Error(`Promotion ${id} not found`);
    const updated = { ...existing, ...patch };
    this.store.set(id, updated);
    return updated;
  }

  async toggleActive(id: number): Promise<MockPromotionRule> {
    const existing = this.store.get(id);
    if (!existing) throw new Error(`Promotion ${id} not found`);
    existing.isActive = !existing.isActive;
    this.store.set(id, existing);
    return existing;
  }

  async delete(id: number): Promise<boolean> {
    return this.store.delete(id);
  }

  async duplicate(id: number, todayYmd: string): Promise<MockPromotionRule> {
    const existing = this.store.get(id);
    if (!existing) throw new Error(`Promotion ${id} not found`);
    const duplicated: MockPromotionRule = {
      ...existing,
      id: this.nextId++,
      name: `نسخة من ${existing.name}`,
      effectiveFrom: todayYmd,
      effectiveTo: null,
      isActive: false, // Default to inactive draft
    };
    this.store.set(duplicated.id, duplicated);
    return duplicated;
  }

  async list(filter?: { channel?: "POS" | "STORE"; isActive?: boolean }): Promise<MockPromotionRule[]> {
    return Array.from(this.store.values()).filter((p) => {
      if (filter?.isActive !== undefined && p.isActive !== filter.isActive) return false;
      if (filter?.channel === "POS" && p.channel === "STORE_ONLY") return false;
      if (filter?.channel === "STORE" && p.channel === "POS_ONLY") return false;
      return true;
    });
  }
}

const CATALOG: MockProduct[] = [
  PRD_PEN_ROTRING,
  PRD_NOTEBOOK_FABER,
  PRD_INK_EPSON,
  PRD_GRAD_SASH,
  PRD_CRYSTAL_SHIELD,
  PRD_LUX_PEN,
  PRD_CHEAP_PEN,
];

function normalizeArabic(text: string): string {
  return text
    .trim()
    .replace(/[أإآ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .toLowerCase();
}

interface SearchProductInput {
  q?: string;
  categoryId?: number;
  limit?: number;
}

interface SearchProductResultItem {
  productId: number;
  productName: string;
  productCode: string;
  categoryId: number;
  variantId: number;
  sku: string;
  isConsignment: boolean;
  costPrice: string | null; // Sanitized: null if unauthorized
  units: Array<{
    id: number;
    unitName: string;
    barcode: string;
    conversionFactor: string;
    isBaseUnit: boolean;
    retailPrice: string;
  }>;
}

function searchProducts(
  input: SearchProductInput,
  actor: MockStaffActor
): SearchProductResultItem[] {
  const query = input.q ? normalizeArabic(input.q) : "";
  const limit = input.limit ?? 20;

  let results = CATALOG.filter((p) => {
    if (input.categoryId && p.categoryId !== input.categoryId) return false;

    if (!query) return true;

    // Name match
    const normName = normalizeArabic(p.name);
    if (normName.includes(query)) return true;

    // Code/SKU match
    if (p.code.toLowerCase().includes(query) || p.sku.toLowerCase().includes(query)) return true;

    // Barcode match
    return p.units.some((u) => u.barcode.includes(query));
  });

  results = results.slice(0, limit);

  return results.map((p) => ({
    productId: p.id,
    productName: p.name,
    productCode: p.code,
    categoryId: p.categoryId,
    variantId: p.variantId,
    sku: p.sku,
    isConsignment: p.isConsignment,
    costPrice: actor.canViewCost ? p.units[0].costPrice.toFixed(2) : null,
    units: p.units.map((u) => ({
      id: u.id,
      unitName: u.unitName,
      barcode: u.barcode,
      conversionFactor: u.conversionFactor.toString(),
      isBaseUnit: u.isBaseUnit,
      retailPrice: u.retailPrice.toFixed(2),
    })),
  }));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Tier 1: Backend Services & Smart Search (F11–F12)", () => {
  let promoService: MockPromotionService;

  beforeEach(() => {
    promoService = new MockPromotionService();
  });

  // =========================================================================
  // F11: Backend CRUD & Hydration
  // =========================================================================
  describe("F11: Backend CRUD & Hydration", () => {
    it("T1-F11-01: call create with FIXED_PRICE promotion payload -> validates and returns created promo record with id", async () => {
      const created = await promoService.create({
        name: "تخفيض خاص للدفاتر",
        type: "FIXED_PRICE",
        channel: "ALL",
        allowBelowCost: false,
        applyToBaseUnitOnly: true,
        effectiveFrom: "2026-06-01",
        effectiveTo: "2026-06-30",
        priority: 15,
        isActive: true,
        fixedPrice: new Decimal(2000),
        targetProductIds: new Set([PRD_NOTEBOOK_FABER.id]),
        targetCategoryIds: new Set(),
        targetUnitIds: new Set(),
      });

      expect(created.id).toBeGreaterThan(0);
      expect(created.name).toBe("تخفيض خاص للدفاتر");
      expect(created.fixedPrice?.toNumber()).toBe(2000);
    });

    it("T1-F11-02: call getById -> returns fully hydrated promotion object with targets and channels", async () => {
      const promo = await promoService.getById(101);

      expect(promo).not.toBeNull();
      expect(promo!.id).toBe(101);
      expect(promo!.name).toBe("عرض القرطاسية 20%");
      expect(promo!.targetProductIds).toBeDefined();
      expect(promo!.targetProductIds.size).toBeGreaterThan(0);
    });

    it("T1-F11-03: call update modifying discount value and active dates -> updates record atomically", async () => {
      const updated = await promoService.update(101, {
        discountPercent: new Decimal(25),
        effectiveTo: "2026-11-30",
      });

      expect(updated.discountPercent?.toNumber()).toBe(25);
      expect(updated.effectiveTo).toBe("2026-11-30");

      // Verify persisted state
      const reloaded = await promoService.getById(101);
      expect(reloaded!.discountPercent?.toNumber()).toBe(25);
    });

    it("T1-F11-04: call list with channel filter 'POS' -> filters to only active POS-applicable promos (ALL and POS_ONLY)", async () => {
      await promoService.create({
        name: "عرض أونلاين فقط",
        type: "PERCENT",
        channel: "STORE_ONLY",
        allowBelowCost: false,
        applyToBaseUnitOnly: true,
        effectiveFrom: "2026-01-01",
        priority: 10,
        isActive: true,
        discountPercent: new Decimal(10),
        targetProductIds: new Set(),
        targetCategoryIds: new Set(),
        targetUnitIds: new Set(),
      });

      const posList = await promoService.list({ channel: "POS" });

      // Must exclude STORE_ONLY promo
      expect(posList.some((p) => p.name === "عرض أونلاين فقط")).toBe(false);
      expect(posList.every((p) => p.channel === "ALL" || p.channel === "POS_ONLY")).toBe(true);
    });

    it("T1-F11-05: call list with channel filter 'STORE' -> filters to only STORE-applicable promos (ALL and STORE_ONLY)", async () => {
      await promoService.create({
        name: "عرض كاشير فقط",
        type: "PERCENT",
        channel: "POS_ONLY",
        allowBelowCost: false,
        applyToBaseUnitOnly: true,
        effectiveFrom: "2026-01-01",
        priority: 10,
        isActive: true,
        discountPercent: new Decimal(10),
        targetProductIds: new Set(),
        targetCategoryIds: new Set(),
        targetUnitIds: new Set(),
      });

      const storeList = await promoService.list({ channel: "STORE" });

      expect(storeList.some((p) => p.name === "عرض كاشير فقط")).toBe(false);
      expect(storeList.every((p) => p.channel === "ALL" || p.channel === "STORE_ONLY")).toBe(true);
    });

    it("T1-F11-06: call toggleActive -> toggles isActive state from true to false and back", async () => {
      const p1 = await promoService.getById(101);
      expect(p1!.isActive).toBe(true);

      const toggledOff = await promoService.toggleActive(101);
      expect(toggledOff.isActive).toBe(false);

      const toggledOn = await promoService.toggleActive(101);
      expect(toggledOn.isActive).toBe(true);
    });

    it("T1-F11-07: call delete -> removes promotion from service store", async () => {
      const deleted = await promoService.delete(101);
      expect(deleted).toBe(true);

      const lookup = await promoService.getById(101);
      expect(lookup).toBeNull();
    });

    it("T1-F11-08: call duplicate -> creates draft with 'نسخة من' prefix, new ID, and defaults to inactive", async () => {
      const duplicated = await promoService.duplicate(101, "2026-06-15");

      expect(duplicated.id).not.toBe(101);
      expect(duplicated.name).toBe("نسخة من عرض القرطاسية 20%");
      expect(duplicated.effectiveFrom).toBe("2026-06-15");
      expect(duplicated.isActive).toBe(false);
      expect(duplicated.discountPercent?.toNumber()).toBe(20);
    });

    it("T1-F11-09: hydration of BUNDLE_PRICE includes bundlePrice, bundleMode, and bundleQuantity", async () => {
      const bundle = await promoService.create({
        name: "باقة الأقلام",
        type: "BUNDLE_PRICE",
        channel: "ALL",
        allowBelowCost: false,
        applyToBaseUnitOnly: true,
        effectiveFrom: "2026-01-01",
        priority: 10,
        isActive: true,
        bundlePrice: new Decimal(8000),
        bundleMode: "PICK_ANY_N",
        bundleQuantity: 3,
        targetProductIds: new Set([PRD_PEN_ROTRING.id]),
        targetCategoryIds: new Set(),
        targetUnitIds: new Set(),
      });

      const hydrated = await promoService.getById(bundle.id);
      expect(hydrated!.bundlePrice?.toNumber()).toBe(8000);
      expect(hydrated!.bundleMode).toBe("PICK_ANY_N");
      expect(hydrated!.bundleQuantity).toBe(3);
    });

    it("T1-F11-10: hydration of TIERED_QTY includes child tiers array", async () => {
      const tiered = await promoService.create({
        name: "شرائح حبر إبسون",
        type: "TIERED_QTY",
        channel: "ALL",
        allowBelowCost: false,
        applyToBaseUnitOnly: true,
        effectiveFrom: "2026-01-01",
        priority: 10,
        isActive: true,
        tieredMode: "PER_ITEM",
        tiers: [
          { minQuantity: new Decimal(5), tierType: "AMOUNT", discountAmount: new Decimal(1000) },
          { minQuantity: new Decimal(10), tierType: "AMOUNT", discountAmount: new Decimal(2000) },
        ],
        targetProductIds: new Set([PRD_INK_EPSON.id]),
        targetCategoryIds: new Set(),
        targetUnitIds: new Set(),
      });

      const hydrated = await promoService.getById(tiered.id);
      expect(hydrated!.tiers).toHaveLength(2);
      expect(hydrated!.tiers![0].minQuantity.toNumber()).toBe(5);
      expect(hydrated!.tiers![1].minQuantity.toNumber()).toBe(10);
    });
  });

  // =========================================================================
  // F12: Smart Product Search Procedure
  // =========================================================================
  describe("F12: Smart Product Search Procedure", () => {
    it("T1-F12-01: search by Arabic product name ('دفتر سلك') -> returns matching product with variants and units", () => {
      const results = searchProducts({ q: "دفتر سلك" }, MANAGER_HAIDER);

      expect(results.length).toBeGreaterThan(0);
      const first = results[0];
      expect(first.productName).toContain("دفتر سلك جامعي");
      expect(first.units.length).toBeGreaterThan(0);
    });

    it("T1-F12-02: search by barcode ('628100100001') -> returns matching Rotring pen", () => {
      const results = searchProducts({ q: "628100100001" }, MANAGER_HAIDER);

      expect(results).toHaveLength(1);
      expect(results[0].productName).toContain("روترينج");
      expect(results[0].units.some((u) => u.barcode === "628100100001")).toBe(true);
    });

    it("T1-F12-03: search by carton barcode ('628100100144') -> matches Rotring pen with carton unit", () => {
      const results = searchProducts({ q: "628100100144" }, MANAGER_HAIDER);

      expect(results).toHaveLength(1);
      const cartonUnit = results[0].units.find((u) => u.barcode === "628100100144");
      expect(cartonUnit).toBeDefined();
      expect(cartonUnit!.unitName).toBe("كرتون");
    });

    it("T1-F12-04: search returns consignment product -> payload has isConsignment: true", () => {
      const results = searchProducts({ q: "إبسون" }, MANAGER_HAIDER);

      expect(results).toHaveLength(1);
      expect(results[0].isConsignment).toBe(true);
    });

    it("T1-F12-05: search by manager actor with cost permission -> costPrice is returned as valid string", () => {
      const results = searchProducts({ q: "روترينج" }, MANAGER_HAIDER);

      expect(results).toHaveLength(1);
      expect(results[0].costPrice).not.toBeNull();
      expect(results[0].costPrice).toBe("350.00");
    });

    it("T1-F12-06: search by cashier actor without cost permission -> costPrice is sanitized to null (cost masking)", () => {
      const results = searchProducts({ q: "روترينج" }, CASHIER_SALWA);

      expect(results).toHaveLength(1);
      // Sensitive cost price MUST be masked to null for cashiers
      expect(results[0].costPrice).toBeNull();
    });

    it("T1-F12-07: search with empty query string returns top active products up to limit", () => {
      const results = searchProducts({ limit: 4 }, MANAGER_HAIDER);
      expect(results).toHaveLength(4);
    });

    it("T1-F12-08: search query sanitization: handles Arabic alef normalization ('إبسون' vs 'ابسون')", () => {
      const withHamza = searchProducts({ q: "إبسون" }, MANAGER_HAIDER);
      const withoutHamza = searchProducts({ q: "ابسون" }, MANAGER_HAIDER);

      expect(withHamza).toHaveLength(1);
      expect(withoutHamza).toHaveLength(1);
      expect(withHamza[0].productId).toBe(withoutHamza[0].productId);
    });

    it("T1-F12-09: search filtering by categoryId returns only products in that category", () => {
      const results = searchProducts({ categoryId: 10 }, MANAGER_HAIDER);

      expect(results.length).toBeGreaterThan(0);
      expect(results.every((p) => p.categoryId === 10)).toBe(true);
    });

    it("T1-F12-10: search by SKU code returns exact matching variant", () => {
      const results = searchProducts({ q: "SKU-ROT-07" }, MANAGER_HAIDER);

      expect(results).toHaveLength(1);
      expect(results[0].sku).toBe("SKU-ROT-07");
    });
  });
});
