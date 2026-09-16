import { useState } from "react";
import { Ban, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { fmt } from "@/lib/money";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import type { ExpenseRow } from "./expenseView";

/** حوار رفض طلب المصروف — استُخرج من Expenses.tsx؛ يملك حالته وطفرته (بلا أثرٍ ماليّ). */
export function ExpenseRejectDialog({
  target,
  onClose,
}: {
  target: ExpenseRow | null;
  onClose: () => void;
}) {
  const utils = trpc.useUtils();
  const [rejectReason, setRejectReason] = useState("");
  const reject = trpc.expenses.reject.useMutation({
    onSuccess: async (_result, variables) => {
      await Promise.all([
        utils.expenses.list.invalidate(),
        utils.expenses.trace.invalidate({ expenseId: variables.expenseId }),
      ]);
      onClose();
      setRejectReason("");
      notify.ok("رُفض طلب المصروف بلا أثر مالي");
    },
    onError: (error) => notify.err(error),
  });

  return (
    <Dialog
      open={target != null}
      onOpenChange={(open) => {
        if (!open && !reject.isPending) {
          onClose();
          setRejectReason("");
        }
      }}
    >
      <DialogContent dir="rtl">
        <DialogHeader>
          <DialogTitle>رفض طلب المصروف</DialogTitle>
          <DialogDescription>
            سيبقى الطلب بلا صرف أو قيد مالي. سبب الرفض إلزامي ويُحفظ في مسار
            التدقيق.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2 py-1">
          <Label htmlFor="expense-rejection-reason">سبب الرفض *</Label>
          <Textarea
            id="expense-rejection-reason"
            value={rejectReason}
            onChange={(event) => setRejectReason(event.target.value)}
            placeholder="مثال: المستند المؤيد ناقص أو المبلغ يحتاج تصحيحاً"
            rows={3}
            maxLength={1000}
            autoFocus
          />
          {target && (
            <p className="text-xs text-muted-foreground">
              طلب #{Number(target.id)} · {fmt(target.amount)} د.ع
            </p>
          )}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
            disabled={reject.isPending}
          >
            تراجع
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={reject.isPending || rejectReason.trim().length < 3}
            onClick={() => {
              if (!target || rejectReason.trim().length < 3) return;
              reject.mutate({
                expenseId: Number(target.id),
                reason: rejectReason.trim(),
              });
            }}
          >
            {reject.isPending ? (
              <Loader2 aria-hidden className="size-4 animate-spin" />
            ) : (
              <Ban aria-hidden className="size-4" />
            )}
            رفض الطلب
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
