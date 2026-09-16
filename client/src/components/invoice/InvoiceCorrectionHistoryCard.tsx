import { Link } from "wouter";
import { FileWarning, History } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { fmtDateTime } from "@/lib/date";
import { fmt } from "@/lib/money";
import type { RouterOutputs } from "@/lib/trpc";

export type CorrectionHistoryList = RouterOutputs["sales"]["correctionHistory"];

interface InvoiceCorrectionHistoryCardProps {
  isLoading: boolean;
  history?: CorrectionHistoryList;
}

export function InvoiceCorrectionHistoryCard({
  isLoading,
  history,
}: InvoiceCorrectionHistoryCardProps) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <History aria-hidden className="size-4" />
          سجل تصحيحات الفاتورة
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading && (
          <p className="text-sm text-muted-foreground">
            جارٍ تحميل سجل التعديل…
          </p>
        )}
        {!isLoading && (history ?? []).length === 0 && (
          <p className="text-sm text-muted-foreground">
            لا توجد تعديلات مسجّلة على هذه الفاتورة.
          </p>
        )}
        {(history ?? []).map((entry) => {
          const oldFields =
            (entry.oldValue as {
              notes?: string | null;
              dueDate?: string | null;
            } | null) ?? {};
          const newValue =
            (entry.newValue as {
              reason?: string;
              fields?: typeof oldFields;
              correctedInvoiceNumber?: string;
              correctedInvoiceId?: number;
              total?: string;
              overpay?: string;
              overpayHandled?: "CREDIT" | "CASH_REFUND" | null;
            } | null) ?? {};
          const newFields = newValue.fields ?? {};
          const isReissue = entry.action === "sale.reissue";
          return (
            <div
              key={entry.id}
              className="rounded-md border bg-muted/20 p-3 text-sm space-y-2"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-semibold">
                  {entry.userName ?? "مستخدم محذوف"}
                </span>
                <span
                  className="text-xs text-muted-foreground tabular-nums"
                  dir="ltr"
                >
                  {fmtDateTime(entry.createdAt)}
                </span>
              </div>
              {isReissue && (
                <span className="inline-flex w-fit items-center gap-1 rounded-md bg-primary/10 px-1.5 py-0.5 text-[10px] font-extrabold text-primary">
                  <FileWarning aria-hidden className="size-3" />
                  تصحيح كامل (عكس وإعادة إصدار)
                </span>
              )}
              <p>
                <span className="text-muted-foreground">السبب: </span>
                {newValue.reason ?? "—"}
              </p>
              {isReissue && newValue.correctedInvoiceNumber && (
                <div className="grid gap-1 text-xs text-muted-foreground">
                  <p>
                    استُبدِلت بالفاتورة{" "}
                    {newValue.correctedInvoiceId ? (
                      <Link
                        href={`/invoices/${newValue.correctedInvoiceId}`}
                        className="font-semibold text-primary hover:underline"
                      >
                        {newValue.correctedInvoiceNumber}
                      </Link>
                    ) : (
                      <span className="font-semibold text-foreground">{newValue.correctedInvoiceNumber}</span>
                    )}
                  </p>
                  {newValue.overpayHandled && (
                    <p>
                      الفرق الزائد:{" "}
                      <span className="text-foreground">
                        {newValue.overpayHandled === "CASH_REFUND" ? "استرداد نقديّ" : "رصيد دائن للعميل"}
                        {newValue.overpay ? ` (${fmt(newValue.overpay)})` : ""}
                      </span>
                    </p>
                  )}
                </div>
              )}
              <div className="grid gap-1 text-xs text-muted-foreground">
                {oldFields.notes !== newFields.notes && (
                  <p>
                    الملاحظات:{" "}
                    <span className="line-through">
                      {oldFields.notes || "—"}
                    </span>{" "}
                    ←{" "}
                    <span className="text-foreground">
                      {newFields.notes || "—"}
                    </span>
                  </p>
                )}
                {oldFields.dueDate !== newFields.dueDate && (
                  <p>
                    تاريخ الاستحقاق:{" "}
                    <span className="line-through" dir="ltr">
                      {oldFields.dueDate || "—"}
                    </span>{" "}
                    ←{" "}
                    <span className="text-foreground" dir="ltr">
                      {newFields.dueDate || "—"}
                    </span>
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
