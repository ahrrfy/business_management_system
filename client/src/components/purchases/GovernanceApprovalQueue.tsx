import { useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  FileCheck2,
  RotateCcw,
  XCircle,
} from "lucide-react";
import { ACTION_LABELS } from "@shared/actionLabels";
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
import { SubmitButton } from "@/components/ui/SubmitButton";
import { Textarea } from "@/components/ui/textarea";
import { fmtDateTime } from "@/lib/date";
import {
  canReviewGovernanceRequest,
  newGovernanceKey,
} from "./purchaseGovernanceUiPolicy";
import { GovernanceRequestNotice } from "./GovernanceRequestNotice";

export type GovernanceQueueRow = {
  id: number;
  requestedBy: number | string;
  requestedAt: Date | string;
  title: string;
  reference: string;
  reason: string;
  amount?: string | null;
  evidence?: string | null;
  details?: Array<{ label: string; value: React.ReactNode }>;
};

type Decision = {
  row: GovernanceQueueRow;
  action: "APPROVE" | "REJECT";
} | null;

export function GovernanceApprovalQueue({
  title,
  scope,
  rows,
  currentUserId,
  isOwner,
  loading,
  fetching,
  error,
  pending,
  reviewAllowed = true,
  reviewBlockedReason,
  onRetry,
  onDecide,
}: {
  title: string;
  scope: string;
  rows: GovernanceQueueRow[];
  currentUserId: number | null | undefined;
  /** ⭐ قرار المالك (٣/٩/٢٦): لا اعتماد ثانٍ بعد المالك — مالكٌ نشط يقرّر طلبه بنفسه. */
  isOwner?: boolean;
  loading: boolean;
  fetching?: boolean;
  error?: unknown;
  pending: boolean;
  reviewAllowed?: boolean;
  reviewBlockedReason?: string;
  onRetry: () => void;
  onDecide: (input: {
    requestId: number;
    action: "APPROVE" | "REJECT";
    reviewReason: string;
    decisionKey: string;
  }) => Promise<unknown>;
}) {
  const [decision, setDecision] = useState<Decision>(null);
  const [reviewReason, setReviewReason] = useState("");

  function close() {
    if (pending) return;
    setDecision(null);
    setReviewReason("");
  }

  async function submit() {
    if (!decision || reviewReason.trim().length < 3) return;
    try {
      await onDecide({
        requestId: decision.row.id,
        action: decision.action,
        reviewReason: reviewReason.trim(),
        decisionKey: newGovernanceKey(
          `${scope}-${decision.row.id}-${decision.action.toLowerCase()}`,
        ),
      });
      setDecision(null);
      setReviewReason("");
    } catch {
      // مالك الاستدعاء يعرض خطأ الخادم؛ نبقي الحوار مفتوحاً للتصحيح وإعادة المحاولة.
    }
  }

  return (
    <>
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-base">
            <span className="inline-flex items-center gap-2">
              <FileCheck2 aria-hidden className="size-4" />
              {title}
            </span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={fetching}
              onClick={onRetry}
            >
              <RotateCcw aria-hidden className="size-4" />
              {ACTION_LABELS.refresh}
            </Button>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <GovernanceRequestNotice />
          {loading ? <LoadingState /> : null}
          {error ? (
            <ErrorState
              message="تعذّر تحميل قائمة الاعتماد. لا تُعامل القائمة كأنها فارغة."
              onRetry={onRetry}
            />
          ) : null}
          {!loading && !error && rows.length === 0 ? (
            <div
              role="status"
              className="rounded-md border bg-muted/20 p-6 text-center text-sm text-muted-foreground"
            >
              لا توجد طلبات معلّقة في نطاقك.
            </div>
          ) : null}
          {!loading && !error
            ? rows.map((row) => {
                const canReview =
                  reviewAllowed &&
                  (isOwner === true ||
                    canReviewGovernanceRequest(currentUserId, row.requestedBy));
                return (
                  <section
                    key={row.id}
                    className="space-y-3 rounded-md border bg-background p-4"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 space-y-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-bold">{row.title}</span>
                          <span className="rounded bg-muted px-2 py-0.5 text-xs">
                            طلب #{row.id}
                          </span>
                          <bdi dir="ltr" className="font-mono text-sm">
                            {row.reference}
                          </bdi>
                        </div>
                        <dl className="grid gap-2 text-sm sm:grid-cols-2 xl:grid-cols-4">
                          <div>
                            <dt className="text-xs text-muted-foreground">
                              سبب الطلب
                            </dt>
                            <dd>{row.reason}</dd>
                          </div>
                          <div>
                            <dt className="text-xs text-muted-foreground">
                              طالب الإجراء
                            </dt>
                            <dd>مستخدم #{Number(row.requestedBy)}</dd>
                          </div>
                          <div>
                            <dt className="text-xs text-muted-foreground">
                              وقت الطلب
                            </dt>
                            <dd dir="ltr" className="text-end">
                              {fmtDateTime(row.requestedAt)}
                            </dd>
                          </div>
                          {row.amount ? (
                            <div>
                              <dt className="text-xs text-muted-foreground">
                                المبلغ
                              </dt>
                              <dd dir="ltr" className="font-semibold">
                                {row.amount}
                              </dd>
                            </div>
                          ) : null}
                          {row.evidence ? (
                            <div>
                              <dt className="text-xs text-muted-foreground">
                                مرجع الدليل
                              </dt>
                              <dd className="break-all">{row.evidence}</dd>
                            </div>
                          ) : null}
                          {(row.details ?? []).map((detail) => (
                            <div key={detail.label}>
                              <dt className="text-xs text-muted-foreground">
                                {detail.label}
                              </dt>
                              <dd>{detail.value}</dd>
                            </div>
                          ))}
                        </dl>
                      </div>
                      <div className="flex gap-2">
                        <Button
                          type="button"
                          size="sm"
                          disabled={!canReview}
                          onClick={() => {
                            setReviewReason("");
                            setDecision({ row, action: "APPROVE" });
                          }}
                        >
                          <CheckCircle2 aria-hidden className="size-4" />
                          {ACTION_LABELS.approve}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="destructive"
                          disabled={!canReview}
                          onClick={() => {
                            setReviewReason("");
                            setDecision({ row, action: "REJECT" });
                          }}
                        >
                          <XCircle aria-hidden className="size-4" />
                          {ACTION_LABELS.reject}
                        </Button>
                      </div>
                    </div>
                    {!canReview ? (
                      <div
                        role="note"
                        className="flex items-start gap-2 rounded-md border bg-muted/30 p-3 text-sm"
                      >
                        <AlertTriangle
                          aria-hidden
                          className="mt-0.5 size-4 shrink-0"
                        />
                        {!reviewAllowed && reviewBlockedReason
                          ? reviewBlockedReason
                          : currentUserId == null
                          ? "أُوقف القرار حتى يكتمل تحميل هوية المستخدم."
                          : "لا يستطيع طالب الإجراء اعتماد طلبه. يلزم مستخدم مستقل، والخادم هو الحكم النهائي."}
                      </div>
                    ) : null}
                  </section>
                );
              })
            : null}
        </CardContent>
      </Card>

      <Dialog open={decision != null} onOpenChange={(open) => !open && close()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {decision?.action === "APPROVE"
                ? "اعتماد الطلب وتطبيقه"
                : "رفض الطلب"}
            </DialogTitle>
            <DialogDescription>
              القرار يُثبت باسم حسابك. يعيد الخادم فحص النسخة والأرصدة والكميات
              قبل أي أثر.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor={`${scope}-review-reason`}>سبب القرار</Label>
            <Textarea
              id={`${scope}-review-reason`}
              value={reviewReason}
              rows={4}
              maxLength={500}
              onChange={(event) => setReviewReason(event.target.value)}
              placeholder="اكتب نتيجة مراجعة المستند والدليل والمبالغ"
            />
            <p className="text-xs text-muted-foreground">مطلوب: 3–500 محرف.</p>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={close}
            >
              تراجع
            </Button>
            <SubmitButton
              type="button"
              pending={pending}
              pendingText={ACTION_LABELS.processing}
              variant={
                decision?.action === "APPROVE" ? "default" : "destructive"
              }
              disabled={reviewReason.trim().length < 3}
              onClick={() => void submit()}
            >
              {decision?.action === "APPROVE" ? "اعتماد وتطبيق" : "تأكيد الرفض"}
            </SubmitButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
