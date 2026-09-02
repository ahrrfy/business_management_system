import { useState } from "react";
import { Link } from "wouter";
import { Check, FileWarning, RefreshCcw, X } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { ErrorState, LoadingState } from "@/components/PageState";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { confirm } from "@/lib/confirm";
import { fmt } from "@/lib/money";
import { trpc } from "@/lib/trpc";
import { ACTION_LABELS } from "@shared/actionLabels";
import {
  SALES_CONTROL_STATUS_LABELS,
  SALES_CONTROL_TYPE_LABELS,
  type SalesControlStatus,
  type SalesControlType,
} from "@shared/salesControl";
import { moduleAccessAllowed, type PermissionMap, type RoleKey } from "@shared/permissions";

const STATUS_BADGE_VARIANTS: Record<
  SalesControlStatus,
  "warning" | "success" | "danger" | "neutral"
> = {
  PENDING: "warning",
  APPROVED: "success",
  REJECTED: "danger",
  STALE: "neutral",
};

function payloadFacts(type: SalesControlType, value: unknown): Array<{ label: string; value: string }> {
  const payload = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const lines = Array.isArray(payload.lines) ? payload.lines : [];
  if (type === "SALES_DUE_DATE_CHANGE") {
    return [{
      label: "تاريخ الاستحقاق المطلوب",
      value: payload.dueDate == null ? "إزالة تاريخ الاستحقاق" : String(payload.dueDate),
    }];
  }
  if (type === "SALES_CANCEL") {
    return [{ label: "جهة الاسترداد", value: String(payload.refundPaymentMethod ?? "غير محددة") }];
  }
  if (type === "SALES_RETURN") {
    const refund = payload.refund && typeof payload.refund === "object"
      ? payload.refund as Record<string, unknown>
      : payload.resolution && typeof payload.resolution === "object"
        ? payload.resolution as Record<string, unknown>
        : null;
    return [
      { label: "بنود الإرجاع", value: String(lines.length) },
      { label: "مصير البضاعة", value: payload.restock === false ? "تالفة — لا تعاد للمخزون" : "سليمة — تعاد للمخزون" },
      { label: "مبلغ الرد", value: refund?.amount == null ? "لا يوجد رد فوري" : `${fmt(String(refund.amount))} د.ع` },
      { label: "طريقة الرد", value: String(refund?.method ?? "—") },
    ];
  }
  const payment = payload.additionalPayment && typeof payload.additionalPayment === "object"
    ? payload.additionalPayment as Record<string, unknown>
    : null;
  return [
    { label: "بنود الفاتورة البديلة", value: String(lines.length) },
    { label: "العميل البديل", value: payload.customerId == null ? "كما هو/عابر" : `#${String(payload.customerId)}` },
    { label: "تحصيل فرق الآن", value: payment?.amount == null ? "لا يوجد" : `${fmt(String(payment.amount))} د.ع — ${String(payment.method ?? "")}` },
    { label: "معالجة الزيادة", value: payload.overpayHandling === "CASH_REFUND" ? "رد نقدي" : payload.overpayHandling === "CREDIT" ? "رصيد دائن" : "حسب النتيجة" },
  ];
}

function isReviewerConflict(
  reviewerId: number | null | undefined,
  request: { requestedBy: number; invoiceCreatedBy: number | null },
): boolean {
  return reviewerId != null && (
    Number(request.requestedBy) === Number(reviewerId)
    || Number(request.invoiceCreatedBy ?? -1) === Number(reviewerId)
  );
}

