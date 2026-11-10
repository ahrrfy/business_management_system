import { assertEconomicInventoryReady, lockEconomicInventoryScope } from "../inventory/economicOwnership";
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
import Decimal from "decimal.js";
import { TRPCError } from "@trpc/server";
import { and, eq, inArray, ne, or } from "drizzle-orm";
import {
  branchStock,
  bundleComponents,
  categories,
  customerContractPrices,
  expenseStockItems,
  giftVoucherLines,
  inventoryMovements,
  invoiceItemBundleComponents,
  invoiceItems,
  onlineOrderItems,
  onlineOrders,
  priceChangeLog,
  productionLines,
  productionRecipeLines,
  productionRecipes,
  products,
  purchaseOrderItems,
  quotationItems,
  receptionDraftLines,
  reservationLines,
  reservationStock,
  stocktakeItems,
  stocktakeSessions,
  workOrderItems,
  workOrderMaterials,
} from "../../../drizzle/schema";
import { appErrorMessage } from "@shared/errors";
import { moduleAccessAllowed, type PermissionMap } from "../../../shared/permissions";
import { checkVariantSanity, classifySeverity, type UnitPricing } from "../../../shared/priceSanity";
import { isSellableStockUsage, type StockUsage } from "../../../shared/stockUsage";
import { normalizeVariantDimension, normalizedVariantComboKey } from "../../../shared/variantCombination";
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
import { assertNoActiveDigitalInventoryBinding } from "../digitalCards/inventoryBindingGuard";

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

/**
 * ⚠️ قراءةٌ **قافلة** (`FOR UPDATE`) وهي أوّلُ قراءةٍ في المعاملة — عمداً (أمسكته الجولة البصريّة لـم٦):
 * القراءةُ العاديّة تُثبّت لقطةَ REPEATABLE READ للمعاملة كلّها، فتعديلٌ ثانٍ ينتظر على أقفال المتغيّرات
 * ثمّ يمضي بقراءاتٍ بائتة (رقمُ النسخة، وحمولةُ «قبل»، وحقولُ `p` التي تُقارَن بها الحرّاس). القراءةُ
 * القافلة لا تُثبّت لقطة، فتُسلسِل التعديلَين عند الباب ويرى الثاني ما التزمه الأوّل.
 */
export async function loadProductForUpdateOrThrow(tx: Tx, productId: number): Promise<ProductRow> {
  await assertEconomicInventoryReady(tx);
  const p = (await tx.select().from(products).where(eq(products.id, productId)).limit(1).for("update"))[0];
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
  flags?: { isService?: boolean; showInPrintPos?: boolean },
): void {
  if (!p.isBundle) return;
  if (flags?.isService || flags?.showInPrintPos) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "البكج لا يمكن تحويله إلى خدمة أو إظهاره في كاشير الطباعة",
        why: "البكج يُخصم مخزونيّاً من مكوّناته، بينما الخدمات وكاشير الطباعة يعملان بلا وصفة تجميع",
        doThis: "أبقِ البكج منتجاً مخزونيّاً وألغِ تفعيل الخدمة أو كاشير الطباعة ثم احفظ",
      }),
    });
  }
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

/** ترتيبُ الأقفال الحاكم نفسه في الشراء/WAVG — ويمنع تغيير كتالوجٍ تثبته نية رقمية نشطة. */
export async function lockVariantsForUpdate(
  tx: Tx,
  variantIds: readonly number[],
): Promise<void> {
  await lockEconomicInventoryScope(tx, variantIds);
  await assertNoActiveDigitalInventoryBinding(
    tx,
    variantIds,
    "تعديل المنتج أثناء إصدار سلة رقمية",
  );
}

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

/**
 * حارس تجميد هيكل وهوية الوحدات أثناء الجرد النشط (Codex P2):
 * يمنع تعديل أي وحدة (تغيير اسم، تعديل معامل تحويل، إضافة وحدة، حذف/تعطيل وحدة)
 * لأي متغيّر مشمول في جلسة جرد حالتها COUNTING أو REVIEW.
 * تغيير أسماء الوحدات أو حذفها أو تعديل معاملاتها أثناء الجرد يؤدي إلى:
 * 1) رفض عدّات العاملين الأوفلاينية أو المفتوحة بـ BAD_REQUEST وحذفها من الطابور
 * 2) تآكل أو تضاعف كميات المستودع الفعلية بالكراتين عند التسوية الدفترية.
 */
