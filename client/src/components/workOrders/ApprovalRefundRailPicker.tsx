/**
 * **رافدُ الردّ عند الاعتماد** — بلاغ المالك (٢/٩/٢٦) على الأمر 5033/#171.
 *
 * الطالبُ يختار الرافدَ ساعةَ الطلب، والمعتمِدُ يُطبّقه ساعةَ الاعتماد — وبينهما ساعات. فُرِّغ
 * الدرجُ بالبيع، فوقف المديرُ أمام «رصيد الدرج المتاح 25٬000 د.ع أقل من المطلوب 70٬000 د.ع»
 * وحمولةُ الطلب **مبصومةٌ لا تُعدَّل**: لا يعتمد ولا يُغيّر، والرسالةُ تقول ما الخطأ ولا تقول
 * ما العمل. بابٌ مسدودٌ على مالِ زبونٍ محتجَز.
 *
 * فهنا يرى المعتمِدُ **الأرصدة الحيّة قبل الضغط** ويختار من أين يخرج المال فعلاً.
 *
 * م٢ ق١٠ب (٥/٩/٢٦): العرضُ هو `RefundRailPickerView` الموحَّد نفسُه (رقائقُ الروافد · حقلُ الدرج ·
 * مرجعُ البطاقة · الروافدُ غيرُ المتاحة بسببها) مبذوراً باقتراح الطالب؛ ما يبقى هنا هو حالةُ
 * الاعتماد وحدها: **هل يختلف الاختيارُ عن الطلب** (`changed`) فيُرسَل تجاوزٌ. ثلاثُ مراجعات
 * كانت قد صلَّبت هذا الملفّ (ترتيبُ المؤثّرات · تصفيرُ البطاقة · تصفيرُ المرجع بين المحاولات)،
 * وكلُّها صارت داخل المنتقي الموحَّد: يُعاد بذرُه مع كلّ فتحٍ (`key`)، ودرجُ الطالب يُصان ما دام
 * مؤهَّلاً، ومرجعُ البطاقة يُبذَر من الطلب فلا يُعَدّ تجاوزاً إلّا إن **اختلف**.
 */
import { useEffect, useMemo, useState } from "react";
import { Wallet } from "lucide-react";
import { refundRailNeedsReference, refundRailNeedsShift, type RefundRail } from "@shared/refundRail";
import type { RefundPreflight } from "@shared/refundPreflight";
import { Label } from "@/components/ui/label";
import { RefundRailPickerView, type RefundRailPickerState } from "@/components/ui/RefundRailPicker";
import { fmtAr } from "@/lib/money";

export interface ApprovalRefundChoice {
  rail: RefundRail;
  shiftId: number | undefined;
  reference: string;
  /** سببُ الحجب المقروء، أو `null` حين يجوز الاعتماد. */
  blockReason: string | null;
  /** هل يختلف الاختيارُ عمّا اقترحه الطالب؟ (يُرسَل التجاوزُ عندئذٍ وحده). */
  changed: boolean;
  /** ما اقترحه الطالب — يبذر به المنتقي الموحَّد. */
  requested: { rail: RefundRail | null; shiftId: number | null; reference: string | null };
  /** يستقبل حالةَ المنتقي الموحَّد (الوضع المضمَّن). */
  onStateChange: (state: RefundRailPickerState) => void;
}

export function useApprovalRefundChoice(args: {
  open: boolean;
  preflight: RefundPreflight | null;
  /** ما اقترحه الطالبُ في حمولة الطلب. */
  requestedRail: RefundRail | null;
  requestedShiftId: number | null;
  requestedReference: string | null;
}): ApprovalRefundChoice {
  const { open, preflight, requestedRail, requestedShiftId, requestedReference } = args;
  const needsCash = preflight?.needsCashDrawer === true;
  const [state, setState] = useState<RefundRailPickerState | null>(null);

  // فتحٌ جديد ⇒ حالةٌ نظيفة (المنتقي نفسُه يُعاد بذرُه من الطلب عند التركيب).
  useEffect(() => {
    if (!open) setState(null);
  }, [open]);

  const rail: RefundRail = state?.selection?.rail ?? requestedRail ?? "DRAWER";
  const shiftId = needsCash && refundRailNeedsShift(rail) ? state?.selection?.refundShiftId : undefined;
  const reference = state?.selection?.cardReference ?? "";

  const blockReason = !needsCash
    ? null
    : state == null || state.loading
      ? "جارٍ التحقق من روافد الردّ والأدراج المفتوحة…"
      : state.error != null
        ? `تعذّر التحقق من روافد الردّ — ${state.error}`
        : state.blockReason;

  const changed = useMemo(() => {
    if (!needsCash || state?.selection == null) return false;
    if (rail !== (requestedRail ?? "DRAWER")) return true;
    if (refundRailNeedsShift(rail) && (shiftId ?? null) !== (requestedShiftId ?? null)) return true;
    // المرجعُ تجاوزٌ حين **يختلف** عمّا قدّمه الطالب — لا لمجرّد وجوده.
    return refundRailNeedsReference(rail)
      && reference.trim() !== (requestedReference ?? "").trim();
  }, [needsCash, state?.selection, rail, requestedRail, shiftId, requestedShiftId, reference, requestedReference]);

  return {
    rail,
    shiftId,
    reference,
    blockReason,
    changed,
    requested: { rail: requestedRail, shiftId: requestedShiftId, reference: requestedReference },
    onStateChange: setState,
  };
}

export function ApprovalRefundRailPicker({
  preflight,
  choice,
  workOrderId,
}: {
  preflight: RefundPreflight | null;
  choice: ApprovalRefundChoice;
  /** أمرُ الشغل المعتمَد إلغاؤه — هويّةُ المستند التي يُبذَر بها المنتقي ويُعاد ضبطُه معها. */
  workOrderId: number;
}) {
  if (preflight?.needsCashDrawer !== true) return null;

  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Label className="inline-flex items-center gap-1.5 text-xs font-bold">
          <Wallet aria-hidden className="size-3.5" /> من أين يخرج المال؟
        </Label>
        <span className="text-2xs text-muted-foreground">
          المطلوب{" "}
          <span dir="ltr" className="font-bold tabular-nums">{fmtAr(preflight.estimatedCashOut)}</span> د.ع
        </span>
      </div>
      <RefundRailPickerView
        context={{ sourceDocType: "WORKORDER_CANCEL", sourceDocId: workOrderId }}
        preflight={preflight}
        loading={false}
        error={null}
        mode="embedded"
        onStateChange={choice.onStateChange}
        initialSelection={{
          rail: choice.requested.rail ?? "DRAWER",
          ...(choice.requested.shiftId != null ? { refundShiftId: choice.requested.shiftId } : {}),
          ...(choice.requested.reference ? { cardReference: choice.requested.reference } : {}),
        }}
        drawerLabel="درج ردّ النقد"
        drawerHint="وردية قبض العربون قد تكون أُغلقت — النقد يخرج من درجٍ مفتوحٍ الآن."
      />
    </div>
  );
}
