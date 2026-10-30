/**
 * **حوارُ إرجاع الإرسالية** — البابُ الثالث الذي كانت رسالةُ الخادم تطلب فيه درجاً لا حقلَ له.
 *
 * `delivery.returnConsignment` يقبل `refundShiftId` منذ مدّة، وشاشةُ التوصيل **لم ترسله قطّ**
 * (نداءان: استلامُ المرتجع من «قيد التوصيل»، والإرجاعُ من شاشة التسوية) ⇒ كلّما فُتح درجان
 * في الفرع صار إرجاعُ طردٍ مدفوعٍ مستحيلاً برسالةٍ تطلب ما لا سبيل لإعطائه.
 *
 * م٢ ذيل (ق١٠): الردُّ عبر `<RefundRailPicker>` الموحَّد — الخادمُ يفتي بالدرج والكفاية،
 * والروافدُ التي لا يقبلها فعلُ `delivery.returnConsignment` (الخزينة/البطاقة) تُعلَن بسببها
 * لا تُخفى: «إرجاعُ الإرسالية يقبل درجاً مفتوحاً فقط» — **المفتاحُ الناقص** في سياسة الخزينة
 * يُفتح حين يقبل فعلُ التوصيل رافدَ الخزينة (خارج هذه الشريحة: `server/services/delivery/**`).
 *
 * حوكمة المسار العكسي لأوامر الشغل: عند استلام طرد راجع لأمر شغل، يُخيَّر الموظف صراحةً بين
 * إعادته إلى «جاهز للتسليم» (`RETURN_TO_READY` — الافتراضي الموصى به دون عكس الفاتورة أو ردّ
 * عربون البضاعة) وبين إلغائه نهائياً (`CANCEL_FINAL` — عكس الفاتورة وردّ المقبوض).
 */
import React, { useState } from "react";
import { AlertTriangle, CheckCircle2, RotateCcw, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  RefundRailPicker,
  type RefundRailPickerState,
} from "@/components/ui/RefundRailPicker";
import { cn } from "@/lib/utils";

export type WorkOrderReturnDisposition = "RETURN_TO_READY" | "CANCEL_FINAL";

export interface ReturnConsignmentTarget {
  consignmentId: number;
  label: string;
  isWorkOrder?: boolean;
  workOrderId?: number | null;
}

export interface ReturnConsignmentConfirmArgs {
  consignmentId: number;
  refundShiftId: number | undefined;
  workOrderDisposition?: WorkOrderReturnDisposition;
}

type ReturnConsignmentCopy = {
  heading?: string;
  disclosure?: React.ReactNode;
  confirmText?: string;
};

/**
 * اشتقاقُ بوّابة التأكيد وحمولة قرار أمر الشغل:
 *  - غير أوامر الشغل: سلوكٌ مطابقٌ ١٠٠٪ لما كان (محكوم بـ`blockReason` و`notReady` من `<RefundRailPicker>`).
 *  - أمر شغل + `RETURN_TO_READY`: لا يُردّ عربون البضاعة فلا تحجبُه عدمُ كفاية الدرج أو غيابُه،
 *    بينما يُمرَّر `refundShiftId` إن وُجد درجٌ مفتوحٌ مختارٌ لردّ أمانة أجرة توصيل محتملة.
 *  - أمر شغل + `CANCEL_FINAL`: المسار الماليّ الكامل — يُلزَم باستيفاء `<RefundRailPicker>`.
 */
export function resolveReturnConsignmentGate(args: {
  isWorkOrder: boolean;
  disposition: WorkOrderReturnDisposition;
  rail: RefundRailPickerState | null;
}): {
  isReturnToReady: boolean;
  blockReason: string | null;
  notReady: boolean;
  refundShiftId: number | undefined;
  workOrderDisposition: WorkOrderReturnDisposition | undefined;
} {
  const { isWorkOrder, disposition, rail } = args;
  const isReturnToReady = isWorkOrder && disposition === "RETURN_TO_READY";
  const refundShiftId = rail?.selection?.refundShiftId;

  if (isReturnToReady) {
    return {
      isReturnToReady: true,
      blockReason: null,
      notReady: Boolean(rail?.loading),
      refundShiftId,
      workOrderDisposition: "RETURN_TO_READY",
    };
  }

  const missingDrawerShift =
    rail != null &&
    rail.needsCash &&
    rail.selection?.rail === "DRAWER" &&
    rail.selection?.refundShiftId == null;

  const blockReason =
    rail == null
      ? null
      : (rail.blockReason ??
        (missingDrawerShift
          ? "اختر درج الاسترداد النقدي أو افتح وردية قبل الإلغاء النهائي."
          : null));

  const notReady = rail == null || rail.loading || rail.error != null;

  return {
    isReturnToReady: false,
    blockReason,
    notReady,
    refundShiftId,
    workOrderDisposition: isWorkOrder ? "CANCEL_FINAL" : undefined,
  };
}

