import { TRPCError } from "@trpc/server";
import type Decimal from "decimal.js";
import { and, eq } from "drizzle-orm";
import { productPrices, products, productUnits, productVariants } from "../../drizzle/schema";
import type { Tx } from "../db";
import { money } from "./money";

export type PriceTier = "RETAIL" | "WHOLESALE" | "GOVERNMENT";

/** Effective tier: explicit override → customer default → RETAIL. */
export const resolveTier = (o: {
  override?: PriceTier | null;
  customerTier?: PriceTier | null;
}): PriceTier => o.override ?? o.customerTier ?? "RETAIL";

/** Unit price for a (unit × tier). No implicit fallback between tiers. */
export async function getUnitPrice(tx: Tx, productUnitId: number, tier: PriceTier): Promise<Decimal> {
  const p = await tryGetUnitPrice(tx, productUnitId, tier);
  if (p == null) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `لا يوجد سعر للوحدة (${productUnitId}) ضمن فئة (${tier}). عرّف السعر أولاً.`,
    });
  }
  return p;
}

/** كـgetUnitPrice لكن يُعيد null بدل الرمي عند غياب السعر — للقياس المرجعيّ (H6) دون إجبار وجود سعرٍ مُعرَّف. */
export async function tryGetUnitPrice(tx: Tx, productUnitId: number, tier: PriceTier): Promise<Decimal | null> {
  const rows = await tx
    .select({ price: productPrices.price })
    .from(productPrices)
    .where(and(eq(productPrices.productUnitId, productUnitId), eq(productPrices.priceTier, tier)))
    .limit(1);
  return rows[0] ? money(rows[0].price) : null;
}

/**
 * اسمُ الوحدة للعرض في رسائل الرفض. **لا يُستدعى على المسار السليم** — نداؤه داخل فرع الفشل
 * وحده (H7) كي لا تدفع كلُّ بيعةٍ ثمن رحلةٍ لا تُقرأ إلا حين يُرفض السطر.
 */
export async function unitNameFor(tx: Tx, productUnitId: number): Promise<string | null> {
  const rows = await tx
    .select({ unitName: productUnits.unitName })
    .from(productUnits)
    .where(eq(productUnits.id, productUnitId))
    .limit(1);
  return rows[0]?.unitName ?? null;
}

/**
 * تسمية الصنف للعرض («اسم المنتج — اسم المتغيّر»). كـ`unitNameFor`: **مسار الرفض وحده**.
 * مسارُ البيع العاديّ يحمل التسمية معه من استعلامه الجامع فلا يحتاج هذه.
 */
export async function variantLabelFor(tx: Tx, variantId: number): Promise<string> {
  const rows = await tx
    .select({ productName: products.name, variantName: productVariants.variantName })
    .from(productVariants)
    .innerJoin(products, eq(productVariants.productId, products.id))
    .where(eq(productVariants.id, variantId))
    .limit(1);
  const r = rows[0];
  if (!r) return `الصنف ${variantId}`;
  return [r.productName, r.variantName].filter(Boolean).join(" — ") || `الصنف ${variantId}`;
}

/**
 * **مرجعُ القياس** لسطر بيع — يسقط على سعر **المفرد** حين لا تحمل فئةُ العميل سعراً.
 *
 * ⛔ **لا يُستعمَل للتحصيل أبداً.** الفرقُ جوهريّ: `getUnitPrice` تمنع عمداً أيّ سقوطٍ ضمنيّ
 * بين الفئات، لأنّ تحصيل سعر المفرد من عميل جملةٍ خطأٌ ماليّ. أمّا **قياس** التنازل فيلزمه
 * مرجعٌ فحسب، وسعرُ المفرد هو سعرُ القائمة القانونيّ للصنف.
 *
 * وبه تبقى سياسة H7 «كل صنفٍ يُباع له سعر قائمة» **إلزاماً واحداً لا ثلاثة**: يكفي الصنفَ سعرُ
 * مفردٍ موجب (وهو ما يفرضه `assertBaseRetailPricePresent` عند المنبع) ولا يُطالَب بتسعيرٍ في
 * الفئات الثلاث. أمسك هذا الفرقَ اختبارُ قناة الطباعة: خدمةٌ مسعَّرةٌ بالمفرد تُباع لعميلٍ
 * حكوميّ بسعرٍ يدويّ — لها سعر قائمة فعلاً، فرفضُها كان تشديداً لم يطلبه المالك.
 */
export async function getReferenceUnitPrice(
  tx: Tx,
  productUnitId: number,
  tier: PriceTier,
  tierPrice?: Decimal | null,
): Promise<Decimal | null> {
  const own = tierPrice !== undefined ? tierPrice : await tryGetUnitPrice(tx, productUnitId, tier);
  if (own != null && own.gt(0)) return own;
  if (tier === "RETAIL") return own;
  return (await tryGetUnitPrice(tx, productUnitId, "RETAIL")) ?? own;
}
