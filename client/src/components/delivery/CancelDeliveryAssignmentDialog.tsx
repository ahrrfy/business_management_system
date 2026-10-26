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
import { Checkbox } from "@/components/ui/checkbox";
import { ACTION_LABELS as L } from "@shared/actionLabels";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export function CancelDeliveryAssignmentDialog({
  consignment,
  open,
  onOpenChange,
  onCompleted,
  branchId,
  onNavigateToAftercare,
}: {
  consignment: { id: number; number: string } | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCompleted?: () => void;
  branchId?: number;
  onNavigateToAftercare?: (context: {
    caseId?: number;
    executionId?: number;
    raw?: string;
  }) => void;
}) {
  const utils = trpc.useUtils();
  const [reason, setReason] = useState("");
  const [physicalHeld, setPhysicalHeld] = useState(false);
  const preview = trpc.delivery.workflow.previewBySource.useQuery(
    {
      source: { kind: "consignment", id: consignment?.id ?? 0 },
      station: "cancelAssignment",
      branchId,
    },
    { enabled: open && consignment != null, retry: false },
  );
  const canCancel = preview.data?.actions.find(
    (a) => a.action === "cancelAssignment",
  );
  const canDeclare = preview.data?.actions.find(
    (a) => a.action === "declareReturn",
  );
  const isAftercare = preview.data?.relations.aftercareExecutionId != null;
  const [clientRequestId, setClientRequestId] = useState(() =>
    crypto.randomUUID(),
  );

  useEffect(() => {
    if (!open) return;
    setReason("");
    setPhysicalHeld(false);
    setClientRequestId(crypto.randomUUID());
  }, [open, consignment?.id]);

  const cancel = trpc.delivery.workflow.assignment.useMutation({
    onSuccess: async (_result, input) => {
      notify.ok(
        input.action === "declareReturn"
          ? "سُجل إعلان رجوع الطرد"
          : "أُلغي إسناد التوصيل",
        "لم يثبت بهذا الإجراء استلام بضاعة أو رد مال؛ تابع الاستلام والفحص من محطته عند الرجوع.",
      );
      await Promise.all([
        utils.delivery.invalidate(),
        utils.sales.get.invalidate(),
        utils.sales.list.invalidate(),
        utils.sales.listPage.invalidate(),
        utils.sales.listSummary.invalidate(),
      ]);
      onOpenChange(false);
      onCompleted?.();
    },
    onError: (error) => notify.err(error),
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!cancel.isPending) onOpenChange(next);
      }}
    >
      <DialogContent dir="rtl" className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-destructive">
            <Ban aria-hidden className="size-4" /> إلغاء إسناد الإرسالية{" "}
            {consignment?.number ?? ""}
          </DialogTitle>
          <DialogDescription className="text-start leading-6">
            الإسناد يعني أن جهة التوصيل استلمت الشحنة وأصبحت بعهدتها. لا يُلغى
            الإسناد إلا بعد عودة كامل الشحنة فعلياً إلى المكتبة؛ بعدها يصبح الطلب
            حراً لإعادة الإسناد، دون إلغاء البيع أو إعادة المخزون.
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
        {preview.isError && (
          <p role="alert" className="text-sm text-destructive">
            {preview.error.message}
          </p>
        )}
        {canCancel && !canCancel.allowed && (
          <p className="text-sm text-muted-foreground">{canCancel.reason}</p>
        )}
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={physicalHeld}
              onCheckedChange={(checked) => setPhysicalHeld(checked === true)}
              disabled={cancel.isPending || !canCancel?.allowed}
            />{" "}
            تحققت فعلياً أن كامل الشحنة عادت إلى عهدة المكتبة
          </label>
          {isAftercare && onNavigateToAftercare && (
              <Button
                variant="outline"
                onClick={() =>
                  onNavigateToAftercare({
                    caseId: preview.data?.relations.aftercareCaseId,
                    executionId: preview.data?.relations.aftercareExecutionId,
                  })
                }
              >
                فتح محضر المعالجة والعهدة
              </Button>
          )}
        </div>
        <DialogFooter className="gap-2 sm:justify-start">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={cancel.isPending}
          >
            رجوع
          </Button>
          {!canCancel?.allowed && canDeclare?.allowed && (
            <Button
              variant="outline"
              disabled={reason.trim().length < 3 || cancel.isPending}
              onClick={() =>
                preview.data &&
                cancel.mutate({
                  source: {
                    kind: preview.data.source.kind,
                    id: preview.data.source.id,
                    expectedVersion: preview.data.source.version,
                  },
                  branchId: preview.data.source.branchId,
                  action: "declareReturn",
                  reason: reason.trim(),
                  clientRequestId: `${clientRequestId}:declare`,
                })
              }
            >
              إعلان الرجوع دون إثبات استلام
            </Button>
          )}
          <Button
            variant="destructive"
            disabled={
              !preview.data ||
              !canCancel?.allowed ||
              reason.trim().length < 3 ||
              cancel.isPending ||
              !physicalHeld
            }
            onClick={() =>
              preview.data &&
              cancel.mutate({
                source: {
                  kind: preview.data.source.kind,
                  id: preview.data.source.id,
                  expectedVersion: preview.data.source.version,
                },
                branchId: preview.data.source.branchId,
                action: "cancelAssignment",
                reason: reason.trim(),
                clientRequestId,
                physicalHeldConfirmed: physicalHeld,
              })
            }
          >
            {cancel.isPending ? L.cancelling : "إلغاء الإسناد وتحرير الطلب"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