export function ReturnConsignmentDialog({
  target,
  pending,
  onClose,
  onConfirm,
  heading,
  disclosure,
  confirmText,
}: {
  target: ReturnConsignmentTarget | null;
  pending?: boolean;
  onClose: () => void;
  onConfirm: (args: ReturnConsignmentConfirmArgs) => void;
} & ReturnConsignmentCopy) {
  if (!target) return null;
  return (
    <ReturnConsignmentDialogBody
      key={target.consignmentId}
      target={target}
      pending={pending}
      onClose={onClose}
      onConfirm={onConfirm}
      heading={heading}
      disclosure={disclosure}
      confirmText={confirmText}
    />
  );
}

/** جسمُ الحوار — يُعاد تركيبه لكلّ إرسالية (`key`) فلا تبقى حالةُ درجٍ من طردٍ سابق. */
function ReturnConsignmentDialogBody({
  target,
  pending,
  onClose,
  onConfirm,
  heading,
  disclosure,
  confirmText,
}: {
  target: ReturnConsignmentTarget;
  pending?: boolean;
  onClose: () => void;
  onConfirm: (args: ReturnConsignmentConfirmArgs) => void;
} & ReturnConsignmentCopy) {
  /**
   * **التمهيدُ الخادميّ الموحَّد** — يقول إن كان الطردُ يُخرج نقداً أصلاً (طردٌ غيرُ محصَّلٍ خارج
   * الوردية لا يُعطَّل — Codex P1)، والأدراجُ مُصفّاةٌ بفرع الإرسالية (Codex P2)، والروافدُ غيرُ
   * المقبولة معلَنةٌ بسببها. الزرُّ يقرأ سببَ الحجب من حالة المنتقي لا من تخمينٍ محلّيّ.
   */
  const isWorkOrder = Boolean(target.isWorkOrder || target.workOrderId);
  const [disposition, setDisposition] =
    useState<WorkOrderReturnDisposition>("RETURN_TO_READY");
  const [rail, setRail] = useState<RefundRailPickerState | null>(null);
  const gate = resolveReturnConsignmentGate({ isWorkOrder, disposition, rail });

  return (
    <Dialog
      open
      onOpenChange={(v) => {
        if (!v && !pending) onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <RotateCcw aria-hidden className="size-4" />{" "}
            {heading ?? "إرجاع الإرسالية"}
          </DialogTitle>
          <DialogDescription>{target.label}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {isWorkOrder && (
            <div
              role="radiogroup"
              aria-label="مصير أمر الشغل بعد استلام الطرد الراجع"
              className="grid grid-cols-1 gap-2"
            >
              <button
                type="button"
                role="radio"
                aria-checked={disposition === "RETURN_TO_READY"}
                disabled={pending}
                onClick={() => setDisposition("RETURN_TO_READY")}
                className={cn(
                  "flex items-start gap-2.5 rounded-lg border p-3 text-start transition-colors",
                  disposition === "RETURN_TO_READY"
                    ? "border-[var(--sem-pos)] bg-[var(--sem-pos-bg)]"
                    : "bg-card hover:bg-muted/60",
                )}
              >
                <CheckCircle2
                  aria-hidden
                  className={cn(
                    "mt-0.5 size-4 shrink-0",
                    disposition === "RETURN_TO_READY"
                      ? "text-[var(--sem-pos)]"
                      : "text-muted-foreground",
                  )}
                />
                <div className="space-y-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-xs font-bold text-foreground">
                      إعادة الطلب إلى «جاهز للتسليم»
                    </span>
                    <span className="rounded bg-[var(--sem-pos-bg)] px-1.5 py-0.5 text-2xs font-bold text-[var(--sem-pos)]">
                      موصى به
                    </span>
                  </div>
                  <p className="text-2xs leading-relaxed text-muted-foreground">
                    يبقى أمر الشغل حيّاً في الاستقبال لإعادة إرساله مع مندوب آخر
                    أو تسليمه للعميل من المحل دون إتلاف الطلب.
                  </p>
                </div>
              </button>

              <button
                type="button"
                role="radio"
                aria-checked={disposition === "CANCEL_FINAL"}
                disabled={pending}
                onClick={() => setDisposition("CANCEL_FINAL")}
                className={cn(
                  "flex items-start gap-2.5 rounded-lg border p-3 text-start transition-colors",
                  disposition === "CANCEL_FINAL"
                    ? "border-[var(--sem-danger)] bg-[var(--sem-danger-bg)]"
                    : "bg-card hover:bg-muted/60",
                )}
              >
                <XCircle
                  aria-hidden
                  className={cn(
                    "mt-0.5 size-4 shrink-0",
                    disposition === "CANCEL_FINAL"
                      ? "text-[var(--sem-danger)]"
                      : "text-muted-foreground",
                  )}
                />
                <div className="space-y-1">
                  <span className="block text-xs font-bold text-foreground">
                    إلغاء الطلب نهائياً واسترجاع الفاتورة
                  </span>
                  <p className="text-2xs leading-relaxed text-muted-foreground">
                    يُقفل أمر الشغل كملغي نهائياً وتُعكس الفاتورة ويُردّ المقبوض.
                  </p>
                </div>
              </button>
            </div>
          )}

          {gate.isReturnToReady ? (
            <p className="flex items-start gap-2 rounded-md bg-[var(--sem-pos-bg)] px-2.5 py-2 text-xs font-bold text-[var(--sem-pos)]">
              <CheckCircle2 aria-hidden className="mt-0.5 size-3.5 shrink-0" />
              <span>
                {disclosure ?? (
                  <>
                    تُفكّ عهدة المندوب فقط ويعود أمر الشغل إلى عمود «جاهز
                    للتسليم» دون عكس الفاتورة أو ردّ عربون البضاعة. لا تُنفّذ
                    إلّا بعد استلام المطبوع في الفرع فعلياً.
                  </>
                )}
              </span>
            </p>
          ) : (
            <p className="flex items-start gap-2 rounded-md bg-[var(--sem-warn-bg)] px-2.5 py-2 text-xs font-bold text-[var(--sem-warn)]">
              <AlertTriangle aria-hidden className="mt-0.5 size-3.5 shrink-0" />
              <span>
                {disclosure ?? (
                  <>
                    يُعكَس البيع كاملاً: تعود البضاعة للمخزون، وتصير الفاتورة
                    مرتجعة، وتسقط ذمّة العميل، ويُردّ ما قُبض. لا تُنفّذ إلّا
                    بعد استلام الطرد في الفرع فعلياً.
                  </>
                )}
              </span>
            </p>
          )}

          <RefundRailPicker
            context={{
              sourceDocType: "CONSIGNMENT_RETURN",
              sourceDocId: target.consignmentId,
            }}
            mode="embedded"
            requestOnly={gate.isReturnToReady}
            onStateChange={setRail}
            drawerHint={
              gate.isReturnToReady
                ? "اختياري: لا يُردّ عربون البضاعة هنا — يُستعمل الدرج المفتوح فقط إن وُجدت أمانة أجرة توصيل محتجزة."
                : "قُبض على هذا الطرد نقدٌ — من هذا الدرج يخرج ردُّه."
            }
            submitting={pending}
          />
        </div>

        <DialogFooter>
          <div className="flex w-full flex-col gap-2 sm:flex-row sm:items-center sm:justify-end">
            {gate.blockReason && (
              <span className="text-2xs font-bold text-[var(--sem-warn)] sm:me-auto">
                {gate.blockReason}
              </span>
            )}
            <div className="flex items-center justify-end gap-2">
              <Button variant="ghost" onClick={onClose} disabled={pending}>
                تراجع
              </Button>
              <Button
                variant={gate.isReturnToReady ? "default" : "destructive"}
                disabled={pending || gate.notReady || gate.blockReason != null}
                onClick={() =>
                  onConfirm({
                    consignmentId: target.consignmentId,
                    refundShiftId: gate.refundShiftId,
                    ...(gate.workOrderDisposition
                      ? { workOrderDisposition: gate.workOrderDisposition }
                      : {}),
                  })
                }
              >
                {pending
                  ? "جارٍ…"
                  : (confirmText ??
                    (gate.isReturnToReady
                      ? "استلمتُ الطرد — أعِده لجاهز للتسليم"
                      : "استلمتُ الطرد — أرجِع"))}
              </Button>
            </div>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
