import { useEffect, useState } from "react";
import { Ban } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { notify } from "@/lib/notify";
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

export function CancelDeliveryAssignmentDialog({
  consignment,
  open,
  onOpenChange,
  onCompleted,
}: {
  consignment: { id: number; number: string } | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCompleted?: () => void;
}) {
  const utils = trpc.useUtils();
  const [reason, setReason] = useState("");
  const [clientRequestId, setClientRequestId] = useState(() =>
    crypto.randomUUID(),
  );

  useEffect(() => {
    if (!open) return;
    setReason("");
    setClientRequestId(crypto.randomUUID());
  }, [open, consignment?.id]);

  const cancel = trpc.delivery.cancelAssignment.useMutation({
    onSuccess: async () => {
      notify.ok(
        "أُلغي إسناد التوصيل",
        "حُررت عهدة المندوب وبقيت الفاتورة والمخزون والمقبوضات كما هي.",
      );
      await Promise.all([
        utils.delivery.invalidate(),
        utils.sales.list.invalidate(),
        utils.sales.listPage.invalidate(),
      ]);
      onOpenChange(false);
      onCompleted?.();
    },
    onError: (error) => notify.err(error),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent dir="rtl" className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-destructive">
            <Ban aria-hidden className="size-4" /> إلغاء إسناد الإرسالية{" "}
            {consignment?.number ?? ""}
          </DialogTitle>
          <DialogDescription className="text-start leading-6">
            هذا الإجراء يلغي التوصيل فقط قبل قبول المندوب للطرد. لا يلغي
            الفاتورة، ولا يعيد البضاعة للمخزون، ولا يصرف أو يقبض نقداً.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="delivery-cancel-reason">سبب الإلغاء *</Label>
          <Textarea
            id="delivery-cancel-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            rows={3}
            maxLength={500}
            placeholder="مثال: العميل سيستلم من الفرع"
          />
        </div>
        <DialogFooter className="gap-2 sm:justify-start">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={cancel.isPending}
          >
            رجوع
          </Button>
          <Button
            variant="destructive"
            disabled={
              !consignment || reason.trim().length < 3 || cancel.isPending
            }
            onClick={() =>
              consignment &&
              cancel.mutate({
                consignmentId: consignment.id,
                reason: reason.trim(),
                clientRequestId,
              })
            }
          >
            {cancel.isPending ? "جارٍ الإلغاء…" : "إلغاء إسناد التوصيل"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
