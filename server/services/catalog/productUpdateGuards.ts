/**
 * ═══ حرّاسُ تعديل المنتج المشتركة (م٦ — علاجُ D5 في مقياس الاحتكاك) ═══
 *
 * **العلّة المقيسة:** خدمتا تعديل المنتج — `productEditService.updateProductWithVariants`
 * (مسار القالب المشترك، شاشة المنتج) و`catalog/productUpdate.updateProduct` (المسار الحامل
 * لمعرّف الوحدة) — كانتا تختلفان في **ستّةٍ من سبعة** حرّاس: حارسُ شكل البكج (B12) في
 * الثانية وحدها، وسجلُّ تغيّر السعر (`priceChangeLog`) فيها وحدها (Codex INV-05: تعديلُ
 * السعر من شاشة المنتج **لا يكتبه**)، وترتيبُ «ثبات الأساس ثمّ إعادة تقييم التكلفة» مكرّرٌ
 * بيدٍ في كلٍّ منهما. فالإصلاحُ في مسارٍ يبقى ثقباً في الآخر.
 *
 * **الحلّ:** مصدرٌ واحد لكلّ حارس، تستدعيه الخدمتان. الحرّاس السبعة بترتيب المعاملة:
 *   ① الوجود           — `loadProductForUpdateOrThrow`
 *   ② الشكل            — `assertHasVariants` + `assertBundleEditShape`
 *   ③ حجز المتجر        — `lockUnitsAndAssertNoActiveOnlineOrderChanges`
 *   ④ قفل المخزون       — `lockVariantsForUpdate` (ترتيب الأقفال الحاكم: variant → branchStock)
 *   ⑤ الأساس والتكلفة   — `assertBaseUnitStableAndRevalueCost` (الأساس أوّلاً ثمّ التكلفة — دائماً)
 *   ⑥ سجلّ السعر        — `logUnitPriceChanges`
 *   ⑦ اللقطة            — `snapshotProductBeforeUpdate` («لا لقطة ⇒ لا تعديل»، ق٨)
 * وحارسا حدّ العقد (كانا خاصَّين بالراوتر) صارا هنا كي يمرّ بهما مسارُ **الاستعادة** أيضاً:
 *   `assertVariantSanityOrThrow` و`assertCostChangeReasonOrThrow`.
 *
 * ⛔ الرسائلُ المتعاقَدُ عليها في الاختبارات أُبقيت **حرفياً** (حارس `check:message-drift`).
 * ⛔ لا يقرأ `ctx` — `Actor` صريح (§٥).
 */
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { priceChangeLog, products } from "../../../drizzle/schema";
import { appErrorMessage } from "@shared/errors";
import { checkVariantSanity, classifySeverity, type UnitPricing } from "../../../shared/priceSanity";
import type { Tx } from "../../db";
import { postCostRevaluation } from "../costRevaluation";
import { lockInventoryVariants } from "../inventory/stockLock";
import { toDbMoney } from "../money";
import type { PriceTier } from "../pricing";
import type { Actor } from "../tx";
import { snapshotBeforeUpdate } from "../versioning/recordVersion";
import { assertBaseUnitStable, type IntendedBase } from "./baseUnitGuard";
import { getProductForVariantEdit } from "./productEditDocument";
import { buildProductSnapshot } from "./productSnapshot";
import {
  assertNoActiveOnlineOrderUnitChanges,
  lockProductUnitsForOnlineAllocation,
} from "./variantAvailability";

/** نوعُ الكيان في `recordVersions` — مصدرٌ واحد للخدمة والاختبارات والواجهة. */
export const PRODUCT_ENTITY_TYPE = "product";

/** سببُ اللقطة حين لا تُسلّم الشاشةُ سبباً — يظهر في سجلّ النسخ. */
export const DEFAULT_PRODUCT_UPDATE_REASON = "تعديل بيانات المنتج";

/** سببُ سجلّ السعر للتعديل اليدويّ — كان في مسارٍ واحد، والآن في المسارَين. */
export const MANUAL_PRICE_CHANGE_REASON = "تعديل يدوي من شاشة المنتج";

