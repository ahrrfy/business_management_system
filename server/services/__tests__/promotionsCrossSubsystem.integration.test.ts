import { beforeEach, describe, expect, it, vi } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { truncateTables } from "./__testUtils__";

// Mock only the R2 S3 adapter so imageRoute can load cleanly without @aws-sdk/core/client in shared virtual store
vi.mock("../../lib/imageStore/r2Store", () => ({
  R2ImageStore: class {},
  readR2ImageStoreConfig: () => null,
}));

import { listActivePosPromotions, listByUnitIds, lookupByBarcode } from "../catalog/pos";
import { kioskLookup } from "../kioskService";
import { priceOnlineOrderLines } from "../onlineOrderService";
import { getAnomalyWatch } from "../reports/anomalyWatch";
import { createSale } from "../saleService";
import { createPromotion } from "../salesPromotionService";
import { lookupShelfPrice } from "../shelfPriceService";
import { storefrontOffers, storefrontProduct } from "../storefrontService";
import { withTx } from "../tx";
import { todayYmdBaghdad } from "../../../shared/promotionScheduling";

const TABLES = [
  "couponRedemptions",
  "couponReservations",
  "coupons",
  "couponPrograms",
  "returnRequests",
  "accountingEntries",
  "receipts",
  "inventoryMovements",
  "invoiceItemBundleComponents",
  "invoiceItems",
  "invoices",
  "idempotencyKeys",
  "promotionTiers",
  "promotionTargets",
  "promotions",
  "customerContractPrices",
  "productRelatedProducts",
  "storefrontProductReviews",
  "branchStock",
  "reservationStock",
  "productPrices",
  "productUnitBarcodes",
  "productUnits",
  "productVariants",
  "productImages",
  "products",
  "shifts",
  "auditLogs",
  "customers",
  "suppliers",
  "categories",
  "users",
  "branches",
];

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set");
  return d;
}

const insertId = (res: unknown): number => {
  const r = res as { insertId?: number } | Array<{ insertId?: number }>;
  return Number(Array.isArray(r) ? r[0]?.insertId : r?.insertId);
};