export async function assertNoActiveStocktakeUnitFreeze(
  tx: Tx,
  variantId: number,
  existingUnits: ReadonlyArray<{
    unitName: string;
    conversionFactor: string | number;
    isBaseUnit?: boolean | number | null;
    isActive?: boolean | number | null;
    barcode?: string | null;
  }>,
  incomingUnits: ReadonlyArray<{
    unitName: string;
    conversionFactor: string | number;
    isBaseUnit?: boolean | number | null;
    barcode?: string | null;
  }>,
): Promise<void> {
  const activeExisting = existingUnits.filter((u) => u.isActive !== false && u.isActive !== 0);
  if (activeExisting.length === 0) return;

  // فحص هل تغير هيكل الوحدات (إضافة، حذف، تغيير اسم، تغيير معامل، تغيير باركود، أو تغيير صفة الأساس)
  const structureChanged =
    activeExisting.length !== incomingUnits.length ||
    activeExisting.some((eu) => {
      const iu = incomingUnits.find((u) => String(u.unitName).trim() === String(eu.unitName).trim());
      if (!iu) return true; // تغير الاسم أو حُذفت الوحدة
      const euFactor = Number(eu.conversionFactor);
      const iuFactor = Number(iu.conversionFactor);
      const factorDiffers =
        Number.isFinite(euFactor) && Number.isFinite(iuFactor)
          ? Math.abs(euFactor - iuFactor) > 1e-6
          : String(iu.conversionFactor).trim() !== String(eu.conversionFactor).trim();
      if (factorDiffers) return true; // تغير المعامل
      if (Boolean(iu.isBaseUnit) !== Boolean(eu.isBaseUnit)) return true; // تغير الأساس
      const euBarcode = (eu.barcode ?? "").trim();
      const iuBarcode = (iu.barcode ?? "").trim();
      if (euBarcode !== iuBarcode) return true; // تغير الباركود
      return false;
    });

  if (!structureChanged) return;

  const active = await tx
    .select({ code: stocktakeSessions.code, status: stocktakeSessions.status })
    .from(stocktakeSessions)
    .innerJoin(stocktakeItems, eq(stocktakeSessions.id, stocktakeItems.sessionId))
    .where(
      and(
        eq(stocktakeItems.variantId, variantId),
        inArray(stocktakeSessions.status, ["COUNTING", "REVIEW"]),
      ),
    )
    .limit(1);

  if (active.length > 0) {
    const s = active[0];
    const phase = s.status === "COUNTING" ? "مرحلة العدّ" : "مرحلة المراجعة";
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: appErrorMessage({
        what: "تعذّر تعديل هيكل أو وحدات الصنف أثناء الجرد النشط",
        why: `هذا الصنف مدرج في جلسة جرد نشطة (${s.code}) في ${phase}، وتعديل أسماء الوحدات أو معاملاتها أو باركوداتها أو حذفها أثناء الجرد يؤدي إلى رفض عدّات العاملين الميدانية وتضارب التسوية الدفترية`,
        doThis: "أكمل اعتماد جلسة الجرد أو ألغِها أولاً قبل تعديل وحدات القياس في الكتالوج",
      }),
    });
  }
}

/**
 * حارس حماية معاملات التحويل أثناء الجرد النشط:
 * يمنع تعديل معامل التحويل لأي وحدة قائمة لمتغيّر مشمول في جلسة جرد حالتها COUNTING أو REVIEW.
 * تعديل المعامل أثناء الجرد يؤدي إلى تآكل أو تضاعف كميات المستودع الفعلية بالكراتين عند التسوية الدفترية.
 */
