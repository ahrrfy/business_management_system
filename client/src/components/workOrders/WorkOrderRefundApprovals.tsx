import React, { useState } from "react";
import { AlertTriangle, CheckCircle2, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { confirm } from "@/lib/confirm";
import { fmtDateTime } from "@/lib/date";
import { fmtAr } from "@/lib/money";
import { notify } from "@/lib/notify";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import {
  normalizedRefundReference,
  refundApprovalResult,
  refundReferenceError,
} from "@/lib/workOrderRefundPolicy";

export type PendingWorkOrderRefund = RouterOutputs["workOrders"]["pendingCancellationRefunds"][number];

const PAYMENT_METHOD_LABEL: Record<string, string> = {
  CARD: "بطاقة مصرفية",
  CHECK: "شيك",
  TRANSFER: "تحويل مصرفي",
  WALLET: "محفظة إلكترونية",
  EXCHANGE: "حساب صرافة",
};

export type WorkOrderRefundApprovalPayload = {
  receiptId: number;
  confirmationReference: string;
};

type ApprovalResult = {
  receiptId: number;
  replayed: boolean;
};

export function buildWorkOrderRefundApprovalPayload(
  receiptId: number,
  reference: string,
): WorkOrderRefundApprovalPayload {
  const error = refundReferenceError(reference);
  if (error) throw new Error(error);
  return { receiptId, confirmationReference: normalizedRefundReference(reference) };
}

export async function invalidateWorkOrderRefundCaches(utils: {
  workOrders: {
    pendingCancellationRefunds: { invalidate: () => Promise<unknown> | unknown };
    cancellationRefundStatus: { invalidate: () => Promise<unknown> | unknown };
  };
}): Promise<void> {
  await Promise.all([
    utils.workOrders.pendingCancellationRefunds.invalidate(),
    utils.workOrders.cancellationRefundStatus.invalidate(),
  ]);
}

/**
 * بوابة العرض نفسها: غير المالك لا يركّب استعلام ownerProcedure أصلاً.
 * ⭐ قرار المالك (٣/٩/٢٦): لا اعتماد ثانٍ بعد المالك — كل مُشاهدي هذه الشاشة مالكون أصلاً
 * (ownerProcedure)، فلا معنى لتعطيل زرّ الاعتماد لأنّ المالك أنشأ طلبه بنفسه.
 */
export function WorkOrderRefundApprovals({ isOwner }: { isOwner: boolean }) {
  if (!isOwner) return null;
  return <OwnerWorkOrderRefundApprovals />;
}

function OwnerWorkOrderRefundApprovals() {
  const utils = trpc.useUtils();
  const queue = trpc.workOrders.pendingCancellationRefunds.useQuery();
  const [lastResult, setLastResult] = useState<ApprovalResult | null>(null);
  const approve = trpc.workOrders.approveCancellationRefund.useMutation({
    onSuccess: async (result) => {
      setLastResult({ receiptId: Number(result.receiptId), replayed: result.replayed });
      notify.ok(result.replayed ? "الطلب معتمد سابقاً" : "تم اعتماد رد العربون", refundApprovalResult(result.replayed));
      await invalidateWorkOrderRefundCaches(utils);
    },
    onError: (error) => notify.err(error),
  });

  return (
    <WorkOrderRefundApprovalsView
      rows={queue.data ?? []}
      isLoading={queue.isLoading}
      errorMessage={queue.error?.message ?? null}
      lastResult={lastResult}
      pendingReceiptId={approve.isPending ? Number(approve.variables?.receiptId) : null}
      onApprove={(payload) => approve.mutate(payload)}
    />
  );
}

export function WorkOrderRefundApprovalsView({
  rows,
  isLoading,
  errorMessage,
  lastResult,
  pendingReceiptId,
  onApprove,
}: {
  rows: PendingWorkOrderRefund[];
  isLoading: boolean;
  errorMessage: string | null;
  lastResult: ApprovalResult | null;
  pendingReceiptId: number | null;
  onApprove: (payload: WorkOrderRefundApprovalPayload) => void;
}) {
  const [references, setReferences] = useState<Record<number, string>>({});

  async function submit(row: PendingWorkOrderRefund, reference: string) {
    const error = refundReferenceError(reference);
    if (error) {
      notify.warn("مرجع التنفيذ غير مكتمل", error);
      return;
    }
    const approved = await confirm({
      variant: "danger",
      title: "تأكيد تنفيذ رد العربون خارج النظام",
      description: `هل نُفّذ فعلياً رد ${fmtAr(row.amount)} د.ع بطريقة ${PAYMENT_METHOD_LABEL[row.paymentMethod ?? ""] ?? row.paymentMethod ?? "غير محددة"} إلى ${row.customerName ?? `العميل #${row.customerId ?? "—"}`}؟ الاعتماد يثبت إيصال الصرف وقيد PAYMENT_OUT ولا يعني مجرد الموافقة الإدارية.`,
      confirmText: "نعم، نُفّذ الرد واعتمده",
      cancelText: "تراجع",
      requireText: "نُفّذ",
    });
    if (!approved) return;
    onApprove(buildWorkOrderRefundApprovalPayload(Number(row.receiptId), reference));
  }

  return (
    <Card className="border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)]/30">
      <CardHeader className="pb-3">
        <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-base">
          <span className="inline-flex items-center gap-2">
            <AlertTriangle aria-hidden className="size-4 text-[var(--sem-warn)]" />
            طلبات رد عربون غير نقدية بانتظار التنفيذ والاعتماد
          </span>
          <span className="rounded-md border bg-background px-2 py-1 text-xs font-semibold tabular-nums">
            {rows.length} معلّق
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          لا تعتمد الطلب قبل تنفيذ التحويل أو الدفع الخارجي فعلياً. الطلب المعلّق بلا أثر نقدي أو قيد دفع حتى الاعتماد.
        </p>

        {lastResult && (
          <div role="status" className="flex items-start gap-2 rounded-md border border-[var(--sem-pos)]/30 bg-[var(--sem-pos-bg)] p-3 text-sm">
            <CheckCircle2 aria-hidden className="mt-0.5 size-4 shrink-0 text-[var(--sem-pos)]" />
            <div>
              <div className="font-semibold">نتيجة الطلب #{lastResult.receiptId}</div>
              <div className="text-muted-foreground">{refundApprovalResult(lastResult.replayed)}</div>
            </div>
          </div>
        )}

        {isLoading && <div className="rounded-md border bg-background p-4 text-center text-sm text-muted-foreground">جارٍ تحميل طلبات الرد…</div>}
        {errorMessage && <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">تعذّر تحميل طلبات الرد: {errorMessage}</div>}
        {!isLoading && !errorMessage && rows.length === 0 && (
          <div className="rounded-md border bg-background p-4 text-center text-sm text-muted-foreground">لا توجد طلبات رد عربون غير نقدية معلّقة.</div>
        )}

        {rows.map((row) => {
          const receiptId = Number(row.receiptId);
          return (
            <WorkOrderRefundApprovalRow
              key={receiptId}
              row={row}
              reference={references[receiptId] ?? ""}
              isPending={pendingReceiptId === receiptId}
              anyApprovalPending={pendingReceiptId != null}
              onReferenceChange={(value) => setReferences((current) => ({ ...current, [receiptId]: value }))}
              onSubmit={submit}
            />
          );
        })}
      </CardContent>
    </Card>
  );
}

export function WorkOrderRefundApprovalRow({
  row,
  reference,
  isPending,
  anyApprovalPending,
  onReferenceChange,
  onSubmit,
}: {
  row: PendingWorkOrderRefund;
  reference: string;
  isPending: boolean;
  anyApprovalPending: boolean;
  onReferenceChange: (value: string) => void;
  onSubmit: (row: PendingWorkOrderRefund, reference: string) => void | Promise<void>;
}) {
  const receiptId = Number(row.receiptId);
  const referenceError = reference.length > 0 ? refundReferenceError(reference) : null;
  return (
    <section className="rounded-md border bg-background p-4" aria-labelledby={`refund-title-${receiptId}`}>
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(260px,0.7fr)]">
        <div className="space-y-2 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <a id={`refund-title-${receiptId}`} href={`/work-orders/${row.workOrderId}`} className="font-bold text-primary hover:underline">
              أمر الشغل {row.orderNumber ?? `#${row.workOrderId}`}
            </a>
            <ExternalLink aria-hidden className="size-3.5 text-muted-foreground" />
            <span className="rounded-md bg-muted px-2 py-0.5 text-xs">طلب صرف #{receiptId}</span>
          </div>
          <dl className="grid grid-cols-2 gap-x-5 gap-y-2 sm:grid-cols-3">
            <div><dt className="text-xs text-muted-foreground">المبلغ</dt><dd dir="ltr" className="font-bold tabular-nums text-end">{fmtAr(row.amount)} د.ع</dd></div>
            <div><dt className="text-xs text-muted-foreground">طريقة الرد</dt><dd className="font-medium">{PAYMENT_METHOD_LABEL[row.paymentMethod ?? ""] ?? row.paymentMethod ?? "—"}</dd></div>
            <div><dt className="text-xs text-muted-foreground">الطرف</dt><dd className="font-medium">{row.customerName ?? `عميل #${row.customerId ?? "—"}`}</dd></div>
            <div><dt className="text-xs text-muted-foreground">أنشأ الطلب</dt><dd>{row.creatorName ?? `مستخدم #${row.createdBy ?? "—"}`}</dd></div>
            <div><dt className="text-xs text-muted-foreground">وقت الطلب</dt><dd dir="ltr" className="text-end">{fmtDateTime(row.createdAt)}</dd></div>
            <div><dt className="text-xs text-muted-foreground">الحالة</dt><dd className="font-semibold text-[var(--sem-warn)]">بانتظار اعتماد المالك</dd></div>
          </dl>
        </div>

        <div className="space-y-2 border-t pt-3 lg:border-s lg:border-t-0 lg:ps-4 lg:pt-0">
          <Label htmlFor={`refund-reference-${receiptId}`}>مرجع تنفيذ الاسترداد الخارجي</Label>
          <Input
            id={`refund-reference-${receiptId}`}
            dir="ltr"
            value={reference}
            maxLength={100}
            placeholder="رقم التحويل أو إشعار الدفع"
            aria-invalid={referenceError != null}
            aria-describedby={`refund-help-${receiptId}`}
            onChange={(event) => onReferenceChange(event.target.value)}
          />
          <p id={`refund-help-${receiptId}`} className={referenceError ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
            {referenceError ?? "مرجع فريد من كشف البنك أو البطاقة أو المحفظة (3–100 محرف)."}
          </p>
          <Button
            className="w-full"
            disabled={anyApprovalPending || refundReferenceError(reference) != null}
            onClick={() => void onSubmit(row, reference)}
          >
            {isPending ? "جارٍ تثبيت الرد…" : "تأكيد التنفيذ واعتماد الرد"}
          </Button>
        </div>
      </div>
    </section>
  );
}
