/**
 * أنواعُ أحداث دورة حياة أمر الشغل — مصدر الحقيقة الوحيد لأسماء الأحداث.
 *
 * تُستعمل في `workOrderEvents.eventType` (drizzle/schema.ts + هجرة 0278). كلّ فعلٍ من
 * لـ`recordWorkOrderEvent` يستهلك قيمةً واحدةً من هذه القائمة — أيّ فعلٍ جديد يلزمه:
 *   ١) إضافة قيمةٍ هنا،
 *   ٢) تعريبٌ في `WORK_ORDER_EVENT_LABEL`،
 *   ٣) وسيرورةٌ مؤصَّلةٌ تستدعيها.
 *
 * القاموس يُغطّي الفعل الحاليّ لدورة أمر الشغل — يمكن التوسّع لاحقاً بلا كسرٍ (enum غير مغلق
 * على مستوى القاعدة — عمود `varchar` — لكن هذا الملف الحاكم على الاستهلاك بأمانٍ نوعيّ).
 */

export const WORK_ORDER_EVENT_TYPES = [
  "CREATED",
  "CLAIMED",
  "RELEASED",
  "ASSIGNED",
  "STARTED",
  "MATERIALS_UPDATED",
  "MARKED_READY",
  "DISPATCHED",
  "DELIVERED",
  "CANCELLED",
  "REVERSED",
  "DESIGN_APPROVED",
  "DESIGN_REJECTED",
] as const;

export type WorkOrderEventType = (typeof WORK_ORDER_EVENT_TYPES)[number];

/** التسمية العربيّة الرسميّة — تُستعمل في `EntityTimeline` الجديد. */
export const WORK_ORDER_EVENT_LABEL: Record<WorkOrderEventType, string> = {
  CREATED: "استُلم الطلب",
  CLAIMED: "سحبه الفنّي",
  RELEASED: "أُعيد إلى الطابور",
  ASSIGNED: "أُعيد الإسناد",
  STARTED: "بدأ التنفيذ",
  MATERIALS_UPDATED: "عُدِّلت المواد",
  MARKED_READY: "جاهز للتسليم",
  DISPATCHED: "أُرسل عبر مندوب",
  DELIVERED: "سُلّم وصدرت الفاتورة",
  CANCELLED: "أُلغي الأمر",
  REVERSED: "عُكس التسليم",
  DESIGN_APPROVED: "أُقرّ التصميم",
  DESIGN_REJECTED: "رُفض التصميم",
};

/** فارغ/مجهول ⇒ يُرجع النوع الخام (لا نرمي — العرض لا ينكسر). */
export function workOrderEventLabel(eventType: string | null | undefined): string {
  if (!eventType) return "—";
  return WORK_ORDER_EVENT_LABEL[eventType as WorkOrderEventType] ?? eventType;
}

/**
 * توليدُ eventKey فريد — الاصطلاح: `wo:<workOrderId>:<eventType>[:<seq>]`.
 *
 * للأحداث الأحاديّة (`STARTED`/`MARKED_READY`/`DELIVERED`/`CANCELLED`/`REVERSED`) لا seq —
 * إن كُتب مرّتين، `UNIQUE` القاعدة يرفض الثاني (حماية idempotency). للأحداث المتكرّرة
 * (`ASSIGNED`/`MATERIALS_UPDATED`) يُمرَّر seq (رقمُ الإسناد رقماً، أو hash المواد).
 */
export function buildWorkOrderEventKey(
  workOrderId: number,
  eventType: WorkOrderEventType,
  seq?: string | number | null,
): string {
  const base = `wo:${workOrderId}:${eventType}`;
  return seq == null ? base : `${base}:${seq}`;
}
