/**
 * digitalSaleIntentStatus — حالةُ **نيّة البيع الرقميّ** (`digitalSaleIntents.status`).
 *
 * المفهوم: سلّةُ بطاقاتٍ مُحضَّرة تسبق الفاتورة، دورتُها
 * `PREPARED → EXECUTING → EXECUTED → FINALIZED`، وتُلغى تلقائياً عند انقضاء `expiresAt`.
 * أخطرُ حالاتها `NEEDS_REVIEW`: كرتٌ صدر لدى المزوّد بلا فاتورة — مالٌ خرج بلا مستند.
 *
 * لماذا وُجد الملفّ (موجة D6، ٢/٩/٢٦): القاموس كان داخل `DigitalDashboard.tsx` **مقصوراً على
 * أربع حالات** هي ما تُرجعه نقطة «العمليات المعلّقة»، بينما العمود تسعُ قيم. أيُّ مستهلكٍ
 * ثانٍ لهذه الحالة (تقرير، شاشةُ شطب، تنبيه) كان سيكتب قاموسَه فينحرف — وهو ما وقع فعلاً
 * في `settlementMode` و`availability` في الشاشة نفسها.
 *
 * ⛔ لا شاشة تُعيد تعريف هذا القاموس محلّياً — يحرسه `localizationDictionaries.test.ts`
 *    بمطابقةٍ حرفيّة مع `digitalSaleIntents.status.enumValues`.
 *
 * ⛔ بلا تشكيل في التسميات (حارس `check:tashkeel`).
 */

export const DIGITAL_SALE_INTENT_STATUSES = [
  /** حُضِّرت السلّة ولم يبدأ الإصدار. */
  "PREPARED",
  /** الإصدار جارٍ لدى المزوّد. */
  "EXECUTING",
  /** صدر الكرت ولم تُنشأ الفاتورة بعد. */
  "EXECUTED",
  /** أُنشئت الفاتورة وأُغلقت النيّة — النهايةُ السليمة. */
  "FINALIZED",
  /** أُلغيت قبل الإصدار. */
  "CANCELLED",
  /** انقضى `expiresAt` قبل التثبيت. */
  "EXPIRED",
  /** كرتٌ صدر بلا فاتورة — يحتاج تدخّلاً بشرياً. */
  "NEEDS_REVIEW",
  /** طُلب شطبُها (هجرة 0129) وينتظر اعتماداً ثانياً — فصلُ مهام: طالبٌ ≠ معتمِد. */
  "WRITEOFF_PENDING",
  /** شُطبت باعتمادٍ ثانٍ. */
  "WRITTEN_OFF",
] as const;

export type DigitalSaleIntentStatus = (typeof DIGITAL_SALE_INTENT_STATUSES)[number];

/**
 * الحالاتُ التي تعدّها لوحةُ البطاقات «عمليةَ بيعٍ لم تكتمل» — مرآةُ `inArray` في
 * `server/services/digitalCards/dashboardService.ts#pendingExecutions` حرفاً بحرف.
 * ⛔ تغييرُ إحداهما بلا الأخرى يُنتج صفّاً بلا تسمية أو تسميةً بلا صفّ.
 */
export const DIGITAL_SALE_INTENT_PENDING_STATUSES: readonly DigitalSaleIntentStatus[] = [
  "PREPARED",
  "EXECUTING",
  "EXECUTED",
  "NEEDS_REVIEW",
] as const;

/**
 * التسمية العربيّة الرسميّة — **جملةُ حالٍ لا رمز**: الموظّف يحتاج أن يعرف ما الذي عليه فعلُه،
 * لا اسم المرحلة في دورة الحياة.
 */
export const DIGITAL_SALE_INTENT_STATUS_LABEL: Readonly<
  Record<DigitalSaleIntentStatus, string>
> = Object.freeze({
  PREPARED: "بانتظار الإصدار",
  EXECUTING: "يجري إصدار الكرت",
  EXECUTED: "صدر الكرت ولم تنشأ الفاتورة",
  FINALIZED: "مثبتة بفاتورة",
  CANCELLED: "ملغاة",
  EXPIRED: "منتهية الصلاحية",
  NEEDS_REVIEW: "تحتاج معالجة",
  WRITEOFF_PENDING: "بانتظار اعتماد الشطب",
  WRITTEN_OFF: "مشطوبة",
});

export function isDigitalSaleIntentStatus(v: unknown): v is DigitalSaleIntentStatus {
  return typeof v === "string" && (DIGITAL_SALE_INTENT_STATUSES as readonly string[]).includes(v);
}

/** المجهول يُعرَض خامّاً — مطابقٌ للسلوك السابق (`INTENT_LABEL[s] ?? s`). */
export function digitalSaleIntentStatusLabel(status: string | null | undefined): string {
  if (!status) return "—";
  return isDigitalSaleIntentStatus(status) ? DIGITAL_SALE_INTENT_STATUS_LABEL[status] : status;
}
