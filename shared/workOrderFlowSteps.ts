/**
 * **اشتقاقُ مسار الطلب — دالّةٌ نقيّة واحدة** (قرار المالك ١/٩/٢٦).
 *
 * الطلبُ يمرّ بأربع محطّات: استلام ← تنفيذ ← جاهز ← تسليم (مباشر أو عبر مندوب).
 *
 * ⛔ **حُذفت محطّةُ «اعتماد التصميم»** (قرار المالك ١/٩/٢٦) مع حارسها في الخادم: كانت خطوةً
 * مفروضةً على كلّ طلبٍ تتطلّب شخصَين، فتقف بين الفنّي وشغله بلا مقابلٍ تشغيليّ.
 *
 * الاشتقاقُ هنا نقيٌّ بلا React ولا استعلام كي يُختبَر وحدَه، ولئلّا تُعيد شاشةٌ ثانية بناءه
 * بيدها — وهو نمطُ `shared/workOrderStatus.ts` نفسه (§٥: قاموسٌ واحدٌ حاكم).
 */
import { isWorkOrderStatus, type WorkOrderStatus } from "./workOrderStatus";

export type WorkOrderFlowStepState = "DONE" | "CURRENT" | "BLOCKED" | "PENDING";

export interface WorkOrderFlowStepView {
  key: "RECEIVED" | "PRODUCTION" | "READY" | "HANDOVER" | "CANCELLED";
  label: string;
  state: WorkOrderFlowStepState;
  hint: string | null;
}

export interface WorkOrderFlowInput {
  status: string;
  hasDelivery: boolean;
  consignmentId: number | null;
  courierDeliveredAt: unknown;
  /** `BLOCKED` بعد تغيير تصميمٍ أثناء الإنتاج — يحمل سببَه على الأمر. */
  kanbanState?: string | null;
  blockedReason?: string | null;
}


/**
 * ترتيبُ المحطّات ثابتٌ دائماً — الطريقُ يُقرأ كاملاً حتى لو لم نبلغه بعد. المحطّةُ الأخيرة
 * وحدها تتبدّل تسميتُها بحسب طريقة التسليم (استلامٌ مباشر ⇄ مندوب توصيل).
 */
export function deriveWorkOrderFlowSteps(input: WorkOrderFlowInput): WorkOrderFlowStepView[] {
  const status: WorkOrderStatus | null = isWorkOrderStatus(input.status) ? input.status : null;

  if (status === "CANCELLED") {
    return [
      { key: "RECEIVED", label: "استلام", state: "DONE", hint: null },
      {
        key: "CANCELLED",
        label: "ملغى",
        state: "BLOCKED",
        hint: "أُلغي الطلب — لا تنفيذ ولا تسليم. راجع سبب الإلغاء وسجلّ ردّ المبالغ إن وُجدت.",
      },
    ];
  }

  const delivered = status === "DELIVERED";
  const inProduction = status === "IN_PROGRESS";
  const ready = status === "READY";
  const arrived = input.courierDeliveredAt != null;
  const dispatched = input.consignmentId != null;

  /** التنفيذُ محجوزٌ بعد تغيير تصميمٍ أثناء الإنتاج — حالةٌ حقيقيّة يحملها الأمر، لا تخمين. */
  const productionBlocked = inProduction && input.kanbanState === "BLOCKED";

  const handoverLabel = input.hasDelivery ? "إسناد للتوصيل" : "تسليم وفوترة";
  const handoverState: WorkOrderFlowStepState = delivered
    ? input.hasDelivery && !arrived
      ? "CURRENT"
      : "DONE"
    : ready
      ? "CURRENT"
      : "PENDING";
  const handoverHint = delivered
    ? input.hasDelivery
      ? arrived
        ? null
        : "الطرد مع جهة التوصيل — بانتظار تأكيد الوصول والتحصيل."
      : null
    : ready
      ? input.hasDelivery
        ? dispatched
          ? "الطلب مُسنَد لمندوب — تابعه من لوحة التوصيل."
          : "اضغط «إسناد لمندوب التوصيل» — تُصدَر الإرسالية ويُحتسب التحصيل."
        : "اضغط «تسليم وإصدار فاتورة» عند حضور العميل."
      : null;

  return [
    { key: "RECEIVED", label: "استلام", state: "DONE", hint: null },
    {
      key: "PRODUCTION",
      label: "التنفيذ",
      // أمرٌ مُستلَم ⇒ **الخطوة الحالية هي البدء** مباشرةً؛ لا محطّةَ اعتمادٍ بينهما بعد اليوم.
      state: delivered || ready
        ? "DONE"
        : productionBlocked
          ? "BLOCKED"
          : "CURRENT",
      hint: productionBlocked
        ? (input.blockedReason?.trim() || "التنفيذ متوقّف — راجع سبب التعطيل على الأمر.")
        : inProduction
          ? "عند انتهاء الشغل اضغط «وضع علامة جاهز»."
          : status === "RECEIVED"
            ? "اضغط «بدء التنفيذ (خصم المواد)» للبدء."
            : null,
    },
    {
      key: "READY",
      label: "جاهز",
      state: delivered ? "DONE" : ready ? "DONE" : "PENDING",
      hint: null,
    },
    { key: "HANDOVER", label: handoverLabel, state: handoverState, hint: handoverHint },
  ];
}
