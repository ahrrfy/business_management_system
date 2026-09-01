/**
 * **اشتقاقُ مسار الطلب — دالّةٌ نقيّة واحدة** (قرار المالك ١/٩/٢٦).
 *
 * الطلبُ يمرّ بخمس محطّاتٍ لا خمسِ حالاتٍ في عمود: استلام ← اعتماد التصميم ← تنفيذ ← جاهز
 * ← تسليم (مباشر أو عبر مندوب). العمودُ `workOrders.status` يعرف ثلاثاً منها فقط، وحارسُ
 * اعتماد التصميم يعيش خارجه كلّياً — فكانت الشاشةُ تعطّل زرَّ «بدء التنفيذ» بعبارةٍ لا تقول
 * أين المحطّة المتعثّرة ولا مَن يفكّها.
 *
 * الاشتقاقُ هنا نقيٌّ بلا React ولا استعلام كي يُختبَر وحدَه، ولئلّا تُعيد شاشةٌ ثانية بناءه
 * بيدها — وهو نمطُ `shared/workOrderStatus.ts` نفسه (§٥: قاموسٌ واحدٌ حاكم).
 */
import { isWorkOrderStatus, type WorkOrderStatus } from "./workOrderStatus";

export type WorkOrderFlowStepState = "DONE" | "CURRENT" | "BLOCKED" | "PENDING";

export interface WorkOrderFlowStepView {
  key: "RECEIVED" | "DESIGN" | "PRODUCTION" | "READY" | "HANDOVER" | "CANCELLED";
  label: string;
  state: WorkOrderFlowStepState;
  hint: string | null;
}

export interface WorkOrderFlowInput {
  status: string;
  /** حالةُ اعتماد النسخة الحالية؛ `null` = لم يُطلب بعد. `undefined` = لم تُقرأ (لا نكذب). */
  designApprovalStatus: "PENDING" | "APPROVED" | "REJECTED" | "SUPERSEDED" | null | undefined;
  hasDelivery: boolean;
  consignmentId: number | null;
  courierDeliveredAt: unknown;
  /** `BLOCKED` بعد تغيير تصميمٍ أثناء الإنتاج — يحمل سببَه على الأمر. */
  kanbanState?: string | null;
  blockedReason?: string | null;
}

function designHint(
  approval: WorkOrderFlowInput["designApprovalStatus"],
): string {
  switch (approval) {
    case "APPROVED":
      return "";
    case "PENDING":
      return "طُلب الاعتماد — بانتظار قرار مديرٍ مخوَّل (غيرِ طالبِه والفنّيِّ المسنَد).";
    case "REJECTED":
      return "رفض العميل النسخة الحالية — عدّل التخصيص ثم اطلب اعتماد النسخة الجديدة.";
    case "SUPERSEDED":
      return "تغيّر التصميم بعد الطلب — اطلب اعتماد النسخة الأحدث.";
    case null:
      return "اطلب اعتماد التصميم من البطاقة أدناه — لا يلزم رفعُ أيّ ملفّ.";
    default:
      return "تعذّر قراءة حالة اعتماد التصميم — لا تبدأ التنفيذ قبل ظهورها.";
  }
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

  const designApproved = input.designApprovalStatus === "APPROVED";
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
      key: "DESIGN",
      label: "اعتماد التصميم",
      state: designApproved ? "DONE" : status === "RECEIVED" ? "BLOCKED" : "DONE",
      // بعد بدء التنفيذ يكون الاعتماد قد وقع يقيناً (حارسُ `assertCurrentDesignApproved`)؛
      // وإن أُبطل لاحقاً بتغيير تصميم فالمحطّةُ التالية هي التي تحمل التعثّر.
      hint: designApproved ? null : status === "RECEIVED" ? designHint(input.designApprovalStatus) : null,
    },
    {
      key: "PRODUCTION",
      label: "التنفيذ",
      // أمرٌ مُستلَمٌ اعتُمد تصميمُه ⇒ **الخطوة الحالية هي البدء**، لا محطّةٌ «لاحقة» بلا فاعل.
      // بغيرها كان الطريقُ يخلو من أيّ محطّةٍ حاليّة فور فكّ حاجز التصميم.
      state: delivered || ready
        ? "DONE"
        : productionBlocked
          ? "BLOCKED"
          : inProduction || (status === "RECEIVED" && designApproved)
            ? "CURRENT"
            : "PENDING",
      hint: productionBlocked
        ? (input.blockedReason?.trim() || "التنفيذ متوقّف — يلزم اعتماد النسخة الجديدة وإقرار الفنّي.")
        : inProduction
          ? "عند انتهاء الشغل اضغط «وضع علامة جاهز»."
          : status === "RECEIVED" && designApproved
            ? "اعتُمد التصميم — اضغط «بدء التنفيذ (خصم المواد)» للبدء."
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
