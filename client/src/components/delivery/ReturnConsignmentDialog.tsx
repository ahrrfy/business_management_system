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
 */
import { useState } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { RefundRailPicker, type RefundRailPickerState } from "@/components/ui/RefundRailPicker";

export interface ReturnConsignmentTarget {
  consignmentId: number;
  label: string;
}

export function ReturnConsignmentDialog({
  target,
  pending,
  onClose,
  onConfirm,
}: {
  target: ReturnConsignmentTarget | null;
  pending?: boolean;
  onClose: () => void;
  onConfirm: (args: { consignmentId: number; refundShiftId: number | undefined }) => void;
}) {
  if (!target) return null;
  return (
    <ReturnConsignmentDialogBody
      key={target.consignmentId}
      target={target}
      pending={pending}
      onClose={onClose}
      onConfirm={onConfirm}
    />
  );
}

/** جسمُ الحوار — يُعاد تركيبه لكلّ إرسالية (`key`) فلا تبقى حالةُ درجٍ من طردٍ سابق. */
function ReturnConsignmentDialogBody({
  target,
  pending,
  onClose,
  onConfirm,
}: {
  target: ReturnConsignmentTarget;
  pending?: boolean;
  onClose: () => void;
  onConfirm: (args: { consignmentId: number; refundShiftId: number | undefined }) => void;
}) {
  /**
   * **التمهيدُ الخادميّ الموحَّد** — يقول إن كان الطردُ يُخرج نقداً أصلاً (طردٌ غيرُ محصَّلٍ خارج
   * الوردية لا يُعطَّل — Codex P1)، والأدراجُ مُصفّاةٌ بفرع الإرسالية (Codex P2)، والروافدُ غيرُ
   * المقبولة معلَنةٌ بسببها. الزرُّ يقرأ سببَ الحجب من حالة المنتقي لا من تخمينٍ محلّيّ.
   */
  const [rail, setRail] = useState<RefundRailPickerState | null>(null);
  const blockReason = rail == null ? null : rail.blockReason;
  const notReady = rail == null || rail.loading || rail.error != null;

  return (
    <Dialog open onOpenChange={(v) => { if (!v && !pending) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <RotateCcw aria-hidden className="size-4" /> إرجاع الإرسالية
          </DialogTitle>
          <DialogDescription>{target.label}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <p className="flex items-start gap-2 rounded-md bg-[var(--sem-warn-bg)] px-2.5 py-2 text-xs font-bold text-[var(--sem-warn)]">
            <AlertTriangle aria-hidden className="mt-0.5 size-3.5 shrink-0" />
            <span>
              يُعكَس البيع كاملاً: تعود البضاعة للمخزون، وتصير الفاتورة مرتجعة، وتسقط ذمّة
              العميل، ويُردّ ما قُبض. لا تُنفّذ إلّا بعد استلام الطرد في الفرع فعلياً.
            </span>
          </p>

          <RefundRailPicker
            context={{ sourceDocType: "CONSIGNMENT_RETURN", sourceDocId: target.consignmentId }}
            mode="embedded"
            onStateChange={setRail}
            drawerHint="قُبض على هذا الطرد نقدٌ — من هذا الدرج يخرج ردُّه."
            submitting={pending}
          />
        </div>

        <DialogFooter>
          <div className="flex w-full flex-col gap-2 sm:flex-row sm:items-center sm:justify-end">
            {blockReason && (
              <span className="text-2xs font-bold text-[var(--sem-warn)] sm:me-auto">{blockReason}</span>
            )}
            <div className="flex items-center justify-end gap-2">
              <Button variant="ghost" onClick={onClose} disabled={pending}>تراجع</Button>
              <Button
                variant="destructive"
                disabled={pending || notReady || blockReason != null}
                onClick={() => onConfirm({ consignmentId: target.consignmentId, refundShiftId: rail?.selection?.refundShiftId })}
              >
                {pending ? "جارٍ…" : "استلمتُ الطرد — أرجِع"}
              </Button>
            </div>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
