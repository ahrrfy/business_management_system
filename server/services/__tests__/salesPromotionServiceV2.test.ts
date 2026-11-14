// اختبارات العروض v2 (٨/٧/٢٦، بعد gstack-review PR #163):
// - resolvePromotionForLine بحبيبة اليوم المحلي (B8): آخر يوم يعمل + عرض يوم واحد يعمل.
// - قصّ الخصم إلى سعر الوحدة (P5).
// - أسبقية عند التعارض حتميّة (P6).
// - contract-price يفوز (returns null).
// - دمج في sale/create: idempotent verification — promotionId يُسجَّل لو تطابقت الأرقام، وإلا يعامل كيدوي.
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { truncateTables } from "./__testUtils__";
import { createPromotion, deactivatePromotion, duplicatePromotion, getPromotionWithTargets, loadPromotionPerformance, resolvePromotionForLine, searchPromotionProducts, updatePromotion } from "../salesPromotionService";
import { hashCouponCode } from "../couponService";
import { returnSale } from "../returnService";
import { createSale } from "../saleService";
import { checkoutReception } from "../receptionCheckoutService";
import { replayOfflineReception } from "../offline/replayReception";
import { withTx } from "../tx";
import { crmRouter } from "../../routers/crmRouter";

const actor = { userId: 1, branchId: 1, role: "admin" as const };

const TABLES = [
  "deliveryOutbox", "deliveryEvents", "deliveryLedgerEntries",
  "deliveryRemittanceLines", "deliveryRemittances", "deliveryConsignments",
  "deliveryPartyMembers", "deliveryParties",
  "couponRedemptions", "couponReservations", "coupons", "couponPrograms",
  "returnRequests", "accountingEntries", "receipts", "inventoryMovements",
  "invoiceItemBundleComponents", "invoiceItems", "invoices", "idempotencyKeys",
  "promotionTiers", "promotionTargets", "promotions",
  "customerContractPrices",
  "branchStock", "productPrices", "productUnits", "productVariants", "productImages", "products",
  "shifts", "auditLogs", "customers", "suppliers", "categories",
  "users", "branches",
];

function db() { const d = getDb(); if (!d) throw new Error("DATABASE_URL not set"); return d; }
const insertId = (res: any): number => Number(res?.[0]?.insertId ?? res?.insertId);

async function reset() { await truncateTables(TABLES); }

async function seedBase() {
  const d = db();
  await d.insert(s.branches).values([
    { id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "المبيعات", code: "SALES", type: "SALES" },
  ]);
  await d.insert(s.users).values({ id: 1, openId: "local_test", name: "admin", role: "admin", loginMethod: "local" });
  await d.insert(s.categories).values([{ id: 1, name: "قرطاسية" }, { id: 2, name: "هدايا" }]);
  await d.insert(s.products).values([
    { id: 1, name: "قلم", categoryId: 1 },
    { id: 2, name: "دفتر", categoryId: 1 },
    { id: 3, name: "لعبة", categoryId: 2 },
  ]);
  await d.insert(s.productVariants).values([
    { id: 1, productId: 1, sku: "PEN-1", costPrice: "4.00" },
    { id: 2, productId: 2, sku: "NB-1", costPrice: "10.00" },
    { id: 3, productId: 3, sku: "TOY-1", costPrice: "20.00" },
  ]);
  await d.insert(s.productUnits).values([
    { id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
    { id: 2, variantId: 2, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
    { id: 3, variantId: 3, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
  ]);
  await d.insert(s.productPrices).values([
    { productUnitId: 1, priceTier: "RETAIL", price: "10.00" },
    { productUnitId: 2, priceTier: "RETAIL", price: "20.00" },
    { productUnitId: 3, priceTier: "RETAIL", price: "50.00" },
  ]);
}

async function setStock(variantId: number, branchId: number, qty: number) {
  await db().insert(s.branchStock).values({ variantId, branchId, quantity: qty });
}
async function openShift(branchId = 1): Promise<number> {
  const r = await db().insert(s.shifts).values({ branchId, userId: 1, openingBalance: "0", status: "OPEN" });
  return insertId(r);
}

beforeEach(async () => { await reset(); await seedBase(); });

describe("resolvePromotionForLine — قواعد الحلّ", () => {
  it("contract-price يفوز ⇒ لا عرض", async () => {
    await withTx(async (tx) => {
      await createPromotion(tx, { name: "خصم 20%", type: "PERCENT", discountPercent: "20", scope: "ALL", effectiveFrom: "2026-01-01" }, 1);
    });
    const result = await withTx((tx) => resolvePromotionForLine(tx, {
      branchId: 1, customerTier: "RETAIL", productId: 1, variantId: 1, categoryId: 1,
      unitPrice: "10.00", lineAmount: "50.00", hasContractPrice: true, todayYmd: "2026-07-15",
    }));
    expect(result).toBeNull();
  });

  it("نطاق ALL: كل منتج يحصل على الخصم", async () => {
    await withTx(async (tx) => {
      await createPromotion(tx, { name: "خصم 10%", type: "PERCENT", discountPercent: "10", scope: "ALL", effectiveFrom: "2026-01-01" }, 1);
    });
    const r = await withTx((tx) => resolvePromotionForLine(tx, {
      branchId: 1, customerTier: "RETAIL", productId: 1, variantId: 1, categoryId: 1,
      unitPrice: "10.00", lineAmount: "10.00", hasContractPrice: false, todayYmd: "2026-07-15",
    }));
    expect(r).not.toBeNull();
    expect(r!.discountForUnit).toBe("1.00");
  });

  it("B8: يعمل في اليوم الأخير (todayYmd == effectiveTo)", async () => {
    await withTx(async (tx) => {
      await createPromotion(tx, { name: "خصم اليوم", type: "PERCENT", discountPercent: "10", scope: "ALL", effectiveFrom: "2026-07-15", effectiveTo: "2026-07-15" }, 1);
    });
    const r = await withTx((tx) => resolvePromotionForLine(tx, {
      branchId: 1, customerTier: "RETAIL", productId: 1, variantId: 1, categoryId: 1,
      unitPrice: "10.00", lineAmount: "10.00", hasContractPrice: false, todayYmd: "2026-07-15",
    }));
    expect(r).not.toBeNull();
  });

  it("B8: لا يعمل خارج النافذة", async () => {
    await withTx(async (tx) => {
      await createPromotion(tx, { name: "خصم منتهي", type: "PERCENT", discountPercent: "10", scope: "ALL", effectiveFrom: "2026-06-01", effectiveTo: "2026-06-30" }, 1);
    });
    const r = await withTx((tx) => resolvePromotionForLine(tx, {
      branchId: 1, customerTier: "RETAIL", productId: 1, variantId: 1, categoryId: 1,
      unitPrice: "10.00", lineAmount: "10.00", hasContractPrice: false, todayYmd: "2026-07-15",
    }));
    expect(r).toBeNull();
  });

  it("P5: خصم AMOUNT أكبر من سعر الوحدة يُقصر إلى سعر الوحدة", async () => {
    await withTx(async (tx) => {
      await createPromotion(tx, { name: "خصم كبير", type: "AMOUNT", discountAmount: "999", scope: "ALL", effectiveFrom: "2026-01-01" }, 1);
    });
    const r = await withTx((tx) => resolvePromotionForLine(tx, {
      branchId: 1, customerTier: "RETAIL", productId: 1, variantId: 1, categoryId: 1,
      unitPrice: "10.00", lineAmount: "10.00", hasContractPrice: false, todayYmd: "2026-07-15",
    }));
    expect(r).not.toBeNull();
    expect(r!.discountForUnit).toBe("10.00");
  });

  it("P6: أعلى priority يفوز عند التعارض", async () => {
    await withTx(async (tx) => {
      await createPromotion(tx, { name: "أدنى", type: "PERCENT", discountPercent: "10", scope: "ALL", effectiveFrom: "2026-01-01", priority: 1 }, 1);
      await createPromotion(tx, { name: "أعلى", type: "PERCENT", discountPercent: "5", scope: "ALL", effectiveFrom: "2026-01-01", priority: 5 }, 1);
    });
    const r = await withTx((tx) => resolvePromotionForLine(tx, {
      branchId: 1, customerTier: "RETAIL", productId: 1, variantId: 1, categoryId: 1,
      unitPrice: "10.00", lineAmount: "10.00", hasContractPrice: false, todayYmd: "2026-07-15",
    }));
    expect(r!.promotionName).toBe("أعلى");
  });

  it("قيد الفرع: عرض فرع 1 لا ينطبق في فرع 2", async () => {
    await withTx(async (tx) => {
      await createPromotion(tx, { name: "MAIN", type: "PERCENT", discountPercent: "10", scope: "ALL", branchId: 1, effectiveFrom: "2026-01-01" }, 1);
    });
    const b1 = await withTx((tx) => resolvePromotionForLine(tx, {
      branchId: 1, customerTier: "RETAIL", productId: 1, variantId: 1, categoryId: 1,
      unitPrice: "10.00", lineAmount: "10.00", hasContractPrice: false, todayYmd: "2026-07-15",
    }));
    expect(b1).not.toBeNull();
    const b2 = await withTx((tx) => resolvePromotionForLine(tx, {
      branchId: 2, customerTier: "RETAIL", productId: 1, variantId: 1, categoryId: 1,
      unitPrice: "10.00", lineAmount: "10.00", hasContractPrice: false, todayYmd: "2026-07-15",
    }));
    expect(b2).toBeNull();
  });

  it("العرض المعطَّل لا ينطبق", async () => {
    const pid = await withTx(async (tx) => createPromotion(tx, { name: "معطَّل", type: "PERCENT", discountPercent: "10", scope: "ALL", effectiveFrom: "2026-01-01" }, 1));
    await withTx((tx) => deactivatePromotion(tx, pid));
    const r = await withTx((tx) => resolvePromotionForLine(tx, {
      branchId: 1, customerTier: "RETAIL", productId: 1, variantId: 1, categoryId: 1,
      unitPrice: "10.00", lineAmount: "10.00", hasContractPrice: false, todayYmd: "2026-07-15",
    }));
    expect(r).toBeNull();
  });
});

describe("دمج مسار البيع — idempotent verification", () => {
  it("مؤشرات الأداء تُشتق من لقطة الفاتورة: المبيعات والخصم والتكلفة والربح", async () => {
    await setStock(1, 1, 100);
    const pid = await withTx((tx) => createPromotion(tx, { name: "خصم 10%", type: "PERCENT", discountPercent: "10", scope: "ALL", effectiveFrom: "2026-01-01" }, 1));
    const shiftId = await openShift();
    await createSale(
      {
        branchId: 1, shiftId, sourceType: "POS", priceTier: "RETAIL",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "5", unitPriceOverride: "10.00", discountAmount: "5.00", promotionId: pid }],
        payment: { amount: "45.00", method: "CASH" },
      } as any,
      actor,
    );

    const performance = await withTx((tx) => loadPromotionPerformance(tx, 1));
    expect(performance.rows).toEqual([{
      promotionId: pid,
      invoiceCount: 1,
      netSales: "45.00",
      discount: "5.00",
      cost: "20.00",
      grossProfit: "25.00",
    }]);
    expect(performance.summary).toMatchObject({ invoiceCount: 1, netSales: "45.00", discount: "5.00", grossProfit: "25.00" });
  });

  it("promotionId يُسجَّل + promotionDiscount يُخزَّن + الخصم في discountAmount", async () => {
    await setStock(1, 1, 100);
    const pid = await withTx((tx) => createPromotion(tx, { name: "خصم 10%", type: "PERCENT", discountPercent: "10", scope: "ALL", effectiveFrom: "2026-01-01" }, 1));
    const shiftId = await openShift();
    const res = await createSale(
      {
        branchId: 1, shiftId, sourceType: "POS", priceTier: "RETAIL",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "5", unitPriceOverride: "10.00", discountAmount: "5.00", promotionId: pid }],
        payment: { amount: "45.00", method: "CASH" },
      } as any,
      actor,
    );
    const items = await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, res.invoiceId));
    expect(items[0].promotionId).not.toBeNull();
    expect(Number(items[0].promotionId)).toBe(pid);
    expect(items[0].promotionDiscount).toBe("5.00");
    expect(items[0].discountAmount).toBe("5.00");
    expect(items[0].total).toBe("45.00");
  });

  it("promotionId مُرسَل لكن العرض لا ينطبق ⇒ الخصم يعامل كيدوي (لا تسجيل promotionId)", async () => {
    await setStock(1, 1, 100);
    // ننشئ عرضاً ثم نُعطّله. POS ما زال يمرّر pid (لقطة قديمة).
    const pid = await withTx((tx) => createPromotion(tx, { name: "قديم", type: "PERCENT", discountPercent: "10", scope: "ALL", effectiveFrom: "2026-01-01" }, 1));
    await withTx((tx) => deactivatePromotion(tx, pid));
    const shiftId = await openShift();
    const res = await createSale(
      {
        branchId: 1, shiftId, sourceType: "POS", priceTier: "RETAIL",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "5", unitPriceOverride: "10.00", discountAmount: "5.00", promotionId: pid }],
        payment: { amount: "45.00", method: "CASH" },
      } as any,
      actor,
    );
    const items = await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, res.invoiceId));
    // العرض معطَّل ⇒ لا يُسجَّل promotionId (يُعامَل كيدوي).
    expect(items[0].promotionId).toBeNull();
    expect(items[0].promotionDiscount).toBe("0.00");
    // لكنّ الخصم اليدوي يبقى.
    expect(items[0].discountAmount).toBe("5.00");
  });

  it("promotionId غير مُرسَل ⇒ لا يُحلّ عرض حتى لو ينطبق (نيّة يدوية)", async () => {
    await setStock(1, 1, 100);
    await withTx((tx) => createPromotion(tx, { name: "متاح", type: "PERCENT", discountPercent: "10", scope: "ALL", effectiveFrom: "2026-01-01" }, 1));
    const shiftId = await openShift();
    const res = await createSale(
      {
        branchId: 1, shiftId, sourceType: "POS", priceTier: "RETAIL",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "5", unitPriceOverride: "10.00" }],
        payment: { amount: "50.00", method: "CASH" },
      } as any,
      actor,
    );
    const items = await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, res.invoiceId));
    expect(items[0].promotionId).toBeNull();
    expect(items[0].total).toBe("50.00");
  });
});

