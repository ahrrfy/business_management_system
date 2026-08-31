/**
 * **حوارُ إرجاع الإرسالية** — البابُ الثالث الذي كانت رسالةُ الخادم تطلب فيه درجاً لا حقلَ له.
 *
 * `delivery.returnConsignment` يقبل `refundShiftId` منذ مدّة، وشاشةُ التوصيل **لم ترسله قطّ**
 * (نداءان: استلامُ المرتجع من «قيد التوصيل»، والإرجاعُ من شاشة التسوية) ⇒ كلّما فُتح درجان
 * في الفرع صار إرجاعُ طردٍ مدفوعٍ مستحيلاً برسالةٍ تطلب ما لا سبيل لإعطائه.
 *
 * ⚠️ رافدُ التوصيل يقبل **أيّ** درجٍ مفتوح (`resolveBranchCashShiftTx`) بخلاف رافد أمر الشغل
 * المقصور على `RECEPTION` — والتمييزُ يقع **خادمياً** في `delivery.returnPreflight`، فلا
 * تُصفّي الشاشةُ ولا تُخمّن.
 */
import { useEffect } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { RefundDrawerPicker, useRefundDrawer } from "@/components/workorder/RefundDrawerPicker";
import { trpc } from "@/lib/trpc";

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
  /**
   * **التمهيدُ الخادميّ** — يقول إن كان الطردُ يُخرج نقداً أصلاً. الافتراضُ السابق («كلُّ
   * إرجاعٍ يُخرج نقداً») كان يُعطّل إرجاعَ طردٍ غيرِ محصَّلٍ خارج الوردية (Codex P1)، والأدراجُ
   * تأتي مُصفّاةً **بفرع الإرسالية** فلا يُعرَض درجُ فرعٍ آخر يرفضه الخادم (Codex P2).
   */
  const preflightQ = trpc.delivery.returnPreflight.useQuery(
    { consignmentId: target?.consignmentId ?? 0 },
    { enabled: target != null, staleTime: 0 },
  );
  const drawer = useRefundDrawer({
    preflight: target ? preflightQ.data ?? null : null,
    emptyLabel: "وردية",
  });

  useEffect(() => {
    if (target) drawer.reset();
  }, [target?.consignmentId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!target) return null;

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

          <RefundDrawerPicker
            state={drawer}
            needed={preflightQ.data?.needsCashDrawer === true}
            hint="قُبض على هذا الطرد نقدٌ — من هذا الدرج يخرج ردُّه."
          />
        </div>

        <DialogFooter>
          <div className="flex w-full flex-col gap-2 sm:flex-row sm:items-center sm:justify-end">
            {drawer.blockReason && (
              <span className="text-2xs font-bold text-[var(--sem-warn)] sm:me-auto">{drawer.blockReason}</span>
            )}
            <div className="flex items-center justify-end gap-2">
              <Button variant="ghost" onClick={onClose} disabled={pending}>تراجع</Button>
              <Button
                variant="destructive"
                disabled={pending || drawer.blockReason != null}
                onClick={() => onConfirm({ consignmentId: target.consignmentId, refundShiftId: drawer.refundShiftId })}
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
