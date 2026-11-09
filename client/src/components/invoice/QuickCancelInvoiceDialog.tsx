import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertCircle, FileWarning } from "lucide-react";
import { ACTION_LABELS } from "@shared/actionLabels";
import { invoiceStatusLabel } from "@shared/invoiceStatus";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AppSelect } from "@/components/ui/AppSelect";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useInvoiceActionPermissions } from "@/hooks/useInvoiceActionPermissions";
import { D, fmt, round2 } from "@/lib/money";
import { notify } from "@/lib/notify";
import { POS_METHODS as METHODS } from "@/lib/paymentMethod";
import { preopenDocumentWindow } from "@/lib/printing/brand";
import { printOrderCancellationReceipt } from "@/lib/printing/cashierLifecycleReceipts";
import { invalidateFinancialQueries } from "@/lib/realtime/financialQueries";
import { trpc } from "@/lib/trpc";
import ReverseDeliveryRequestDialog from "@/components/workorder/ReverseDeliveryRequestDialog";

const CANCEL_REASON_PRESETS = [
  "تراجع الزبون",
  "خطأ في الإدخال",
  "تغيير الطلب",
  "طلب مكرر",
] as const;

type CancelMethod = (typeof METHODS)[number]["v"] | "MIXED";

export interface QuickCancelInvoiceDialogProps {
  invoiceId: number | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: (message: string) => void;
  onSwitchToReturn?: (invoiceId: number) => void;
}

export function QuickCancelInvoiceDialog(props: QuickCancelInvoiceDialogProps) {
  if (!props.open || !props.invoiceId) return null;
  return <QuickCancelInvoiceDialogInner {...props} />;
}

