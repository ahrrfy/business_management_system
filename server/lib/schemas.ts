import { z } from "zod";
import { MAX_PRICE_DECIMALS } from "../../shared/moneyPrecision";
import { canonicalizeBarcodeInput, hasUnsupportedBarcodeCharacters } from "../../shared/barcodeNormalize";

/** سلسلة مالية بـ٢ خانات عشرية على الأكثر، تَقبل السالب (للمرتجعات/التعديلات).
 *  متّسق مع toDbMoney(string) في server/services/money.ts.
 */
export const moneyString = z
  .string()
  .regex(/^-?\d+(\.\d{1,2})?$/, "مبلغ بصيغة غير صالحة");

/** سلسلة مالية موجبة فقط (> 0)، بـ٢ خانات عشرية. للدفعات/الفواتير الإيجابية.
 *  يَرفض الصفر و السالب (الصفر = «بلا دفعة» يَستخدم تدفّقاً مختلفاً).
 *  (§٥: بلا parseFloat على المال — نَكتفي بفحص وجود رقم غير صفري، والـregex يَمنع السالب أصلاً.)
 */
export const positiveMoneyString = z
  .string()
  .regex(/^\d+(\.\d{1,2})?$/, "مبلغ موجب فقط")
  .refine((s) => /[1-9]/.test(s), "مبلغ موجب صفر غير مسموح");

/** سلسلة مالية غير سالبة (≥ 0)، بـ٢ خانات عشرية. للأسعار/الخصومات التي تَقبل الصفر
 *  (سعر شراء/مرتجع، override). الـregex يَمنع السالب؛ الصفر مسموح. */
export const positiveRateString = z
  .string()
  .regex(/^\d+(\.\d{1,4})?$/, "سعر صرف موجب غير صالح")
  .refine((s) => /[1-9]/.test(s), "سعر الصرف يجب أن يكون موجباً");

export const nonNegMoneyString = z
  .string()
  .regex(/^\d+(\.\d{1,2})?$/, "مبلغ غير صالح (غير سالب، منزلتان كحدّ أقصى)");

/**
 * **سعر وحدة بعملة المستند** — غير سالب، حتى `MAX_PRICE_DECIMALS` (٤) منزلة.
 *
 * لماذا أوسع من `nonNegMoneyString`: سعر الوحدة بالدولار يُشتقّ عادةً بالقسمة (سعر الكرتون ÷ عدد
 * القطع = 3.4566) والعمود `purchaseOrderItems.usdUnitPrice` مُعرَّف `decimal(15,4)` أصلاً؛ فقصُّه
 * لمنزلتين على حدّ الـAPI كان يرمي دقّةً تحفظها قاعدةُ البيانات، ويُنقص ذمّة المورّد بحجم الكمية.
 *
 * ⚠️ هذا **سقفٌ أعلى** لا إذنٌ مفتوح: العملة تُضيّقه داخل الخدمة (الدينار منزلتان) عبر
 * `isWithinPriceDecimals` — لأنّ العملة تُعرَف على مستوى المستند لا على مستوى الحقل. لا تستعمله
 * لمبالغ الفواتير/الدفعات (تلك أعمدة `decimal(15,2)` ⇒ `nonNegMoneyString`/`positiveMoneyString`).
 */
export const unitPriceString = z
  .string()
  .regex(
    new RegExp(`^\\d+(\\.\\d{1,${MAX_PRICE_DECIMALS}})?$`),
    `سعر غير صالح (غير سالب، ${MAX_PRICE_DECIMALS} منازل كحدّ أقصى)`,
  );

/** كمية موجبة (> 0)، بـ٣ منازل عشرية كحدّ أقصى. */
export const positiveQtyString = z
  .string()
  .regex(/^\d+(\.\d{1,3})?$/, "كمية غير صالحة (موجبة، ٣ منازل)")
  .refine((s) => /[1-9]/.test(s), "الكمية يجب أن تكون موجبة");

/** نسبة مئوية في [٠، ١٠٠]، بـ٢ منازل. للضريبة/الخصم النسبي (نسبة لا مال ⇒ مقارنة عددية مقبولة). */
export const percentString = z
  .string()
  .regex(/^\d+(\.\d{1,2})?$/, "نسبة غير صالحة")
  .refine((s) => Number(s) <= 100, "النسبة يجب ألّا تتجاوز ١٠٠٪");

/** سلسلة مالية موقَّعة (تَقبل السالب للمرتجعات). مرادف لـmoneyString — للوضوح الدلالي. */
export const signedMoneyString = moneyString;

/**
 * حقل باركود إلزاميّ — يُطبَّع على حدّ الـAPI (تقليم + طيّ الأرقام العربية-الهندية) قبل أن يبلغ الخدمة.
 *
 * لماذا هنا لا في الشاشة: مخطّطات الحفظ كانت `z.string()` عاريةً بلا `.trim()`، فأيّ مسافةٍ طرفية
 * تُحفَظ حرفياً في `productUnits.barcode`، بينما المسح يُقارن بمساواةٍ SQL خامّة ⇒ الباركود يُحفَظ
 * ويمرّ فحصَ التفرّد (الذي كان يقلّم للفحص وحده) ثمّ لا يُمسَح أبداً. المصدر: `canonicalizeBarcodeInput`.
 */
export const barcodeString = z
  .string()
  .transform(canonicalizeBarcodeInput)
  .refine((s) => s.length > 0, "الباركود فارغ")
  .refine((s) => s.length <= 64, "الباركود أطول من ٦٤ خانة")
  .refine((s) => !hasUnsupportedBarcodeCharacters(s), "الباركود يحوي محارف تحكّم أو فراغات غير مدعومة");

/** حقل باركود اختياريّ (وحدةٌ قد تُنشأ بلا باركود ويُضاف لاحقاً) — نفس التطبيع؛ الفارغ بعده ⇒ `null`. */
export const optionalBarcodeString = z
  .string()
  .nullish()
  .transform((s) => (s == null ? null : canonicalizeBarcodeInput(s) || null))
  .refine((s) => s == null || s.length <= 64, "الباركود أطول من ٦٤ خانة")
  .refine((s) => s == null || !hasUnsupportedBarcodeCharacters(s), "الباركود يحوي محارف تحكّم أو فراغات غير مدعومة");

/** تاريخ بصيغة YYYY-MM-DD (متّسق مع toDateStr() في money.ts و dueDate في invoices). */
export const ymdDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "تاريخ بصيغة YYYY-MM-DD");
