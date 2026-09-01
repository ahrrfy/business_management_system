import React, { useState } from "react";
import { AlertTriangle, CheckCircle2, ExternalLink, ShieldCheck, XCircle } from "lucide-react";
import { ErrorState, LoadingState } from "@/components/PageState";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { fmtDateTime } from "@/lib/date";
import { notify } from "@/lib/notify";
import { trpc, type RouterOutputs } from "@/lib/trpc";

export type PendingWorkOrderControl = RouterOutputs["workOrders"]["pendingControlRequests"][number];
export type WorkOrderControlDetail = RouterOutputs["workOrders"]["controlRequest"];
export type WorkOrderControlDecision = { id: number; mode: "APPROVE" | "REJECT" };

const CONTROL_TYPE_LABEL: Record<string, string> = {
  COMMERCIAL_EDIT: "تعديل بيانات تجارية",
  MATERIAL_ADJUST: "تعديل مواد الأمر",
  CANCEL: "إلغاء أمر الشغل",
  REVERSE_DELIVERY: "عكس تسليم أمر الشغل",
};

export function workOrderControlTypeLabel(value: string): string {
  return CONTROL_TYPE_LABEL[value] ?? value;
}

export function formatWorkOrderControlPayload(payload: unknown): string {
  if (payload == null) return "—";
  if (typeof payload === "string") return payload;
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return String(payload);
  }
}

type Invalidatable = { invalidate: () => Promise<unknown> | unknown };
export async function invalidateWorkOrderControlCaches(utils: {
  workOrders: {
    pendingControlRequests: Invalidatable;
    controlRequest: Invalidatable;
    list: Invalidatable;
    counts: Invalidatable;
    get: Invalidatable;
    controlPreflight: Invalidatable;
    timeline: Invalidatable;
  };
}): Promise<void> {
  await Promise.all([
    utils.workOrders.pendingControlRequests.invalidate(),
    utils.workOrders.controlRequest.invalidate(),
    utils.workOrders.list.invalidate(),
    utils.workOrders.counts.invalidate(),
    utils.workOrders.get.invalidate(),
    utils.workOrders.controlPreflight.invalidate(),
    utils.workOrders.timeline.invalidate(),
  ]);
}

/** لا يركّب استعلامات المراجعة إطلاقاً خارج شاشة المدير/الأدمن. */
export function WorkOrderControlApprovals({
  canReview,
  currentUserId,
}: {
  canReview: boolean;
  currentUserId: number | null | undefined;
}) {
  if (!canReview) return null;
  return <SupervisorWorkOrderControlApprovals currentUserId={currentUserId} />;
}

function SupervisorWorkOrderControlApprovals({
  currentUserId,
}: {
  currentUserId: number | null | undefined;
}) {
  const utils = trpc.useUtils();
  const queue = trpc.workOrders.pendingControlRequests.useQuery();
  const [decision, setDecision] = useState<WorkOrderControlDecision | null>(null);
  const [note, setNote] = useState("");
  const selectedId = decision?.id ?? 1;
  const detail = trpc.workOrders.controlRequest.useQuery(
    { id: selectedId },
    { enabled: decision != null },
  );

  const invalidate = () => invalidateWorkOrderControlCaches(utils);
  const approve = trpc.workOrders.approveControl.useMutation({
    onSuccess: (result) => {
      notify.ok(result.replayed ? "الطلب معتمد سابقاً" : "تم اعتماد الطلب وتطبيقه");
      setDecision(null);
      setNote("");
    },
    onError: (error) => notify.err(error),
    onSettled: () => { void invalidate(); },
  });
  const reject = trpc.workOrders.rejectControl.useMutation({
    onSuccess: (result) => {
      notify.ok(result.replayed ? "الطلب مرفوض سابقاً" : "تم رفض طلب التحكم");
      setDecision(null);
      setNote("");
    },
    onError: (error) => notify.err(error),
    onSettled: () => { void invalidate(); },
  });

  const openDecision = (row: PendingWorkOrderControl, mode: WorkOrderControlDecision["mode"]) => {
    setNote("");
    setDecision({ id: Number(row.id), mode });
  };
  const closeDecision = () => {
    if (approve.isPending || reject.isPending) return;
    setDecision(null);
    setNote("");
  };

  return (
    <>
      <WorkOrderControlApprovalsView
        rows={queue.data ?? []}
        currentUserId={currentUserId}
        isLoading={queue.isLoading}
        errorMessage={queue.error?.message ?? null}
        onRetry={() => { void queue.refetch(); }}
        onApprove={(row) => openDecision(row, "APPROVE")}
        onReject={(row) => openDecision(row, "REJECT")}
      />
      <WorkOrderControlDecisionDialog
        decision={decision}
        request={detail.data ?? null}
        currentUserId={currentUserId}
        note={note}
        isLoading={detail.isLoading}
        errorMessage={detail.error?.message ?? null}
        isPending={approve.isPending || reject.isPending}
        onNoteChange={setNote}
        onRetry={() => { void detail.refetch(); }}
        onClose={closeDecision}
        onSubmit={() => {
          if (!decision) return;
          if (decision.mode === "APPROVE") {
            approve.mutate({ id: decision.id, note: note.trim() || null });
          } else {
            reject.mutate({ id: decision.id, reason: note.trim() });
          }
        }}
      />
    </>
  );
}