function QuickCancelInvoiceDialogInner({
  invoiceId,
  open,
  onOpenChange,
  onSuccess,
  onSwitchToReturn,
}: QuickCancelInvoiceDialogProps) {
  const utils = trpc.useUtils();
  const queryClient = useQueryClient();
  const me = trpc.auth.me.useQuery();
  const {
    canCancelInvoice,
    canCancelUnpaidCodInvoice,
    canReverseWorkOrder,
  } = useInvoiceActionPermissions(me.data);

  const inv = trpc.sales.get.useQuery(
    { invoiceId: invoiceId ?? 0 },
    { enabled: open && Boolean(invoiceId && invoiceId > 0) },
  );

  const [reason, setReason] = useState<string>(CANCEL_REASON_PRESETS[0]);
  const [cancelMethod, setCancelMethod] = useState<CancelMethod>("CASH");
  const [error, setError] = useState("");
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const printWinRef = useRef<Window | null>(null);

  const data = inv.data;

  useEffect(() => {
    if (!open) return;
    setError("");
    setReason((prev) => (prev.trim().length >= 3 ? prev : CANCEL_REASON_PRESETS[0]));
    setRequestId(crypto.randomUUID());
  }, [open, invoiceId]);

  useEffect(() => {
    if (!data) return;
    const byMethod =
      (data as { refundableByMethod?: Record<string, string> }).refundableByMethod ?? {};
    const mixed =
      data.paymentMethod === "MIXED" || Object.keys(byMethod).length > 1;
    if (mixed) {
      setCancelMethod("MIXED");
      return;
    }
    const raw = data.paymentMethod as CancelMethod | null;
    if (raw && METHODS.some((m) => m.v === raw)) {
      setCancelMethod(raw);
    } else {
      setCancelMethod("CASH");
    }
  }, [data]);

  async function refreshAfterCancel(branchId?: number | null, executed = true) {
    await Promise.all([
      invoiceId ? utils.sales.get.invalidate({ invoiceId }) : Promise.resolve(),
      utils.sales.list.invalidate(),
      utils.sales.listPage.invalidate(),
      utils.sales.listSummary.invalidate(),
      utils.reception.invoiceQueue.invalidate(),
      utils.salesControl.list.invalidate(),
      executed ? invalidateFinancialQueries(queryClient, branchId ?? undefined) : Promise.resolve(),
    ]);
  }

  const cancelMutation = trpc.sales.cancel.useMutation({
    onSuccess: async (r) => {
      const win = printWinRef.current;
      printWinRef.current = null;
      const msg =
        r.mode === "EXECUTED"
          ? D(r.pendingRefundAmount ?? "0").gt(0)
            ? `تم إلغاء الفاتورة وإنشاء سند صرف بقيمة ${fmt(r.pendingRefundAmount ?? "0")}`
            : D(r.refundAmount ?? "0").gt(0)
              ? `تم إلغاء الفاتورة ورد ${fmt(r.refundAmount ?? "0")} للزبون`
              : "تم إلغاء الفاتورة بنجاح"
          : `أُرسل طلب إلغاء الفاتورة (#${r.requestId}) لموافقة المدير`;

      if (r.mode === "EXECUTED" && data) {
        void printOrderCancellationReceipt(
          {
            documentNumber: data.invoiceNumber,
            orderKind: "INVOICE",
            customerName: data.customerName,
            customerPhone: data.customerPhone,
            originalTotal: data.total,
            refundedAmount: r.refundAmount ?? "0",
            pendingRefundAmount: r.pendingRefundAmount ?? "0",
            pendingRefundRef: r.refundVoucherNumber ?? null,
            refundMethod: cancelMethod,
            reason: reason.trim(),
            cashierName: me.data?.name ?? null,
          },
          { into: win },
        ).catch(() => {});
      } else {
        try {
          win?.close();
        } catch {
          /* noop */
        }
      }

      notify.ok(r.mode === "EXECUTED" ? "تم إلغاء الفاتورة" : "أُرسل الطلب للمدير", msg);
      setError("");
      onOpenChange(false);
      await refreshAfterCancel(data?.branchId, r.mode === "EXECUTED");
      setRequestId(crypto.randomUUID());
      onSuccess?.(msg);
    },
    onError: (err) => {
      try {
        printWinRef.current?.close();
      } catch {
        /* noop */
      }
      printWinRef.current = null;
      setError(err.message);
    },
  });

  const cancelUnpaidCodMutation = trpc.sales.cancelUnpaidCod.useMutation({
    onSuccess: async () => {
      const win = printWinRef.current;
      printWinRef.current = null;
      if (data) {
        void printOrderCancellationReceipt(
          {
            documentNumber: data.invoiceNumber,
            orderKind: "INVOICE",
            customerName: data.customerName,
            customerPhone: data.customerPhone,
            originalTotal: data.total,
            refundedAmount: "0",
            reason: reason.trim(),
            cashierName: me.data?.name ?? null,
          },
          { into: win },
        ).catch(() => {});
      }
      const msg = "تم إلغاء الفاتورة بنجاح";
      notify.ok("تم إلغاء الفاتورة", msg);
      setError("");
      onOpenChange(false);
      await refreshAfterCancel(data?.branchId, true);
      setRequestId(crypto.randomUUID());
      onSuccess?.(msg);
    },
    onError: (err) => {
      try {
        printWinRef.current?.close();
      } catch {
        /* noop */
      }
      printWinRef.current = null;
      setError(err.message);
    },
  });

  const paidAmountForRefund = round2(D(data?.refundablePaidAmount ?? "0"));
  const refundableByMethod =
    (data as { refundableByMethod?: Record<string, string> } | undefined)?.refundableByMethod ?? {};
  const isMixedRefundable =
    data?.paymentMethod === "MIXED" || Object.keys(refundableByMethod).length > 1;
  const useLimitedCancellation =
    Boolean(data) &&
    !canCancelInvoice &&
    canCancelUnpaidCodInvoice &&
    Boolean(data?.unpaidCodCancellationEligible);
  const canProceed = canCancelInvoice || useLimitedCancellation;
  const isBusy = cancelMutation.isPending || cancelUnpaidCodMutation.isPending;

  const linkedWorkOrderId = (() => {
    const m = /^WO-(\d+)(?::R\d+)?$/.exec(String(data?.sourceId ?? ""));
    return m ? Number(m[1]) : null;
  })();

  const deliveryBlockReason =
    data?.consignmentId == null
      ? null
      : data.consignmentStatus === "DELIVERED" ||
          data.consignmentStatus === "PARTIAL" ||
          data.consignmentParcelStatus === "DELIVERED"
        ? "الطرد مُسلّم للزبون — استعمل زر «مرتجع» لإرجاع الأصناف."
        : data.consignmentStatus === "WRITTEN_OFF" || data.consignmentStatus === "RETURNED"
          ? "للشحنة تسوية توصيل سابقة — راجع شاشة التوصيل أولاً."
          : null;

  function handleConfirm() {
    if (!invoiceId || !data || reason.trim().length < 3 || isBusy) return;
    setError("");
    printWinRef.current = preopenDocumentWindow();
    if (useLimitedCancellation) {
      cancelUnpaidCodMutation.mutate({
        invoiceId,
        reason: reason.trim(),
        clientRequestId: requestId,
      });
      return;
    }
    cancelMutation.mutate({
      invoiceId,
      refundPaymentMethod: paidAmountForRefund.isZero() ? "CASH" : cancelMethod,
      reason: reason.trim(),
      clientRequestId: requestId,
    });
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !isBusy && onOpenChange(next)}>
      <DialogContent className="sm:max-w-md" dir="rtl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-destructive">
            <FileWarning aria-hidden className="size-5 shrink-0" />
            <span>
              إلغاء الفاتورة{" "}
              {data?.invoiceNumber ? (
                <span dir="ltr" className="font-mono">
                  #{data.invoiceNumber}
                </span>
              ) : null}
            </span>
          </DialogTitle>
          <DialogDescription>
            {data
              ? `${data.customerName ?? "زبون نقدي"} · الإجمالي ${fmt(data.total)} · ${invoiceStatusLabel(data.status)}`
              : "تأكيد إلغاء الفاتورة وإعادة الأصناف للمخزون."}
          </DialogDescription>
        </DialogHeader>

        {inv.isLoading ? (
          <div className="py-6 text-center text-sm text-muted-foreground">
            {ACTION_LABELS.loading}
          </div>
        ) : inv.isError || !data ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            {inv.error?.message ?? "تعذّر تحميل بيانات الفاتورة."}
          </div>
        ) : data.sourceType === "WORKORDER" ? (
          <div className="space-y-3 py-1">
            <p className="rounded-md border bg-muted/40 p-3 text-sm">
              هذه فاتورة طلب مطبعة مُسلَّم. لإرجاعها أو إلغائها اضغط الزر أدناه لإرسال طلب عكس التسليم.
            </p>
            {canReverseWorkOrder && linkedWorkOrderId != null ? (
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => onOpenChange(false)}>
                  إغلاق
                </Button>
                <ReverseDeliveryRequestDialog
                  workOrderId={linkedWorkOrderId}
                  orderNumber={String(data.sourceId ?? linkedWorkOrderId)}
                  title={`فاتورة ${data.invoiceNumber}`}
                  buttonLabel="متابعة عكس التسليم"
                  size="sm"
                  onRequested={(msg) => {
                    onOpenChange(false);
                    onSuccess?.(msg);
                  }}
                />
              </div>
            ) : null}
          </div>
        ) : deliveryBlockReason ? (
          <div className="space-y-3 py-1">
            <div className="rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] p-3 text-sm text-[var(--sem-warn)]">
              {deliveryBlockReason}
            </div>
            <DialogFooter className="gap-2">
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                إغلاق
              </Button>
              {onSwitchToReturn && invoiceId ? (
                <Button
                  onClick={() => {
                    onOpenChange(false);
                    onSwitchToReturn(invoiceId);
                  }}
                >
                  فتح المرتجع
                </Button>
              ) : null}
            </DialogFooter>
          </div>
        ) : (
          <>
            <div className="space-y-3">
              {paidAmountForRefund.gt(0) ? (
                <div className="rounded-lg border bg-muted/30 p-3 space-y-2">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">المبلغ المسترد للزبون</span>
                    <span className="font-mono font-bold text-destructive">
                      {fmt(paidAmountForRefund.toFixed(2))}
                    </span>
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="quick-cancel-method" className="text-xs">
                      طريقة ردّ المبلغ
                    </Label>
                    <AppSelect
                      id="quick-cancel-method"
                      className="h-9"
                      value={cancelMethod}
                      onValueChange={(v) => setCancelMethod(v as CancelMethod)}
                    >
                      {isMixedRefundable ? (
                        <option value="MIXED">نفس طرق الدفع الأصلية تلقائياً</option>
                      ) : null}
                      {METHODS.map((m) => (
                        <option key={m.v} value={m.v}>
                          {m.label}
                        </option>
                      ))}
                    </AppSelect>
                  </div>
                </div>
              ) : (
                <div className="rounded-md border bg-muted/25 px-3 py-2 text-xs text-muted-foreground">
                  لا يوجد مبلغ مدفوع على الفاتورة — ستُلغى الفاتورة وتُعاد الأصناف للمخزون مباشرة.
                </div>
              )}

              <div className="space-y-1.5">
                <Label htmlFor="quick-cancel-reason" className="text-xs">
                  سبب الإلغاء
                </Label>
                <div className="flex flex-wrap gap-1.5">
                  {CANCEL_REASON_PRESETS.map((preset) => {
                    const active = reason.trim() === preset;
                    return (
                      <Button
                        key={preset}
                        type="button"
                        size="sm"
                        variant={active ? "default" : "outline"}
                        className="h-7 px-2.5 text-xs"
                        onClick={() => setReason(preset)}
                      >
                        {preset}
                      </Button>
                    );
                  })}
                </div>
                <Input
                  id="quick-cancel-reason"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  maxLength={500}
                  placeholder="اكتب سبب الإلغاء..."
                  className="h-9"
                />
              </div>

              {error ? (
                <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2.5 text-xs text-destructive">
                  <AlertCircle aria-hidden className="size-4 shrink-0 mt-0.5" />
                  <span>{error}</span>
                </div>
              ) : null}
            </div>

            <DialogFooter className="gap-2 sm:justify-between">
              <Button
                type="button"
                variant="outline"
                disabled={isBusy}
                onClick={() => onOpenChange(false)}
              >
                تراجع
              </Button>
              <Button
                type="button"
                variant="destructive"
                disabled={!canProceed || isBusy || reason.trim().length < 3}
                onClick={handleConfirm}
              >
                {isBusy ? ACTION_LABELS.processing : "تأكيد إلغاء الفاتورة"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