export async function assertNoActiveStocktakeFactorChange(
  tx: Tx,
  variantId: number,
  unitChanges: Array<{ unitName: string; oldFactor?: string | null; newFactor: string }>,
): Promise<void> {
  const factorChanged = unitChanges.some((u) => {
    if (u.oldFactor == null) return false;
    const oldNum = Number(u.oldFactor);
    const newNum = Number(u.newFactor);
    if (Number.isFinite(oldNum) && Number.isFinite(newNum)) {
      return Math.abs(oldNum - newNum) > 1e-6;
    }
    return String(u.oldFactor).trim() !== String(u.newFactor).trim();
  });
  if (!factorChanged) return;

  const active = await tx
    .select({ code: stocktakeSessions.code, status: stocktakeSessions.status })
    .from(stocktakeSessions)
    .innerJoin(stocktakeItems, eq(stocktakeSessions.id, stocktakeItems.sessionId))
    .where(
      and(
        eq(stocktakeItems.variantId, variantId),
        inArray(stocktakeSessions.status, ["COUNTING", "REVIEW"]),
      ),
    )
    .limit(1);

  if (active.length > 0) {
    const s = active[0];
    const phase = s.status === "COUNTING" ? "مرحلة العدّ" : "مرحلة المراجعة";
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: appErrorMessage({
        what: "تعذّر تعديل معامل التحويل للوحدة",
        why: `هذا الصنف مدرج في جلسة جرد نشطة (${s.code}) في ${phase}، وتعديل المعامل أثناء الجرد يؤدي إلى تآكل أو تضارب أرصدة المستودع الفعلية عند التسوية الدفترية`,
        doThis: "أكمل اعتماد جلسة الجرد أو ألغِها أولاً قبل تغيير معاملات التحويل في الكتالوج",
      }),
    });
  }
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
      conversionFactor: u.isBaseUnit ? "1" : u.conversionFactor,
      isBaseUnit: u.isBaseUnit,
      retail,
      wholesale: priceOf("WHOLESALE"),
      government: priceOf("GOVERNMENT"),
    };
  });
}

/**
 * CATALOG-SURGICAL-20261107 — يضمن فرادة أسماء الوحدات وفئات الأسعار داخل المتغيّر الواحد.
 */
export function assertUniqueUnitNamesAndTiers(
  variantLabel: string,
  units: ReadonlyArray<{
    unitName: string;
    prices?: ReadonlyArray<{ priceTier: PriceTier; price: string }>;
  }>,
): void {
  const seenNames = new Set<string>();
  for (const u of units) {
    const rawName = u.unitName.trim();
    const normName = normalizeVariantDimension(rawName) || rawName;
    if (seenNames.has(normName)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: `المتغيّر ${variantLabel}: اسم وحدةٍ مكرّرٌ في الطلب («${rawName}»)`,
          why: "لا يجوز تعريف وحدتين بالاسم نفسه داخل المتغيّر الواحد",
          doThis: "امنح كل وحدة اسماً مميّزاً (مثل قطعة، علبة 12، كرتون) ثم أعد الحفظ",
        }),
      });
    }
    seenNames.add(normName);
    const seenTiers = new Set<string>();
    for (const p of u.prices ?? []) {
      if (seenTiers.has(p.priceTier)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: `المتغيّر ${variantLabel}: فئة السعر «${p.priceTier}» مكرّرة للوحدة «${rawName}»`,
            why: "كل وحدة تقبل سعراً واحداً فقط لكل فئة تسعير (مفرد / جملة / حكومي)",
            doThis: "أبقِ فئة سعر واحدة لكل شريحة على نفس الوحدة ثم أعد الحفظ",
          }),
        });
      }
      seenTiers.add(p.priceTier);
    }
  }
}

/**
 * CATALOG-SURGICAL-20261107 — يمنع إضافة تركيبة عادية مكرّرة بعد التطبيع (لون × قياس)،
 * مع احترام المتغيّرات البديلة (`ALTERNATIVE`) وعدم إسقاط السجلات الإرثية القائمة ما لم تُستحدَث أو تُعدَّل إليها.
 */
