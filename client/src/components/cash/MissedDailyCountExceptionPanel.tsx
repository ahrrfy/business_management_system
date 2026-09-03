import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  FileWarning,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { ErrorState, LoadingState } from "@/components/PageState";
import { newClientRequestId } from "@/lib/countQueue";
import { fmtDate } from "@/lib/date";
import { fmtAr } from "@/lib/money";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import {
  MISSED_DAILY_COUNT_EVIDENCE_MIN,
  MISSED_DAILY_COUNT_REASON_MIN,
  missedDailyCountExceptionStatusLabel,
} from "@shared/missedDailyCountException";

interface Props {
  branchId: number;
  businessDate: string;
  canManage: boolean;
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

export function MissedDailyCountExceptionPanel({
  branchId,
  businessDate,
  canManage,
}: Props) {
  const historical = businessDate < todayUtc();
  const enabled = branchId > 0 && historical;
  const utils = trpc.useUtils();
  const contextQ = trpc.treasury.missedDailyCount.context.useQuery(
    { branchId, businessDate },
    { enabled },
  );
  const [reason, setReason] = useState("");
  const [evidenceReference, setEvidenceReference] = useState("");
  const [decisionNote, setDecisionNote] = useState("");
  const [requestId, setRequestId] = useState(newClientRequestId);
  const [decisionRequestId, setDecisionRequestId] =
    useState(newClientRequestId);

  useEffect(() => {
    setReason("");
    setEvidenceReference("");
    setDecisionNote("");
    setRequestId(newClientRequestId());
    setDecisionRequestId(newClientRequestId());
  }, [branchId, businessDate]);

  const refresh = async () => {
    await utils.treasury.missedDailyCount.context.invalidate({
      branchId,
      businessDate,
    });
    await utils.reports.monthCloseReadiness.invalidate();
  };
  const requestM = trpc.treasury.missedDailyCount.request.useMutation({
    onSuccess: async () => {
      notify.ok(
        "أُرسل طلب استثناء الجرد",
        "لم يُنشأ جرد تاريخي ولم تتغير أي حركة مالية. ينتظر الطلب مراجعاً مختلفاً.",
      );
      setReason("");
      setEvidenceReference("");
      setRequestId(newClientRequestId());
      await refresh();
    },
    onError: (error) => notify.err(error),
  });
  const decideM = trpc.treasury.missedDailyCount.decide.useMutation({
    onSuccess: async (result) => {
      notify.ok(
        result.status === "APPROVED" ? "اعتُمد الاستثناء" : "رُفض الاستثناء",
        result.status === "APPROVED"
          ? "سيُستثنى اليوم من حاجز إقفال الشهر ما دامت مطابقة الترحيل مطابقة لبصمتها المغلقة."
          : "يمكن إنشاء طلب جديد من دليل حالي إذا ظل اليوم مفقوداً.",
      );
      setDecisionNote("");
      setDecisionRequestId(newClientRequestId());
      await refresh();
    },
    onError: (error) => notify.err(error),
  });

  const active = useMemo(
    () =>
      contextQ.data?.requests.find(
        (row) => row.status === "PENDING" || row.status === "APPROVED",
      ) ?? null,
    [contextQ.data?.requests],
  );
  const priorDecisions = useMemo(
    () => contextQ.data?.requests.filter((row) => row.id !== active?.id) ?? [],
    [active?.id, contextQ.data?.requests],
  );

  if (!enabled) return null;
  if (contextQ.isLoading) {
    return (
      <Card>
        <CardContent className="p-5">
          <LoadingState />
        </CardContent>
      </Card>
    );
  }
  if (contextQ.isError) {
    return (
      <Card>
        <CardContent className="p-5">
          <ErrorState
            message="تعذّر التحقق من مسار استثناء الجرد؛ لم يُفترض أن اليوم مستثنى."
            onRetry={() => void contextQ.refetch()}
          />
        </CardContent>
      </Card>
    );
  }
  const context = contextQ.data;
  if (
    !context ||
    (!context.evidence.required && context.requests.length === 0)
  ) {
    return null;
  }

  return (
    <Card className="border-[var(--sem-warn)]/40">
      <CardContent className="space-y-4 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 font-bold">
              <FileWarning className="size-4 text-[var(--sem-warn)]" />
              استثناء جرد يومي مفقود
            </div>
            <p className="mt-1 max-w-3xl text-xs text-muted-foreground">
              هذا المسار لا يصنع جرداً بأثر رجعي ولا يعدّل رصيداً. يثبت فقدان
              الجرد، ويربطه بمطابقة لاحقة مغلقة وببصمات غير قابلة للتبديل، ثم
              يحتاج مراجعاً مختلفاً.
            </p>
          </div>
          <div className="text-left text-xs">
            <p className="text-muted-foreground">
              رصيد الخزينة بنهاية اليوم المفقود
            </p>
            <p className="font-bold tabular-nums" dir="ltr">
              {fmtAr(context.evidence.endOfDayTreasuryCash)} د.ع
            </p>
          </div>
        </div>

        <div className="grid gap-3 rounded-md border bg-muted/20 p-3 sm:grid-cols-3">
          <div>
            <p className="text-[11px] text-muted-foreground">
              حركات نقدية في اليوم
            </p>
            <p className="font-bold tabular-nums" dir="ltr">
              {context.evidence.dayCashReceiptCount}
            </p>
          </div>
          <div>
            <p className="text-[11px] text-muted-foreground">ورديات اليوم</p>
            <p className="font-bold tabular-nums" dir="ltr">
              {context.evidence.shiftCount}
            </p>
          </div>
          <div>
            <p className="text-[11px] text-muted-foreground">بصمة دليل اليوم</p>
            <p
              className="truncate font-mono text-[11px]"
              dir="ltr"
              title={context.evidence.evidenceHash}
            >
              {context.evidence.evidenceHash}
            </p>
          </div>
        </div>

        {!context.carryForward && !active && (
          <div className="flex gap-2 rounded-md border border-[var(--sem-warn)]/40 p-3 text-xs">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-[var(--sem-warn)]" />
            لا توجد مطابقة خزينة لاحقة مغلقة أصبحت تاريخية وغير قابلة لإعادة
            الفتح. يجب إقفال جرد فعلي لاحق وانتظار ثبات يومه أولاً؛ لا يجوز
            اختراع رصيد أو جرد تاريخي.
          </div>
        )}

        {context.carryForward && !active && (
          <div className="rounded-md border p-3 text-xs">
            <div className="flex items-center gap-2 font-bold">
              <ShieldCheck className="size-4" /> دليل الترحيل الحالي
            </div>
            <div className="mt-2 grid gap-2 sm:grid-cols-3">
              <p>
                المطابقة:{" "}
                <span className="font-bold tabular-nums" dir="ltr">
                  #{context.carryForward.id}
                </span>
              </p>
              <p>
                التاريخ:{" "}
                <span className="font-bold">
                  {fmtDate(context.carryForward.businessDate)}
                </span>
              </p>
              <p>
                الإصدار:{" "}
                <span className="font-bold tabular-nums" dir="ltr">
                  #{context.carryForward.version}
                </span>
              </p>
            </div>
          </div>
        )}

        {context.actions.canRequest && context.carryForward && canManage && (
          <div className="space-y-3 border-t pt-4">
            <Textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              maxLength={500}
              placeholder="سبب فقدان الجرد ومن كان مسؤولاً عن إجرائه (15 حرفاً على الأقل)"
            />
            <Textarea
              value={evidenceReference}
              onChange={(event) => setEvidenceReference(event.target.value)}
              maxLength={4_000}
              placeholder="مرجع الدليل: محضر، رقم تذكرة، رابط مستند، أو وصف مكان الملف"
            />
            <Button
              disabled={
                requestM.isPending ||
                reason.trim().length < MISSED_DAILY_COUNT_REASON_MIN ||
                evidenceReference.trim().length <
                  MISSED_DAILY_COUNT_EVIDENCE_MIN
              }
              onClick={() =>
                requestM.mutate({
                  branchId,
                  businessDate,
                  carryForwardReconciliationId: Number(
                    context.carryForward!.id,
                  ),
                  reason: reason.trim(),
                  evidenceReference: evidenceReference.trim(),
                  clientRequestId: requestId,
                })
              }
            >
              إرسال طلب الاستثناء للمراجعة
            </Button>
          </div>
        )}

        {active && (
          <div className="space-y-3 border-t pt-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="font-bold">
                  طلب #{active.id} —{" "}
                  {missedDailyCountExceptionStatusLabel[active.status]}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  الطالب:{" "}
                  {active.requestedByName ??
                    `مستخدم #${active.requestedByUserId}`}{" "}
                  · مطابقة الترحيل #{active.carryForwardReconciliationId} بتاريخ{" "}
                  {fmtDate(active.carryForwardBusinessDate)}
                </p>
              </div>
              {active.status === "APPROVED" &&
              context.approvedExemptionValid ? (
                <CheckCircle2 className="size-5 text-money-positive" />
              ) : (
                <AlertTriangle className="size-5 text-[var(--sem-warn)]" />
              )}
            </div>
            <div className="grid gap-3 rounded-md border bg-muted/20 p-3 text-xs sm:grid-cols-2">
              <div>
                <span className="text-muted-foreground">السبب: </span>
                {active.reason}
              </div>
              <div>
                <span className="text-muted-foreground">مرجع الدليل: </span>
                {active.evidenceReference}
              </div>
              <div className="sm:col-span-2">
                <span className="text-muted-foreground">بصمة الطلب: </span>
                <span className="font-mono" dir="ltr">
                  {active.immutableEvidenceHash}
                </span>
              </div>
              {active.decisionNote && (
                <div className="sm:col-span-2">
                  <span className="text-muted-foreground">قرار المراجع: </span>
                  {active.decisionNote}
                </div>
              )}
            </div>

            {active.status === "APPROVED" &&
              !context.approvedExemptionValid && (
                <div className="flex gap-2 rounded-md border border-money-negative/40 p-3 text-xs text-money-negative">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                  مطابقة الترحيل لم تعد تطابق الإصدار والبصمة المختومين.
                  الاستثناء ظاهر للتدقيق لكنه لا يرفع حاجز إقفال الشهر.
                </div>
              )}

            {active.status === "PENDING" && !context.actions.canDecide && (
              <p className="text-xs text-muted-foreground">
                ينتظر الطلب مراجعاً مختلفاً عن الطالب، بلا استثناء للدور
                الإداري.
              </p>
            )}
            {active.status === "PENDING" &&
              context.actions.canDecide &&
              canManage && (
                <div className="space-y-2">
                  <Textarea
                    value={decisionNote}
                    onChange={(event) => setDecisionNote(event.target.value)}
                    maxLength={500}
                    placeholder="ملاحظة قرار المراجعة (10 أحرف على الأقل)"
                  />
                  <div className="flex flex-wrap gap-2">
                    <Button
                      disabled={
                        decideM.isPending || decisionNote.trim().length < 10
                      }
                      onClick={() =>
                        decideM.mutate({
                          exceptionId: Number(active.id),
                          expectedVersion: Number(active.version),
                          decision: "APPROVED",
                          note: decisionNote.trim(),
                          clientRequestId: decisionRequestId,
                        })
                      }
                      className="gap-1.5"
                    >
                      <CheckCircle2 className="size-4" /> اعتماد الاستثناء
                    </Button>
                    <Button
                      variant="destructive"
                      disabled={
                        decideM.isPending || decisionNote.trim().length < 10
                      }
                      onClick={() =>
                        decideM.mutate({
                          exceptionId: Number(active.id),
                          expectedVersion: Number(active.version),
                          decision: "REJECTED",
                          note: decisionNote.trim(),
                          clientRequestId: decisionRequestId,
                        })
                      }
                      className="gap-1.5"
                    >
                      <XCircle className="size-4" /> رفض الاستثناء
                    </Button>
                  </div>
                </div>
              )}
          </div>
        )}

        {priorDecisions.length > 0 && (
          <div className="space-y-2 border-t pt-4">
            <p className="text-xs font-bold">سجل الطلبات السابقة</p>
            {priorDecisions.map((row) => (
              <div
                key={row.id}
                className="grid gap-2 rounded-md border bg-muted/20 p-3 text-xs sm:grid-cols-3"
              >
                <p>
                  طلب <span className="font-bold tabular-nums">#{row.id}</span>{" "}
                  — {missedDailyCountExceptionStatusLabel[row.status]}
                </p>
                <p>
                  الطالب:{" "}
                  {row.requestedByName ?? `مستخدم #${row.requestedByUserId}`}
                </p>
                <p>المراجع: {row.reviewedByName ?? "—"}</p>
                <p className="sm:col-span-3">
                  {row.decisionNote ?? row.reason}
                </p>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
