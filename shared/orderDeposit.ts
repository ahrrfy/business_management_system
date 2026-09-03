/**
 * orderDeposit — مفردات **عربون الطلب المحفوظ** (`orderPayments`): نوعُ الصفّ وحالةُ الاحتجاز.
 *
 * المفهوم: مالٌ يدخل **قبل** وجود فاتورة (عربونٌ على مسوّدة طلبٍ في الاستقبال). الجدولُ
 * ثلاثةُ أنواع صفوف — قبضٌ محتجَز، تخصيصٌ لمستندٍ عند التثبيت، وردٌّ مربوطٌ بأمّه — والمبلغُ
 * موجبٌ دائماً والاتّجاهُ من `kind` ([drizzle/schema.ts] `orderPayments`).
 *
 * لماذا وُجد الملفّ (موجة D6، ٢/٩/٢٦): القاموسان كانا داخل مكوّنٍ واحد
 * (`client/src/components/reception/DraftPaymentsDialog.tsx`) ولا يحرسهما اختبار، بينما
 * العمودان `orderPayKind` و`orderPayStatus` تعدادان صارمان في القاعدة.
 *
 * ⛔ **طريقةُ الدفع ليست هنا:** العمود `orderPayMethod` مفهومٌ ثالثٌ له مصدرُه الموحَّد
 *    `shared/terms.ts` (`paymentMethodCompact`) — إعادةُ تعريفه هنا تُنتج القاموسَ الخامس عشر
 *    لطريقة الدفع (الجرد في `terms.ts`: أربعةَ عشرَ في `client/**` وحدها).
 *
 * ⛔ بلا تشكيل في التسميات (حارس `check:tashkeel`) — الحوار يعرضها بحجم `text-xs`.
 */

/* ══════════════════════ ١) نوع صفّ العربون ══════════════════════ */

export const ORDER_DEPOSIT_KINDS = [
  /** قبضٌ محتجَز على المسوّدة — لم يُخصَّص لمستندٍ بعد. */
  "COLLECTION",
  /** تخصيصُ قبضٍ سابقٍ لفاتورةٍ أو أمرِ شغلٍ عند التثبيت. */
  "APPLICATION",
  /** ردٌّ لجزءٍ من قبضٍ أو كلِّه — مربوطٌ بأمّه عبر `parentPaymentId`. */
  "REFUND",
] as const;

export type OrderDepositKind = (typeof ORDER_DEPOSIT_KINDS)[number];

export const ORDER_DEPOSIT_KIND_LABEL: Readonly<Record<OrderDepositKind, string>> = Object.freeze({
  COLLECTION: "قبض عربون",
  APPLICATION: "مطبق على مستند",
  REFUND: "رد",
});

export function isOrderDepositKind(v: unknown): v is OrderDepositKind {
  return typeof v === "string" && (ORDER_DEPOSIT_KINDS as readonly string[]).includes(v);
}

/** المجهول يُعرَض خامّاً — مطابقٌ للسلوك السابق (`KIND_AR[k] ?? k`). */
export function orderDepositKindLabel(kind: string | null | undefined): string {
  if (!kind) return "—";
  return isOrderDepositKind(kind) ? ORDER_DEPOSIT_KIND_LABEL[kind] : kind;
}

/* ══════════════════════ ٢) حالة الاحتجاز ══════════════════════ */

/**
 * على صفوف `COLLECTION` وحدها ([drizzle/schema.ts]: العمود `NULL` لغيرها) — ولذلك تعرضها
 * الشاشة مشروطةً بالنوع لا مطلقةً.
 */
export const ORDER_DEPOSIT_STATUSES = [
  /** المال محتجَزٌ للزبون: يقبل الردّ، ولم يُستهلَك على مستند. */
  "HELD",
  /** استُهلك على فاتورةٍ أو أمرِ شغل — مسارُ استرجاعه صار مرتجعَ ذلك المستند لا هذا الحوار. */
  "APPLIED",
  /** رُدّ بالكامل. */
  "REFUNDED",
] as const;

export type OrderDepositStatus = (typeof ORDER_DEPOSIT_STATUSES)[number];

export const ORDER_DEPOSIT_STATUS_LABEL: Readonly<Record<OrderDepositStatus, string>> =
  Object.freeze({
    HELD: "محتجز",
    APPLIED: "مطبق",
    REFUNDED: "مردود بالكامل",
  });

export function isOrderDepositStatus(v: unknown): v is OrderDepositStatus {
  return typeof v === "string" && (ORDER_DEPOSIT_STATUSES as readonly string[]).includes(v);
}

/** المجهول يُعرَض خامّاً — مطابقٌ للسلوك السابق (`STATUS_AR[s] ?? s`). */
export function orderDepositStatusLabel(status: string | null | undefined): string {
  if (!status) return "—";
  return isOrderDepositStatus(status) ? ORDER_DEPOSIT_STATUS_LABEL[status] : status;
}