export function assertUniqueNormalizedVariantCombos(
  variants: ReadonlyArray<{
    id?: number;
    sku: string;
    variantKind?: string | null;
    color?: string | null;
    size?: string | null;
    isActive?: boolean | null;
  }>,
  existingById?: ReadonlyMap<
    number,
    { variantKind?: string | null; color?: string | null; size?: string | null }
  >,
): void {
  const regular = variants.filter(
    (v) => (v.variantKind ?? "VARIANT") !== "ALTERNATIVE",
  );
  if (regular.length <= 1) return;

  const seen = new Map<string, (typeof regular)[number]>();
  for (const v of regular) {
    const key = normalizedVariantComboKey(v.color, v.size);
    const first = seen.get(key);
    if (!first) {
      seen.set(key, v);
      continue;
    }
    const bothLegacyUntouched =
      existingById != null &&
      first.id != null &&
      v.id != null &&
      (() => {
        const prevFirst = existingById.get(Number(first.id));
        const prevCur = existingById.get(Number(v.id));
        if (!prevFirst || !prevCur) return false;
        return (
          (prevFirst.variantKind ?? "VARIANT") !== "ALTERNATIVE" &&
          (prevCur.variantKind ?? "VARIANT") !== "ALTERNATIVE" &&
          normalizedVariantComboKey(prevFirst.color, prevFirst.size) === key &&
          normalizedVariantComboKey(prevCur.color, prevCur.size) === key
        );
      })();
    if (bothLegacyUntouched) continue;

    const label =
      [v.color?.trim(), v.size?.trim()].filter(Boolean).join(" / ") || v.sku;
    throw new TRPCError({
      code: "CONFLICT",
      message: appErrorMessage({
        what: `التركيبة «${label}» مكرّرة داخل الصنف بعد التطبيع`,
        why: "لا يجوز تعريف متغيّرَين عاديَّين بنفس اللون والقياس (أو متغيّرَين فارغَي الأبعاد) تحت صنفٍ واحد",
        doThis: "احذف المتغيّر المكرّر أو ميّز لونه/قياسه (أو استعمل متغيّراً بديلاً باسمٍ وباركود مستقلَّين)",
      }),
    });
  }
}

/** هل المتغيّر مستخدم برصيد غير صفري أو حجز أو حركة مخزنية أو مستند مرجعي؟ (تُفحَص بعد قفل المتغيّر). */
export async function isVariantIdentityUsed(
  tx: Tx,
  variantId: number,
): Promise<boolean> {
  const [stockRow] = await tx
    .select({ id: branchStock.id })
    .from(branchStock)
    .where(and(eq(branchStock.variantId, variantId), ne(branchStock.quantity, 0)))
    .limit(1);
  if (stockRow) return true;

  const [resStock] = await tx
    .select({ variantId: reservationStock.variantId })
    .from(reservationStock)
    .where(and(eq(reservationStock.variantId, variantId), ne(reservationStock.reservedBase, 0)))
    .limit(1);
  if (resStock) return true;

  const [mov] = await tx.select({ id: inventoryMovements.id }).from(inventoryMovements).where(eq(inventoryMovements.variantId, variantId)).limit(1);
  if (mov) return true;

  const [inv] = await tx.select({ id: invoiceItems.id }).from(invoiceItems).where(eq(invoiceItems.variantId, variantId)).limit(1);
  if (inv) return true;

  const [po] = await tx.select({ id: purchaseOrderItems.id }).from(purchaseOrderItems).where(eq(purchaseOrderItems.variantId, variantId)).limit(1);
  if (po) return true;

  const [qt] = await tx.select({ id: quotationItems.id }).from(quotationItems).where(eq(quotationItems.variantId, variantId)).limit(1);
  if (qt) return true;

  const [rd] = await tx.select({ id: receptionDraftLines.id }).from(receptionDraftLines).where(eq(receptionDraftLines.variantId, variantId)).limit(1);
  if (rd) return true;

  const [woi] = await tx.select({ id: workOrderItems.id }).from(workOrderItems).where(eq(workOrderItems.variantId, variantId)).limit(1);
  if (woi) return true;

  const [wom] = await tx.select({ id: workOrderMaterials.id }).from(workOrderMaterials).where(eq(workOrderMaterials.variantId, variantId)).limit(1);
  if (wom) return true;

  const [recOut] = await tx.select({ id: productionRecipes.id }).from(productionRecipes).where(eq(productionRecipes.outputVariantId, variantId)).limit(1);
  if (recOut) return true;

  const [recIn] = await tx.select({ id: productionRecipeLines.id }).from(productionRecipeLines).where(eq(productionRecipeLines.inputVariantId, variantId)).limit(1);
  if (recIn) return true;

  const [prodLine] = await tx.select({ id: productionLines.id }).from(productionLines).where(eq(productionLines.variantId, variantId)).limit(1);
  if (prodLine) return true;

  const [bundleRef] = await tx
    .select({ id: bundleComponents.id })
    .from(bundleComponents)
    .where(or(eq(bundleComponents.bundleVariantId, variantId), eq(bundleComponents.componentVariantId, variantId)))
    .limit(1);
  if (bundleRef) return true;

  const [invBundle] = await tx.select({ id: invoiceItemBundleComponents.id }).from(invoiceItemBundleComponents).where(eq(invoiceItemBundleComponents.componentVariantId, variantId)).limit(1);
  if (invBundle) return true;

  const [online] = await tx.select({ id: onlineOrderItems.id }).from(onlineOrderItems).where(eq(onlineOrderItems.variantId, variantId)).limit(1);
  if (online) return true;

  const [stk] = await tx.select({ id: stocktakeItems.id }).from(stocktakeItems).where(eq(stocktakeItems.variantId, variantId)).limit(1);
  if (stk) return true;

  const [exp] = await tx.select({ id: expenseStockItems.id }).from(expenseStockItems).where(eq(expenseStockItems.variantId, variantId)).limit(1);
  if (exp) return true;

  const [gift] = await tx.select({ id: giftVoucherLines.id }).from(giftVoucherLines).where(eq(giftVoucherLines.variantId, variantId)).limit(1);
  if (gift) return true;

  const [resLine] = await tx.select({ id: reservationLines.id }).from(reservationLines).where(eq(reservationLines.variantId, variantId)).limit(1);
  if (resLine) return true;

  return false;
}