export type ProductRow = typeof products.$inferSelect;

/* ─────────────── ① الوجود ─────────────── */

/** رسالةُ NOT_FOUND الموحَّدة للمنتج — «المنتج غير موجود» نصٌّ متعاقَدٌ عليه في الاختبارات (يبقى في «ماذا حدث»). */
export function productNotFoundError(productId: number): TRPCError {
  return new TRPCError({
    code: "NOT_FOUND",
    message: appErrorMessage({
      what: "المنتج غير موجود",
      why: `لا منتج بالمعرّف ${productId} — حُذف أو الرابط قديم`,
      doThis: "افتح المنتج من قائمة المنتجات ثم أعد المحاولة",
    }),
  });
}

export async function loadProductForUpdateOrThrow(tx: Tx, productId: number): Promise<ProductRow> {
  const p = (await tx.select().from(products).where(eq(products.id, productId)).limit(1))[0];
  if (!p) throw productNotFoundError(productId);
  return p;
}

/* ─────────────── ② الشكل ─────────────── */

export function assertHasVariants(variantCount: number): void {
  if (variantCount < 1) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "المنتج يحتاج متغيّراً واحداً على الأقل",
        why: "الحمولة بلا متغيّرات، ومنتجٌ بلا متغيّر لا يُباع ولا يُجرَد",
        doThis: "أضف لوناً أو قياساً واحداً على الأقل (أو المتغيّر الافتراضي) ثم احفظ",
      }),
    });
  }
}

/**
 * gstack B12 (٧/٧/٢٦): البكج = متغيّرٌ واحد فقط + وحدةُ أساسٍ واحدة فقط. كان في مسار المعرّف وحده،
 * فتعديلُ بكجٍ من شاشة المنتج (مسار القالب) كان يقبل متغيّراً ثانياً «شبحاً» بلا وصفة يفشل عند البيع.
 */
export function assertBundleEditShape(
  p: Pick<ProductRow, "isBundle">,
  variantCount: number,
  baseUnitCount: number,
): void {
  if (!p.isBundle) return;
  if (variantCount !== 1) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "البكج لا يقبل إلّا متغيّراً واحداً",
        why: "البكج يُركَّب من وصفته لا من ألوانٍ وقياسات، ومتغيّرٌ ثانٍ بلا وصفة يفشل عند البيع",
        doThis: "احذف المتغيّرات الإضافية ثم احفظ",
      }),
    });
  }
  if (baseUnitCount !== 1) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "البكج لا يقبل إلّا وحدة أساس واحدة",
        why: "كمّية البكج تُقوَّم بوحدةٍ واحدة تُترجَم إلى مكوّناته",
        doThis: "أبقِ وحدة أساسٍ واحدة واحذف الباقي ثم احفظ",
      }),
    });
  }
}

/* ─────────────── ③ حجز المتجر ─────────────── */

export type LockedUnit = Awaited<ReturnType<typeof lockProductUnitsForOnlineAllocation>>[number];

/**
 * productUnit هو mutex معنى الكمّية: نقفل وحدات المتغيّرات القائمة قبل أيّ قفل variant/كتابة،
 * ثمّ نحدّد المحميّ من القراءة المقفلة (لا من لقطةٍ قديمة) ونفحص طلبات المتجر النشطة.
 * `isProtected(unit)` يقرّر من الصفّ المقفول هل يتغيّر معناه (معاملُه أو غيابُه).
 */
export async function lockUnitsAndAssertNoActiveOnlineOrderChanges(
  tx: Tx,
  unitIds: number[],
  isProtected: (unit: LockedUnit) => boolean,
): Promise<LockedUnit[]> {
  const lockedUnits = await lockProductUnitsForOnlineAllocation(tx, unitIds);
  const protectedUnitIds = lockedUnits.filter(isProtected).map((unit) => unit.id);
  await assertNoActiveOnlineOrderUnitChanges(tx, protectedUnitIds);
  return lockedUnits;
}

