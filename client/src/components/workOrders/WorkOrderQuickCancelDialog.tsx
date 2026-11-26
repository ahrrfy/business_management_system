import { useRef } from "react";
import { PackageX } from "lucide-react";
import { ACTION_LABELS } from "@shared/actionLabels";
import { variantDisplayName } from "@shared/variantDisplay";
import CancelWorkOrderDialog, { type CancelDecision } from "./CancelWorkOrderDialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { newClientRequestId } from "@/lib/countQueue";
import { notify } from "@/lib/notify";
import { preopenDocumentWindow } from "@/lib/printing/brand";
import { printOrderCancellationReceipt } from "@/lib/printing/cashierLifecycleReceipts";
import { trpc } from "@/lib/trpc";
import {
  workOrderDetailOperationAccess,
  workOrderDirectCancellationAllowed,
} from "@/lib/workOrderDetailOperationAccess";
import { cancellationRefundNotice } from "@/lib/workOrderRefundPolicy";

export interface WorkOrderQuickCancelDialogProps {
  workOrderId: number | null;
  onOpenChange: (open: boolean) => void;
  onSuccess?: (message: string) => void;
}

export function WorkOrderQuickCancelDialog({
  workOrderId,
  onOpenChange,
  onSuccess,
}: WorkOrderQuickCancelDialogProps) {
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const { canReadControlPreflight, canCancelDirectly, canOpenCancellation } =
    workOrderDetailOperationAccess(me.data);

  const active = workOrderId != null && workOrderId > 0;
  const wo = trpc.workOrders.get.useQuery(
    { workOrderId: workOrderId ?? 0 },
    { enabled: active },
  );
  const controlPreflight = trpc.workOrders.controlPreflight.useQuery(
    { workOrderId: workOrderId ?? 0 },
    { enabled: active && canReadControlPreflight && canOpenCancellation },
  );
  const printWinRef = useRef<Window | null>(null);

  async function refreshAll(id: number) {
    await Promise.all([
      utils.workOrders.get.invalidate({ workOrderId: id }),
      utils.workOrders.controlPreflight.invalidate({ workOrderId: id }),
      utils.workOrders.list.invalidate(),
      utils.workOrders.counts.invalidate(),
      utils.workOrders.pendingControlRequests.invalidate(),
      utils.reception.invoiceQueue.invalidate(),
    ]);
  }

  const cancelMut = trpc.workOrders.cancel.useMutation({
    onSuccess: async (result, vars) => {
      const win = printWinRef.current;
      printWinRef.current = null;
      const d = wo.data;
      const notice = cancellationRefundNotice(
        result.pendingRefundReceiptIds,
        result.replayed,
      );
      if (d) {
        void printOrderCancellationReceipt(
          {
            documentNumber: d.orderNumber,
            orderKind: "WORK_ORDER",
            customerName: d.customerName,
            customerPhone: d.customerPhone,
            originalTotal: d.salePrice,
            refundedAmount: notice.awaitingOwner ? "0" : (d.deposit ?? "0"),
            pendingRefundAmount: notice.awaitingOwner ? (d.deposit ?? "0") : "0",
            pendingRefundRef:
              notice.awaitingOwner && result.pendingRefundReceiptIds?.length
                ? `#${result.pendingRefundReceiptIds.join(", #")}`
                : null,
            refundMethod: vars.refundRail ?? "CASH",
            reason: vars.reason,
            cashierName: me.data?.name,
          },
          win ? { into: win } : undefined,
        ).catch(() => {
          try {
            win?.close();
          } catch {
            /* noop */
          }
        });
      }
      notify.ok(notice.title, notice.description);
      onOpenChange(false);
      await refreshAll(vars.workOrderId);
      onSuccess?.(`${notice.title} — ${notice.description}`);
    },
    onError: (err) => {
      try {
        printWinRef.current?.close();
      } catch {
        /* noop */
      }
      printWinRef.current = null;
      notify.err(err);
    },
  });

  const requestControlMut = trpc.workOrders.requestControl.useMutation({
    onSuccess: async (result, vars) => {
      const msg = result.replayed
        ? "طلب الإلغاء مُسجّل مسبقاً وبانتظار موافقة المدير."
        : "أُرسل طلب إلغاء الطلب لموافقة المدير.";
      notify.ok("أُرسل طلب الإلغاء", msg);
      onOpenChange(false);
      await refreshAll(vars.workOrderId);
      onSuccess?.(msg);
    },
    onError: (err) => notify.err(err),
  });

  if (!active) return null;

  const d = wo.data;
  if (!d) {
    return (
      <Dialog open onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-md" dir="rtl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <PackageX aria-hidden className="size-4" />
              إلغاء الطلب
            </DialogTitle>
            <DialogDescription>
              {wo.isError
                ? "تعذّر تحميل بيانات الطلب — أعد المحاولة."
                : ACTION_LABELS.loading}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              إغلاق
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  const cancelDirectAllowed = workOrderDirectCancellationAllowed(
    me.data,
    controlPreflight.data,
    canCancelDirectly,
  );
  const requiresApproval = !cancelDirectAllowed;
  const approvalRefundPreflight = requiresApproval
    ? controlPreflight.data == null
      ? null
      : {
          needsCashDrawer: controlPreflight.data.cashRefundRequired,
          cardRefundAllowed: controlPreflight.data.cardRefundAllowed,
          estimatedCashOut: controlPreflight.data.expectedCashRefund,
          branchId: controlPreflight.data.branchId,
          drawers: controlPreflight.data.openReceptionShifts.map((shift) => ({
            shiftId: shift.id,
            userId: shift.userId,
            userName: shift.userName ?? `#${shift.userId}`,
            shiftType: "RECEPTION" as const,
            ...(shift.expectedCash == null
              ? {}
              : { expectedCash: shift.expectedCash }),
            sufficient: shift.sufficient,
          })),
          treasuryCash: controlPreflight.data.treasuryCash,
          treasurySufficient: controlPreflight.data.treasurySufficient,
        }
    : undefined;

  function handleConfirm(decision: CancelDecision) {
    if (!workOrderId) return;
    const preflight = controlPreflight.data;
    if (!preflight) {
      notify.err("انتظر لحظة حتى يكتمل تحميل بيانات الطلب ثم أعد التأكيد.");
      return;
    }
    if (requiresApproval) {
      requestControlMut.mutate({
        requestType: "CANCEL",
        requestKey: newClientRequestId(),
        workOrderId,
        baseVersion: preflight.version,
        reason: decision.reason,
        payload: {
          refundShiftId: decision.refundShiftId,
          refundRail: decision.refundRail,
          refundReference: decision.refundReference,
          materials: decision.materials,
          confirmAllMaterialsReturnedUsable:
            decision.confirmAllMaterialsReturnedUsable,
        },
      });
      return;
    }
    printWinRef.current = preopenDocumentWindow();
    cancelMut.mutate({
      workOrderId,
      expectedVersion: preflight.version,
      clientRequestId: newClientRequestId(),
      refundShiftId: decision.refundShiftId,
      refundRail: decision.refundRail,
      refundReference: decision.refundReference,
      reason: decision.reason,
      materials: decision.materials,
      confirmAllMaterialsReturnedUsable:
        decision.confirmAllMaterialsReturnedUsable,
    });
  }

  return (
    <CancelWorkOrderDialog
      open
      onOpenChange={onOpenChange}
      workOrderId={workOrderId}
      orderNumber={d.orderNumber}
      title={d.title}
      materials={
        d.status === "IN_PROGRESS" || d.status === "READY"
          ? (d.materials ?? []).map((m) => ({
              id: Number(m.id),
              name:
                variantDisplayName({
                  productName: m.productName ?? "",
                  variantName: m.variantName,
                  color: m.color,
                  size: m.size,
                  variantKind: m.variantKind,
                  sku: m.sku,
                }) ||
                m.sku ||
                `#${m.variantId}`,
              baseQuantity: Number(m.baseQuantity),
              unitCost: m.unitCost ?? null,
              lineCost: m.lineCost ?? null,
            }))
          : []
      }
      requiresApproval={requiresApproval}
      refundPreflight={approvalRefundPreflight}
      refundPreflightPending={
        requiresApproval &&
        (controlPreflight.isLoading || controlPreflight.isFetching)
      }
      refundPreflightError={requiresApproval && controlPreflight.isError}
      onRetryRefundPreflight={() => {
        void controlPreflight.refetch();
      }}
      pending={cancelMut.isPending || requestControlMut.isPending}
      onConfirm={handleConfirm}
    />
  );
}