export function WorkOrderControlApprovalsView({
  rows,
  currentUserId,
  isLoading,
  errorMessage,
  onRetry,
  onApprove,
  onReject,
}: {
  rows: PendingWorkOrderControl[];
  currentUserId: number | null | undefined;
  isLoading: boolean;
  errorMessage: string | null;
  onRetry: () => void;
  onApprove: (row: PendingWorkOrderControl) => void;
  onReject: (row: PendingWorkOrderControl) => void;
}) {
  return (
    <Card className="border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)]/20">
      <CardHeader className="pb-3">
        <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-base">
          <span className="inline-flex items-center gap-2">
            <ShieldCheck aria-hidden className="size-4 text-[var(--sem-warn)]" />
            طلبات التحكم الإداري بانتظار المراجعة
          </span>
          <span className="rounded-md border bg-background px-2 py-1 text-xs font-semibold tabular-nums">
            {isLoading || errorMessage ? "—" : rows.length} معلّق
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          الطلب المعلّق لا يغيّر أمر الشغل. افحص السبب والحمولة والنسخة قبل الاعتماد؛ النظام يمنع منشئ الطلب من حسم طلبه بنفسه.
        </p>
        {isLoading && <LoadingState className="rounded-md border bg-background p-5" message="جارٍ تحميل طلبات التحكم…" />}
        {errorMessage && (
          <ErrorState
            className="rounded-md border border-destructive/40 bg-background p-5"
            message={<>تعذّر تحميل طلبات التحكم: {errorMessage}. لا يمكن افتراض عدم وجود طلبات معلّقة.</>}
            onRetry={onRetry}
          />
        )}
        {!isLoading && !errorMessage && rows.length === 0 && (
          <div role="status" className="rounded-md border bg-background p-4 text-center text-sm text-muted-foreground">
            لا توجد طلبات تحكم معلّقة في نطاقك.
          </div>
        )}
        {!isLoading && !errorMessage && rows.map((row) => (
          <WorkOrderControlApprovalRow
            key={Number(row.id)}
            row={row}
            currentUserId={currentUserId}
            onApprove={onApprove}
            onReject={onReject}
          />
        ))}
      </CardContent>
    </Card>
  );
}

