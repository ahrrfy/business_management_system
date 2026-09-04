import { useState } from "react";
import { Link } from "wouter";
import { Check, FileWarning, RefreshCcw, Undo2, X } from "lucide-react";
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
import { salesControlFacts, type SalesControlFactsType } from "@shared/salesControlFacts";

const STATUS_BADGE_VARIANTS: Record<
  SalesControlStatus,
  "warning" | "success" | "danger" | "neutral"
> = {
  PENDING: "warning",
  APPROVED: "success",
  REJECTED: "danger",
  STALE: "neutral",
  WITHDRAWN: "neutral",
};

/**
 * ⭐ الاشتقاقُ من `@shared/salesControlFacts` لا نسخةٌ محلّية (تصويب مراجعة Codex على PR #932).
 * كانت هذه الدالّة تُعيد تعريف «مصير البضاعة» محلّياً فتعرضه معكوساً للزبون العابر، ثمّ كاد
 * صندوقُ موافقات أندرويد يُعيد العطب من بابٍ ثانٍ. تعريفٌ واحد يعرضه الطرفان.
 */
const payloadFacts = (type: SalesControlType, value: unknown) =>
  salesControlFacts(type as SalesControlFactsType, value, fmt);

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
  /**
   * ⭐ درجُ الاسترداد لحظة الاعتماد (تدقيق ١/٩/٢٦ — «حارسٌ بلا حقلٍ في الواجهة = ميزةٌ مقفلة»).
   *
   * الدرج المختار وقت **الطلب** يُجمَّد في الحمولة المُبصَمة؛ فإن أُقفلت الوردية قبل الاعتماد
   * سقط التنفيذ حتماً بـ«الوردية المحدَّدة غير مفتوحة» ولا حقلَ هنا لتبديلها — فكلّ مرتجعٍ
   * نقديّ يُطلَب آخر الدوام كان يولد ميتاً. الخادم يقبل `cashRouting` الآن؛ هذا هو الحقل.
   */
  const [routingFor, setRoutingFor] = useState<number | null>(null);
  const [routingShiftId, setRoutingShiftId] = useState<string>("");
  /**
   * ⭐ مرجع استرداد البطاقة لحظة الاعتماد لا لحظة الطلب (مراجعة Codex على PR #988) — نظير
   * `routingShiftId` تماماً. الطالب قد يترك المرجع فارغاً (لم ينفّذ الاسترداد بعد)؛ المُعتمِد
   * يدخله هنا بعد تنفيذه الفعليّ على الجهاز، أو يعتمد ما أدخله الطالب إن كان قد نفّذه هو.
   */
  const [routingReference, setRoutingReference] = useState<string>("");
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

  /**
   * سحبُ الطالب لطلبه — المخرج الوحيد حين لا يوجد مراجعٌ مستقلّ في الفرع (هجرة 0326).
   * صفريُّ الأثر: يُحرّر `activeInvoiceId` فتعود الفاتورة قابلةً لطلبٍ جديد.
   */
  const withdraw = trpc.salesControl.withdraw.useMutation({
    onSuccess: async () => {
      setMessage("سُحب الطلب — تحرّرت الفاتورة ويمكن إرسال طلبٍ جديد. لم يتغيّر المال ولا المخزون.");
      setError("");
      await utils.salesControl.list.invalidate();
    },
    onError: (cause) => { setError(cause.message); setMessage(""); },
  });

  async function withdrawOne(requestId: number, invoiceNumber: string) {
    if (!(await confirm({
      variant: "warning",
      title: `سحب الطلب #${requestId}`,
      description: `تسحب طلبك على الفاتورة ${invoiceNumber}. لا يتغيّر المال ولا المخزون — يُغلَق الطلب فقط وتعود الفاتورة قابلةً لطلبٍ جديد.`,
      confirmText: "سحب الطلب",
    }))) return;
    withdraw.mutate({ requestId, reason: "سحبه الطالب" });
  }

  async function approveOne(requestId: number, invoiceNumber: string, type: SalesControlType) {
    const shiftId = routingFor === requestId && routingShiftId ? Number(routingShiftId) : null;
    const reference = routingFor === requestId && routingReference.trim() ? routingReference.trim() : null;
    const cashRouting = shiftId != null || reference != null
      ? { ...(shiftId != null ? { shiftId } : {}), ...(reference != null ? { reference } : {}) }
      : null;
    if (!(await confirm({
      variant: "danger",
      title: `اعتماد ${SALES_CONTROL_TYPE_LABELS[type]}`,
      description: `سيُنفَّذ الأثر الآن على الفاتورة ${invoiceNumber} داخل معاملة واحدة.${
        shiftId ? ` النقد يخرج من الدرج #${shiftId}.` : ""
      }${reference ? ` مرجع جهاز الدفع: ${reference}.` : ""} لا يمكن للطالب أو منشئ الفاتورة اعتمادها.`,
      confirmText: "اعتماد وتنفيذ",
      requireText: invoiceNumber,
    }))) return;
    approve.mutate(cashRouting ? { requestId, cashRouting } : { requestId });
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
              {canReview && request.requestType === "SALES_RETURN" && !isReviewerConflict(me.data?.id, request) && (
                <div className="space-y-1 rounded-md border border-dashed p-3">
                  <Label htmlFor={`routing-${request.id}`} className="text-xs">
                    درج خروج النقد (اختياريّ — اتركه فارغاً لاستعمال الدرج المسجَّل في الطلب)
                  </Label>
                  <Input
                    id={`routing-${request.id}`}
                    dir="ltr"
                    inputMode="numeric"
                    className="h-8 w-32 tabular-nums"
                    placeholder="رقم الوردية"
                    value={routingFor === Number(request.id) ? routingShiftId : ""}
                    onChange={(event) => {
                      setRoutingFor(Number(request.id));
                      setRoutingShiftId(event.target.value.replace(/[^\d]/g, ""));
                    }}
                  />
                  <p className="text-[11px] text-muted-foreground">
                    إن أُقفلت وردية الطلب فسيسقط التنفيذ — حدّد هنا وردية مفتوحة الآن. المبلغ والطريقة لا يتغيّران.
                  </p>
                </div>
              )}
              {canReview && request.requestType === "SALES_CANCEL"
                && (request.payload as { refundPaymentMethod?: string } | null)?.refundPaymentMethod === "CARD"
                && !isReviewerConflict(me.data?.id, request) && (
                <div className="space-y-1 rounded-md border border-dashed p-3">
                  <Label htmlFor={`cancel-ref-${request.id}`} className="text-xs">
                    مرجع استرداد البطاقة — نفّذه على الجهاز ثمّ أدخِله هنا قبل الاعتماد
                  </Label>
                  <Input
                    id={`cancel-ref-${request.id}`}
                    dir="ltr"
                    className="h-8 w-56"
                    placeholder="رقم العملية / كود الموافقة"
                    value={routingFor === Number(request.id)
                      ? routingReference
                      : String((request.payload as { reference?: string } | null)?.reference ?? "")}
                    onChange={(event) => {
                      setRoutingFor(Number(request.id));
                      setRoutingReference(event.target.value);
                    }}
                  />
                  <p className="text-[11px] text-muted-foreground">
                    المرجع الذي تعتمده هنا هو ما يُنفَّذ فعلياً — قارنه بإيصال الجهاز قبل الاعتماد. تركه فارغاً
                    يرفض الاعتماد فوراً (لا أثر) إن كانت الطريقة بطاقة.
                  </p>
                </div>
              )}
              {request.status === "PENDING" && me.data?.id != null
                && Number(request.requestedBy) === Number(me.data.id) && (
                <div className="flex flex-wrap items-center gap-2 rounded-md border border-dashed p-2">
                  <span className="text-xs text-muted-foreground">
                    هذا طلبك — لا تراجعه بنفسك. إن تعذّر إيجاد مراجعٍ مستقل، اسحبه لتتحرّر الفاتورة.
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={withdraw.isPending}
                    onClick={() => withdrawOne(Number(request.id), request.invoiceNumber)}
                  >
                    <Undo2 aria-hidden className="me-1 size-4" />
                    سحب الطلب
                  </Button>
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
