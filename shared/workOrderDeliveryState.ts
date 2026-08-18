/**
 * حالة التوصيل المشتقّة لأمر الشغل — **المصدر الوحيد** لتسميتها وألوانها في كل شاشة.
 *
 * لماذا مشتقّة لا قيمة enum جديدة على `workOrders.status` (بلاغ المالك ١٨/٨):
 *  · الحقيقة موجودةٌ أصلاً في `deliveryConsignments` — إضافة حالةٍ ثانية تعني كاتبَين لحقيقةٍ
 *    واحدة (إسناد/إلغاء إسناد/تأكيد تسليم/إرجاع) فينجرفان حتماً: أمرٌ يقول DISPATCHED
 *    وإرساليّته CANCELLED. الاشتقاق لا ينجرف بنيوياً.
 *  · `READY` تعني «البضاعة جاهزة فيزيائياً» وتبقى صادقةً والطرد بيد المندوب؛ فكلّ حارسٍ
 *    قائمٍ يفحص `status === "READY"` (الإسناد، التسليم المباشر، تغيير طريقة التسليم، الإلغاء)
 *    يبقى صحيحاً بلا إعادة تدقيق.
 *  · صفر هجرة وصفر backfill على جدولٍ ساخن.
 *
 * درس `shared/invoiceStatus.ts` مطبَّقٌ هنا: ⛔ لا شاشة تُعيد تعريف هذا القاموس محلّياً.
 */

/** حالة الطرد على الإرسالية (مرآة `deliveryConsignments.parcelStatus`). */
export type ParcelStatus =
  | "ASSIGNED"
  | "ACCEPTED"
  | "PICKED_UP"
  | "OUT_FOR_DELIVERY"
  | "DELIVERED"
  | "FAILED"
  | "RETURNED"
  | "CANCELLED";

/** حالة إغلاق الإرسالية (مرآة `deliveryConsignments.consignmentStatus`). */
export type ConsignmentStatus = "DISPATCHED" | "PARTIAL" | "DELIVERED" | "CANCELLED" | "RETURNED";

/**
 * ما يُعرَض للموظّف عن موقع الطلب في رحلة التوصيل:
 *  · `NONE`       — بلا إرسالية حيّة (الحالة العامّة للأمر هي القول الفصل).
 *  · `ASSIGNED`   — أُسنِد لجهة ولم يخرج من المكتبة بعد.
 *  · `IN_TRANSIT` — خرج فعلاً وهو بالطريق.
 *  · `FAILED`     — تعذّر التسليم ويحتاج قراراً (إعادة محاولة أو استرجاع).
 */
export type WorkOrderDeliveryState = "NONE" | "ASSIGNED" | "IN_TRANSIT" | "FAILED";

export function deriveWoDeliveryState(
  consignmentStatus: ConsignmentStatus | string | null | undefined,
  parcelStatus: ParcelStatus | string | null | undefined,
): WorkOrderDeliveryState {
  // الإرسالية الملغاة/المرتجعة ليست حيّة — الأمر يعود لطابور الإرسال (queries.ts) فلا وسم له.
  if (!consignmentStatus || consignmentStatus === "CANCELLED" || consignmentStatus === "RETURNED") {
    return "NONE";
  }
  if (parcelStatus === "FAILED") return "FAILED";
  if (parcelStatus === "ASSIGNED") return "ASSIGNED";
  if (parcelStatus === "ACCEPTED" || parcelStatus === "PICKED_UP" || parcelStatus === "OUT_FOR_DELIVERY") {
    return "IN_TRANSIT";
  }
  // DELIVERED (وما بعده) ⇒ الرحلة انتهت؛ حالة الأمر نفسها تحكي الباقي.
  return "NONE";
}

/** التسمية العربية المعتمدة — يحرسها اختبارٌ نصّيّ (لا مرادفات منجرفة بين الشاشات). */
export const WO_DELIVERY_STATE_AR: Record<Exclude<WorkOrderDeliveryState, "NONE">, string> = {
  ASSIGNED: "مُسنَد — لم يخرج",
  IN_TRANSIT: "بالطريق",
  FAILED: "تعذّر التسليم",
};

export function woDeliveryStateLabel(state: WorkOrderDeliveryState): string | null {
  return state === "NONE" ? null : WO_DELIVERY_STATE_AR[state];
}

/** توكنز الحالة الدلالية (لا ألوان خامّة — حارس `check:colors`). */
export const WO_DELIVERY_STATE_CLS: Record<Exclude<WorkOrderDeliveryState, "NONE">, string> = {
  ASSIGNED: "border-[var(--sem-info)]/45 bg-[var(--sem-info-bg)] text-[var(--sem-info)]",
  IN_TRANSIT: "border-[var(--sem-warn)]/45 bg-[var(--sem-warn-bg)] text-[var(--sem-warn)]",
  FAILED: "border-[var(--sem-danger)]/45 bg-[var(--sem-danger-bg)] text-[var(--sem-danger)]",
};
