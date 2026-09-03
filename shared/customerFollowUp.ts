/**
 * customerFollowUp — مفردات **متابعة العميل** (تحصيلٌ ووعدُ دفع): وسيلةُ المتابعة ونتيجتُها.
 *
 * المفهوم: الموظّف يسجّل ما جرى مع عميلٍ مدين (اتّصالٌ/رسالةٌ/زيارة) ونتيجتَه (تواصلَ/وعدَ/
 * اعترضَ/أفاد بأنّه دفع)، فتُحفَظ ملاحظةً في سجلّ العميل مع مهمّة متابعةٍ اختياريّة.
 *
 * لماذا وُجد الملفّ (موجة D6، ٢/٩/٢٦): القاموسان كانا داخل
 * `client/src/components/customers/CustomerFollowUpDialog.tsx` وحدَه. القيمُ **ليست عموداً في
 * القاعدة**: الحوار يركّب منها نصّ الملاحظة المحفوظة، ولذلك هي **عقدُ قراءةٍ** لكلّ من سيقرأ
 * تلك الملاحظات لاحقاً (تقريرُ تحصيلٍ أو تصنيفُ نتائج المتابعة). تركُها داخل مكوّنٍ يجعل أيّ
 * قارئٍ ثانٍ يخترع تصنيفاً موازياً — والملاحظات المكتوبة بالتصنيف الأوّل تصير غير قابلة للعدّ.
 *
 * ⛔ لا شاشة تُعيد تعريف أيٍّ من القاموسَين محلّياً — يحرسه `localizationDictionaries.test.ts`.
 *
 * ⛔ بلا تشكيل في التسميات (حارس `check:tashkeel`).
 */

/* ══════════════════════ ١) وسيلة المتابعة ══════════════════════ */

export const CUSTOMER_FOLLOW_UP_KINDS = [
  "CALL",
  /** تسجيلُ وعدِ دفعٍ صريح — يقترن عادةً بتاريخٍ ومبلغ. */
  "PROMISE",
  "MESSAGE",
  "VISIT",
  /** ملاحظةٌ بلا تواصل (توثيقٌ داخليّ). */
  "NOTE",
] as const;

export type CustomerFollowUpKind = (typeof CUSTOMER_FOLLOW_UP_KINDS)[number];

export const CUSTOMER_FOLLOW_UP_KIND_LABEL: Readonly<Record<CustomerFollowUpKind, string>> =
  Object.freeze({
    CALL: "مكالمة",
    PROMISE: "وعد دفع",
    MESSAGE: "رسالة",
    VISIT: "زيارة",
    NOTE: "ملاحظة",
  });

export function isCustomerFollowUpKind(v: unknown): v is CustomerFollowUpKind {
  return typeof v === "string" && (CUSTOMER_FOLLOW_UP_KINDS as readonly string[]).includes(v);
}

/* ══════════════════════ ٢) نتيجة المتابعة ══════════════════════ */

/**
 * ⚠️ النتيجةُ **إفادةُ موظّفٍ لا واقعةٌ ماليّة**: `PAID` تعني «قال إنّه دفع» لا «سُجّل قبض».
 * القبضُ مسارُه سندٌ بإيصال — أيُّ قارئٍ يعامل هذه القيمة تحصيلاً يُنقص ذمّةً بلا دينارٍ داخل.
 */
export const CUSTOMER_FOLLOW_UP_OUTCOMES = [
  "REACHED",
  "NO_ANSWER",
  "PROMISED",
  "DISPUTED",
  "PAID",
  "OTHER",
] as const;

export type CustomerFollowUpOutcome = (typeof CUSTOMER_FOLLOW_UP_OUTCOMES)[number];

export const CUSTOMER_FOLLOW_UP_OUTCOME_LABEL: Readonly<
  Record<CustomerFollowUpOutcome, string>
> = Object.freeze({
  REACHED: "تم التواصل",
  NO_ANSWER: "لا إجابة",
  PROMISED: "وعد بالدفع",
  DISPUTED: "اعتراض/نزاع",
  PAID: "أفاد بأنه دفع",
  OTHER: "نتيجة أخرى",
});

export function isCustomerFollowUpOutcome(v: unknown): v is CustomerFollowUpOutcome {
  return typeof v === "string" && (CUSTOMER_FOLLOW_UP_OUTCOMES as readonly string[]).includes(v);
}