export default function SalesControlApprovals() {
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const canReview = !!me.data?.role && moduleAccessAllowed(
    me.data.role as RoleKey,
    (me.data.permissionsOverride ?? null) as PermissionMap | null,
    "sales",
    "FULL",
    ["manager"],
  );
  const pending = trpc.salesControl.list.useQuery(
    canReview ? { status: "PENDING" } : { mine: true },
  );
  const [rejecting, setRejecting] = useState<number | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function refresh() {
    await pending.refetch();
  }

  const approve = trpc.salesControl.approve.useMutation({
    onSuccess: async (result) => {
      setMessage(result.replayed ? "الطلب منفّذ سلفاً." : "اعتمد الطلب ونُفِّذ أثره ذرّياً.");
      setError("");
      await Promise.all([
        utils.salesControl.list.invalidate(),
        utils.sales.list.invalidate(),
        utils.returns.list.invalidate(),
      ]);
    },
    onError: (cause) => { setError(cause.message); setMessage(""); },
  });
  const reject = trpc.salesControl.reject.useMutation({
    onSuccess: async () => {
      setRejecting(null);
      setRejectReason("");
      setMessage("رُفض الطلب وحُفظ السبب بلا أي أثر مالي أو مخزني.");
      setError("");
      await utils.salesControl.list.invalidate();
    },
    onError: (cause) => { setError(cause.message); setMessage(""); },
  });

  async function approveOne(requestId: number, invoiceNumber: string, type: SalesControlType) {
    if (!(await confirm({
      variant: "danger",
      title: `اعتماد ${SALES_CONTROL_TYPE_LABELS[type]}`,
      description: `سيُنفَّذ الأثر الآن على الفاتورة ${invoiceNumber} داخل معاملة واحدة. لا يمكن للطالب أو منشئ الفاتورة اعتمادها.`,
      confirmText: "اعتماد وتنفيذ",
      requireText: invoiceNumber,
    }))) return;
    approve.mutate({ requestId });
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title={canReview ? "اعتمادات عمليات البيع" : "طلباتي على فواتير البيع"}
        description={canReview
          ? "طلبات الإرجاع والإلغاء وإعادة الإصدار والاستبدال — الطلب صفري الأثر حتى اعتماد مراجع مستقل."
          : "تابع حالة طلباتك؛ لا يتغير المال أو المخزون قبل اعتماد مدير مستقل."}
        icon={<FileWarning className="size-5" />}
        backHref="/invoices?tab=controls"
        backLabel="المبيعات"
        actions={(
          <Button variant="outline" onClick={refresh} disabled={pending.isFetching}>
            <RefreshCcw aria-hidden className="me-1 size-4" />
            {pending.isFetching ? ACTION_LABELS.refreshing : ACTION_LABELS.refresh}
          </Button>
        )}
      />

      {error && <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">{error}</div>}
      {message && <div className="rounded-md border border-[var(--sem-pos)]/40 bg-[var(--sem-pos-bg)] p-3 text-sm text-[var(--sem-pos)]">{message}</div>}

      {pending.isLoading ? <LoadingState message={ACTION_LABELS.loading} /> : null}
      {pending.isError ? <ErrorState onRetry={() => void pending.refetch()} /> : null}
      {!pending.isLoading && !pending.isError && !(pending.data?.length ?? 0) ? (
        <Card>
          <CardContent className="p-10 text-center text-sm text-muted-foreground">
            {canReview ? "لا توجد طلبات بيع معلّقة." : "لم تُرسل أي طلبات على فواتير البيع بعد."}
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-3 xl:grid-cols-2">
        {pending.data?.map((request) => (
          <Card key={request.id}>
            <CardHeader className="pb-2">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <CardTitle className="text-base">
                    {SALES_CONTROL_TYPE_LABELS[request.requestType as SalesControlType]}
                  </CardTitle>
                  <div className="mt-1 text-xs text-muted-foreground">
                    طلب #{request.id} · الطالب {request.requestedByName}
                  </div>
                </div>
                <Badge variant={STATUS_BADGE_VARIANTS[request.status as SalesControlStatus]}>
                  {SALES_CONTROL_STATUS_LABELS[request.status as SalesControlStatus]}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="grid grid-cols-2 gap-2 rounded-md border bg-muted/25 p-3">
                <div><div className="text-xs text-muted-foreground">الفاتورة</div><Link href={`/invoices/${request.invoiceId}`} className="font-mono font-bold text-primary hover:underline">{request.invoiceNumber}</Link></div>
                <div><div className="text-xs text-muted-foreground">الإجمالي</div><div dir="ltr" className="font-bold tabular-nums">{fmt(request.invoiceTotal)}</div></div>
                <div><div className="text-xs text-muted-foreground">منشئ الفاتورة</div><div>{request.invoiceCreatedByName ?? "غير معروف"}</div></div>
                <div><div className="text-xs text-muted-foreground">بصمة الحمولة</div><div dir="ltr" className="font-mono text-xs">{request.payloadHash.slice(0, 12)}</div></div>
              </div>
              <div><div className="text-xs text-muted-foreground">السبب</div><div className="font-medium">{request.reason}</div></div>
              <div className="grid grid-cols-2 gap-2 rounded-md border border-dashed p-3">
                {payloadFacts(request.requestType as SalesControlType, request.payload).map((fact) => (
                  <div key={fact.label}>
                    <div className="text-xs text-muted-foreground">{fact.label}</div>
                    <div className="font-medium">{fact.value}</div>
                  </div>
                ))}
              </div>
              {canReview && isReviewerConflict(me.data?.id, request) && (
                <div className="rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] p-2 text-xs text-[var(--sem-warn)]">
                  لا يمكنك مراجعة هذا الطلب لأنك الطالب أو منشئ الفاتورة. يجب أن يحسمه مدير مستقل.
                </div>
              )}
              {canReview && <div className="flex flex-wrap gap-2">
                <Button
                  onClick={() => approveOne(Number(request.id), request.invoiceNumber, request.requestType as SalesControlType)}
                  disabled={approve.isPending || reject.isPending || isReviewerConflict(me.data?.id, request)}
                >
                  <Check aria-hidden className="me-1 size-4" />
                  اعتماد وتنفيذ
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => { setRejecting(Number(request.id)); setRejectReason(""); }}
                  disabled={approve.isPending || reject.isPending || isReviewerConflict(me.data?.id, request)}
                >
                  <X aria-hidden className="me-1 size-4" />
                  رفض
                </Button>
              </div>}
            </CardContent>
          </Card>
        ))}
      </div>

      <Dialog open={rejecting != null} onOpenChange={(open) => { if (!open) setRejecting(null); }}>
        <DialogContent dir="rtl">
          <DialogHeader>
            <DialogTitle>رفض طلب البيع</DialogTitle>
            <DialogDescription>يُحفظ السبب للطالب ويُغلق الطلب بلا أثر مالي أو مخزني.</DialogDescription>
          </DialogHeader>
          <div className="space-y-1">
            <Label htmlFor="sales-control-reject-reason">سبب الرفض *</Label>
            <Input
              id="sales-control-reject-reason"
              value={rejectReason}
              onChange={(event) => setRejectReason(event.target.value)}
              maxLength={500}
              placeholder="مثال: الكميات أو مسار الاسترداد غير صحيح"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejecting(null)}>رجوع</Button>
            <Button
              variant="destructive"
              disabled={rejectReason.trim().length < 3 || reject.isPending}
              onClick={() => rejecting != null && reject.mutate({ requestId: rejecting, reason: rejectReason.trim() })}
            >
              {reject.isPending ? ACTION_LABELS.sending : ACTION_LABELS.reject}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
