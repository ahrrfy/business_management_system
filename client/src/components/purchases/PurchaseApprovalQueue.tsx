import { useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  FileCheck2,
  RotateCcw,
  XCircle,
} from "lucide-react";
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

type PendingControl =
  RouterOutputs["purchases"]["pendingControls"]["rows"][number];
type Decision = {
  row: PendingControl;
  approve: boolean;
  decisionKey: string;
} | null;

const KIND_LABEL: Record<string, string> = {
  APPROVE_REVISION: "اعتماد مراجعة أمر شراء",
  CANCEL_ORDER: "إلغاء أمر شراء",
  EMERGENCY_ORDER: "استثناء أمر طارئ",
  APPROVE: "اعتماد طلب شراء",
  CANCEL: "إلغاء طلب شراء",
};

function documentReference(row: PendingControl) {
  return row.documentType === "PURCHASE_ORDER"
    ? row.poNumber
    : row.requisitionNumber;
}

function violatesVisibleSod(
  row: PendingControl,
  currentUserId: number | null | undefined,
) {
  if (currentUserId == null) return false;
  const ids =
    row.documentType === "PURCHASE_ORDER"
      ? [row.requestedBy, row.creatorId, row.lastEditedBy]
      : [row.requestedBy, row.creatorId, row.submittedBy];
  return ids.some((id) => id != null && Number(id) === Number(currentUserId));
}