describe("خدمات العروض v2 — CRUD وتكرار وبحث المنتجات", () => {
  it("createPromotion + getPromotionWithTargets: يدعم نوع TIERED_QTY وحبيبة packaging unit والشرائح", async () => {
    const promoId = await withTx(async (tx) => {
      return createPromotion(tx, {
        name: "عرض شرائح كراتين",
        type: "TIERED_QTY",
        tieredMode: "PER_ITEM",
        scope: "PRODUCTS",
        effectiveFrom: "2026-01-01",
        effectiveTo: "2026-12-31",
        channel: "POS_ONLY",
        applyToBaseUnitOnly: false,
        activeDays: [0, 1, 2, 3, 4],
        targets: [
          { productUnitId: 1 },
        ],
        tiers: [
          { minQuantity: "5.00", tierType: "PERCENT", discountPercent: "10.00" },
          { minQuantity: "10.00", tierType: "PERCENT", discountPercent: "20.00" },
        ],
      }, 1);
    });

    expect(promoId).toBeGreaterThan(0);

    const hydrated = await withTx(async (tx) => getPromotionWithTargets(tx, promoId));
    expect(hydrated).not.toBeNull();
    expect(hydrated!.promotion.name).toBe("عرض شرائح كراتين");
    expect(hydrated!.promotion.type).toBe("TIERED_QTY");
    expect(hydrated!.promotion.channel).toBe("POS_ONLY");
    expect(hydrated!.promotion.applyToBaseUnitOnly).toBe(false);
    expect(hydrated!.promotion.activeDays).toEqual([0, 1, 2, 3, 4]);
    expect(hydrated!.targets).toHaveLength(1);
    expect(hydrated!.targets[0].productUnitId).toBe(1);
    expect(hydrated!.tiers).toHaveLength(2);
    expect(Number(hydrated!.tiers[0].minQuantity)).toBe(5);
    expect(Number(hydrated!.tiers[0].discountPercent)).toBe(10);
    expect(Number(hydrated!.tiers[1].minQuantity)).toBe(10);
    expect(Number(hydrated!.tiers[1].discountPercent)).toBe(20);
  });

  it("duplicatePromotion: ينسخ العرض كمسودة معطَّلة ببادئة 'نسخة من ' مع حفظ الأهداف والشرائح", async () => {
    const sourceId = await withTx(async (tx) => {
      return createPromotion(tx, {
        name: "خصم الجمعة",
        type: "TIERED_QTY",
        tieredMode: "PER_ITEM",
        scope: "PRODUCTS",
        effectiveFrom: "2026-01-01",
        effectiveTo: "2026-12-31",
        branchId: 1,
        targets: [{ productUnitId: 2 }],
        tiers: [{ minQuantity: "3.00", tierType: "PERCENT", discountPercent: "15.00" }],
      }, 1);
    });

    const clonedId = await withTx(async (tx) => {
      return duplicatePromotion(tx, sourceId, 1, "2026-07-15", { role: "admin", id: 1 } as any);
    });

    expect(clonedId).toBeGreaterThan(0);
    expect(clonedId).not.toBe(sourceId);

    const cloned = await withTx(async (tx) => getPromotionWithTargets(tx, clonedId));
    expect(cloned).not.toBeNull();
    expect(cloned!.promotion.name).toBe("نسخة من خصم الجمعة");
    expect(cloned!.promotion.isActive).toBe(false);
    expect(cloned!.targets).toHaveLength(1);
    expect(cloned!.targets[0].productUnitId).toBe(2);
    expect(cloned!.tiers).toHaveLength(1);
    expect(Number(cloned!.tiers[0].minQuantity)).toBe(3);
    expect(Number(cloned!.tiers[0].discountPercent)).toBe(15);
  });

  it("searchPromotionProducts: تطبيع عربي ومطابقة الباركود وقناع التكلفة حسب الصلاحية", async () => {
    // نبحث عن 'قلم' بدون همزة أو تشكيل
    const d = db();
    const resultsNoCost = await searchPromotionProducts(d, { q: "قلم" }, false);
    expect(resultsNoCost.length).toBeGreaterThan(0);
    expect(resultsNoCost[0].productName).toBe("قلم");
    expect(resultsNoCost[0].costPrice).toBeNull(); // محجوب
    expect(resultsNoCost[0].units).toHaveLength(1);
    expect(resultsNoCost[0].units[0].retailPrice).toBe("10.00");

    const resultsWithCost = await searchPromotionProducts(d, { q: "PEN-1" }, true);
    expect(resultsWithCost.length).toBeGreaterThan(0);
    expect(resultsWithCost[0].costPrice).toBe("4.00"); // مكشوف لمن يملك الصلاحية
  });
});

