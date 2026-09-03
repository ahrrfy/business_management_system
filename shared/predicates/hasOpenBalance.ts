/**
 * hasOpenBalance — «هل لهذا الطرف رصيدٌ مفتوح؟»
 *
 * **مصدر الحقيقة الوحيد** لسؤالٍ يتكرّر بلا اتّفاقٍ على معناه في ≥١٥ موضعاً (D2 في مقياس الاحتكاك، §٤).
 *
 * ⚠️ **الحقلُ يحمل إشارة، والإشارةُ تُفسَّر بحسب نوع الطرف** (Codex #961):
 *   · **العميل / جهة التوصيل**: `currentBalance` موجبٌ = **مدينٌ لنا** (AR receivable)،
 *     سالبٌ = **دائنٌ علينا** (دفع زيادةً أو له عربونٌ).
 *   · **المورّد**: العكسُ حرفياً — موجبٌ = **نحن ندين له** (AP payable، مرآةُ
 *     `supplierOperationsService.ts:92-93`)، سالبٌ = دائنُنا هو (دفعنا زيادةً).
 *
 * ⇒ «رصيدٌ مفتوح» بلا نوعٍ = «غير صفريّ في أيّ اتّجاه» — الصفر وحده هو «مُصفَّى»، والاتّجاه
 * الاسميّ (`receivable`/`payable`) **يتطلّب نوعَ الطرف** كي لا نُبلِّغ مورّداً بأنّه علينا AR.
 *
 * **لماذا Decimal.js لا `Number`:** الرصيد نصٌّ من عمود `decimal(15,2)`؛ `Number("0.00")==0` صحيح
 * لكنّ `Number("0.001")==0` بحسب دقّة الـfloat يُخفي مالاً حقيقياً. اقرأ [[feedback-smart-simple-high-value]]:
 * «كلّ المال عبر Decimal + money.ts» (§٥). المسند هنا **لا يستورد** من `server/services/money.ts` كي يبقى
 * صالحاً للعميل — يُنشئ `Decimal` بنفسه من نصٍّ آمن.
 *
 * **الاستعمال المتوقَّع** (يوصَل في شرائح لاحقة تحت `check:vocabulary` بعد أن يُبنى):
 *   - قوائم العملاء/المورّدين/جهات التوصيل (شارة «مفتوح»/«مصفَّى»).
 *   - بوّاباتُ الحذف: **`readBalanceStrict`** بدلاً من `hasOpenBalance` — يرمي `INDETERMINATE`
 *     على حقلٍ غير مقروء بدل معاملته «مُصفَّى» فيسمح بحذف طرفٍ رصيدُه فاسدٌ (Codex #961).
 *   - كواشف الجرد الشهريّ (تجميع الأطراف المفتوحة).
 *
 * **لا يوصَل في هذه الشريحة** — الاستخراج **إضافةٌ لا هدم** (م٥). التغيير لاحق.
 */

import Decimal from "decimal.js";

/** الشكل المشترك الذي يظهر به الرصيد في كلّ الجداول (customers · suppliers · deliveryParties). */
export type EntityWithBalance = {
  currentBalance: string | number | null | undefined;
};

/** نصٌّ أو رقمٌ يمثّل مالاً — يُقبل من قاعدةٍ أو من حساب. */
export type BalanceInput = string | number | Decimal | null | undefined;

/** نوعُ الطرف — يحدّد كيف تُفسَّر إشارةُ الرصيد إلى `receivable`/`payable`. */
export type BalancePartyKind = "customer" | "supplier" | "deliveryParty";

/**
 * تحويلٌ آمنٌ إلى `Decimal` بلا رمي: `null`/`undefined`/`""`/غير رقميّ ⇒ صفر.
 * **لا يرمي**: مسند القراءة يجب ألّا يُسقط شاشةً بسبب حقلٍ غائبٍ في صفٍّ قديم.
 *
 * ⚠️ Codex #961: هذا التغاضي مقبولٌ في العرض (شارة/فلتر)، لكنّه **غير مقبولٍ لبوّابات الحذف**.
 * استعمل `readBalanceStrict` هناك — يرمي `INDETERMINATE` على حقلٍ غير مقروء.
 */
function toDecimalSafe(v: BalanceInput): Decimal {
  if (v === null || v === undefined || v === "") return new Decimal(0);
  try {
    const d = v instanceof Decimal ? v : new Decimal(v);
    return d.isFinite() ? d : new Decimal(0);
  } catch {
    return new Decimal(0);
  }
}

