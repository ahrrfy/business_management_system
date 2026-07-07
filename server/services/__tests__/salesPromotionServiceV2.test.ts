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
import { createPromotion, deactivatePromotion, resolvePromotionForLine } from "../salesPromotionService";
import { createSale } from "../saleService";
import { withTx } from "../tx";

const actor = { userId: 1, branchId: 1 };

const TABLES = [
  "accountingEntries", "receipts", "inventoryMovements",
  "invoiceItemBundleComponents", "invoiceItems", "invoices", "idempotencyKeys",
  "promotionTargets", "promotions",
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
