import { and, eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { truncateTables } from "./__testUtils__";
import { ensureProductSearchNormFixture } from "./__searchNormFixture__";
import {
  createPromotion,
  duplicatePromotion,
  getPromotionWithTargets,
  searchPromotionProducts,
  updatePromotion,
} from "../salesPromotionService";
import { promotionsV2Router } from "../../routers/promotionsV2Router";
import { withTx } from "../tx";
import { canSeeCostForUser } from "../../trpc";

const TABLES = [
  "inventoryProjectionState",
  "accountingEntries", "receipts", "inventoryMovements",
  "invoiceItemBundleComponents", "invoiceItems", "invoices", "idempotencyKeys",
  "promotionTiers", "promotionTargets", "promotions",
  "customerContractPrices",
  "branchStock", "productPrices", "productUnits", "productVariants", "productImages", "products",
  "shifts", "auditLogs", "customers", "suppliers", "categories",
  "users", "branches",
];

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set");
  return d;
}

async function reset() {
  await truncateTables(TABLES);
}

async function seedData() {
  const d = db();
  await d.insert(s.branches).values([
    { id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" },
  ]);
  await d.insert(s.users).values([
    { id: 1, openId: "admin_user", name: "admin", role: "admin", loginMethod: "local" },
    { id: 2, openId: "cashier_user", name: "cashier", role: "cashier", loginMethod: "local" },
    { id: 3, openId: "sales_user", name: "sales", role: "sales_rep", loginMethod: "local" },
  ]);
  await d.insert(s.categories).values([
    { id: 1, name: "أدوات مكتبية" },
    { id: 2, name: "هدايا وأمانات" },
  ]);

  // Products:
  // Product 1: Owned goods ("قلم حبر جاف")
  // Product 2: Consignment goods ("لوحة فنية تراثية") -> isConsignment: true
  // Product 3: Arabic name with hamza ("أقلام رصاص ملونة")
  // Product 4: Arabic name with taa marbuta ("مكتبة خشبية فاخرة")
  // Product 5: Product with Latin digits ("دفتر ملاحظات 100 ورقة")
  await d.insert(s.products).values([
    { id: 1, name: "قلم حبر جاف", categoryId: 1, isConsignment: false },
    { id: 2, name: "لوحة فنية تراثية", categoryId: 2, isConsignment: true },
    { id: 3, name: "أقلام رصاص ملونة", categoryId: 1, isConsignment: false },
    { id: 4, name: "مكتبة خشبية فاخرة", categoryId: 1, isConsignment: false },
    { id: 5, name: "دفتر ملاحظات 100 ورقة", categoryId: 1, isConsignment: false },
  ]);

  // Variants
  await d.insert(s.productVariants).values([
    { id: 1, productId: 1, sku: "PEN-001", costPrice: "250.00", variantKind: "VARIANT" },
    { id: 2, productId: 2, sku: "ART-CONSIGN-99", costPrice: "45000.00", variantKind: "VARIANT" },
    { id: 3, productId: 3, sku: "PENCIL-COLOR", costPrice: "1200.00", variantKind: "VARIANT" },
    { id: 4, productId: 4, sku: "DESK-WOOD", costPrice: "85000.00", variantKind: "VARIANT" },
    { id: 5, productId: 5, sku: "NOTE-100", costPrice: "750.00", variantKind: "VARIANT" },
  ]);

  // Units with barcodes
  await d.insert(s.productUnits).values([
    { id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", barcode: "6281001122334", isBaseUnit: true, isActive: true },
    { id: 2, variantId: 1, unitName: "باكيت 12 قلم", conversionFactor: "12", barcode: "6281001122999", isBaseUnit: false, isActive: true },
    { id: 3, variantId: 2, unitName: "قطعة", conversionFactor: "1", barcode: "ART998877", isBaseUnit: true, isActive: true },
    { id: 4, variantId: 3, unitName: "علبة", conversionFactor: "1", barcode: "PENCIL123", isBaseUnit: true, isActive: true },
    { id: 5, variantId: 4, unitName: "قطعة", conversionFactor: "1", barcode: "DESK4455", isBaseUnit: true, isActive: true },
    { id: 6, variantId: 5, unitName: "دفتر", conversionFactor: "1", barcode: "NOTE100PAGE", isBaseUnit: true, isActive: true },
    // Inactive unit with barcode
    { id: 7, variantId: 1, unitName: "تالف ملغي", conversionFactor: "1", barcode: "DEAD-BARCODE-999", isBaseUnit: false, isActive: false },
  ]);

  // Retail Prices
  await d.insert(s.productPrices).values([
    { productUnitId: 1, priceTier: "RETAIL", price: "500.00" },
    { productUnitId: 2, priceTier: "RETAIL", price: "5500.00" },
    { productUnitId: 3, priceTier: "RETAIL", price: "75000.00" },
    { productUnitId: 4, priceTier: "RETAIL", price: "2500.00" },
    { productUnitId: 5, priceTier: "RETAIL", price: "120000.00" },
    { productUnitId: 6, priceTier: "RETAIL", price: "1500.00" },
  ]);
}

beforeAll(async () => {
  await ensureProductSearchNormFixture();
});

beforeEach(async () => {
  await reset();
  await seedData();
});

describe("Adversarial Challenge 1: Security & Cost Price Masking", () => {
  it("when user is admin (canSeeCostForUser = true), costPrice is visible as exact string", async () => {
    const adminUser = { id: 1, role: "admin", isOwner: true };
    const canViewCost = canSeeCostForUser(adminUser as any);
    expect(canViewCost).toBe(true);

    const results = await searchPromotionProducts(db(), { q: "PEN-001" }, canViewCost);
    expect(results).toHaveLength(1);
    expect(results[0].costPrice).toBe("250.00");
  });

  it("when user is cashier (canSeeCostForUser = false), costPrice is strictly NULL", async () => {
    const cashierUser = { id: 2, role: "cashier" };
    const canViewCost = canSeeCostForUser(cashierUser as any);
    expect(canViewCost).toBe(false);

    const results = await searchPromotionProducts(db(), { q: "PEN-001" }, canViewCost);
    expect(results).toHaveLength(1);
    expect(results[0].costPrice).toBeNull();
    expect(results[0].costPrice).not.toBe("250.00");
    expect(results[0].costPrice).not.toBe("0.00");
  });

  it("when user is sales rep without reports permission, costPrice is strictly NULL across all returned products", async () => {
    const salesUser = { id: 3, role: "sales_rep" };
    const canViewCost = canSeeCostForUser(salesUser as any);
    expect(canViewCost).toBe(false);

    const allResults = await searchPromotionProducts(db(), { limit: 50 }, canViewCost);
    expect(allResults.length).toBeGreaterThanOrEqual(5);
    for (const item of allResults) {
      expect(item.costPrice).toBeNull();
      // Ensure units also do not leak cost
      for (const unit of item.units) {
        expect((unit as any).costPrice).toBeUndefined();
        expect((unit as any).cost).toBeUndefined();
      }
    }
  });

  it("strict JSON serialization check: costPrice serialized as null without numeric residue", async () => {
    const results = await searchPromotionProducts(db(), { q: "ART-CONSIGN-99" }, false);
    expect(results).toHaveLength(1);
    const jsonStr = JSON.stringify(results[0]);
    expect(jsonStr).toContain('"costPrice":null');
    expect(jsonStr).not.toContain("45000");
  });
});

describe("Adversarial Challenge 2: Arabic Search Normalization", () => {
  it("normalizes hamzas (أ, إ, آ, ٱ -> ا): query with plain alif finds product with hamza", async () => {
    // Product in DB is "أقلام رصاص ملونة"
    // Query with plain alif: "اقلام"
    const resultsPlain = await searchPromotionProducts(db(), { q: "اقلام" }, false);
    // Should match! Note: in MySQL, LIKE on utf8mb4_unicode_ci or via products.name/products.searchNorm
    const found = resultsPlain.some((r) => r.productId === 3);
    expect(found).toBe(true);
  });

  it("normalizes hamzas: query with madda (آ) finds product with hamza (أ)", async () => {
    const resultsMadda = await searchPromotionProducts(db(), { q: "آقلام" }, false);
    const found = resultsMadda.some((r) => r.productId === 3);
    expect(found).toBe(true);
  });

  it("normalizes taa marbuta (ة -> ه): query with haa finds product with taa marbuta", async () => {
    // Product in DB is "مكتبة خشبية فاخرة"
    // Query with haa: "مكتبه"
    const resultsHaa = await searchPromotionProducts(db(), { q: "مكتبه" }, false);
    const found = resultsHaa.some((r) => r.productId === 4);
    expect(found).toBe(true);
  });

  it("normalizes Persian and Arabic-Indic numerals: ١٠٠ finds product with '100'", async () => {
    // Product in DB is "دفتر ملاحظات 100 ورقة"
    // Query with Arabic digits: "١٠٠"
    const resultsDigits = await searchPromotionProducts(db(), { q: "١٠٠" }, false);
    const found = resultsDigits.some((r) => r.productId === 5);
    expect(found).toBe(true);
  });

  it("handles whitespace padding and extra spaces gracefully", async () => {
    const results = await searchPromotionProducts(db(), { q: "   قلم    حبر   " }, false);
    // When normalized, "قلم حبر" or words match
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].productId).toBe(1);
  });

  it("handles SQL wildcards and special characters without crashing", async () => {
    // Queries like '%', '_', quotes
    const results1 = await searchPromotionProducts(db(), { q: "%" }, false);
    expect(Array.isArray(results1)).toBe(true);

    const results2 = await searchPromotionProducts(db(), { q: "' OR '1'='1" }, false);
    expect(Array.isArray(results2)).toBe(true);
  });
});

