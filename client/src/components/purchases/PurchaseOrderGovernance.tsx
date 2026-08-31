import { useEffect, useState } from "react";
import {
  GitCompareArrows,
  History,
  RotateCcw,
  ShieldCheck,
} from "lucide-react";
import { ErrorState, LoadingState } from "@/components/PageState";
import { AppSelect } from "@/components/ui/AppSelect";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { fmtDateTime } from "@/lib/date";
import { trpc } from "@/lib/trpc";

const HEAD_LABEL: Record<string, string> = {
  supplierId: "المورّد",
  agreedCurrency: "العملة",
  agreedRate: "سعر الصرف",
  settlementType: "نوع التسوية",
  expectedDeliveryDate: "تاريخ التسليم المتوقع",
  subtotal: "المجموع",
  taxAmount: "الضريبة",
  shippingCost: "الشحن",
  customsCost: "الكمرك",
  invoiceDiscount: "خصم فاتورة المورّد",
  total: "الإجمالي",
  usdTotal: "إجمالي الدولار",
  notesSnapshot: "الملاحظات",
};

function valueText(value: unknown) {
  if (value == null || value === "") return "—";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

export function PurchaseOrderGovernance({
  purchaseOrderId,
}: {
  purchaseOrderId: number;
}) {
  const revisions = trpc.purchases.revisions.useQuery({ purchaseOrderId });
  const events = trpc.purchases.events.useQuery({ purchaseOrderId });
  const [fromRevisionId, setFromRevisionId] = useState(0);
  const [toRevisionId, setToRevisionId] = useState(0);

  useEffect(() => {
    if (!revisions.data?.length || toRevisionId) return;
    setToRevisionId(Number(revisions.data[0].id));
    setFromRevisionId(Number(revisions.data[1]?.id ?? revisions.data[0].id));
  }, [revisions.data, toRevisionId]);

  const diff = trpc.purchases.revisionDiff.useQuery(
    { purchaseOrderId, fromRevisionId, toRevisionId },
    { enabled: fromRevisionId > 0 && toRevisionId > 0 },
  );
  const failed = revisions.error ?? events.error;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-base">
          <span className="inline-flex items-center gap-2">
            <ShieldCheck aria-hidden className="size-4" /> سجل المراجعات
            والأحداث
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              void revisions.refetch();
              void events.refetch();
            }}
          >
            <RotateCcw aria-hidden className="size-4" /> تحديث
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          كل حفظ يُنشئ مراجعة ثابتة. طلب الاعتماد يطابق مراجعة ونسخة بعينهما،
          والأحداث سلسلة تدقيق لا تستبدلها الحالة الحالية.
        </p>
        {revisions.isLoading || events.isLoading ? (
          <LoadingState message="جارٍ تحميل سجل أمر الشراء…" />
        ) : null}
        {failed ? (
          <ErrorState
            message={`تعذّر تحميل سجل الحوكمة: ${failed.message}`}
            onRetry={() => {
              void revisions.refetch();
              void events.refetch();
            }}
          />
        ) : null}
        {!failed && revisions.data ? (
          <>
            <div className="grid gap-3 lg:grid-cols-2">
              <section className="rounded-md border p-3">
                <div className="mb-2 flex items-center gap-2 font-semibold">
                  <History aria-hidden className="size-4" /> المراجعات
                </div>
                <div className="max-h-64 space-y-2 overflow-y-auto">
                  {revisions.data.map((revision) => (
                    <div
                      key={Number(revision.id)}
                      className="rounded border bg-muted/20 p-2 text-sm"
                    >
                      <div className="flex flex-wrap justify-between gap-2">
                        <span className="font-bold">
                          مراجعة {Number(revision.revisionNo)}
                        </span>
                        <span
                          dir="ltr"
                          className="text-xs text-muted-foreground"
                        >
                          {fmtDateTime(revision.createdAt)}
                        </span>
                      </div>
                      <div className="mt-1 text-muted-foreground">
                        {revision.revisionReason}
                      </div>
                      <div className="mt-1 text-xs">
                        بصمة:{" "}
                        <bdi dir="ltr" className="font-mono">
                          {revision.payloadHash.slice(0, 16)}…
                        </bdi>
                      </div>
                    </div>
                  ))}
                  {!revisions.data.length ? (
                    <div className="p-4 text-center text-sm text-muted-foreground">
                      لا توجد مراجعات.
                    </div>
                  ) : null}
                </div>
              </section>
              <section className="rounded-md border p-3">
                <div className="mb-2 flex items-center gap-2 font-semibold">
                  <History aria-hidden className="size-4" /> الأحداث
                </div>
                <div className="max-h-64 space-y-2 overflow-y-auto">
                  {(events.data ?? []).map((event) => (
                    <div
                      key={Number(event.id)}
                      className="rounded border bg-muted/20 p-2 text-sm"
                    >
                      <div className="flex flex-wrap justify-between gap-2">
                        <span className="font-semibold">{event.eventType}</span>
                        <span
                          dir="ltr"
                          className="text-xs text-muted-foreground"
                        >
                          {fmtDateTime(event.occurredAt)}
                        </span>
                      </div>
                      {event.reason ? (
                        <div className="mt-1 text-muted-foreground">
                          {event.reason}
                        </div>
                      ) : null}
                      <div className="mt-1 text-xs">
                        فاعل:{" "}
                        {event.actorUserId
                          ? `مستخدم #${Number(event.actorUserId)}`
                          : "النظام"}
                      </div>
                    </div>
                  ))}
                  {!events.data?.length ? (
                    <div className="p-4 text-center text-sm text-muted-foreground">
                      لا توجد أحداث.
                    </div>
                  ) : null}
                </div>
              </section>
            </div>

            {revisions.data.length ? (
              <section className="space-y-3 rounded-md border p-3">
                <div className="flex items-center gap-2 font-semibold">
                  <GitCompareArrows aria-hidden className="size-4" /> مقارنة
                  مراجعتين
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <AppSelect
                    value={String(fromRevisionId)}
                    onValueChange={(value) => setFromRevisionId(Number(value))}
                  >
                    {revisions.data.map((revision) => (
                      <option key={revision.id} value={revision.id}>
                        من مراجعة {revision.revisionNo}
                      </option>
                    ))}
                  </AppSelect>
                  <AppSelect
                    value={String(toRevisionId)}
                    onValueChange={(value) => setToRevisionId(Number(value))}
                  >
                    {revisions.data.map((revision) => (
                      <option key={revision.id} value={revision.id}>
                        إلى مراجعة {revision.revisionNo}
                      </option>
                    ))}
                  </AppSelect>
                </div>
                {diff.isLoading ? (
                  <LoadingState message="جارٍ حساب الفرق…" />
                ) : null}
                {diff.error ? (
                  <ErrorState
                    message={diff.error.message}
                    onRetry={() => void diff.refetch()}
                  />
                ) : null}
                {diff.data ? (
                  <div className="space-y-2 text-sm">
                    {diff.data.head.map((change) => (
                      <div
                        key={change.field}
                        className="grid gap-1 rounded border p-2 sm:grid-cols-[10rem_1fr_1fr]"
                      >
                        <span className="font-semibold">
                          {HEAD_LABEL[change.field] ?? change.field}
                        </span>
                        <span className="text-[var(--sem-neg)]">
                          قبل: {valueText(change.before)}
                        </span>
                        <span className="text-[var(--sem-pos)]">
                          بعد: {valueText(change.after)}
                        </span>
                      </div>
                    ))}
                    {diff.data.items.map((change) => (
                      <details
                        key={change.lineNo}
                        className="rounded border p-2"
                      >
                        <summary className="cursor-pointer font-semibold">
                          تغيير السطر {change.lineNo}
                        </summary>
                        <pre
                          dir="ltr"
                          className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-start text-xs"
                        >
                          {JSON.stringify(
                            { before: change.before, after: change.after },
                            null,
                            2,
                          )}
                        </pre>
                      </details>
                    ))}
                    {!diff.data.head.length && !diff.data.items.length ? (
                      <div className="rounded border p-4 text-center text-muted-foreground">
                        لا فرق بين المراجعتين.
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </section>
            ) : null}
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