async function seedCatalogFixture() {
  const d = db();
  await d.insert(s.branches).values([
    { id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN", isActive: true },
  ]);
  await d.insert(s.users).values([
    { id: 1, openId: "admin_promo_cross", name: "مدير النظام", role: "admin", loginMethod: "local" },
    { id: 2, openId: "cashier_promo_cross", name: "كاشير 1", role: "cashier", branchId: 1, loginMethod: "local" },
  ]);
  await d.insert(s.categories).values([
    { id: 1, name: "قرطاسية مدرسية", isActive: true, showInStore: true },
  ]);
  await d.insert(s.products).values([
    { id: 1, name: "قلم جاف أزرق", categoryId: 1, isActive: true, showInStore: true, isBundle: false },
    { id: 2, name: "دفتر جامعي 100 ورقة", categoryId: 1, isActive: true, showInStore: true, isBundle: false },
    { id: 3, name: "حقيبة باقة مدرسية جاهزة", categoryId: 1, isActive: true, showInStore: true, isBundle: true },
  ]);
  await d.insert(s.productVariants).values([
    { id: 1, productId: 1, sku: "PEN-BLUE", costPrice: "5.00", isActive: true },
    { id: 2, productId: 2, sku: "NOTE-100", costPrice: "15.00", isActive: true },
    { id: 3, productId: 3, sku: "BUNDLE-BAG", costPrice: "0.00", isActive: true },
  ]);
  await d.insert(s.productUnits).values([
    // Pen: base piece + carton of 12
    {
      id: 1,
      variantId: 1,
      unitName: "قطعة",
      conversionFactor: "1",
      isBaseUnit: true,
      isActive: true,
      isStoreSaleUnit: true,
      barcode: "628990000001",
    },
    {
      id: 2,
      variantId: 1,
      unitName: "علبة 12",
      conversionFactor: "12",
      isBaseUnit: false,
      isActive: true,
      isStoreSaleUnit: true,
      barcode: "628990000012",
    },
    // Notebook: base piece
    {
      id: 3,
      variantId: 2,
      unitName: "قطعة",
      conversionFactor: "1",
      isBaseUnit: true,
      isActive: true,
      isStoreSaleUnit: true,
      barcode: "628990000002",
    },
    // Pre-made bundle product: base pack
    {
      id: 4,
      variantId: 3,
      unitName: "باقة",
      conversionFactor: "1",
      isBaseUnit: true,
      isActive: true,
      isStoreSaleUnit: true,
      barcode: "628990000003",
    },
  ]);
  await d.insert(s.productPrices).values([
    { productUnitId: 1, priceTier: "RETAIL", price: "10.00" },
    { productUnitId: 2, priceTier: "RETAIL", price: "110.00" },
    { productUnitId: 3, priceTier: "RETAIL", price: "50.00" },
    { productUnitId: 4, priceTier: "RETAIL", price: "60.00" },
  ]);
  await d.insert(s.branchStock).values([
    { variantId: 1, branchId: 1, quantity: 200 },
    { variantId: 2, branchId: 1, quantity: 100 },
    { variantId: 3, branchId: 1, quantity: 25 },
  ]);
}

beforeEach(async () => {
  await truncateTables(TABLES);
  await seedCatalogFixture();
});

describe("Cross-Subsystem Promotions Integration (POS Catalog, Shelf QR, Kiosk, Storefront, Online Orders, Anomaly Watch)", () => {
  it("POS catalog (lookupByBarcode, listByUnitIds, listActivePosPromotions): enforces FIXED_PRICE, applyToBaseUnitOnly, POS channel isolation, and isBundle ALL-scope exclusion", async () => {
    const today = todayYmdBaghdad();
    await withTx(async (tx) => {
      // 1) Store-only offer (must NOT leak into POS)
      await createPromotion(
        tx,
        {
          name: "عرض متجر فقط",
          type: "PERCENT",
          discountPercent: "50",
          scope: "ALL",
          channel: "STORE_ONLY",
          priority: 100,
          effectiveFrom: today,
        },
        1,
      );
      // 2) Global ALL-scope percent offer (must NOT apply to pre-made isBundle=true product #3)
      await createPromotion(
        tx,
        {
          name: "خصم عام 10%",
          type: "PERCENT",
          discountPercent: "10",
          scope: "ALL",
          channel: "ALL",
          priority: 10,
          effectiveFrom: today,
        },
        1,
      );
      // 3) FIXED_PRICE offer on Pen (productId=1) with applyToBaseUnitOnly=true -> piece=7.50, carton stays unaffected by FIXED_PRICE!
      await createPromotion(
        tx,
        {
          name: "القلم بسعر موحد 7.50",
          type: "FIXED_PRICE",
          fixedPrice: "7.50",
          scope: "PRODUCTS",
          channel: "POS_ONLY",
          applyToBaseUnitOnly: true,
          priority: 50,
          effectiveFrom: today,
          targets: [{ productId: 1 }],
        },
        1,
      );
    });

    // Piece barcode -> FIXED_PRICE 7.50 (discount 2.50)
    const pieceRow = await lookupByBarcode("628990000001", 1, "RETAIL");
    expect(pieceRow).not.toBeNull();
    expect(pieceRow!.promotionName).toBe("القلم بسعر موحد 7.50");
    expect(pieceRow!.promotionDiscountForUnit).toBe("2.50");
    expect(pieceRow!.promotionEffectivePrice).toBe("7.50");

    // Carton barcode -> applyToBaseUnitOnly=true blocks FIXED_PRICE 7.50 from turning a 110.00 carton into 7.50!
    // Instead, carton only matches the lower-priority ALL-scope 10% offer (if applyToBaseUnitOnly is false on it? Note: default applyToBaseUnitOnly is true on createPromotion too!).
    const cartonRow = await lookupByBarcode("628990000012", 1, "RETAIL");
    expect(cartonRow).not.toBeNull();
    expect(cartonRow!.promotionEffectivePrice).toBeNull();
    expect(cartonRow!.promotionDiscountForUnit).toBe("0.00");

    // Pre-made bundle product (isBundle=true) -> excluded from ALL-scope promotion automatically
    const rowsByUnit = await listByUnitIds([3, 4], 1, "RETAIL");
    const notebookRow = rowsByUnit.find((r) => r.productUnitId === 3)!;
    const bundleRow = rowsByUnit.find((r) => r.productUnitId === 4)!;
    expect(notebookRow.promotionName).toBe("خصم عام 10%");
    expect(notebookRow.promotionEffectivePrice).toBe("45.00");
    expect(bundleRow.promotionId).toBeNull();
    expect(bundleRow.promotionEffectivePrice).toBeNull();

    // Active POS rules exclude STORE_ONLY
    const activePosRules = await listActivePosPromotions(1, "RETAIL");
    expect(activePosRules.map((r) => r.name)).toContain("القلم بسعر موحد 7.50");
    expect(activePosRules.map((r) => r.name)).not.toContain("عرض متجر فقط");
  });

  it("Shelf QR Lookup & Kiosk Price Reader: resolve FIXED_PRICE accurately, protect non-base units, and never leak costPrice", async () => {
    const today = todayYmdBaghdad();
    await withTx(async (tx) => {
      await createPromotion(
        tx,
        {
          name: "سعر رف موحد 8 د.ع",
          type: "FIXED_PRICE",
          fixedPrice: "8.00",
          scope: "PRODUCTS",
          channel: "ALL",
          applyToBaseUnitOnly: true,
          priority: 20,
          effectiveFrom: today,
          targets: [{ productId: 1 }],
        },
        1,
      );
    });

    // Shelf QR lookup on base unit
    const shelfPiece = await lookupShelfPrice("628990000001", 1);
    expect(shelfPiece.found).toBe(true);
    if (shelfPiece.found) {
      expect(shelfPiece.price).toBe("8.00");
      expect(shelfPiece.originalPrice).toBe("10.00");
      expect(shelfPiece.promotionName).toBe("سعر رف موحد 8 د.ع");
      expect("costPrice" in shelfPiece).toBe(false);
    }

    // Shelf QR lookup on carton (conversionFactor=12, isBaseUnit=false) -> protected from piece FIXED_PRICE
    const shelfCarton = await lookupShelfPrice("628990000012", 1);
    expect(shelfCarton.found).toBe(true);
    if (shelfCarton.found) {
      expect(shelfCarton.price).toBe("110.00");
      expect(shelfCarton.originalPrice).toBeNull();
      expect(shelfCarton.promotionName).toBeNull();
    }

    // Kiosk lookup on base unit & carton
    const kioskPiece = await kioskLookup("628990000001", 1);
    expect(kioskPiece).not.toBeNull();
    expect(kioskPiece!.price).toBe("8.00");
    expect(kioskPiece!.originalPrice).toBe("10.00");
    expect(kioskPiece!.promotionName).toBe("سعر رف موحد 8 د.ع");
    expect("costPrice" in (kioskPiece as unknown as Record<string, unknown>)).toBe(false);

    const kioskCarton = await kioskLookup("628990000012", 1);
    expect(kioskCarton).not.toBeNull();
    expect(kioskCarton!.price).toBe("110.00");
    expect(kioskCarton!.originalPrice).toBeUndefined();
  });

  it("Storefront & Online Order Pricing: filters AUTO + STORE channels, formats all offer summaries, and prices cart-level BUNDLE_PRICE in online orders", async () => {
    const today = todayYmdBaghdad();
    await withTx(async (tx) => {
      // POS_ONLY offer -> must NOT appear on storefront or apply to online orders
      await createPromotion(
        tx,
        {
          name: "عرض كاشير فقط",
          type: "FIXED_PRICE",
          fixedPrice: "5.00",
          scope: "PRODUCTS",
          channel: "POS_ONLY",
          priority: 100,
          effectiveFrom: today,
          targets: [{ productId: 1 }],
        },
        1,
      );
      // COUPON-mode rule -> must NOT appear in public storefrontOffers banner or auto-apply without coupon
      await createPromotion(
        tx,
        {
          name: "قاعدة كوبون مخفية",
          type: "PERCENT",
          discountPercent: "40",
          scope: "ALL",
          channel: "STORE_ONLY",
          applicationMode: "COUPON",
          priority: 90,
          effectiveFrom: today,
        },
        1,
      );
      // STORE_ONLY FIXED_PRICE on Notebook (50.00 -> 38.00)
      await createPromotion(
        tx,
        {
          name: "عرض المتجر للدفتر",
          type: "FIXED_PRICE",
          fixedPrice: "38.00",
          scope: "PRODUCTS",
          channel: "STORE_ONLY",
          priority: 40,
          effectiveFrom: today,
          targets: [{ productId: 2 }],
        },
        1,
      );
      // STORE_ONLY BUNDLE_PRICE: Buy any 3 pens (normally 30.00) for 21.00 (discount 9.00 => 3.00/unit)
      await createPromotion(
        tx,
        {
          name: "3 أقلام بـ 21 للمتجر",
          type: "BUNDLE_PRICE",
          bundleMode: "PICK_ANY_N",
          bundleQuantity: 3,
          bundlePrice: "21.00",
          scope: "PRODUCTS",
          channel: "STORE_ONLY",
          priority: 60,
          effectiveFrom: today,
          targets: [{ productId: 1 }],
        },
        1,
      );
    });

    const offers = await storefrontOffers(1);
    const offerNames = offers.map((o) => o.name);
    expect(offerNames).toContain("عرض المتجر للدفتر");
    expect(offerNames).toContain("3 أقلام بـ 21 للمتجر");
    expect(offerNames).not.toContain("عرض كاشير فقط");
    expect(offerNames).not.toContain("قاعدة كوبون مخفية");
    const bundleBanner = offers.find((o) => o.name === "3 أقلام بـ 21 للمتجر")!;
    expect(bundleBanner.summary).toBeTruthy();

    // Storefront single-unit product card:
    // Pen has POS_ONLY FIXED_PRICE (ignored) and STORE_ONLY 3-for-21 BUNDLE_PRICE (conditional on qty=3 -> single card shows no misleading unit salePrice!)
    const penCard = await storefrontProduct(1, 1);
    expect(penCard).not.toBeNull();
    expect(penCard!.price).toBe("10.00");
    expect(penCard!.salePrice).toBeNull();

    // Notebook single-unit product card shows STORE_ONLY FIXED_PRICE 38.00
    const notebookCard = await storefrontProduct(2, 1);
    expect(notebookCard).not.toBeNull();
    expect(notebookCard!.price).toBe("50.00");
    expect(notebookCard!.salePrice).toBe("38.00");
    expect(notebookCard!.promotionName).toBe("عرض المتجر للدفتر");

    // Online order cart pricing with qty=3 pens + qty=1 notebook -> cart-level evaluation applies BOTH offers!
    const priced = await withTx((tx) =>
      priceOnlineOrderLines(
        tx,
        1,
        [
          { productUnitId: 1, quantity: 3 },
          { productUnitId: 3, quantity: 1 },
        ],
        { lock: false },
      ),
    );
    expect(priced.benefit.type).toBe("OFFER");
    // 3 pens: 30.00 -> 21.00 (discount 9.00) + 1 notebook: 50.00 -> 38.00 (discount 12.00) => total discount 21.00!
    expect(priced.benefit.discount).toBe("21.00");
    const penLine = priced.items.find((i) => i.productUnitId === 1)!;
    const noteLine = priced.items.find((i) => i.productUnitId === 3)!;
    expect(penLine.lineTotal).toBe("21.00");
    expect(noteLine.lineTotal).toBe("38.00");
  });

  it("Anomaly Watch (D2 Discount Spike): separates official promotionDiscount from manualDiscount and does not double-count grossTotal", async () => {
    const today = todayYmdBaghdad();
    const shiftRes = await db().insert(s.shifts).values({
      branchId: 1,
      userId: 2,
      openingBalance: "0",
      status: "OPEN",
    });
    const shiftId = insertId(shiftRes);

    const promoId = await withTx(async (tx) =>
      createPromotion(
        tx,
        {
          name: "تخفيض رسمي 30% على الدفتر",
          type: "PERCENT",
          discountPercent: "30",
          scope: "PRODUCTS",
          channel: "ALL",
          priority: 30,
          effectiveFrom: today,
          targets: [{ productId: 2 }],
        },
        1,
      ),
    );

    // Cashier (userId=2, role="cashier") sells 1 Notebook (50.00 -> 35.00 via 30% promo, 0 manual discount)
    const sale = await createSale(
      {
        branchId: 1,
        shiftId,
        sourceType: "POS",
        priceTier: "RETAIL",
        lines: [
          {
            variantId: 2,
            productUnitId: 3,
            quantity: "1",
            discountAmount: "15.00",
            promotionId: promoId,
          },
        ],
        payment: { method: "CASH", amount: "35.00" },
      },
      { userId: 2, branchId: 1, role: "cashier" },
    );
    expect(sale.total).toBe("35.00");

    const report = await getAnomalyWatch({
      from: "2020-01-01",
      to: "2030-12-31",
      branchId: 1,
    });
    const cashierRow = report.discounts.rows.find((r) => r.userId === 2);
    expect(cashierRow).toBeDefined();
    // Gross must be exactly 50.00 (NOT 65.00 double-counted!), manualDiscount = 0.00, promoDiscount = 15.00, flagged = false
    expect(cashierRow!.grossTotal).toBe("50.00");
    expect(cashierRow!.manualDiscount).toBe("0.00");
    expect(cashierRow!.promoDiscount).toBe("15.00");
    expect(cashierRow!.discountRatePct).toBe("0.00");
    expect(cashierRow!.flagged).toBe(false);
  });
});