describe("Adversarial Challenge 3: Barcode Lookup", () => {
  it("instant exact barcode match returns the correct product and all its packaging units", async () => {
    const results = await searchPromotionProducts(db(), { q: "6281001122334" }, false);
    expect(results).toHaveLength(1);
    expect(results[0].productId).toBe(1);
    expect(results[0].productName).toBe("قلم حبر جاف");
    // Should include both active packaging units (Piece and Box of 12)
    expect(results[0].units).toHaveLength(2);
    const barcodes = results[0].units.map((u) => u.barcode);
    expect(barcodes).toContain("6281001122334");
    expect(barcodes).toContain("6281001122999");
  });

  it("searching derived packaging unit barcode returns the parent product with the derived unit", async () => {
    const results = await searchPromotionProducts(db(), { q: "6281001122999" }, false);
    expect(results).toHaveLength(1);
    expect(results[0].productId).toBe(1);
    const boxUnit = results[0].units.find((u) => u.barcode === "6281001122999");
    expect(boxUnit).toBeDefined();
    expect(Number(boxUnit!.conversionFactor)).toBe(12);
    expect(boxUnit!.retailPrice).toBe("5500.00");
  });

  it("inactive packaging units (isActive = false) are never matched or returned", async () => {
    // Barcode "DEAD-BARCODE-999" belongs to inactive unit id 7
    const results = await searchPromotionProducts(db(), { q: "DEAD-BARCODE-999" }, false);
    expect(results).toHaveLength(0);
  });
});