describe("منظومة الأنواع الـ 6 والتحقق السلطوي وبوابات الحوكمة (H6 / التكلفة / الوحدات / المرتجعات / الأوفلاين)", () => {
  it("FIXED_PRICE: يطبّق السعر الموحد على الأصناف الأغلى ولا يرفع سعر الأصناف الأرخص (قاعدة السقف الحديدية)", async () => {
    await setStock(1, 1, 50);
    await setStock(2, 1, 50);
    const pid = await withTx((tx) =>
      createPromotion(tx, {
        name: "سعر موحد 15",
        type: "FIXED_PRICE",
        fixedPrice: "15.00",
        scope: "ALL",
        effectiveFrom: "2026-01-01",
      }, 1),
    );

    // منتج 1 سعره 10.00 <= 15.00 ⇒ السقف يمنع أي خصم أو رفع سعر
    const cheap = await withTx((tx) =>
      resolvePromotionForLine(tx, {
        branchId: 1, customerTier: "RETAIL", productId: 1, variantId: 1, productUnitId: 1, isBaseUnit: true, categoryId: 1,
        unitPrice: "10.00", lineAmount: "10.00", hasContractPrice: false, todayYmd: "2026-07-15",
      }),
    );
    expect(cheap).toBeNull();

    // منتج 2 سعره 20.00 > 15.00 ⇒ خصم 5.00 للوحدة
    const dear = await withTx((tx) =>
      resolvePromotionForLine(tx, {
        branchId: 1, customerTier: "RETAIL", productId: 2, variantId: 2, productUnitId: 2, isBaseUnit: true, categoryId: 1,
        unitPrice: "20.00", lineAmount: "20.00", hasContractPrice: false, todayYmd: "2026-07-15",
      }),
    );
    expect(dear).not.toBeNull();
    expect(dear!.discountForUnit).toBe("5.00");

    const shiftId = await openShift();
    const sale = await createSale(
      {
        branchId: 1, shiftId, sourceType: "POS", priceTier: "RETAIL",
        lines: [
          { variantId: 1, productUnitId: 1, quantity: "2", unitPriceOverride: "10.00", promotionId: pid },
          { variantId: 2, productUnitId: 2, quantity: "2", unitPriceOverride: "20.00", discountAmount: "10.00", promotionDiscount: "10.00", promotionId: pid },
        ],
        payment: { amount: "50.00", method: "CASH" },
      } as any,
      actor,
    );
    const items = await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, sale.invoiceId));
    const line1 = items.find((i) => Number(i.variantId) === 1)!;
    const line2 = items.find((i) => Number(i.variantId) === 2)!;
    expect(line1.promotionId).toBeNull();
    expect(line1.total).toBe("20.00");
    expect(Number(line2.promotionId)).toBe(pid);
    expect(line2.promotionDiscount).toBe("10.00");
    expect(line2.total).toBe("30.00");
  });

  it("BUNDLE_PRICE (ALL_REQUIRED) + المرتجع الجزئي: توزيع نسبي بلا isGift وحفظ التوازن المالي 100%", async () => {
    await setStock(1, 1, 50);
    await setStock(2, 1, 50);
    // منتج 1 (10.00) + منتج 2 (20.00) = 30.00 ⇒ باقة بـ 24.00 (توفير 6.00: 2.00 لـ1 و4.00 لـ2)
    const bundlePromoId = await withTx((tx) =>
      createPromotion(tx, {
        name: "باقة قلم ودفتر بـ 24",
        type: "BUNDLE_PRICE",
        bundleMode: "ALL_REQUIRED",
        bundlePrice: "24.00",
        scope: "PRODUCTS",
        effectiveFrom: "2026-01-01",
        targets: [{ productId: 1 }, { productId: 2 }],
      }, 1),
    );

    const shiftId = await openShift();
    const sale = await createSale(
      {
        branchId: 1, shiftId, sourceType: "POS", priceTier: "RETAIL",
        lines: [
          { variantId: 1, productUnitId: 1, quantity: "1", unitPriceOverride: "10.00", discountAmount: "2.00", promotionDiscount: "2.00", promotionId: bundlePromoId },
          { variantId: 2, productUnitId: 2, quantity: "1", unitPriceOverride: "20.00", discountAmount: "4.00", promotionDiscount: "4.00", promotionId: bundlePromoId },
        ],
        payment: { amount: "24.00", method: "CASH" },
      } as any,
      actor,
    );
    expect(sale.total).toBe("24.00");

    const items = await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, sale.invoiceId));
    const item1 = items.find((i) => Number(i.variantId) === 1)!;
    const item2 = items.find((i) => Number(i.variantId) === 2)!;
    expect(Boolean(item1.isGift)).toBe(false);
    expect(Boolean(item2.isGift)).toBe(false);
    expect(Number(item1.promotionId)).toBe(bundlePromoId);
    expect(Number(item2.promotionId)).toBe(bundlePromoId);
    expect(item1.total).toBe("8.00");
    expect(item2.total).toBe("16.00");

    // مرتجع جزئي للمنتج الأول يسترد 8.00 فقط لا 10.00
    const ret1 = await returnSale(
      {
        invoiceId: sale.invoiceId,
        lines: [{ invoiceItemId: Number(item1.id), baseQuantity: 1 }],
        resolution: {
          kind: "IMMEDIATE_REFUND",
          method: "CASH",
          amount: "8.00",
          shiftId,
          reason: "إرجاع القلم من الباقة",
          disposition: "RESTOCK",
        },
      },
      { userId: 1, branchId: 1, role: "admin" } as any,
    );
    expect(ret1.returnedTotal).toBe("8.00");
    expect(ret1.fullyReturned).toBe(false);

    // ثم إرجاع المنتج الثاني يسترد 16.00 ⇒ المجموع 8 + 16 = 24.00 بالضبط
    const ret2 = await returnSale(
      {
        invoiceId: sale.invoiceId,
        lines: [{ invoiceItemId: Number(item2.id), baseQuantity: 1 }],
        resolution: {
          kind: "IMMEDIATE_REFUND",
          method: "CASH",
          amount: "16.00",
          shiftId,
          reason: "إرجاع الدفتر من الباقة",
          disposition: "RESTOCK",
        },
      },
      { userId: 1, branchId: 1, role: "admin" } as any,
    );
    expect(ret2.returnedTotal).toBe("16.00");
    expect(ret2.fullyReturned).toBe(true);
  });

  it("BOGO بكوبون + TIERED_QTY (POOL_ACROSS_TARGETS): تقييم سلطوي على مستوى السلة في createSale", async () => {
    await setStock(1, 1, 50);
    await setStock(2, 1, 50);
    const shiftId = await openShift();

    // 1. BOGO (اشترِ 2 واحصل على 1 مجاناً) عبر كوبون
    const bogoPromoId = await withTx((tx) =>
      createPromotion(tx, {
        name: "كوبون اشتر 2 واحصل على 1 مجاناً",
        type: "BOGO",
        bogoBuyQuantity: 2,
        bogoGetQuantity: 1,
        bogoGetDiscountPercent: "100",
        scope: "PRODUCTS",
        applicationMode: "COUPON",
        effectiveFrom: "2026-01-01",
        effectiveTo: "2027-12-31",
        targets: [{ productId: 1 }],
      }, 1),
    );
    const progRes = await db().insert(s.couponPrograms).values({
      promotionId: bogoPromoId, name: "برنامج BOGO", status: "ACTIVE", branchId: 1,
      validFrom: new Date("2026-01-01"), validTo: new Date("2027-12-31"),
      perCouponLimit: 1, perCustomerLimit: 1, codePrefix: "BOGO", createdBy: 1,
    });
    const progId = insertId(progRes);
    const code = "BOGO-FREE-1";
    await db().insert(s.coupons).values({ programId: progId, code, codeHash: hashCouponCode(code), status: "ACTIVE" });

    const bogoSale = await createSale(
      {
        branchId: 1, shiftId, sourceType: "POS", priceTier: "RETAIL", couponCode: code,
        lines: [{ variantId: 1, productUnitId: 1, quantity: "3", unitPriceOverride: "10.00", discountAmount: "10.00", promotionDiscount: "10.00", promotionId: bogoPromoId }],
        payment: { amount: "20.00", method: "CASH" },
      } as any,
      actor,
    );
    expect(bogoSale.total).toBe("20.00");
    const red = (await db().select().from(s.couponRedemptions).where(eq(s.couponRedemptions.invoiceId, bogoSale.invoiceId)))[0];
    expect(red.discountAmount).toBe("10.00");

    // 2. TIERED_QTY بتجميع الكميات عبر الأصناف (POOL_ACROSS_TARGETS): 2 قلم + 1 دفتر = 3 قطع ⇒ خصم 20%
    const tieredPromoId = await withTx((tx) =>
      createPromotion(tx, {
        name: "شرائح مجمّعة 3+ خصم 20%",
        type: "TIERED_QTY",
        tieredMode: "POOL_ACROSS_TARGETS",
        scope: "PRODUCTS",
        effectiveFrom: "2026-01-01",
        targets: [{ productId: 1 }, { productId: 2 }],
        tiers: [{ minQuantity: "3", tierType: "PERCENT", discountPercent: "20" }],
      }, 1),
    );

    const tieredSale = await createSale(
      {
        branchId: 1, shiftId, sourceType: "POS", priceTier: "RETAIL",
        lines: [
          { variantId: 1, productUnitId: 1, quantity: "2", unitPriceOverride: "10.00", discountAmount: "4.00", promotionDiscount: "4.00", promotionId: tieredPromoId },
          { variantId: 2, productUnitId: 2, quantity: "1", unitPriceOverride: "20.00", discountAmount: "4.00", promotionDiscount: "4.00", promotionId: tieredPromoId },
        ],
        payment: { amount: "32.00", method: "CASH" },
      } as any,
      actor,
    );
    expect(tieredSale.total).toBe("32.00");
    const tieredItems = await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, tieredSale.invoiceId));
    expect(tieredItems.every((i) => Number(i.promotionId) === tieredPromoId && i.promotionDiscount === "4.00")).toBe(true);
  });

  it("بوابة H6 و allowBelowCost للكاشير: العرض الرسمي >15% أو تحت التكلفة المعتمدة يمرّ، والتزوير يُحجَب", async () => {
    await db().insert(s.users).values({ id: 2, openId: "cashier_test", name: "كاشير", role: "cashier", branchId: 1, loginMethod: "local" });
    const cashierShiftRes = await db().insert(s.shifts).values({ branchId: 1, userId: 2, openingBalance: "0", status: "OPEN" });
    const cashierShiftId = insertId(cashierShiftRes);
    const cashierActor = { userId: 2, branchId: 1, role: "cashier" } as any;

    await setStock(3, 1, 50); // لعبة: تكلفة 20.00، بيع 50.00
    await setStock(1, 1, 50); // قلم: تكلفة 4.00، بيع 10.00

    // أ) عرض رسمي 30% (> عتبة H6 15%) للكاشير بدون priceOverrideApproved ⇒ يمرّ لأن الخصم الترويجي الموثّق معفى من H6
    const official30Id = await withTx((tx) =>
      createPromotion(tx, {
        name: "تخفيضات 30%",
        type: "PERCENT",
        discountPercent: "30",
        scope: "PRODUCTS",
        effectiveFrom: "2026-01-01",
        targets: [{ productId: 3 }],
      }, 1),
    );
    const okSale = await createSale(
      {
        branchId: 1, shiftId: cashierShiftId, sourceType: "POS", priceTier: "RETAIL",
        lines: [{ variantId: 3, productUnitId: 3, quantity: "1", discountAmount: "15.00", promotionDiscount: "15.00", promotionId: official30Id }],
        payment: { amount: "35.00", method: "CASH" },
      } as any,
      cashierActor,
    );
    expect(okSale.total).toBe("35.00");

    // ب) عميل خبيث يزوّر promotionDiscount = 15.00 (30%) بـ promotionId وهمي بدون موافقة مدير ⇒ يُصدّ ببوابة H6
    await expect(
      createSale(
        {
          branchId: 1, shiftId: cashierShiftId, sourceType: "POS", priceTier: "RETAIL",
          lines: [{ variantId: 3, productUnitId: 3, quantity: "1", discountAmount: "15.00", promotionDiscount: "15.00", promotionId: 999999 }],
          payment: { amount: "35.00", method: "CASH" },
        } as any,
        cashierActor,
      ),
    ).rejects.toThrow();

    // ج) عرض بسعر موحد 3.00 تحت التكلفة (4.00) مع allowBelowCost = true ⇒ يمرّ للكاشير بلا إيقاف
    const belowCostPromoId = await withTx((tx) =>
      createPromotion(tx, {
        name: "تصفية تحت التكلفة",
        type: "FIXED_PRICE",
        fixedPrice: "3.00",
        allowBelowCost: true,
        scope: "PRODUCTS",
        effectiveFrom: "2026-01-01",
        targets: [{ productId: 1 }],
      }, 1),
    );
    const belowCostOk = await createSale(
      {
        branchId: 1, shiftId: cashierShiftId, sourceType: "POS", priceTier: "RETAIL",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "1", discountAmount: "7.00", promotionDiscount: "7.00", promotionId: belowCostPromoId }],
        payment: { amount: "3.00", method: "CASH" },
      } as any,
      cashierActor,
    );
    expect(belowCostOk.total).toBe("3.00");

    // د) محاولة تهريب خصم يدوي إضافي تحت التكلفة فوق عرض لا ينزل وحده تحت التكلفة ⇒ يُصدّ
    const halfOffId = await withTx((tx) =>
      createPromotion(tx, {
        name: "نصف السعر 5.00",
        type: "FIXED_PRICE",
        fixedPrice: "5.00",
        allowBelowCost: true,
        priority: 50,
        scope: "PRODUCTS",
        effectiveFrom: "2026-01-01",
        targets: [{ productId: 1 }],
      }, 1),
    );
    await expect(
      createSale(
        {
          branchId: 1, shiftId: cashierShiftId, sourceType: "POS", priceTier: "RETAIL",
          lines: [{ variantId: 1, productUnitId: 1, quantity: "1", discountAmount: "7.00", promotionDiscount: "5.00", cashierDiscountAmount: "2.00", promotionId: halfOffId }],
          payment: { amount: "3.00", method: "CASH" },
        } as any,
        cashierActor,
      ),
    ).rejects.toThrow();
  });

  it("حماية applyToBaseUnitOnly واستثناء الباقات الجاهزة (isBundle = true) وإعادة تشغيل الأوفلاين", async () => {
    // إضافة وحدة كارتون (غير أساسية) للقلم + منتج باقة جاهزة (isBundle = true)
    await db().insert(s.productUnits).values({ id: 10, variantId: 1, unitName: "كارتون", conversionFactor: "12", isBaseUnit: false });
    await db().insert(s.productPrices).values({ productUnitId: 10, priceTier: "RETAIL", price: "100.00" });
    await db().insert(s.products).values({ id: 4, name: "باقة مدرسية جاهزة", categoryId: 1, isBundle: true });
    await db().insert(s.productVariants).values({ id: 4, productId: 4, sku: "BND-1", costPrice: "30.00" });
    await db().insert(s.productUnits).values({ id: 4, variantId: 4, unitName: "باقة", conversionFactor: "1", isBaseUnit: true });
    await db().insert(s.productPrices).values({ productUnitId: 4, priceTier: "RETAIL", price: "45.00" });

    await withTx((tx) =>
      createPromotion(tx, {
        name: "خصم عام للوحدات الأساسية فقط",
        type: "PERCENT",
        discountPercent: "20",
        scope: "ALL",
        applyToBaseUnitOnly: true,
        effectiveFrom: "2026-01-01",
      }, 1),
    );

    // القطعة الأساسية تحصل على الخصم
    const baseRes = await withTx((tx) =>
      resolvePromotionForLine(tx, {
        branchId: 1, customerTier: "RETAIL", productId: 1, variantId: 1, productUnitId: 1, isBaseUnit: true, categoryId: 1,
        unitPrice: "10.00", lineAmount: "10.00", hasContractPrice: false, todayYmd: "2026-07-15",
      }),
    );
    expect(baseRes?.discountForUnit).toBe("2.00");

    // الكارتون محميّ من تسرب عرض القطعة
    const cartonRes = await withTx((tx) =>
      resolvePromotionForLine(tx, {
        branchId: 1, customerTier: "RETAIL", productId: 1, variantId: 1, productUnitId: 10, isBaseUnit: false, categoryId: 1,
        unitPrice: "100.00", lineAmount: "100.00", hasContractPrice: false, todayYmd: "2026-07-15",
      }),
    );
    expect(cartonRes).toBeNull();

    // الباقة الجاهزة (isBundle = true) مستثناة من عرض ALL العام منعاً لازدواج الخصم
    const preBundleRes = await withTx((tx) =>
      resolvePromotionForLine(tx, {
        branchId: 1, customerTier: "RETAIL", productId: 4, variantId: 4, productUnitId: 4, isBaseUnit: true, isBundle: true, categoryId: 1,
        unitPrice: "45.00", lineAmount: "45.00", hasContractPrice: false, todayYmd: "2026-07-15",
      }),
    );
    expect(preBundleRes).toBeNull();

    // إعادة تشغيل فاتورة أوفلاين التُقطت يوم 2026-05-10 لعرض انتهى في ذلك اليوم
    await setStock(2, 1, 50);
    const flashId = await withTx((tx) =>
      createPromotion(tx, {
        name: "عرض يوم 10 أيار فقط",
        type: "AMOUNT",
        discountAmount: "5.00",
        priority: 100,
        scope: "PRODUCTS",
        effectiveFrom: "2026-05-10",
        effectiveTo: "2026-05-10",
        targets: [{ productId: 2 }],
      }, 1),
    );
    const shiftId = await openShift();
    const replayed = await createSale(
      {
        branchId: 1, shiftId, sourceType: "POS", priceTier: "RETAIL",
        offlineCapture: {
          capturedAt: new Date("2026-05-10T10:30:00.000Z"),
          offlineReceiptNumber: "OFF-TEST-001",
          deviceId: "DEV-1",
        },
        lines: [{ variantId: 2, productUnitId: 2, quantity: "1", unitPriceOverride: "20.00", discountAmount: "5.00", promotionDiscount: "5.00", promotionId: flashId }],
        payment: { amount: "15.00", method: "CASH" },
      },
      actor,
    );
    const replayedItem = (await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, replayed.invoiceId)))[0];
    expect(Number(replayedItem.promotionId)).toBe(flashId);
    expect(replayedItem.promotionDiscount).toBe("5.00");
  });
});