/** يرفض تغيير الهوية الفعلية لمتغيّرٍ مستخدم (النوع أو تركيبة اللون/القياس أو اسم البديل). */
export async function assertVariantIdentityImmutableIfUsed(
  tx: Tx,
  variantId: number,
  prev: { variantKind?: string | null; color?: string | null; size?: string | null; variantName?: string | null },
  next: { variantKind?: string | null; color?: string | null; size?: string | null; variantName?: string | null },
  label: string,
  options?: { allowClearingSoleRegularVariantDimensions?: boolean },
): Promise<void> {
  const prevKind = prev.variantKind === "ALTERNATIVE" ? "ALTERNATIVE" : "VARIANT";
  const nextKind = next.variantKind === "ALTERNATIVE" ? "ALTERNATIVE" : "VARIANT";
  if (
    options?.allowClearingSoleRegularVariantDimensions &&
    prevKind === "VARIANT" &&
    nextKind === "VARIANT" &&
    !next.color &&
    !next.size
  ) {
    return;
  }
  const identityChanged =
    prevKind !== nextKind ||
    (nextKind === "VARIANT" &&
      normalizedVariantComboKey(prev.color, prev.size) !==
        normalizedVariantComboKey(next.color, next.size)) ||
    (nextKind === "ALTERNATIVE" &&
      normalizeVariantDimension(prev.variantName) !==
        normalizeVariantDimension(next.variantName));
  if (!identityChanged) return;

  if (await isVariantIdentityUsed(tx, variantId)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: `لا يمكن تغيير هوية المتغيّر «${label}» بعد استخدامه`,
        why: "هذا المتغيّر مرتبط برصيد أو حركة مخزنية أو مستندات مسجّلة، وتعديل لونه أو قياسه أو نوعه في مكانه يغيّر معنى الأرصدة والسجلّات السابقة",
        doThis: "عطّل المتغيّر الحالي مع الإبقاء على هويته، وأضف التركيبة الجديدة كمتغيّر مستقلّ بمعرّف ورصيد جديدين",
      }),
    });
  }
}