describe("Adversarial Challenge 4: Consignment Goods", () => {
  it("correctly identifies consignment goods with isConsignment: true", async () => {
    const results = await searchPromotionProducts(db(), { q: "لوحة فنية" }, false);
    expect(results).toHaveLength(1);
    expect(results[0].productId).toBe(2);
    expect(results[0].isConsignment).toBe(true);
    expect(typeof results[0].isConsignment).toBe("boolean");
  });

  it("correctly identifies owned goods with isConsignment: false", async () => {
    const results = await searchPromotionProducts(db(), { q: "قلم حبر" }, false);
    expect(results).toHaveLength(1);
    expect(results[0].productId).toBe(1);
    expect(results[0].isConsignment).toBe(false);
    expect(typeof results[0].isConsignment).toBe("boolean");
  });
});

describe("Adversarial Challenge 5: CRUD & Hydration", () => {
  it("full lifecycle: create TIERED_QTY with productUnitId targets and multi-tier rules, hydrate, update, and duplicate", async () => {
    // 1. Create multi-tier promotion
    const promoId = await withTx(async (tx) => {
      return createPromotion(tx, {
        name: "عرض القرطاسية المتدرج للكرتون",
        description: "خصم كميات تصاعدي على كرتون الأقلام",
        type: "TIERED_QTY",
        tieredMode: "PER_ITEM",
        scope: "PRODUCTS",
        effectiveFrom: "2026-05-01",
        effectiveTo: "2026-10-31",
        channel: "POS_ONLY",
        allowBelowCost: true,
        applyToBaseUnitOnly: false,
        activeDays: [0, 1, 2, 3, 4], // Sun-Thu
        targets: [
          { productUnitId: 2 }, // Packaging unit (Box of 12)
        ],
        tiers: [
          { minQuantity: "3.00", tierType: "PERCENT", discountPercent: "10.00" },
          { minQuantity: "6.00", tierType: "PERCENT", discountPercent: "15.00" },
          { minQuantity: "12.00", tierType: "FIXED_PRICE", fixedPrice: "4000.00" },
        ],
      }, 1);
    });

    expect(promoId).toBeGreaterThan(0);

    // 2. Hydrate via getPromotionWithTargets
    const hydrated = await withTx(async (tx) => getPromotionWithTargets(tx, promoId));
    expect(hydrated).not.toBeNull();
    const p = hydrated!.promotion;
    expect(p.name).toBe("عرض القرطاسية المتدرج للكرتون");
    expect(p.type).toBe("TIERED_QTY");
    expect(p.channel).toBe("POS_ONLY");
    expect(p.allowBelowCost).toBe(true);
    expect(p.applyToBaseUnitOnly).toBe(false);
    expect(p.activeDays).toEqual([0, 1, 2, 3, 4]);

    // Verify targets hydration
    expect(hydrated!.targets).toHaveLength(1);
    expect(hydrated!.targets[0].productUnitId).toBe(2);
    expect(hydrated!.targets[0].productId).toBeNull();
    expect(hydrated!.targets[0].categoryId).toBeNull();
    expect(hydrated!.targets[0].variantId).toBeNull();

    // Verify tiers hydration (ordered by minQuantity)
    expect(hydrated!.tiers).toHaveLength(3);
    expect(Number(hydrated!.tiers[0].minQuantity)).toBe(3);
    expect(hydrated!.tiers[0].tierType).toBe("PERCENT");
    expect(Number(hydrated!.tiers[0].discountPercent)).toBe(10);

    expect(Number(hydrated!.tiers[1].minQuantity)).toBe(6);
    expect(hydrated!.tiers[1].tierType).toBe("PERCENT");
    expect(Number(hydrated!.tiers[1].discountPercent)).toBe(15);

    expect(Number(hydrated!.tiers[2].minQuantity)).toBe(12);
    expect(hydrated!.tiers[2].tierType).toBe("FIXED_PRICE");
    expect(Number(hydrated!.tiers[2].fixedPrice)).toBe(4000);

    // 3. Update promotion: change tiers and target
    await withTx(async (tx) => {
      await updatePromotion(tx, {
        id: promoId,
        name: "عرض القرطاسية المحدث",
        targets: [
          { productUnitId: 1 }, // Changed to Piece unit
        ],
        tiers: [
          { minQuantity: "10.00", tierType: "AMOUNT", discountAmount: "50.00" },
          { minQuantity: "20.00", tierType: "AMOUNT", discountAmount: "100.00" },
        ],
      }, 1);
    });

    const updated = await withTx(async (tx) => getPromotionWithTargets(tx, promoId));
    expect(updated!.promotion.name).toBe("عرض القرطاسية المحدث");
    expect(updated!.targets).toHaveLength(1);
    expect(updated!.targets[0].productUnitId).toBe(1);
    expect(updated!.tiers).toHaveLength(2);
    expect(Number(updated!.tiers[0].minQuantity)).toBe(10);
    expect(updated!.tiers[0].tierType).toBe("AMOUNT");
    expect(Number(updated!.tiers[0].discountAmount)).toBe(50);
    expect(Number(updated!.tiers[1].minQuantity)).toBe(20);

    // 4. Duplicate promotion
    const clonedId = await withTx(async (tx) => {
      return duplicatePromotion(tx, promoId, 1, "2026-06-01", { role: "admin", id: 1 } as any);
    });
    expect(clonedId).toBeGreaterThan(0);
    expect(clonedId).not.toBe(promoId);

    const cloned = await withTx(async (tx) => getPromotionWithTargets(tx, clonedId));
    expect(cloned!.promotion.name).toBe("نسخة من عرض القرطاسية المحدث");
    expect(cloned!.promotion.isActive).toBe(false); // Draft
    expect(cloned!.promotion.effectiveFrom).toBe("2026-06-01");
    expect(cloned!.promotion.effectiveTo).toBeNull();
    expect(cloned!.targets).toHaveLength(1);
    expect(cloned!.targets[0].productUnitId).toBe(1);
    expect(cloned!.tiers).toHaveLength(2);
  });

  it("shape enforcement rejects invalid TIERED_QTY configurations", async () => {
    // TIERED_QTY with empty tiers must throw BAD_REQUEST
    await expect(
      withTx(async (tx) => {
        return createPromotion(tx, {
          name: "عرض باطل بلا شرائح",
          type: "TIERED_QTY",
          tieredMode: "PER_ITEM",
          scope: "PRODUCTS",
          effectiveFrom: "2026-01-01",
          targets: [{ productUnitId: 1 }],
          tiers: [],
        }, 1);
      })
    ).rejects.toThrow();

    // Target with multiple grains (e.g. productId AND productUnitId) must throw BAD_REQUEST
    await expect(
      withTx(async (tx) => {
        return createPromotion(tx, {
          name: "عرض باطل حبيبات متعددة",
          type: "TIERED_QTY",
          tieredMode: "PER_ITEM",
          scope: "PRODUCTS",
          effectiveFrom: "2026-01-01",
          targets: [{ productId: 1, productUnitId: 1 }],
          tiers: [{ minQuantity: "5", tierType: "PERCENT", discountPercent: "10" }],
        }, 1);
      })
    ).rejects.toThrow();
  });
});