describe("اختبارات الانحدار للمراجعة العدائية (SOD-03 / أولوية السلة / تعديل الأنواع / التكلفة / الهيدرة والباركود)", () => {
  it("SOD-03: مدير الفرع (manager) لا يملك الموافقة الذاتية على خصم يدوي >15% أو بيع يدوي تحت التكلفة، بينما يمرّ العرض الرسمي المعتمد", async () => {
    await db().insert(s.users).values({
      id: 3,
      openId: "manager_test",
      name: "مدير فرع",
      role: "manager",
      branchId: 1,
      loginMethod: "local",
    });
    const mgrShiftRes = await db().insert(s.shifts).values({ branchId: 1, userId: 3, openingBalance: "0", status: "OPEN" });
    const mgrShiftId = insertId(mgrShiftRes);
    const managerActor = { userId: 3, branchId: 1, role: "manager" } as any;

    await setStock(3, 1, 50); // لعبة: تكلفة 20.00، بيع 50.00
    await setStock(1, 1, 50); // قلم: تكلفة 4.00، بيع 10.00

    // أ) خصم يدوي 30% بدون priceOverrideApproved من مدير آخر ⇒ يُرفض التزاماً بـ SOD-03
    await expect(
      createSale(
        {
          branchId: 1,
          shiftId: mgrShiftId,
          sourceType: "POS",
          priceTier: "RETAIL",
          lines: [{ variantId: 3, productUnitId: 3, quantity: "1", discountAmount: "15.00", cashierDiscountAmount: "15.00" }],
          payment: { amount: "35.00", method: "CASH" },
        } as any,
        managerActor,
      ),
    ).rejects.toThrow();

    // ب) تعديل سعر يدوي تحت التكلفة (3.00 < 4.00) بدون موافقة منفصلة ⇒ يُرفض التزاماً بـ SOD-03
    await expect(
      createSale(
        {
          branchId: 1,
          shiftId: mgrShiftId,
          sourceType: "POS",
          priceTier: "RETAIL",
          lines: [{ variantId: 1, productUnitId: 1, quantity: "1", unitPriceOverride: "3.00" }],
          payment: { amount: "3.00", method: "CASH" },
        } as any,
        managerActor,
      ),
    ).rejects.toThrow();

    // ج) عرض رسمي تحت التكلفة (allowBelowCost = true) يمرّ لمدير الفرع بلا حاجة لكلمة مرور إضافية
    const promoId = await withTx((tx) =>
      createPromotion(
        tx,
        {
          name: "تصفية معتمدة 3.00",
          type: "FIXED_PRICE",
          fixedPrice: "3.00",
          allowBelowCost: true,
          scope: "PRODUCTS",
          effectiveFrom: "2026-01-01",
          targets: [{ productId: 1 }],
        },
        1,
      ),
    );
    const okSale = await createSale(
      {
        branchId: 1,
        shiftId: mgrShiftId,
        sourceType: "POS",
        priceTier: "RETAIL",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "1", discountAmount: "7.00", promotionDiscount: "7.00", promotionId: promoId }],
        payment: { amount: "3.00", method: "CASH" },
      } as any,
      managerActor,
    );
    expect(okSale.total).toBe("3.00");
  });

  it("التقييم الموحّد للسلة في createSale يمنع تزوير الأولوية وتكديس العروض غير القابلة للتراكم", async () => {
    await db().insert(s.users).values({
      id: 2,
      openId: "cashier_prio",
      name: "كاشير",
      role: "cashier",
      branchId: 1,
      loginMethod: "local",
    });
    const shiftRes = await db().insert(s.shifts).values({ branchId: 1, userId: 2, openingBalance: "0", status: "OPEN" });
    const shiftId = insertId(shiftRes);
    const cashierActor = { userId: 2, branchId: 1, role: "cashier" } as any;

    await setStock(1, 1, 50); // قلم: 10.00
    await setStock(2, 1, 50); // دفتر: 20.00
    await setStock(3, 1, 50); // لعبة: 50.00

    // 1. عرض عالي الأولوية (priority 50) خصم 5% مقابل عرض منخفض الأولوية (priority 1) خصم 40% على نفس اللعبة
    await withTx(async (tx) => {
      await createPromotion(
        tx,
        {
          name: "عرض أولوية 50 بنسبة 5%",
          type: "PERCENT",
          discountPercent: "5",
          priority: 50,
          scope: "PRODUCTS",
          effectiveFrom: "2026-01-01",
          targets: [{ productId: 3 }],
        },
        1,
      );
    });
    const lowPrio40Id = await withTx((tx) =>
      createPromotion(
        tx,
        {
          name: "عرض أولوية 1 بنسبة 40%",
          type: "PERCENT",
          discountPercent: "40",
          priority: 1,
          scope: "PRODUCTS",
          effectiveFrom: "2026-01-01",
          targets: [{ productId: 3 }],
        },
        1,
      ),
    );

    // العميل يحاول المطالبة بعرض الأولوية المنخفضة (40% = 20.00) لتجاوز H6 ⇒ الخادم يقيّم كل قواعد AUTO معاً فيرفض
    await expect(
      createSale(
        {
          branchId: 1,
          shiftId,
          sourceType: "POS",
          priceTier: "RETAIL",
          lines: [{ variantId: 3, productUnitId: 3, quantity: "1", discountAmount: "20.00", promotionDiscount: "20.00", promotionId: lowPrio40Id }],
          payment: { amount: "30.00", method: "CASH" },
        } as any,
        cashierActor,
      ),
    ).rejects.toThrow();

    // 2. منع تكديس عرض فردي عالي الأولوية (يستهلك القلم) مع باقة BUNDLE_PRICE ALL_REQUIRED تتطلب (قلم + دفتر)
    const penHighPrioId = await withTx((tx) =>
      createPromotion(
        tx,
        {
          name: "خصم 10% على القلم (أولوية 60)",
          type: "PERCENT",
          discountPercent: "10",
          priority: 60,
          scope: "PRODUCTS",
          effectiveFrom: "2026-01-01",
          targets: [{ productId: 1 }],
        },
        1,
      ),
    );
    const bundleLowPrioId = await withTx((tx) =>
      createPromotion(
        tx,
        {
          name: "باقة قلم + دفتر بـ 18 (أولوية 10)",
          type: "BUNDLE_PRICE",
          bundlePrice: "18.00",
          bundleMode: "ALL_REQUIRED",
          priority: 10,
          scope: "PRODUCTS",
          effectiveFrom: "2026-01-01",
          targets: [{ productId: 1 }, { productId: 2 }],
        },
        1,
      ),
    );

    // القلم استُهلك بعرض الأولوية 60 فلم تعد الباقة مكتملة؛ المطالبة بخصم الباقة (8.00 = 40%) على الدفتر تُحجب ببوابة H6
    await expect(
      createSale(
        {
          branchId: 1,
          shiftId,
          sourceType: "POS",
          priceTier: "RETAIL",
          lines: [
            { variantId: 1, productUnitId: 1, quantity: "1", discountAmount: "1.00", promotionDiscount: "1.00", promotionId: penHighPrioId },
            { variantId: 2, productUnitId: 2, quantity: "1", discountAmount: "8.00", promotionDiscount: "8.00", promotionId: bundleLowPrioId },
          ],
          payment: { amount: "21.00", method: "CASH" },
        } as any,
        cashierActor,
      ),
    ).rejects.toThrow();
  });

  it("updatePromotion: تطبيع شرائح AMOUNT/FIXED_PRICE (chk_promo_tier_shape)، التحديث الجزئي، وتبديل نوع العرض وتنظيف الشرائح القديمة", async () => {
    // 1. إنشاء TIERED_QTY بشريحة AMOUNT مع بقايا discountPercent = '10' كما ترسلها الواجهة سابقاً ⇒ ينجح دون كسر chk_promo_tier_shape
    const promoId = await withTx((tx) =>
      createPromotion(
        tx,
        {
          name: "شرائح مبلغ ثابت",
          type: "TIERED_QTY",
          tieredMode: "PER_ITEM",
          scope: "PRODUCTS",
          effectiveFrom: "2026-01-01",
          targets: [{ productId: 2 }],
          tiers: [
            { minQuantity: "3", tierType: "AMOUNT", discountAmount: "2.00", discountPercent: "10" },
            { minQuantity: "6", tierType: "FIXED_PRICE", fixedPrice: "15.00", discountPercent: "10", discountAmount: "2.00" },
          ],
        },
        1,
      ),
    );

    // 2. تحديث جزئي للاسم وحالة التفعيل فقط دون إرسال tiers أو targets ⇒ يحافظ على الشرائح والأهداف
    await withTx((tx) =>
      updatePromotion(
        tx,
        {
          id: promoId,
          name: "شرائح مبلغ محدّث",
          isActive: false,
        },
        1,
      ),
    );
    const afterPartial = await withTx((tx) => getPromotionWithTargets(tx, promoId, true));
    expect(afterPartial?.promotion.name).toBe("شرائح مبلغ محدّث");
    expect(afterPartial?.promotion.isActive).toBe(false);
    expect(afterPartial?.tiers).toHaveLength(2);
    expect(afterPartial?.targets).toHaveLength(1);

    // 3. تبديل النوع TIERED_QTY -> FIXED_PRICE -> PERCENT -> AMOUNT ينظف الأعمدة المتعارضة ويحذف الشرائح القديمة
    await withTx((tx) =>
      updatePromotion(
        tx,
        {
          id: promoId,
          type: "FIXED_PRICE",
          fixedPrice: "16.00",
          isActive: true,
        },
        1,
      ),
    );
    const afterFixed = await withTx((tx) => getPromotionWithTargets(tx, promoId, true));
    expect(afterFixed?.promotion.type).toBe("FIXED_PRICE");
    expect(afterFixed?.promotion.fixedPrice).toBe("16.00");
    expect(afterFixed?.promotion.tieredMode).toBeNull();
    expect(afterFixed?.tiers).toHaveLength(0);

    await withTx((tx) =>
      updatePromotion(tx, { id: promoId, type: "PERCENT", discountPercent: "20" }, 1),
    );
    const afterPercent = await withTx((tx) => getPromotionWithTargets(tx, promoId, true));
    expect(afterPercent?.promotion.type).toBe("PERCENT");
    expect(afterPercent?.promotion.fixedPrice).toBeNull();
    expect(afterPercent?.promotion.discountPercent).toBe("20.00");

    await withTx((tx) =>
      updatePromotion(tx, { id: promoId, type: "AMOUNT", discountAmount: "3.00" }, 1),
    );
    const afterAmount = await withTx((tx) => getPromotionWithTargets(tx, promoId, true));
    expect(afterAmount?.promotion.type).toBe("AMOUNT");
    expect(afterAmount?.promotion.discountPercent).toBe("0.00");
    expect(afterAmount?.promotion.discountAmount).toBe("3.00");
  });

  it("بوابة allowBelowCost عند الإنشاء والتعديل: تمنع حفظ عرض ينزل تحت تكلفة الوحدة أو الكارتون ما لم يؤكَّد صراحةً", async () => {
    // إضافة وحدة كارتون (12 قطعة ⇒ تكلفة الكارتون = 12 × 4.00 = 48.00، سعر بيع الكارتون = 100.00)
    await db().insert(s.productUnits).values({ id: 11, variantId: 1, unitName: "كارتون", conversionFactor: "12", isBaseUnit: false });
    await db().insert(s.productPrices).values({ productUnitId: 11, priceTier: "RETAIL", price: "100.00" });

    // 1. محاولة إنشاء FIXED_PRICE = 3.00 (< تكلفة القلم 4.00) بدون allowBelowCost ⇒ تُرفض
    await expect(
      withTx((tx) =>
        createPromotion(
          tx,
          {
            name: "سعر موحد تحت التكلفة غير مؤكد",
            type: "FIXED_PRICE",
            fixedPrice: "3.00",
            allowBelowCost: false,
            scope: "PRODUCTS",
            effectiveFrom: "2026-01-01",
            targets: [{ productId: 1 }],
          },
          1,
        ),
      ),
    ).rejects.toThrow(/التكلفة/);

    // 2. محاولة إنشاء عرض على وحدة الكارتون (productUnitId: 11) بسعر 45.00 (< تكلفة الكارتون 48.00) بدون allowBelowCost ⇒ تُرفض
    await expect(
      withTx((tx) =>
        createPromotion(
          tx,
          {
            name: "كارتون تحت التكلفة غير مؤكد",
            type: "FIXED_PRICE",
            fixedPrice: "45.00",
            allowBelowCost: false,
            applyToBaseUnitOnly: false,
            scope: "PRODUCTS",
            effectiveFrom: "2026-01-01",
            targets: [{ productUnitId: 11 }],
          },
          1,
        ),
      ),
    ).rejects.toThrow(/التكلفة/);

    // 3. مع allowBelowCost = true ينجح الإنشاء، وإلغاء allowBelowCost في التعديل يُرفض ما دام السعر تحت التكلفة
    const allowedId = await withTx((tx) =>
      createPromotion(
        tx,
        {
          name: "سعر موحد تحت التكلفة مؤكد",
          type: "FIXED_PRICE",
          fixedPrice: "3.00",
          allowBelowCost: true,
          scope: "PRODUCTS",
          effectiveFrom: "2026-01-01",
          targets: [{ productId: 1 }],
        },
        1,
      ),
    );
    await expect(
      withTx((tx) => updatePromotion(tx, { id: allowedId, allowBelowCost: false }, 1)),
    ).rejects.toThrow(/التكلفة/);
  });

  it("هيدرة أهداف التعديل (hydratedTargets) مع حجب التكلفة لغير المصرّح لهم وترتيب التطابق التام للباركود أولاً", async () => {
    await db().update(s.productUnits).set({ barcode: "123456" }).where(eq(s.productUnits.id, 1));
    await db().insert(s.productUnits).values({
      id: 12,
      variantId: 2,
      unitName: "دزينة",
      conversionFactor: "12",
      barcode: "NB-DOZEN-99",
      isBaseUnit: false,
    });
    await db().insert(s.productPrices).values({ productUnitId: 12, priceTier: "RETAIL", price: "210.00" });

    // منتج أحدث يحمل باركوداً فرعياً يحتوي "123456" واسماً يحتوي "123456" (كان يتصدّر خطأً بسبب ORDER BY p.id DESC)
    await db().insert(s.products).values({ id: 5, name: "ملف 123456 حديث", categoryId: 1 });
    await db().insert(s.productVariants).values({ id: 5, productId: 5, sku: "FILE-99", costPrice: "6.00" });
    await db().insert(s.productUnits).values({
      id: 5,
      variantId: 5,
      unitName: "قطعة",
      conversionFactor: "1",
      barcode: "9912345600",
      isBaseUnit: true,
    });
    await db().insert(s.productPrices).values({ productUnitId: 5, priceTier: "RETAIL", price: "12.00" });

    // أ) البحث بالباركود "123456" يعيد القلم (تطابق باركود تام) في المرتبة الأولى مع حجب التكلفة عند canViewCost = false
    const searchMasked = await searchPromotionProducts(db(), { q: "123456", limit: 5 }, false);
    expect(searchMasked.length).toBeGreaterThanOrEqual(2);
    expect(searchMasked[0].productId).toBe(1);
    expect(searchMasked[0].costPrice).toBeNull();

    const searchWithCost = await searchPromotionProducts(db(), { q: "123456", limit: 5 }, true);
    expect(searchWithCost[0].productId).toBe(1);
    expect(searchWithCost[0].costPrice).toBe("4.00");

    // ب) getPromotionWithTargets يُعيد hydratedTargets بالحبيبات المختلفة (PRODUCT و UNIT) ويحجب التكلفة لغير المصرّح لهم
    const promoId = await withTx((tx) =>
      createPromotion(
        tx,
        {
          name: "عرض مختلط الحبيبات",
          type: "PERCENT",
          discountPercent: "10",
          scope: "PRODUCTS",
          effectiveFrom: "2026-01-01",
          targets: [
            { productId: 1 },
            { productUnitId: 12 },
          ],
        },
        1,
      ),
    );

    const maskedDetail = await withTx((tx) => getPromotionWithTargets(tx, promoId, false));
    expect(maskedDetail?.hydratedTargets).toHaveLength(2);
    expect(maskedDetail?.hydratedTargets.every((t) => t.costPrice === null)).toBe(true);

    const adminDetail = await withTx((tx) => getPromotionWithTargets(tx, promoId, true));
    const unitTarget = adminDetail?.hydratedTargets.find((t) => t.targetGrain === "UNIT");
    expect(unitTarget).toBeDefined();
    expect(unitTarget?.productUnitId).toBe(12);
    expect(unitTarget?.retailPrice).toBe("210.00");
    expect(unitTarget?.costPrice).toBe("10.00");
  });

  it("FREE_SHIPPING: إنشاء العرض وتطبيقه الذرّي التلقائي في createSale مع إعفاء أجرة التوصيل وإرجاع promotionSummary", async () => {
    await setStock(3, 1, 50); // لعبة بسعر 50.00
    const promoId = await withTx((tx) =>
      createPromotion(
        tx,
        {
          name: "توصيل مجاني للطلبات فوق 80",
          type: "FREE_SHIPPING",
          scope: "ALL",
          minOrderSpend: "80.00",
          effectiveFrom: "2020-01-01",
          channel: "ALL",
        },
        1,
      ),
    );
    expect(promoId).toBeGreaterThan(0);

    const hydrated = await withTx((tx) => getPromotionWithTargets(tx, promoId, true));
    expect(hydrated?.promotion.type).toBe("FREE_SHIPPING");
    expect(hydrated?.promotion.freeShipping).toBe(true);

    const shiftId = await openShift();
    // يشتري قطعتين (2 × 50 = 100 >= 80) مع تمرير deliveryFee = 15.00 بدون deliveryFree:
    // الخادم يكتشف تأهّل FREE_SHIPPING ذرّياً ويعفي الأجرة تلقائياً!
    const saleRes = await createSale(
      {
        branchId: 1,
        shiftId,
        sourceType: "ORDER",
        priceTier: "RETAIL",
        lines: [{ variantId: 3, productUnitId: 3, quantity: "2" }],
        deliveryFee: "15.00",
        payment: { amount: "100.00", method: "CASH" },
      } as any,
      actor,
    );

    expect(saleRes.total).toBe("100.00");
    expect(saleRes.promotionSummary?.freeShippingPromo).toEqual({
      promotionId: promoId,
      promotionName: "توصيل مجاني للطلبات فوق 80",
      waivedAmount: "15.00",
    });

    const [savedInv] = await db()
      .select()
      .from(s.invoices)
      .where(eq(s.invoices.id, saleRes.invoiceId));
    expect(savedInv.deliveryFee).toBe("0.00");
    expect(savedInv.deliveryFree).toBe(true);
    expect(savedInv.deliveryWaivedAmount).toBe("15.00");

    // التحقق من تطابق إيراد قيد الدفتر SALE مع إجمالي الفاتورة بعد الإعفاء التلقائي لأجرة الشحن
    const [saleEntry] = await db()
      .select()
      .from(s.accountingEntries)
      .where(eq(s.accountingEntries.dedupeKey, `SALE:${saleRes.invoiceId}`));
    expect(saleEntry.revenue).toBe("100.00");
    expect(saleEntry.amount).toBe("100.00");

    // التحقق من إمكانية تصفير minOrderSpend و minLineAmount صراحةً بـ "0" عند التعديل
    await withTx((tx) =>
      updatePromotion(
        tx,
        {
          id: promoId,
          minOrderSpend: "0",
          minLineAmount: "0",
        },
        1,
      ),
    );
    const afterClearThresholds = await withTx((tx) => getPromotionWithTargets(tx, promoId, true));
    expect(afterClearThresholds?.promotion.minOrderSpend).toBe("0.00");
    expect(afterClearThresholds?.promotion.minLineAmount).toBe("0.00");

    // رفض إنشاء أو تحويل عرض BUNDLE_PRICE (ALL_REQUIRED) بنطاق ALL لأنه بلا أهداف مطلوبة
    await expect(
      withTx((tx) =>
        createPromotion(
          tx,
          {
            name: "باقة إلزامية بلا أهداف",
            type: "BUNDLE_PRICE",
            bundlePrice: "25.00",
            bundleMode: "ALL_REQUIRED",
            scope: "ALL",
            effectiveFrom: "2026-01-01",
          },
          1,
        ),
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      withTx((tx) =>
        updatePromotion(
          tx,
          {
            id: promoId,
            type: "BUNDLE_PRICE",
            bundlePrice: "25.00",
            bundleMode: "ALL_REQUIRED",
          },
          1,
        ),
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("مؤشرات أداء العروض تحتفظ بتكلفة البضاعة التالفة غير المُعادة للمخزون عند الإرجاع الكلي (RETURNED)", async () => {
    await setStock(1, 1, 100);
    const pid = await withTx((tx) =>
      createPromotion(
        tx,
        {
          name: "عرض خصم 10% مع إرجاع تالف",
          type: "PERCENT",
          discountPercent: "10",
          scope: "ALL",
          effectiveFrom: "2026-01-01",
        },
        1,
      ),
    );
    const shiftId = await openShift();
    const sale = await createSale(
      {
        branchId: 1,
        shiftId,
        sourceType: "POS",
        priceTier: "RETAIL",
        lines: [
          {
            variantId: 1,
            productUnitId: 1,
            quantity: "5",
            unitPriceOverride: "10.00",
            discountAmount: "5.00",
            promotionId: pid,
          },
        ],
        payment: { amount: "45.00", method: "CASH" },
      } as any,
      actor,
    );

    const [soldItem] = await db()
      .select()
      .from(s.invoiceItems)
      .where(eq(s.invoiceItems.invoiceId, sale.invoiceId));

    const ret = await returnSale(
      {
        invoiceId: sale.invoiceId,
        lines: [{ invoiceItemId: Number(soldItem.id), baseQuantity: 5 }],
        resolution: {
          kind: "IMMEDIATE_REFUND",
          method: "CASH",
          amount: "45.00",
          shiftId,
          reason: "تلف كامل بعد البيع",
          disposition: "DAMAGED",
        },
      },
      { userId: 1, branchId: 1, role: "admin" } as any,
    );
    expect(ret.fullyReturned).toBe(true);

    const [returnedInv] = await db()
      .select()
      .from(s.invoices)
      .where(eq(s.invoices.id, sale.invoiceId));
    expect(returnedInv.status).toBe("RETURNED");

    const performance = await withTx((tx) => loadPromotionPerformance(tx, 1));
    expect(performance.rows).toEqual([
      {
        promotionId: pid,
        invoiceCount: 0,
        netSales: "0.00",
        discount: "0.00",
        cost: "20.00",
        grossProfit: "-20.00",
      },
    ]);
    expect(performance.summary).toMatchObject({
      invoiceCount: 0,
      netSales: "0.00",
      discount: "0.00",
      cost: "20.00",
      grossProfit: "-20.00",
    });
  });

  it("معاينة الكوبون crm.coupons.preview تستثني منتجات الخدمة (isService) تماماً مثل الإتمام الفعلي", async () => {
    const d = db();
    await d.insert(s.products).values({
      id: 90,
      name: "خدمة تغليف هدايا",
      categoryId: 2,
      isService: true,
    });
    await d.insert(s.productVariants).values({
      id: 90,
      productId: 90,
      sku: "SRV-WRAP",
      costPrice: "0.00",
    });
    await d.insert(s.productUnits).values({
      id: 90,
      variantId: 90,
      unitName: "خدمة",
      conversionFactor: "1",
      isBaseUnit: true,
    });
    await d.insert(s.productPrices).values({
      productUnitId: 90,
      priceTier: "RETAIL",
      price: "25.00",
    });

    const promoId = await withTx((tx) =>
      createPromotion(
        tx,
        {
          name: "كوبون عام 20%",
          type: "PERCENT",
          discountPercent: "20",
          scope: "ALL",
          applicationMode: "COUPON",
          effectiveFrom: "2026-01-01",
        },
        1,
      ),
    );
    await d.insert(s.couponPrograms).values({
      id: 90,
      promotionId: promoId,
      name: "برنامج كوبون عام",
      status: "ACTIVE",
      branchId: 1,
      validFrom: new Date("2026-01-01"),
      validTo: new Date("2028-01-01"),
      perCouponLimit: 10,
      perCustomerLimit: 10,
      codePrefix: "SRV",
      createdBy: 1,
    });
    await d.insert(s.coupons).values({
      id: 90,
      programId: 90,
      code: "SRV-TEST20",
      codeHash: hashCouponCode("SRV-TEST20"),
      status: "ACTIVE",
    });

    const caller = crmRouter.createCaller({
      req: { headers: {} } as any,
      res: {} as any,
      user: { id: 1, openId: "local_test", name: "admin", role: "admin", branchId: 1, isActive: true } as any,
      sessionId: "test-session",
    } as any);

    await expect(
      caller.coupons.preview({
        code: "SRV-TEST20",
        branchId: 1,
        customerTier: "RETAIL",
        lines: [
          {
            productId: 90,
            variantId: 90,
            productUnitId: 90,
            unitPrice: "25.00",
            quantity: 1,
            hasContractPrice: false,
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("TIERED_QTY المجمّع (POOL_ACROSS_TARGETS + FIXED_PRICE): يحتفظ بالأسطر المؤهلة ذات الخصم الصفري في تقييم الكوبون والعرض التلقائي", async () => {
    await setStock(1, 1, 50); // قلم: سعر 10.00
    await setStock(2, 1, 50); // دفتر: سعر 20.00

    // 1. كوبون شرائح مجمّعة: 3 قطع فأكثر بسعر موحد 15.00 (الدفتر 20.00 يأخذ خصم 5.00، القلمان 10.00 يساهمان بالكمية بلا خصم ولا promotionId)
    const couponPromoId = await withTx((tx) =>
      createPromotion(
        tx,
        {
          name: "كوبون 3+ بسعر موحد 15",
          type: "TIERED_QTY",
          tieredMode: "POOL_ACROSS_TARGETS",
          applicationMode: "COUPON",
          scope: "PRODUCTS",
          effectiveFrom: "2026-01-01",
          targets: [{ productId: 1 }, { productId: 2 }],
          tiers: [{ minQuantity: "3", tierType: "FIXED_PRICE", fixedPrice: "15.00" }],
        },
        1,
      ),
    );
    await db().insert(s.couponPrograms).values({
      id: 91,
      promotionId: couponPromoId,
      name: "برنامج شرائح مجمعة",
      status: "ACTIVE",
      branchId: 1,
      validFrom: new Date("2026-01-01"),
      validTo: new Date("2028-01-01"),
      perCouponLimit: 10,
      perCustomerLimit: 10,
      codePrefix: "POOL",
      createdBy: 1,
    });
    await db().insert(s.coupons).values({
      id: 91,
      programId: 91,
      code: "POOL-3X15",
      codeHash: hashCouponCode("POOL-3X15"),
      status: "ACTIVE",
    });

    const shiftId = await openShift();
    const couponSale = await createSale(
      {
        branchId: 1,
        shiftId,
        sourceType: "POS",
        priceTier: "RETAIL",
        couponCode: "POOL-3X15",
        lines: [
          {
            variantId: 2,
            productUnitId: 2,
            quantity: "1",
            unitPriceOverride: "20.00",
            discountAmount: "5.00",
            promotionDiscount: "5.00",
            promotionId: couponPromoId,
          },
          {
            variantId: 1,
            productUnitId: 1,
            quantity: "2",
            unitPriceOverride: "10.00",
          },
        ],
        payment: { amount: "35.00", method: "CASH" },
      } as any,
      actor,
    );
    expect(couponSale.total).toBe("35.00");

    // 2. عرض تلقائي مماثل لكاشير بدون صلاحية مدير: خصم 8.00 على الدفتر (40% > 15%) ينجح لأن القلمين يكملان نصاب الـ 3 قطع
    await db().insert(s.users).values({
      id: 2,
      openId: "cashier_pool",
      name: "كاشير",
      role: "cashier",
      branchId: 1,
      loginMethod: "local",
    });
    const cashierShiftRes = await db().insert(s.shifts).values({
      branchId: 1,
      userId: 2,
      openingBalance: "0",
      status: "OPEN",
    });
    const cashierShiftId = insertId(cashierShiftRes);
    const cashierActor = { userId: 2, branchId: 1, role: "cashier" } as any;

    const autoPromoId = await withTx((tx) =>
      createPromotion(
        tx,
        {
          name: "عرض تلقائي 3+ بسعر موحد 12",
          type: "TIERED_QTY",
          tieredMode: "POOL_ACROSS_TARGETS",
          applicationMode: "AUTO",
          scope: "PRODUCTS",
          effectiveFrom: "2026-01-01",
          targets: [{ productId: 1 }, { productId: 2 }],
          tiers: [{ minQuantity: "3", tierType: "FIXED_PRICE", fixedPrice: "12.00" }],
        },
        1,
      ),
    );

    const autoSale = await createSale(
      {
        branchId: 1,
        shiftId: cashierShiftId,
        sourceType: "POS",
        priceTier: "RETAIL",
        lines: [
          {
            variantId: 2,
            productUnitId: 2,
            quantity: "1",
            unitPriceOverride: "20.00",
            discountAmount: "8.00",
            promotionDiscount: "8.00",
            promotionId: autoPromoId,
          },
          {
            variantId: 1,
            productUnitId: 1,
            quantity: "2",
            unitPriceOverride: "10.00",
          },
        ],
        payment: { amount: "32.00", method: "CASH" },
      } as any,
      cashierActor,
    );
    expect(autoSale.total).toBe("32.00");
  });

  it("بوابة H6: تمنع تضخيم unitPriceOverride لمحو خط الأساس المرجعي وتمرير خصم يدوي فوق 15% بلا موافقة مدير", async () => {
    // صنف سعره المرجعي 1000.00 وتكلفته 50.00 (فوق التكلفة بكثير)
    await db().insert(s.products).values({ id: 92, name: "حقيبة فاخرة", categoryId: 1 });
    await db().insert(s.productVariants).values({ id: 92, productId: 92, sku: "BAG-92", costPrice: "50.00" });
    await db().insert(s.productUnits).values({ id: 92, variantId: 92, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true });
    await db().insert(s.productPrices).values({ productUnitId: 92, priceTier: "RETAIL", price: "1000.00" });
    await setStock(92, 1, 20);

    await db().insert(s.users).values({
      id: 2,
      openId: "cashier_override_h6",
      name: "كاشير",
      role: "cashier",
      branchId: 1,
      loginMethod: "local",
    });
    const shiftRes = await db().insert(s.shifts).values({
      branchId: 1,
      userId: 2,
      openingBalance: "0",
      status: "OPEN",
    });
    const cashierShiftId = insertId(shiftRes);
    const cashierActor = { userId: 2, branchId: 1, role: "cashier" } as any;

    const halfOffId = await withTx((tx) =>
      createPromotion(
        tx,
        {
          name: "خصم 50% غير مسقوف",
          type: "PERCENT",
          discountPercent: "50",
          scope: "PRODUCTS",
          effectiveFrom: "2026-01-01",
          targets: [{ productId: 92 }],
        },
        1,
      ),
    );

    // محاولة رفع unitPriceOverride إلى 2000 للحصول على promotionDiscount = 1000 وتمرير cashierDiscountAmount = 900 (صافي 100 > تكلفة 50)
    await expect(
      createSale(
        {
          branchId: 1,
          shiftId: cashierShiftId,
          sourceType: "POS",
          priceTier: "RETAIL",
          lines: [
            {
              variantId: 92,
              productUnitId: 92,
              quantity: "1",
              unitPriceOverride: "2000.00",
              discountAmount: "1900.00",
              promotionDiscount: "1000.00",
              cashierDiscountAmount: "900.00",
              promotionId: halfOffId,
            },
          ],
          payment: { amount: "100.00", method: "CASH" },
        } as any,
        cashierActor,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    // وكذلك لو وُضع الخصم اليدوي على رأس الفاتورة invoiceDiscount = 900.00 بدل السطر
    await expect(
      createSale(
        {
          branchId: 1,
          shiftId: cashierShiftId,
          sourceType: "POS",
          priceTier: "RETAIL",
          invoiceDiscount: "900.00",
          lines: [
            {
              variantId: 92,
              productUnitId: 92,
              quantity: "1",
              unitPriceOverride: "2000.00",
              discountAmount: "1000.00",
              promotionDiscount: "1000.00",
              promotionId: halfOffId,
            },
          ],
          payment: { amount: "100.00", method: "CASH" },
        } as any,
        cashierActor,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("R6-1: checkoutReception يطبّق التوصيل المجاني خادمياً ويُروّج إرسالية المندوب إلى SHOP مع ختم deliveryWaivedAmount", async () => {
    await db().insert(s.deliveryParties).values({
      id: 1,
      name: "مندوب بغداد",
      partyType: "INDIVIDUAL",
      branchId: 1,
      currentBalance: "0.00",
      isActive: true,
      defaultFee: "5000.00",
    });
    await db().insert(s.products).values({ id: 93, name: "طابعة ليزر", categoryId: 1 });
    await db().insert(s.productVariants).values({ id: 93, productId: 93, sku: "PRN-93", costPrice: "20000.00" });
    await db().insert(s.productUnits).values({ id: 93, variantId: 93, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true });
    await db().insert(s.productPrices).values({ productUnitId: 93, priceTier: "RETAIL", price: "30000.00" });
    await setStock(93, 1, 10);

    await withTx((tx) =>
      createPromotion(
        tx,
        {
          name: "توصيل مجاني لطلبات 20 ألف+",
          type: "FREE_SHIPPING",
          minOrderSpend: "20000.00",
          scope: "ALL",
          channel: "ALL",
          effectiveFrom: "2026-01-01",
        },
        1,
      ),
    );

    const recShiftRes = await db().insert(s.shifts).values({
      branchId: 1,
      userId: 1,
      shiftType: "RECEPTION",
      openingBalance: "0",
      status: "OPEN",
    });
    const recShiftId = insertId(recShiftRes);

    const res = await checkoutReception(
      {
        branchId: 1,
        shiftId: recShiftId,
        paymentMethod: "CASH",
        paidAmount: "30000.00",
        clientRequestId: "r6-free-shipping-rec-1",
        regularSale: {
          amount: "30000.00",
          lines: [{ variantId: 93, productUnitId: 93, quantity: "1" }],
        },
        delivery: {
          partyId: 1,
          fee: "5000.00",
          feeCollection: "COURIER",
          recipientName: "زبون الكرادة",
          recipientPhone: "07701234567",
          address: "بغداد - الكرادة",
        },
      },
      actor,
    );

    expect(res.regularSale?.effectiveDeliveryFeeCollection).toBe("SHOP");
    expect(res.regularSale?.promotionSummary?.freeShippingPromo).toMatchObject({
      promotionName: "توصيل مجاني لطلبات 20 ألف+",
      waivedAmount: "5000.00",
    });

    const [inv] = await db()
      .select()
      .from(s.invoices)
      .where(eq(s.invoices.id, res.regularSale!.invoiceId));
    expect(inv.deliveryFree).toBe(true);
    expect(inv.deliveryWaivedAmount).toBe("5000.00");

    const [consignment] = await db()
      .select()
      .from(s.deliveryConsignments)
      .where(eq(s.deliveryConsignments.invoiceId, res.regularSale!.invoiceId));
    expect(consignment.feeCollection).toBe("SHOP");
  });

  it("R6-2: replayOfflineReception يحفظ إجمالي الفاتورة الملتقط أوفلاين عند إلغاء العرض قبل المزامنة دون فشل التطابق", async () => {
    await db().insert(s.products).values({ id: 94, name: "موسوعة علمية", categoryId: 1 });
    await db().insert(s.productVariants).values({ id: 94, productId: 94, sku: "ENC-94", costPrice: "4000.00" });
    await db().insert(s.productUnits).values({ id: 94, variantId: 94, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true });
    await db().insert(s.productPrices).values({ productUnitId: 94, priceTier: "RETAIL", price: "10000.00" });
    await setStock(94, 1, 10);

    const promoId = await withTx((tx) =>
      createPromotion(
        tx,
        {
          name: "خصم 10% مؤقت",
          type: "PERCENT",
          discountPercent: "10",
          scope: "PRODUCTS",
          effectiveFrom: "2026-01-01",
          targets: [{ productId: 94 }],
        },
        1,
      ),
    );

    // الكاشير يلتقط الطلب أوفلاين (خصم عرض 1000 + خصم كاشير 900 = 1900، الصافي المقبوض = 8100)، ثم يُلغى العرض قبل المزامنة
    await withTx((tx) => deactivatePromotion(tx, promoId));

    const recShiftRes = await db().insert(s.shifts).values({
      branchId: 1,
      userId: 1,
      shiftType: "RECEPTION",
      openingBalance: "0",
      status: "OPEN",
    });
    const recShiftId = insertId(recShiftRes);

    const replayed = await replayOfflineReception(
      {
        branchId: 1,
        shiftId: recShiftId,
        paymentMethod: "CASH",
        paidAmount: "8100.00",
        clientRequestId: "r6-offline-rec-deactivated-1",
        capturedAt: new Date(Date.now() - 60_000).toISOString(),
        offlineReceiptNumber: "OFF-REC-9401",
        deviceId: "REC-DEV-1",
        regularSale: {
          amount: "8100.00",
          lines: [
            {
              variantId: 94,
              productUnitId: 94,
              quantity: "1",
              unitPriceOverride: "10000.00",
              discountAmount: "1900.00",
              promotionDiscount: "1000.00",
              cashierDiscountAmount: "900.00",
              promotionId: promoId,
            },
          ],
        },
      },
      actor,
    );

    expect(replayed.invoiceId).toBeGreaterThan(0);
    const [inv] = await db()
      .select()
      .from(s.invoices)
      .where(eq(s.invoices.id, replayed.invoiceId));
    expect(inv.total).toBe("8100.00");
    expect(inv.paidAmount).toBe("8100.00");
    expect(inv.originatedOffline).toBe(true);

    const [item] = await db()
      .select()
      .from(s.invoiceItems)
      .where(eq(s.invoiceItems.invoiceId, replayed.invoiceId));
    expect(item.promotionId).toBeNull();
    expect(item.promotionDiscount).toBe("0.00");
    expect(item.discountAmount).toBe("1900.00");
    expect(item.total).toBe("8100.00");
  });

  it("R6-4: loadPromotionPerformance يطرح حصة خصم رأس الفاتورة (invoiceDiscount) تناسبياً من صافي مبيعات العرض وربحه", async () => {
    await db().insert(s.products).values([
      { id: 95, name: "حاسبة علمية", categoryId: 1 },
      { id: 96, name: "دفتر هندسي", categoryId: 1 },
    ]);
    await db().insert(s.productVariants).values([
      { id: 95, productId: 95, sku: "CALC-95", costPrice: "8000.00" },
      { id: 96, productId: 96, sku: "ENG-96", costPrice: "6000.00" },
    ]);
    await db().insert(s.productUnits).values([
      { id: 95, variantId: 95, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
      { id: 96, variantId: 96, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
    ]);
    await db().insert(s.productPrices).values([
      { productUnitId: 95, priceTier: "RETAIL", price: "12000.00" },
      { productUnitId: 96, priceTier: "RETAIL", price: "10000.00" },
    ]);
    await setStock(95, 1, 10);
    await setStock(96, 1, 10);

    const promoId = await withTx((tx) =>
      createPromotion(
        tx,
        {
          name: "خصم 2000 د.ع على الحاسبة",
          type: "AMOUNT",
          discountAmount: "2000.00",
          scope: "PRODUCTS",
          effectiveFrom: "2026-01-01",
          targets: [{ productId: 95 }],
        },
        1,
      ),
    );

    const shiftId = await openShift();
    // السطر الترويجي بعد العرض = 10,000 + سطر عادي = 10,000 (المجموع 20,000) ثم خصم رأس 2,000 => صافي الفاتورة 18,000
    // حصة السطر الترويجي من الإيراد المحقّق = 9,000، وكلفته = 8,000 => مجمل ربح العرض = 1,000
    const sale = await createSale(
      {
        branchId: 1,
        shiftId,
        sourceType: "POS",
        priceTier: "RETAIL",
        invoiceDiscount: "2000.00",
        lines: [
          {
            variantId: 95,
            productUnitId: 95,
            quantity: "1",
            discountAmount: "2000.00",
            promotionDiscount: "2000.00",
            promotionId: promoId,
          },
          {
            variantId: 96,
            productUnitId: 96,
            quantity: "1",
          },
        ],
        payment: { amount: "18000.00", method: "CASH" },
      } as any,
      actor,
    );
    expect(sale.total).toBe("18000.00");

    const perf = await withTx((tx) => loadPromotionPerformance(tx, 1));
    const promoRow = perf.rows.find((r) => r.promotionId === promoId);
    expect(promoRow).toBeDefined();
    expect(promoRow!.invoiceCount).toBe(1);
    expect(promoRow!.discount).toBe("2000.00");
    expect(promoRow!.netSales).toBe("9000.00");
    expect(promoRow!.cost).toBe("8000.00");
    expect(promoRow!.grossProfit).toBe("1000.00");
  });

  it("R7-3: searchPromotionProducts يدعم الترقيم الحتمي عبر offset عند جلب أصناف فئة كاملة", async () => {
    await db().insert(s.categories).values({ id: 77, name: "أقلام ملونة" });
    await db().insert(s.products).values([
      { id: 191, name: "قلم 1", categoryId: 77 },
      { id: 192, name: "قلم 2", categoryId: 77 },
      { id: 193, name: "قلم 3", categoryId: 77 },
    ]);
    await db().insert(s.productVariants).values([
      { id: 191, productId: 191, sku: "CLR-191", costPrice: "500.00" },
      { id: 192, productId: 192, sku: "CLR-192", costPrice: "500.00" },
      { id: 193, productId: 193, sku: "CLR-193", costPrice: "500.00" },
    ]);
    await db().insert(s.productUnits).values([
      { id: 191, variantId: 191, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
      { id: 192, variantId: 192, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
      { id: 193, variantId: 193, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
    ]);
    await db().insert(s.productPrices).values([
      { productUnitId: 191, priceTier: "RETAIL", price: "1000.00" },
      { productUnitId: 192, priceTier: "RETAIL", price: "1000.00" },
      { productUnitId: 193, priceTier: "RETAIL", price: "1000.00" },
    ]);

    const page1 = await searchPromotionProducts(db(), { categoryId: 77, limit: 2, offset: 0 }, true);
    const page2 = await searchPromotionProducts(db(), { categoryId: 77, limit: 2, offset: 2 }, true);
    const page3 = await searchPromotionProducts(db(), { categoryId: 77, limit: 2, offset: 4 }, true);

    expect(page1.map((p) => p.variantId)).toEqual([193, 192]);
    expect(page2.map((p) => p.variantId)).toEqual([191]);
    expect(page3).toEqual([]);
  });

  it("R8-2: loadPromotionPerformance يعد الفاتورة الواحدة متعددة العروض مرةً واحدة في الملخص مع إبقاء عداد كل عرض مستقلاً", async () => {
    await db().insert(s.products).values([
      { id: 196, name: "منتج عرض أ", categoryId: 1 },
      { id: 197, name: "منتج عرض ب", categoryId: 1 },
    ]);
    await db().insert(s.productVariants).values([
      { id: 196, productId: 196, sku: "PROMO-A-196", costPrice: "3000.00" },
      { id: 197, productId: 197, sku: "PROMO-B-197", costPrice: "4000.00" },
    ]);
    await db().insert(s.productUnits).values([
      { id: 196, variantId: 196, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
      { id: 197, variantId: 197, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
    ]);
    await db().insert(s.productPrices).values([
      { productUnitId: 196, priceTier: "RETAIL", price: "5000.00" },
      { productUnitId: 197, priceTier: "RETAIL", price: "8000.00" },
    ]);
    await setStock(196, 1, 20);
    await setStock(197, 1, 20);

    const promoA = await withTx((tx) =>
      createPromotion(
        tx,
        {
          name: "عرض منتج أ",
          type: "AMOUNT",
          discountAmount: "500.00",
          scope: "PRODUCTS",
          effectiveFrom: "2020-01-01",
          targets: [{ variantId: 196 }],
        },
        1,
      ),
    );
    const promoB = await withTx((tx) =>
      createPromotion(
        tx,
        {
          name: "عرض منتج ب",
          type: "AMOUNT",
          discountAmount: "1000.00",
          scope: "PRODUCTS",
          effectiveFrom: "2020-01-01",
          targets: [{ variantId: 197 }],
        },
        1,
      ),
    );

    const shiftId = await openShift();
    const sale = await createSale(
      {
        branchId: 1,
        shiftId,
        sourceType: "POS",
        priceTier: "RETAIL",
        lines: [
          {
            variantId: 196,
            productUnitId: 196,
            quantity: "1",
            discountAmount: "500.00",
            promotionDiscount: "500.00",
            promotionId: promoA,
          },
          {
            variantId: 197,
            productUnitId: 197,
            quantity: "1",
            discountAmount: "1000.00",
            promotionDiscount: "1000.00",
            promotionId: promoB,
          },
        ],
        payment: { amount: "11500.00", method: "CASH" },
      } as any,
      actor,
    );
    expect(sale.total).toBe("11500.00");

    const perf = await withTx((tx) => loadPromotionPerformance(tx, 1));
    expect(perf.canSeeCost).toBe(true);
    const rowA = perf.rows.find((r) => r.promotionId === promoA);
    const rowB = perf.rows.find((r) => r.promotionId === promoB);
    expect(rowA?.invoiceCount).toBe(1);
    expect(rowB?.invoiceCount).toBe(1);
    expect(perf.summary.invoiceCount).toBe(1);
    expect(perf.summary.discount).toBe("1500.00");
    expect(perf.summary.netSales).toBe("11500.00");
    expect(perf.summary.cost).toBe("7000.00");
    expect(perf.summary.grossProfit).toBe("4500.00");

    // R9-1: قارئ بلا صلاحية رؤية التكلفة يستلم cost=null و grossProfit=null على الصفوف والملخص معاً
    const redactedPerf = await withTx((tx) => loadPromotionPerformance(tx, 1, false));
    expect(redactedPerf.canSeeCost).toBe(false);
    expect(redactedPerf.summary.cost).toBeNull();
    expect(redactedPerf.summary.grossProfit).toBeNull();
    expect(redactedPerf.summary.netSales).toBe("11500.00");
    expect(redactedPerf.summary.discount).toBe("1500.00");
    for (const r of redactedPerf.rows) {
      expect(r.cost).toBeNull();
      expect(r.grossProfit).toBeNull();
    }
  });

  it("R9-2: createPromotion و updatePromotion يحفظان أكثر من 500 هدف عبر إدراج دفعي مجزأ", async () => {
    const bulkCount = 620;
    await db().insert(s.products).values(
      Array.from({ length: bulkCount }, (_, idx) => ({
        id: 2000 + idx,
        name: `صنف جملة ${idx + 1}`,
        categoryId: 1,
      })),
    );
    await db().insert(s.productVariants).values(
      Array.from({ length: bulkCount }, (_, idx) => ({
        id: 2000 + idx,
        productId: 2000 + idx,
        sku: `BLK-${2000 + idx}`,
        costPrice: "400.00",
      })),
    );
    await db().insert(s.productUnits).values(
      Array.from({ length: bulkCount }, (_, idx) => ({
        id: 2000 + idx,
        variantId: 2000 + idx,
        unitName: "قطعة",
        conversionFactor: "1",
        isBaseUnit: true,
      })),
    );
    await db().insert(s.productPrices).values(
      Array.from({ length: bulkCount }, (_, idx) => ({
        productUnitId: 2000 + idx,
        priceTier: "RETAIL" as const,
        price: "1000.00",
      })),
    );

    const targets620 = Array.from({ length: bulkCount }, (_, idx) => ({
      variantId: 2000 + idx,
    }));
    const promoId = await withTx((tx) =>
      createPromotion(
        tx,
        {
          name: "عرض فئة واسعة 620 صنف",
          type: "PERCENT",
          discountPercent: "10",
          scope: "PRODUCTS",
          effectiveFrom: "2026-01-01",
          targets: targets620,
        },
        1,
      ),
    );

    await withTx((tx) =>
      updatePromotion(
        tx,
        {
          id: promoId,
          targets: targets620.slice(0, 580),
        },
        1,
      ),
    );

    const savedTargets = await db()
      .select()
      .from(s.promotionTargets)
      .where(eq(s.promotionTargets.promotionId, promoId));
    expect(savedTargets).toHaveLength(580);
  });

  it("R9-3: عرض التوصيل المجاني يحفظ freeShippingPromotionId على الفاتورة ويظهر في عداد استخدام العرض والملخص دون تضخيم المبيعات", async () => {
    await db().insert(s.deliveryParties).values({
      id: 9,
      name: "مندوب الرصافة",
      partyType: "INDIVIDUAL",
      branchId: 1,
      currentBalance: "0.00",
      isActive: true,
      defaultFee: "5000.00",
    });
    await db().insert(s.products).values([
      { id: 198, name: "طابعة مكتبية", categoryId: 1 },
      { id: 199, name: "ورق A4", categoryId: 1 },
    ]);
    await db().insert(s.productVariants).values([
      { id: 198, productId: 198, sku: "PRN-198", costPrice: "15000.00" },
      { id: 199, productId: 199, sku: "PPR-199", costPrice: "3000.00" },
    ]);
    await db().insert(s.productUnits).values([
      { id: 198, variantId: 198, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
      { id: 199, variantId: 199, unitName: "ماعون", conversionFactor: "1", isBaseUnit: true },
    ]);
    await db().insert(s.productPrices).values([
      { productUnitId: 198, priceTier: "RETAIL", price: "25000.00" },
      { productUnitId: 199, priceTier: "RETAIL", price: "5000.00" },
    ]);
    await setStock(198, 1, 10);
    await setStock(199, 1, 10);

    const shipPromoId = await withTx((tx) =>
      createPromotion(
        tx,
        {
          name: "توصيل مجاني فوق 20 ألف",
          type: "FREE_SHIPPING",
          minOrderSpend: "20000.00",
          scope: "ALL",
          channel: "ALL",
          effectiveFrom: "2020-01-01",
        },
        1,
      ),
    );
    const merchPromoId = await withTx((tx) =>
      createPromotion(
        tx,
        {
          name: "خصم ورق A4",
          type: "AMOUNT",
          discountAmount: "1000.00",
          scope: "PRODUCTS",
          channel: "ALL",
          effectiveFrom: "2020-01-01",
          targets: [{ variantId: 199 }],
        },
        1,
      ),
    );

    const recShiftRes = await db().insert(s.shifts).values({
      branchId: 1,
      userId: 1,
      shiftType: "RECEPTION",
      openingBalance: "0",
      status: "OPEN",
    });
    const recShiftId = insertId(recShiftRes);

    // فاتورة 1: عرض شحن مجاني فقط بلا خصم سلعي على أي سطر
    const shipOnlySale = await checkoutReception(
      {
        branchId: 1,
        shiftId: recShiftId,
        paymentMethod: "CASH",
        paidAmount: "25000.00",
        clientRequestId: "r9-3-ship-only-1",
        regularSale: {
          amount: "25000.00",
          lines: [{ variantId: 198, productUnitId: 198, quantity: "1" }],
        },
        delivery: {
          partyId: 9,
          fee: "5000.00",
          feeCollection: "COURIER",
          recipientName: "زبون 1",
          recipientPhone: "07701112233",
          address: "بغداد",
        },
      },
      actor,
    );
    const [inv1] = await db()
      .select()
      .from(s.invoices)
      .where(eq(s.invoices.id, shipOnlySale.regularSale!.invoiceId));
    expect(inv1.freeShippingPromotionId).toBe(shipPromoId);

    const perfAfterShipOnly = await withTx((tx) => loadPromotionPerformance(tx, 1));
    const shipRow1 = perfAfterShipOnly.rows.find((r) => r.promotionId === shipPromoId);
    expect(shipRow1).toEqual({
      promotionId: shipPromoId,
      invoiceCount: 1,
      netSales: "0.00",
      discount: "0.00",
      cost: "0.00",
      grossProfit: "0.00",
    });
    expect(perfAfterShipOnly.summary.invoiceCount).toBe(1);

    // فاتورة 2: تجمع عرض خصم سلعي + عرض توصيل مجاني معاً — لا تتضاعف summary.invoiceCount
    await checkoutReception(
      {
        branchId: 1,
        shiftId: recShiftId,
        paymentMethod: "CASH",
        paidAmount: "29000.00",
        clientRequestId: "r9-3-mixed-2",
        regularSale: {
          amount: "29000.00",
          lines: [
            { variantId: 198, productUnitId: 198, quantity: "1" },
            {
              variantId: 199,
              productUnitId: 199,
              quantity: "1",
              discountAmount: "1000.00",
              promotionDiscount: "1000.00",
              promotionId: merchPromoId,
            },
          ],
        },
        delivery: {
          partyId: 9,
          fee: "5000.00",
          feeCollection: "COURIER",
          recipientName: "زبون 2",
          recipientPhone: "07701112244",
          address: "بغداد",
        },
      },
      actor,
    );

    const perfAfterMixed = await withTx((tx) => loadPromotionPerformance(tx, 1));
    const shipRow2 = perfAfterMixed.rows.find((r) => r.promotionId === shipPromoId);
    const merchRow2 = perfAfterMixed.rows.find((r) => r.promotionId === merchPromoId);
    expect(shipRow2?.invoiceCount).toBe(2);
    expect(merchRow2?.invoiceCount).toBe(1);
    expect(perfAfterMixed.summary.invoiceCount).toBe(2);
    expect(perfAfterMixed.summary.netSales).toBe("4000.00");
    expect(perfAfterMixed.summary.discount).toBe("1000.00");
  });
});