export function PurchaseApprovalQueue({
  currentUserId,
}: {
  currentUserId: number | null | undefined;
}) {
  const utils = trpc.useUtils();
  const queue = trpc.purchases.pendingControls.useInfiniteQuery(
    { limit: 50 },
    { getNextPageParam: (last) => last.nextCursor ?? undefined },
  );
  const queueRows = queue.data?.pages.flatMap((page) => page.rows) ?? [];
  const [decision, setDecision] = useState<Decision>(null);
  const [reason, setReason] = useState("");
  const invalidate = async () => {
    await Promise.all([
      utils.purchases.pendingControls.invalidate(),
      utils.purchases.list.invalidate(),
      utils.purchases.requisitions.invalidate(),
    ]);
  };
  const close = () => {
    setDecision(null);
    setReason("");
  };
  const success = async (status: string) => {
    notify.ok(
      status === "STALE"
        ? "أُغلق الطلب كمنتهي الصلاحية لأن المستند تغيّر"
        : status === "APPROVED"
          ? "تم اعتماد الطلب وتطبيقه"
          : "تم رفض الطلب وتسجيل السبب",
    );
    close();
    await invalidate();
  };
  const orderDecision = trpc.purchases.decideControl.useMutation({
    onSuccess: (result) => void success(result.status),
    onError: (error) => notify.err(error),
  });
  const requisitionDecision = trpc.purchases.decideRequisition.useMutation({
    onSuccess: (result) => void success(result.status),
    onError: (error) => notify.err(error),
  });
  const pending = orderDecision.isPending || requisitionDecision.isPending;

  function submit() {
    if (!decision || reason.trim().length < 3) return;
    const input = {
      requestId: Number(decision.row.id),
      decisionKey: decision.decisionKey,
      approve: decision.approve,
      reason: reason.trim(),
    };
    if (decision.row.documentType === "PURCHASE_ORDER")
      orderDecision.mutate(input);
    else requisitionDecision.mutate(input);
  }

  return (
    <>
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-base">
            <span className="inline-flex items-center gap-2">
              <FileCheck2 aria-hidden className="size-4" />
              طلبات المشتريات بانتظار قرار مستقل
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void queue.refetch()}
              disabled={queue.isFetching}
            >
              <RotateCcw aria-hidden className="size-4" /> تحديث
            </Button>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            الإرسال أو طلب الإلغاء صفري الأثر. لا يتغيّر أمر الشراء أو طلب
            الشراء إلا بعد قرار مستخدم مستقل، والخادم يعيد فحص النسخة عند
            التطبيق.
          </p>
          {queue.isLoading ? (
            <LoadingState message="جارٍ تحميل قائمة الاعتماد…" />
          ) : null}
          {queue.error ? (
            <ErrorState
              message={`تعذّر تحميل طلبات الاعتماد: ${queue.error.message}. لا يُفترض أن القائمة فارغة.`}
              onRetry={() => void queue.refetch()}
            />
          ) : null}
          {!queue.isLoading && !queue.error && queueRows.length === 0 ? (
            <div
              role="status"
              className="rounded-md border bg-muted/20 p-5 text-center text-sm text-muted-foreground"
            >
              لا توجد طلبات معلّقة في نطاقك.
            </div>
          ) : null}
          {queueRows.map((row) => {
            const identityUnavailable = currentUserId == null;
            const own =
              identityUnavailable || violatesVisibleSod(row, currentUserId);
            const reference = documentReference(row);
            return (
              <section
                key={`${row.documentType}:${row.id}`}
                className="rounded-md border bg-background p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-bold">
                        {KIND_LABEL[row.kind] ?? row.kind}
                      </span>
                      <span className="rounded bg-muted px-2 py-0.5 text-xs">
                        طلب #{Number(row.id)}
                      </span>
                      <span dir="ltr" className="font-mono text-sm">
                        {reference}
                      </span>
                    </div>
                    <dl className="grid gap-2 text-sm sm:grid-cols-3">
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
                    </dl>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      disabled={own}
                      onClick={() => {
                        setReason("");
                        setDecision({
                          row,
                          approve: true,
                          decisionKey: `purchase-decision-${row.documentType}-${row.id}-approve-${crypto.randomUUID()}`,
                        });
                      }}
                    >
                      <CheckCircle2 aria-hidden className="size-4" /> اعتماد
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={own}
                      onClick={() => {
                        setReason("");
                        setDecision({
                          row,
                          approve: false,
                          decisionKey: `purchase-decision-${row.documentType}-${row.id}-reject-${crypto.randomUUID()}`,
                        });
                      }}
                    >
                      <XCircle aria-hidden className="size-4" /> رفض
                    </Button>
                  </div>
                </div>
                {own ? (
                  <div
                    role="note"
                    className="mt-3 flex items-start gap-2 rounded-md border bg-muted/30 p-3 text-sm"
                  >
                    <AlertTriangle
                      aria-hidden
                      className="mt-0.5 size-4 shrink-0 text-[var(--sem-warn)]"
                    />
                    {identityUnavailable
                      ? "أُوقف القرار حتى يكتمل تحميل هوية المستخدم."
                      : "لا يستطيع هذا الحساب حسم الطلب لأنه صاحب الطلب أو منشئ/مرسل/آخر محرر للمستند. الخادم هو الحكم النهائي."}
                  </div>
                ) : null}
              </section>
            );
          })}
          {queue.hasNextPage ? (
            <div className="flex justify-center">
              <Button
                type="button"
                variant="outline"
                disabled={queue.isFetchingNextPage}
                onClick={() => void queue.fetchNextPage()}
              >
                تحميل المزيد
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Dialog
        open={decision != null}
        onOpenChange={(open) => {
          if (!open && !pending) close();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {decision?.approve ? "اعتماد الطلب وتطبيقه" : "رفض الطلب"}
            </DialogTitle>
            <DialogDescription>
              القرار يُثبت باسم حسابك. إذا تغيّرت نسخة المستند فلن يطبّق الخادم
              طلباً قديماً.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="purchase-control-decision-reason">سبب القرار</Label>
            <Textarea
              id="purchase-control-decision-reason"
              value={reason}
              maxLength={500}
              rows={4}
              placeholder="اكتب نتيجة مراجعة البنود والأسعار والمستندات"
              onChange={(event) => setReason(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">مطلوب: 3–500 محرف.</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={close} disabled={pending}>
              تراجع
            </Button>
            <Button
              variant={decision?.approve ? "default" : "destructive"}
              disabled={pending || reason.trim().length < 3}
              onClick={submit}
            >
              {pending
                ? "جارٍ تثبيت القرار…"
                : decision?.approve
                  ? "اعتماد وتطبيق"
                  : "تأكيد الرفض"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