/** هل وحدة القياس مشارٌ إليها في فواتير/مشتريات/حجوزات/عروض/وصفات/بكجات أو طلب متجر غير ملغى؟ */
export async function isUnitIdentityUsed(
  tx: Tx,
  unitId: number,
): Promise<boolean> {
  const [inv] = await tx.select({ id: invoiceItems.id }).from(invoiceItems).where(eq(invoiceItems.productUnitId, unitId)).limit(1);
  if (inv) return true;

  const [po] = await tx.select({ id: purchaseOrderItems.id }).from(purchaseOrderItems).where(eq(purchaseOrderItems.productUnitId, unitId)).limit(1);
  if (po) return true;

  const [qt] = await tx.select({ id: quotationItems.id }).from(quotationItems).where(eq(quotationItems.productUnitId, unitId)).limit(1);
  if (qt) return true;

  const [rd] = await tx.select({ id: receptionDraftLines.id }).from(receptionDraftLines).where(eq(receptionDraftLines.productUnitId, unitId)).limit(1);
  if (rd) return true;

  const [woi] = await tx.select({ id: workOrderItems.id }).from(workOrderItems).where(eq(workOrderItems.productUnitId, unitId)).limit(1);
  if (woi) return true;

  const [rec] = await tx.select({ id: productionRecipes.id }).from(productionRecipes).where(eq(productionRecipes.outputProductUnitId, unitId)).limit(1);
  if (rec) return true;

  const [prod] = await tx.select({ id: productionLines.id }).from(productionLines).where(eq(productionLines.productUnitId, unitId)).limit(1);
  if (prod) return true;

  const [bc] = await tx.select({ id: bundleComponents.id }).from(bundleComponents).where(eq(bundleComponents.componentUnitId, unitId)).limit(1);
  if (bc) return true;

  const [ccp] = await tx.select({ id: customerContractPrices.id }).from(customerContractPrices).where(eq(customerContractPrices.productUnitId, unitId)).limit(1);
  if (ccp) return true;

  const [exp] = await tx.select({ id: expenseStockItems.id }).from(expenseStockItems).where(eq(expenseStockItems.productUnitId, unitId)).limit(1);
  if (exp) return true;

  const [gift] = await tx.select({ id: giftVoucherLines.id }).from(giftVoucherLines).where(eq(giftVoucherLines.productUnitId, unitId)).limit(1);
  if (gift) return true;

  const [resLine] = await tx.select({ id: reservationLines.id }).from(reservationLines).where(eq(reservationLines.productUnitId, unitId)).limit(1);
  if (resLine) return true;

  const [online] = await tx
    .select({ id: onlineOrderItems.id })
    .from(onlineOrderItems)
    .innerJoin(onlineOrders, eq(onlineOrderItems.onlineOrderId, onlineOrders.id))
    .where(and(eq(onlineOrderItems.productUnitId, unitId), ne(onlineOrders.status, "CANCELLED")))
    .limit(1);
  if (online) return true;

  return false;
}

/** يرفض تعديل معامل تحويل وحدة مستخدمة في مستندات أو التزامات غير ملغاة. */
export async function assertUnitFactorImmutableIfUsed(
  tx: Tx,
  unitId: number,
  oldFactor: string | number,
  newFactor: string | number,
  unitName: string,
): Promise<void> {
  const same = (() => {
    try {
      return new Decimal(oldFactor).eq(new Decimal(newFactor));
    } catch {
      return String(oldFactor).trim() === String(newFactor).trim();
    }
  })();
  if (same) return;

  if (await isUnitIdentityUsed(tx, unitId)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: `لا يمكن تعديل معامل التحويل للوحدة «${unitName}» بعد استخدامها`,
        why: "هذه الوحدة مرجعية في فواتير أو أوامر شراء أو حجوزات أو وصفات أو طلبات غير ملغاة، وتغيير معاملها يحرّف تفسير الكميات المسجّلة",
        doThis: "أبقِ المعامل الحالي للوحدة القائمة وأضف عبوة جديدة باسم ومعامل مستقلَّين عند الحاجة",
      }),
    });
  }
}

/**
 * CATALOG-SURGICAL-20261107 — بوّابة النشر الصريح على المتجر الإلكتروني:
 * تشترط صلاحية إدارة المتجر (عند تمرير دور الفاعل) + جاهزية الصنف والفئة والوحدة وسعر المفرد.
 */
