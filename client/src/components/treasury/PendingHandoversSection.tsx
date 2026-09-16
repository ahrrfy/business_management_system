import { AlertTriangle, Clock3, Loader2, RefreshCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AppSelect } from "@/components/ui/AppSelect";
import type { RouterOutputs } from "@/lib/trpc";

type PendingQueueRow = RouterOutputs["treasury"]["pendingHandoverQueue"][number];
type HandoverRecipient = RouterOutputs["shifts"]["handoverRecipients"][number];

export function CustodyQueryNotice({
  loading,
  error,
  loadingLabel,
  errorLabel,
  onRetry,
}: {
  loading: boolean;
  error: boolean;
  loadingLabel: string;
  errorLabel: string;
  onRetry: () => void;
}) {
  if (loading) {
    return (
      <div role="status" className="flex items-center gap-2 rounded-md border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
        <Loader2 aria-hidden className="size-3.5 animate-spin" />
        {loadingLabel}
      </div>
    );
  }
  if (!error) return null;
  return (
    <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
      <span className="flex items-center gap-2">
        <AlertTriangle aria-hidden className="size-3.5" />
        {errorLabel}
      </span>
      <Button type="button" size="sm" variant="outline" className="h-7 gap-1.5" onClick={onRetry}>
        <RefreshCcw aria-hidden className="size-3.5" /> إعادة المحاولة
      </Button>
    </div>
  );
}

export function PendingHandoversSection({
  canGovernHandovers,
  pendingQueue,
  handoverRecipients,
  reassignHandover,
}: {
  canGovernHandovers: boolean;
  pendingQueue: {
    isLoading: boolean;
    isError: boolean;
    data?: PendingQueueRow[];
    refetch: () => void;
  };
  handoverRecipients: {
    isLoading: boolean;
    isError: boolean;
    data?: HandoverRecipient[];
    refetch: () => void;
  };
  reassignHandover: {
    isPending: boolean;
    mutate: (args: { receiptId: number; toUserId: number }) => void;
  };
}) {
  if (!canGovernHandovers) return null;
  if (!pendingQueue.isLoading && !pendingQueue.isError && (pendingQueue.data?.length ?? 0) === 0) {
    return null;
  }

  return (
    <section className="rounded-md border p-4">
      <div className="mb-3 flex items-center gap-2">
        <Clock3 className="h-4 w-4 text-muted-foreground" />
        <div>
          <h2 className="text-sm font-bold">نقدٌ معلَّق لدى مستلمين (رقابة المدير)</h2>
          <p className="text-xs text-muted-foreground">
            عهدٌ خرجت من الأدراج ولم تدخل رصيد الخزينة بعد. إن تعذّر على المستلم قبولها
            (إجازة/تعطيل حساب) فأعِد إسنادها — المبلغ لا يتحرّك، يتغيّر المسؤول عن قبوله فقط.
          </p>
        </div>
      </div>
      <div className="space-y-3">
        <CustodyQueryNotice
          loading={pendingQueue.isLoading}
          error={pendingQueue.isError}
          loadingLabel="جارٍ تحميل طابور عهد الاستلام…"
          errorLabel="تعذّر تحميل طابور عهد الاستلام؛ لا يمكن افتراض عدم وجود عهد معلّقة."
          onRetry={() => void pendingQueue.refetch()}
        />
        {!pendingQueue.isLoading && !pendingQueue.isError && (
          <>
            <CustodyQueryNotice
              loading={handoverRecipients.isLoading}
              error={handoverRecipients.isError}
              loadingLabel="جارٍ تحميل المستلمين المؤهلين…"
              errorLabel="تعذّر تحميل قائمة المستلمين؛ أُوقفت إعادة الإسناد لحين نجاح التحميل."
              onRetry={() => void handoverRecipients.refetch()}
            />
            <div className="grid gap-2">
              {pendingQueue.data?.map((row) => (
                <div
                  key={row.id}
                  className="flex flex-wrap items-center gap-3 rounded-md border bg-card px-3 py-2.5"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold tabular-nums" dir="ltr">
                        {row.referenceNumber}
                      </span>
                      {row.ageDays >= 2 && (
                        <span className="rounded bg-[var(--sem-warn)]/15 px-1.5 py-0.5 text-xs text-[var(--sem-warn)]">
                          معلَّقة منذ {row.ageDays} يوماً
                        </span>
                      )}
                      {!row.assignedToActive && (
                        <span className="rounded bg-destructive/15 px-1.5 py-0.5 text-xs text-destructive">
                          المستلم معطَّل
                        </span>
                      )}
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      مُسنَدة إلى:{" "}
                      <span className="font-medium text-foreground">
                        {row.assignedToName ?? `#${row.assignedToId}`}
                      </span>
                      {row.sourceEmployeeName ? <> · من وردية {row.sourceEmployeeName}</> : null}
                    </div>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    المبلغ مخفي لحماية العد المستقل
                  </div>
                  <AppSelect
                    value=""
                    onValueChange={(v) => {
                      if (v) {
                        reassignHandover.mutate({ receiptId: row.id, toUserId: Number(v) });
                      }
                    }}
                    disabled={
                      reassignHandover.isPending ||
                      handoverRecipients.isLoading ||
                      handoverRecipients.isError
                    }
                    placeholder="إعادة إسناد إلى…"
                    className="w-48"
                    aria-label={`إعادة إسناد العهدة ${row.referenceNumber}`}
                  >
                    {(handoverRecipients.data ?? [])
                      .filter(
                        (u) =>
                          Number(u.id) !== row.assignedToId &&
                          Number(u.branchId) === row.branchId,
                      )
                      .map((u) => (
                        <option key={u.id} value={String(u.id)}>
                          {u.name ?? `#${u.id}`}
                        </option>
                      ))}
                  </AppSelect>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
