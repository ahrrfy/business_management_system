/**
 * **حوارُ إرجاع الإرسالية** — البابُ الثالث الذي كانت رسالةُ الخادم تطلب فيه درجاً لا حقلَ له.
 *
 * `delivery.returnConsignment` يقبل `refundShiftId` منذ مدّة، وشاشةُ التوصيل **لم ترسله قطّ**
 * (نداءان: استلامُ المرتجع من «قيد التوصيل»، والإرجاعُ من شاشة التسوية) ⇒ كلّما فُتح درجان
 * في الفرع صار إرجاعُ طردٍ مدفوعٍ مستحيلاً برسالةٍ تطلب ما لا سبيل لإعطائه.
 *
 * ⚠️ رافدُ التوصيل يقبل **أيّ** درجٍ مفتوح (`resolveBranchCashShiftTx`) بخلاف رافد أمر الشغل
 * المقصور على `RECEPTION` — ولذلك `requiredShiftType = null` هنا.
 */
import { useEffect } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { RefundDrawerPicker, useRefundDrawer } from "@/components/workorder/RefundDrawerPicker";

export interface ReturnConsignmentTarget {
  consignmentId: number;
  label: string;
  /**
   * تقديرُ النقد الخارج — للتحذير من درجٍ لا يكفي. `null` حين لا تملكه الشاشة: عندئذٍ
   * يُعرَض المنتقي بلا تقديرٍ بدل إخفائه (إظهارٌ زائد غيرُ ضارّ، والإخفاءُ بابٌ مسدود).
   */
  estimatedRefund: string | number | null;
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
  const drawer = useRefundDrawer({
    // نفترض خروجَ نقدٍ ما دام الحوار مفتوحاً: الشاشةُ لا تحمل `paidAmount` للطرد، والخادمُ
    // يتجاهل الدرجَ حين لا يخرج نقد — فالإظهارُ آمنٌ والإخفاءُ يُعيد الحائط.
    needed: target != null,
    // صفوفُ التوصيل بلا `branchId` ⇒ نطاقُ الخادم هو الحاكم (`undefined` لا `null`).
    branchId: undefined,
    requiredShiftType: null,
    emptyLabel: "وردية",
    estimatedAmount: target?.estimatedRefund ?? null,
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
            needed
            hint="إن كان قد قُبض على هذا الطرد نقدٌ، فمن هذا الدرج يخرج ردُّه."
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