export async function assertStorefrontPublishReadyTx(
  tx: Tx,
  args: {
    actor?: { role?: string; isOwner?: boolean; permissionsOverride?: PermissionMap | null };
    requirePermission?: boolean;
    previouslyPublished?: { showInStore: boolean; categoryId: number | null };
    isActive: boolean;
    isService: boolean;
    stockUsage: StockUsage | null | undefined;
    categoryId: number | null | undefined;
    variants: ReadonlyArray<{
      isActive: boolean;
      units: ReadonlyArray<{
        isActive: boolean;
        isStoreSaleUnit: boolean;
        conversionFactor: string | number;
        retailPrice: string | null | undefined;
      }>;
    }>;
  },
): Promise<void> {
  const wasAlreadyPublished = args.previouslyPublished?.showInStore === true;
  if (args.requirePermission && !wasAlreadyPublished && args.actor?.role) {
    const allowed =
      args.actor.isOwner === true ||
      args.actor.role === "admin" ||
      moduleAccessAllowed(
        args.actor.role,
        args.actor.permissionsOverride ?? null,
        "store",
        "FULL",
        ["manager"],
      );
    if (!allowed) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: appErrorMessage({
          what: "لا تملك صلاحية نشر الأصناف في المتجر الإلكتروني",
          why: "النشر العلني في المتجر يتطلّب صلاحية إدارة المتجر الكاملة",
          doThis: "احفظ الصنف مخفياً عن المتجر ثم اطلب من مسؤول المتجر مراجعته ونشره",
        }),
      });
    }
  }

  if (!args.isActive) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "لا يمكن نشر صنف معطّل في المتجر",
        why: "الصنف غير نشط حالياً فلا يُعرض لزبائن المتجر",
        doThis: "فعّل الصنف أولاً ثم انشره في المتجر",
      }),
    });
  }
  if (args.isService || !isSellableStockUsage(args.stockUsage)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "هذا الصنف غير مؤهّل للنشر في المتجر الإلكتروني",
        why: args.isService
          ? "الخدمات الفورية لا تُنشر كسلع مخزنية في المتجر"
          : "تصنيف استخدام الصنف (مادة خام أو مستلزم تشغيل) يمنع بيعه في المتجر",
        doThis: "أبقِ الصنف مخفياً عن المتجر أو غيّر استخدامه إلى «للبيع» إن كان سلعة مبيعة",
      }),
    });
  }
  const legacyUncategorizedGrandfathered =
    wasAlreadyPublished && args.previouslyPublished?.categoryId == null && args.categoryId == null;
  if (!legacyUncategorizedGrandfathered) {
    if (args.categoryId == null) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "لا يمكن نشر الصنف في المتجر بدون فئة نشطة وظاهرة",
          why: "النشر العلني في المتجر يشترط تحديد فئة نشطة ومسموح عرضها في المتجر",
          doThis: "اختر فئة نشطة ظاهرة في المتجر للصنف ثم أعد النشر",
        }),
      });
    }
    const unchangedLegacyCategory =
      wasAlreadyPublished && args.previouslyPublished?.categoryId === args.categoryId;
    if (!unchangedLegacyCategory) {
      const [cat] = await tx
        .select({ id: categories.id, isActive: categories.isActive, showInStore: categories.showInStore })
        .from(categories)
        .where(eq(categories.id, args.categoryId))
        .limit(1);
      if (!cat || !cat.isActive || !cat.showInStore) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "فئة الصنف مخفية أو معطّلة في المتجر",
            why: "لا يمكن نشر صنف ينتمي إلى فئة غير مفعّلة أو مخفية عن واجهة المتجر",
            doThis: "فعّل إظهار الفئة في المتجر أو انقل الصنف إلى فئة منشورة ثم أعد المحاولة",
          }),
        });
      }
    }
  }

  const activeVariants = args.variants.filter((v) => v.isActive);
  if (!activeVariants.length) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "لا يوجد متغيّر نشط للنشر في المتجر",
        why: "جميع متغيّرات الصنف معطّلة حالياً",
        doThis: "فعّل متغيّراً واحداً على الأقل ثم انشر الصنف",
      }),
    });
  }

  if (!wasAlreadyPublished) {
    const hasReadyStoreUnit = activeVariants.some((v) =>
      v.units.some((u) => {
        if (!u.isActive || !u.isStoreSaleUnit) return false;
        const priceRaw = (u.retailPrice ?? "").trim();
        if (!priceRaw) return false;
        try {
          const factor = new Decimal(u.conversionFactor);
          const retail = new Decimal(priceRaw);
          return factor.isInteger() && factor.gte(1) && retail.gt(0);
        } catch {
          return false;
        }
      }),
    );
    if (!hasReadyStoreUnit) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "الصنف يفتقر إلى وحدة بيع متجر بسعر مفرد صالح",
          why: "النشر في المتجر يشترط وجود وحدة مفعّلة للبيع في المتجر بسعر مفرد أكبر من صفر",
          doThis: "فعّل خيار «وحدة بيع بالمتجر» وأدخل سعر المفرد للوحدة ثم أعد النشر",
        }),
      });
    }
  }
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