export function WorkOrderControlApprovalRow({
  row,
  currentUserId,
  onApprove,
  onReject,
}: {
  row: PendingWorkOrderControl;
  currentUserId: number | null | undefined;
  onApprove: (row: PendingWorkOrderControl) => void;
  onReject: (row: PendingWorkOrderControl) => void;
}) {
  const requestId = Number(row.id);
  const workOrderId = Number(row.workOrderId);
  // الحقول الوصفية تُعاد من قائمة المراجعة عند توفر إثراء الخادم، مع fallback آمن
  // للصفوف القديمة/المخبأة كي لا تختفي هوية الأمر أو الطالب.
  const display = row as PendingWorkOrderControl & {
    orderNumber?: string | null;
    title?: string | null;
    requestedByName?: string | null;
  };
  const orderNumber = display.orderNumber?.trim() || `#${workOrderId}`;
  const requester = display.requestedByName?.trim() || `مستخدم #${Number(row.requestedBy)}`;
  const ownRequest = currentUserId != null && Number(row.requestedBy) === Number(currentUserId);
  return (
    <section className="rounded-md border bg-background p-4" aria-labelledby={`control-request-title-${requestId}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span id={`control-request-title-${requestId}`} className="font-bold">
              {workOrderControlTypeLabel(row.requestType)}
            </span>
            <span className="rounded-md bg-muted px-2 py-0.5 text-xs">طلب #{requestId}</span>
            <a href={`/work-orders/${workOrderId}`} className="inline-flex items-center gap-1 text-sm font-semibold text-primary hover:underline">
              رقم الأمر {orderNumber}
              <ExternalLink aria-hidden className="size-3.5" />
            </a>
            {display.title?.trim() && <span className="text-sm text-muted-foreground">{display.title}</span>}
          </div>
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <div><dt className="text-xs text-muted-foreground">سبب الطلب</dt><dd className="font-medium whitespace-pre-wrap">{row.reason}</dd></div>
            <div><dt className="text-xs text-muted-foreground">الطالب</dt><dd>{requester}</dd></div>
            <div><dt className="text-xs text-muted-foreground">نسخة الأمر الأساس</dt><dd dir="ltr" className="text-end font-mono">v{Number(row.baseVersion)}</dd></div>
            <div><dt className="text-xs text-muted-foreground">تاريخ الطلب</dt><dd dir="ltr" className="text-end">{fmtDateTime(row.createdAt)}</dd></div>
          </dl>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button size="sm" onClick={() => onApprove(row)} disabled={ownRequest}>
            <CheckCircle2 aria-hidden className="size-4" /> اعتماد وتطبيق
          </Button>
          <Button size="sm" variant="destructive" onClick={() => onReject(row)} disabled={ownRequest}>
            <XCircle aria-hidden className="size-4" /> رفض
          </Button>
        </div>
      </div>
      {ownRequest && (
        <div role="note" className="mt-3 flex items-start gap-2 rounded-md border border-[var(--sem-warn)]/30 bg-[var(--sem-warn-bg)] p-3 text-sm font-medium text-[var(--sem-warn)]">
          <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
          هذا الطلب أنشأه حسابك؛ لا يمكنك اعتماده أو رفضه. يجب أن يحسمه مدير أو أدمن آخر.
        </div>
      )}
      <details className="mt-3 rounded-md border bg-muted/20 p-3 text-sm">
        <summary className="cursor-pointer font-semibold">الحمولة المطلوب تطبيقها</summary>
        <pre dir="ltr" className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded bg-background p-3 text-start text-xs">
          {formatWorkOrderControlPayload(row.payload)}
        </pre>
      </details>
    </section>
  );
}

export function WorkOrderControlDecisionDialog({
  decision,
  request,
  currentUserId,
  note,
  isLoading,
  errorMessage,
  isPending,
  onNoteChange,
  onRetry,
  onClose,
  onSubmit,
}: {
  decision: WorkOrderControlDecision | null;
  request: WorkOrderControlDetail | null;
  currentUserId: number | null | undefined;
  note: string;
  isLoading: boolean;
  errorMessage: string | null;
  isPending: boolean;
  onNoteChange: (value: string) => void;
  onRetry: () => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const rejecting = decision?.mode === "REJECT";
  const ownRequest = request != null
    && currentUserId != null
    && Number(request.requestedBy) === Number(currentUserId);
  const trimmed = note.trim();
  const invalidNote = note.length > 500 || (rejecting && trimmed.length < 3);

  return (
    <Dialog open={decision != null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{rejecting ? "رفض طلب التحكم" : "اعتماد طلب التحكم وتطبيقه"}</DialogTitle>
          <DialogDescription>
            {rejecting
              ? "اكتب سبباً واضحاً للرفض؛ سيُحفظ في سجل أمر الشغل."
              : "راجع الحمولة والنسخة. الاعتماد يطبّق التغيير على أمر الشغل فوراً إذا بقيت النسخة مطابقة."}
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <LoadingState className="p-6" message="جارٍ تحميل النسخة الحالية من الطلب…" />
        ) : errorMessage ? (
          <ErrorState
            className="p-6"
            message={<>تعذّر تحميل تفاصيل طلب التحكم: {errorMessage}. أُوقف القرار حتى نجاح التحميل.</>}
            onRetry={onRetry}
          />
        ) : request ? (
          <div className="space-y-4">
            <div className="rounded-md border bg-muted/20 p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-bold">{workOrderControlTypeLabel(request.requestType)}</span>
                <a href={`/work-orders/${Number(request.workOrderId)}`} className="font-semibold text-primary hover:underline">
                  رقم الأمر #{Number(request.workOrderId)}
                </a>
              </div>
              <dl className="mt-3 grid gap-2 sm:grid-cols-3">
                <div><dt className="text-xs text-muted-foreground">السبب</dt><dd>{request.reason}</dd></div>
                <div><dt className="text-xs text-muted-foreground">الطالب</dt><dd>مستخدم #{Number(request.requestedBy)}</dd></div>
                <div><dt className="text-xs text-muted-foreground">النسخة</dt><dd dir="ltr" className="text-end font-mono">v{Number(request.baseVersion)}</dd></div>
              </dl>
              <pre dir="ltr" className="mt-3 max-h-52 overflow-auto whitespace-pre-wrap break-words rounded border bg-background p-3 text-start text-xs">
                {formatWorkOrderControlPayload(request.payload)}
              </pre>
            </div>

            {ownRequest && (
              <div role="alert" className="flex items-start gap-2 rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] p-3 text-sm font-medium text-[var(--sem-warn)]">
                <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
                أُوقف القرار: هذا الطلب أنشأه حسابك، ويلزم مراجع آخر.
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="work-order-control-review-note">
                {rejecting ? "سبب الرفض (مطلوب)" : "ملاحظة الاعتماد (اختيارية)"}
              </Label>
              <Textarea
                id="work-order-control-review-note"
                value={note}
                maxLength={500}
                rows={4}
                aria-invalid={invalidNote}
                placeholder={rejecting ? "مثال: الحمولة لا تطابق المستند المرفق…" : "ملاحظة تدقيقية مختصرة…"}
                onChange={(event) => onNoteChange(event.target.value)}
              />
              <p className={invalidNote ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
                {rejecting && trimmed.length < 3
                  ? "سبب الرفض مطلوب وبحد أدنى 3 محارف."
                  : `${note.length}/500 محرف`}
              </p>
            </div>
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isPending}>تراجع</Button>
          <Button
            variant={rejecting ? "destructive" : "default"}
            disabled={!request || !!errorMessage || isLoading || isPending || ownRequest || invalidNote}
            onClick={onSubmit}
          >
            {isPending
              ? "جارٍ تثبيت القرار…"
              : rejecting ? "تأكيد الرفض" : "اعتماد وتطبيق الآن"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