/* ─────────────── ④ قفل المخزون ─────────────── */

/** ترتيبُ الأقفال الحاكم نفسه في الشراء/WAVG — يُستدعى بعد ③ وقبل أيّ كتابة. */
export const lockVariantsForUpdate = lockInventoryVariants;

/* ─────────────── ⑤ الأساس والتكلفة ─────────────── */

/**
 * الترتيبُ ثابت: حارسُ ثبات وحدة الأساس (#549) **ثمّ** إعادة تقييم التكلفة (H3/H4) — الأساسُ يملك
 * أولويّة التشخيص، والتقييمُ يقفل variant→branchStock ويرفض تعديلَ تكلفة صنفٍ مملوكٍ له رصيد.
 */
export async function assertBaseUnitStableAndRevalueCost(
  tx: Tx,
  variantId: number,
  intendedBase: IntendedBase,
  oldCost: string | null | undefined,
  newCost: string,
  actor: Actor,
  reason?: string | null,
): Promise<void> {
  await assertBaseUnitStable(tx, variantId, intendedBase);
  await postCostRevaluation(tx, variantId, oldCost, newCost, actor, reason);
}

/* ─────────────── ⑥ سجلّ السعر ─────────────── */

/**
 * صفٌّ في `priceChangeLog` لكلّ (وحدة × فئة) تغيّر سعرُها. كان يُكتب في مسار المعرّف وحده؛ الآن
 * يُكتب في المسارَين ⇒ «سجل السعر» في شاشة المنتج يُظهر التعديل اليدويّ أيضاً (Codex INV-05).
 * ⚠️ الأسعارُ تُطبَّع بـ`toDbMoney` قبل المقارنة كي لا يُسجَّل «1000» ⇒ «1000.00» تغييراً.
 */
export async function logUnitPriceChanges(
  tx: Tx,
  input: {
    productUnitId: number;
    previousByTier: ReadonlyMap<string, string>;
    next: ReadonlyArray<{ priceTier: PriceTier; price: string }>;
    actor: Actor;
    reason?: string;
  },
): Promise<void> {
  for (const pr of input.next) {
    if (!pr.price.trim()) continue;
    const oldPrice = input.previousByTier.get(pr.priceTier) ?? null;
    const newPrice = toDbMoney(pr.price);
    if (oldPrice != null && toDbMoney(oldPrice) === newPrice) continue;
    await tx.insert(priceChangeLog).values({
      productUnitId: input.productUnitId,
      priceTier: pr.priceTier,
      oldPrice,
      newPrice,
      reason: input.reason ?? MANUAL_PRICE_CHANGE_REASON,
      waveId: null,
      actorUserId: input.actor.userId,
    });
  }
}

/* ─────────────── ⑦ اللقطة ─────────────── */

/**
 * «لا لقطة ⇒ لا تعديل» (ق٨): تُقرأ حالةُ المنتج **داخل المعاملة وبعد الأقفال** (فلا كاتبَ
 * متزامنٌ يزيح «قبل»)، وتُكتب كاملةً في `recordVersions`. أيُّ فشلٍ لاحق ⇒ ROLLBACK يُسقط اللقطة
 * مع التعديل، وأيُّ فشلٍ في اللقطة نفسها يُسقط التعديل — لا كتابةَ بلا تاريخ.
 */
export async function snapshotProductBeforeUpdate(
  tx: Tx,
  productId: number,
  reason: string | null | undefined,
  actor: Actor,
): Promise<{ id: number; versionNumber: number }> {
  const doc = await getProductForVariantEdit(productId, tx);
  if (!doc) throw productNotFoundError(productId);
  return snapshotBeforeUpdate(
    tx,
    {
      entityType: PRODUCT_ENTITY_TYPE,
      entityId: productId,
      payloadJson: buildProductSnapshot(doc),
      reason: (reason ?? "").trim() || DEFAULT_PRODUCT_UPDATE_REASON,
    },
    actor,
  );
}

/* ─────────────── حرّاس حدّ العقد (الراوتر + الاستعادة) ─────────────── */

