/**
 * hasOpenBalance — «هل لهذا الطرف رصيدٌ مفتوح؟»
 *
 * **مصدر الحقيقة الوحيد** لسؤالٍ يتكرّر بلا اتّفاقٍ على معناه في ≥١٥ موضعاً (D2 في مقياس الاحتكاك، §٤).
 *
 * ⚠️ **الحقلُ يحمل إشارة**: `currentBalance` **موجبٌ = مدينٌ لنا** (AR على العميل، أو على جهة التوصيل)،
 * و**سالبٌ = دائنٌ علينا** (له عندنا مالٌ إمّا لأنّه دفع زيادةً أو أنّه مورّدٌ لم نسدّده). ⇒ «رصيدٌ مفتوح» =
 * **غير صفريّ في أيّ اتّجاه**: الصفر وحده هو «مُصفَّى». الاتّجاه يُقاس بمسندٍ منفصل عند الحاجة.
 *
 * **لماذا Decimal.js لا `Number`:** الرصيد نصٌّ من عمود `decimal(15,2)`؛ `Number("0.00")==0` صحيح
 * لكنّ `Number("0.001")==0` بحسب دقّة الـfloat يُخفي مالاً حقيقياً. اقرأ [[feedback-smart-simple-high-value]]:
 * «كلّ المال عبر Decimal + money.ts» (§٥). المسند هنا **لا يستورد** من `server/services/money.ts` كي يبقى
 * صالحاً للعميل — يُنشئ `Decimal` بنفسه من نصٍّ آمن.
 *
 * **الاستعمال المتوقَّع** (يوصَل في شرائح لاحقة تحت `check:vocabulary` بعد أن يُبنى):
 *   - قوائم العملاء/المورّدين/جهات التوصيل (شارة «مفتوح»/«مصفَّى»).
 *   - بوّاباتُ الحذف: «لا يُحذف طرفٌ رصيدُه مفتوح» (SoD ماليّ).
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

/**
 * تحويلٌ آمنٌ إلى `Decimal` بلا رمي: `null`/`undefined`/`""`/غير رقميّ ⇒ صفر.
 * **لا يرمي**: مسند القراءة يجب ألّا يُسقط شاشةً بسبب حقلٍ غائبٍ في صفٍّ قديم.
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
 * ⭐ **المسند الحاكم**: هل هذا الطرف يحمل رصيداً مفتوحاً (غير صفريّ في أيّ اتّجاه)؟
 *
 * @example
 *   hasOpenBalance({ currentBalance: "0.00" })    // false — مُصفَّى
 *   hasOpenBalance({ currentBalance: "1250.50" }) // true  — مدينٌ لنا (AR)
 *   hasOpenBalance({ currentBalance: "-300.00" }) // true  — دائنٌ (دفع زيادةً/مورّد)
 *   hasOpenBalance(null)                          // false — لا طرف ⇒ لا رصيد
 *   hasOpenBalance({ currentBalance: null })      // false — قاعدةٌ لم تُدخِل بعد
 */
export function hasOpenBalance(entity: EntityWithBalance | null | undefined): boolean {
  if (!entity) return false;
  return !toDecimalSafe(entity.currentBalance).isZero();
}

/** **اتّجاه** الرصيد المفتوح — للاستهلاك بعد `hasOpenBalance`، لا بدلاً منه. */
export function balanceDirection(entity: EntityWithBalance | null | undefined): "receivable" | "payable" | "zero" {
  if (!entity) return "zero";
  const d = toDecimalSafe(entity.currentBalance);
  if (d.isZero()) return "zero";
  return d.isPositive() ? "receivable" : "payable";
}