/**
 * ⭐ **المسند الحاكم للعرض/الفلتر**: هل هذا الطرف يحمل رصيداً مفتوحاً (غير صفريّ في أيّ اتّجاه)؟
 *
 * ⛔ **لا تستعمله لبوّابات الحذف** — استعمل `readBalanceStrict` هناك. رصيدٌ فاسدٌ يُترجَم صفراً
 * هنا فيسمح للطرف بالحذف بينما مالُه حقيقيّ (Codex #961).
 *
 * @example
 *   hasOpenBalance({ currentBalance: "0.00" })    // false — مُصفَّى
 *   hasOpenBalance({ currentBalance: "1250.50" }) // true  — غير صفريّ (اتّجاهه بحسب النوع)
 *   hasOpenBalance({ currentBalance: "-300.00" }) // true  — غير صفريّ
 *   hasOpenBalance(null)                          // false — لا طرف ⇒ لا رصيد
 *   hasOpenBalance({ currentBalance: null })      // false — قاعدةٌ لم تُدخِل بعد
 */
export function hasOpenBalance(entity: EntityWithBalance | null | undefined): boolean {
  if (!entity) return false;
  return !toDecimalSafe(entity.currentBalance).isZero();
}

/**
 * Codex #961: قراءةٌ **صارمة** للرصيد — تُستعمَل حصراً في بوّاباتٍ حسّاسة (الحذف، تسوية
 * نهاية الخدمة، الأرشفة). ترمي `INDETERMINATE` على حقلٍ غير قابلٍ للقراءة بدل ترجمته صفراً.
 * لا معنى لـ«لا رصيد مفتوح» على طرفٍ رصيدُه فاسدٌ في القاعدة — الجوابُ الصحيح **لا أعلم**،
 * والبوّابةُ حينها تطلبُ إصلاحَ الرصيد لا تُرخّص الحذف.
 */
export class IndeterminateBalanceError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "IndeterminateBalanceError";
  }
}

export function readBalanceStrict(entity: EntityWithBalance | null | undefined): Decimal {
  if (!entity) throw new IndeterminateBalanceError("لا طرف — لا يمكن قراءةُ رصيده");
  const v = entity.currentBalance;
  if (v === null || v === undefined || v === "") {
    throw new IndeterminateBalanceError(
      "الرصيدُ غير مقروء (فارغٌ/غائب) — أصلحه في القاعدة قبل الاستمرار",
    );
  }
  let d: Decimal;
  try {
    // النوعُ من `EntityWithBalance.currentBalance` = `string|number|null|undefined`؛ لا Decimal.
    // نمرّره مباشرةً كي لا يُعقّد كودَ الاستدعاء `readBalanceStrict(...)` بلا فائدة.
    d = new Decimal(v);
  } catch {
    throw new IndeterminateBalanceError(`الرصيدُ غير رقميّ (${String(v)}) — أصلحه قبل الاستمرار`);
  }
  if (!d.isFinite()) {
    throw new IndeterminateBalanceError(`الرصيدُ غير منتهٍ (${String(v)}) — أصلحه قبل الاستمرار`);
  }
  return d;
}

/** نظير `hasOpenBalance` لكن يرمي بدل الابتلاع — لبوّابات الحذف. */
export function hasOpenBalanceStrict(entity: EntityWithBalance | null | undefined): boolean {
  return !readBalanceStrict(entity).isZero();
}

/**
 * ⭐ **اتّجاه** الرصيد المفتوح — للاستهلاك بعد `hasOpenBalance`، لا بدلاً منه.
 *
 * Codex #961: **يتطلّب نوعَ الطرف** لأنّ إشارةَ الرصيد **تُقلَب في المورّد**. النسخةُ السابقة
 * كانت تُبلّغ مورّداً برصيدٍ موجبٍ بأنّه «receivable» — وهو قلبُ الحقيقة (مورّدٌ موجبُ الرصيد
 * = **نحن ندين له** = payable). المنطقُ هنا يعكس الإشارةَ للمورّد صراحةً.
 */
export function balanceDirection(
  entity: EntityWithBalance | null | undefined,
  kind: BalancePartyKind,
): "receivable" | "payable" | "zero" {
  if (!entity) return "zero";
  const d = toDecimalSafe(entity.currentBalance);
  if (d.isZero()) return "zero";
  // على العميل وجهة التوصيل: موجب ⇒ AR (مدينٌ لنا) · سالب ⇒ AP (له عندنا).
  // على المورّد: موجب ⇒ AP (نحن ندين له) · سالب ⇒ AR (دفعنا زيادةً).
  const positiveMeans: "receivable" | "payable" = kind === "supplier" ? "payable" : "receivable";
  const negativeMeans: "receivable" | "payable" = kind === "supplier" ? "receivable" : "payable";
  return d.isPositive() ? positiveMeans : negativeMeans;
}