/**
 * حرّاس عقلانية على تكلفة/سعر/معامل — دفاعٌ في العمق ضدّ أيّ عميل يتجاوز حرّاس الواجهة
 * (حادثة SINARLINE ٣٠/٧: تكلفة 16162 vs بيع 2000 ⇒ توقّف كاشير ساعات). يرمي BAD_REQUEST بلا
 * تعديل الحالة. المصدر مشترك: shared/priceSanity.ts.
 */
export function assertVariantSanityOrThrow(
  variantLabel: string,
  costPrice: string,
  units: UnitPricing[],
): void {
  const issues = checkVariantSanity(costPrice, units);
  const blocker = issues.find((i) => i.level === "blocker");
  if (blocker) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: `[${variantLabel}] ${blocker.message}`,
        why: "حارس عقلانية الأسعار (priceSanity) يوقف تكلفةً تفوق سعر البيع بخمسة أضعاف أو معاملَ تحويلٍ غير صالح قبل أن يوقفا الكاشير",
        doThis: "صحّح التكلفة أو سعر البيع أو معامل التحويل للوحدة المذكورة ثم احفظ",
      }),
    });
  }
}

/**
 * **priceSanity L1.7 (٣٠/٧):** حارس السبب الإلزاميّ. عند تغيير التكلفة بنسبة ≥ ٥× مقارنةً بالقيمة
 * السابقة (blocker حسب `classifySeverity`)، يجب أن يمرَّر `costChangeReason` بمحارف ≥ ١٠.
 * يمنع تغييرات صامتة كارثيّة (حالة SINARLINE) من الاستيراد أو استعادات المسودّات.
 */
export function assertCostChangeReasonOrThrow(
  variantLabel: string,
  oldCost: string | number | null | undefined,
  newCost: string | number,
  reason: string | null | undefined,
): void {
  const sev = classifySeverity(newCost, { oldCost: oldCost ?? null });
  if (sev === "blocker" || sev === "catastrophic") {
    const r = (reason ?? "").trim();
    if (r.length < 10) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: `[${variantLabel}] تغيير التكلفة كبير جداً (من ${oldCost ?? "؟"} إلى ${newCost})`,
          why: "التغيّر يبلغ خمسة أضعاف القيمة السابقة أو أكثر (priceSanity L1.7) فلا يمرّ بلا سببٍ مكتوب — حالة SINARLINE",
          doThis: "اكتب سبباً من 10 محارف فأكثر في حقل «سبب تغيير التكلفة» ثم احفظ",
        }),
      });
    }
  }
}

/** يبني مدخلَ حارس العقلانية من قالب الوحدات المشترك + سعر الأساس الخاصّ بالمتغيّر (إن وُجد). */
export function unitPricingsFromTemplate(
  template: ReadonlyArray<{ unitName: string; conversionFactor: string; isBaseUnit: boolean; prices: ReadonlyArray<{ priceTier: PriceTier; price: string }> }>,
  baseRetailOverride?: string | null,
): UnitPricing[] {
  return template.map((u) => {
    const priceOf = (tier: PriceTier) => u.prices.find((p) => p.priceTier === tier)?.price ?? null;
    const retail = u.isBaseUnit && baseRetailOverride ? baseRetailOverride : priceOf("RETAIL");
    return {
      unitName: u.unitName,
      conversionFactor: u.isBaseUnit ? 1 : Number(u.conversionFactor) || 0,
      retail,
      wholesale: priceOf("WHOLESALE"),
      government: priceOf("GOVERNMENT"),
    };
  });
}

/** يرمي بصيغة العقد الرباعيّ حين تكون اللقطة غير صالحة للاستعادة. */
export function invalidSnapshotError(why: string): TRPCError {
  return new TRPCError({
    code: "BAD_REQUEST",
    message: appErrorMessage({
      what: "تعذّرت الاستعادة",
      why,
      doThis: "افتح سجلّ المنتج واختر نسخةً أخرى، وأبلغ المدير إن تكرّر",
    }),
  });
}