describe("Adversarial Challenge 6: promotionsV2Router RBAC & Procedure Contracts", () => {
  it("router searchProducts procedure masks costPrice for cashier and reveals for admin", async () => {
    const adminCaller = promotionsV2Router.createCaller({
      user: { id: 1, role: "admin", isOwner: true, branchId: 1 },
      req: {} as any,
      res: {} as any,
    } as any);

    const cashierCaller = promotionsV2Router.createCaller({
      user: { id: 2, role: "cashier", isOwner: false, branchId: 1 },
      req: {} as any,
      res: {} as any,
    } as any);

    const adminRes = await adminCaller.searchProducts({ q: "PEN-001" });
    expect(adminRes).toHaveLength(1);
    expect(adminRes[0].costPrice).toBe("250.00");

    const cashierRes = await cashierCaller.searchProducts({ q: "PEN-001" });
    expect(cashierRes).toHaveLength(1);
    expect(cashierRes[0].costPrice).toBeNull();
  });

  it("router create, getById, and duplicate lifecycle via tRPC caller", async () => {
    const adminCaller = promotionsV2Router.createCaller({
      user: { id: 1, role: "admin", isOwner: true, branchId: 1 },
      req: {} as any,
      res: {} as any,
    } as any);

    const { promotionId } = await adminCaller.create({
      name: "عرض الراوتر للشرائح",
      type: "TIERED_QTY",
      scope: "PRODUCTS",
      effectiveFrom: "2026-01-01",
      tieredMode: "PER_ITEM",
      targets: [{ productUnitId: 1 }],
      tiers: [
        { minQuantity: "5.00", tierType: "PERCENT", discountPercent: "10.00" },
      ],
    });
    expect(promotionId).toBeGreaterThan(0);

    const details = await adminCaller.getById({ promotionId });
    expect(details).not.toBeNull();
    expect(details!.promotion.name).toBe("عرض الراوتر للشرائح");
    expect(details!.targets).toHaveLength(1);
    expect(details!.targets[0].productUnitId).toBe(1);
    expect(details!.tiers).toHaveLength(1);

    const { promotionId: clonedId } = await adminCaller.duplicate({ promotionId });
    expect(clonedId).toBeGreaterThan(0);
    expect(clonedId).not.toBe(promotionId);

    const clonedDetails = await adminCaller.getById({ promotionId: clonedId });
    expect(clonedDetails!.promotion.name).toBe("نسخة من عرض الراوتر للشرائح");
    expect(clonedDetails!.promotion.isActive).toBe(false);
  });

  it("router enforces branch scoping on getById for non-admin", async () => {
    // Create promotion belonging to branch 1
    const adminCaller = promotionsV2Router.createCaller({
      user: { id: 1, role: "admin", isOwner: true, branchId: 1 },
      req: {} as any,
      res: {} as any,
    } as any);

    const { promotionId } = await adminCaller.create({
      name: "عرض خاص بفرع 1",
      type: "PERCENT",
      scope: "ALL",
      effectiveFrom: "2026-01-01",
      discountPercent: "10.00",
      branchId: 1,
    });

    // Caller from branch 2
    const otherBranchCaller = promotionsV2Router.createCaller({
      user: { id: 4, role: "manager", isOwner: false, branchId: 2 },
      req: {} as any,
      res: {} as any,
    } as any);

    await expect(
      otherBranchCaller.getById({ promotionId })
    ).rejects.toThrow();
  });
});

