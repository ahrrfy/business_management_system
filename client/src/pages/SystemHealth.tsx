import { PageHeader } from "@/components/PageHeader";
import { ErrorState, LoadingState } from "@/components/PageState";
import { DataTable } from "@/components/data-table/DataTable";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { confirm } from "@/lib/confirm";
import { fmtDateTime } from "@/lib/date";
import { notify } from "@/lib/notify";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { AlertTriangle, RefreshCw, RotateCcw } from "lucide-react";
import type { ColumnDef } from "@tanstack/react-table";

type DeadLetterRow = RouterOutputs["delivery"]["listDeadLetterOutbox"][number];

export default function SystemHealth() {
  const utils = trpc.useUtils();
  const deadLetters = trpc.delivery.listDeadLetterOutbox.useQuery(
    { limit: 100 },
    { refetchInterval: 60_000, refetchOnWindowFocus: true },
  );
  const rows = deadLetters.data ?? [];
  const requeue = trpc.delivery.requeueDeadLetter.useMutation({
    onSuccess: async (result) => {
      if (result.requeued > 0) {
        notify.ok("أُعيدت الرسالة إلى الطابور", "ستحاول خدمة الإشعارات معالجتها في الدورة التالية.");
      } else {
        notify.warn("لم تتغيّر الرسالة", "قد تكون أُعيدت إلى الطابور أو عولجت في جلسة أخرى.");
      }
      await utils.delivery.listDeadLetterOutbox.invalidate();
    },
    onError: (error) => notify.err(error),
  });

  async function handleRequeue(row: DeadLetterRow) {
    const accepted = await confirm({
      variant: "danger",
      title: "إعادة الرسالة إلى الطابور؟",
      description: `الرسالة #${row.id} فشلت ${row.attempts} مرة. أعدها فقط بعد معالجة السبب الظاهر؛ وإلا ستعود إلى قائمة الرسائل المستنفدة.`,
      confirmText: "إعادة إلى الطابور",
    });
    if (!accepted) return;
    requeue.mutate({ id: Number(row.id) });
  }

  const columns: ColumnDef<DeadLetterRow, unknown>[] = [
    {
      id: "message",
      header: "الرسالة",
      cell: ({ row }) => (
        <div>
          <div className="font-mono font-bold" dir="ltr">#{row.original.id}</div>
          <div className="mt-1 font-mono text-xs text-muted-foreground" dir="ltr">{row.original.eventId}</div>
        </div>
      ),
      meta: { kind: "code" },
    },
    {
      accessorKey: "topic",
      header: "الموضوع",
      cell: ({ row }) => <span className="font-mono text-xs" dir="ltr">{row.original.topic}</span>,
      meta: { kind: "code" },
    },
    {
      accessorKey: "attempts",
      header: "المحاولات",
      cell: ({ row }) => <span className="font-bold tabular-nums">{row.original.attempts}</span>,
      meta: { kind: "number", align: "center" },
    },
    {
      accessorKey: "lastError",
      header: "سبب الفشل الأخير",
      cell: ({ row }) => (
        <p className="max-w-md whitespace-pre-wrap break-words text-xs text-destructive" dir="ltr">
          {row.original.lastError?.trim() || "لم يُسجّل سبب للفشل."}
        </p>
      ),
      meta: { kind: "text", width: "wide", wrap: true },
    },
    {
      id: "deadLetteredAt",
      header: "وقت الاستنفاد",
      cell: ({ row }) => (
        <span className="whitespace-nowrap text-xs">
          {fmtDateTime(row.original.deadLetteredAt ?? row.original.createdAt)}
        </span>
      ),
      meta: { kind: "date" },
    },
    {
      id: "actions",
      header: "الإجراء",
      cell: ({ row }) => {
        const busy = requeue.isPending && Number(requeue.variables?.id) === Number(row.original.id);
        return (
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5"
            disabled={requeue.isPending}
            onClick={() => void handleRequeue(row.original)}
          >
            <RotateCcw aria-hidden className="size-4" />
            {busy ? "جارٍ الإعادة…" : "إعادة إلى الطابور"}
          </Button>
        );
      },
      meta: { kind: "actions", align: "center" },
    },
  ];

  return (
    <div className="space-y-4" dir="rtl">
      <PageHeader
        title="صحة النظام"
        description="مراقبة الأعطال التشغيلية التي تحتاج تدخلاً إدارياً صريحاً."
        actions={(
          <Button variant="outline" size="sm" onClick={() => void deadLetters.refetch()} disabled={deadLetters.isFetching}>
            <RefreshCw aria-hidden className={`size-4 ${deadLetters.isFetching ? "animate-spin" : ""}`} />
            تحديث
          </Button>
        )}
      />

      <Card>
        <CardHeader className="border-b">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <AlertTriangle aria-hidden className="size-4 text-[var(--sem-warn)]" />
                رسائل إشعارات التوصيل المستنفدة
              </CardTitle>
              <p className="mt-1 text-xs text-muted-foreground">
                رسائل تجاوزت حد إعادة المحاولة. راجع سبب الفشل وعالج أصل المشكلة قبل إعادتها.
              </p>
            </div>
            {!deadLetters.isError && (
              <span className="rounded-md border bg-muted px-2.5 py-1 text-sm font-bold tabular-nums">
                {rows.length} رسالة
              </span>
            )}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {deadLetters.isLoading ? (
            <LoadingState message="جارٍ فحص الرسائل المستنفدة…" />
          ) : deadLetters.isError ? (
            <div className="p-4">
              <ErrorState
                message="تعذّر فحص طابور إشعارات التوصيل؛ لا يمكن افتراض أن الطابور سليم."
                onRetry={() => void deadLetters.refetch()}
              />
            </div>
          ) : (
            <DataTable
              data={rows}
              columns={columns}
              searchable={false}
              emptyText="لا توجد رسائل توصيل مستنفدة حالياً."
              viewKey="system-health-delivery-dead-letter"
              getRowId={(row) => String(row.id)}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
