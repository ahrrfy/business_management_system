import { AlertCircle, History, RefreshCw } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { fmtDateTime } from "@/lib/date";
import { toPriceHistoryDisplay } from "@/lib/priceHistory";
import { trpc } from "@/lib/trpc";
import { Link } from "wouter";
import { cn } from "@/lib/utils";

interface UnitPriceHistoryProps {
  variantId: number | null | undefined;
  unitName: string;
  variantLabel?: string;
  className?: string;
}

/** سجلّ تسعير وحدة محفوظة؛ لا ينفّذ الاستعلام الثقيل إلا بعد طلب المدير فتح الحوار. */
export function UnitPriceHistory({
  variantId,
  unitName,
  variantLabel,
  className,
}: UnitPriceHistoryProps) {
  const [open, setOpen] = useState(false);
  const canOpen =
    Number.isInteger(Number(variantId)) &&
    Number(variantId) > 0 &&
    !!unitName.trim();
  const resolveQ = trpc.catalog.resolveProductUnitId.useQuery(
    { variantId: Number(variantId), unitName },
    { enabled: open && canOpen, staleTime: 30_000 },
  );
  const productUnitId = resolveQ.data ?? null;
  const historyQ = trpc.priceWaves.unitHistory.useQuery(
    { productUnitId: Number(productUnitId), limit: 50 },
    { enabled: open && productUnitId != null, staleTime: 15_000 },
  );

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={!canOpen}
        title={
          canOpen
            ? "عرض سجل تغيّر سعر هذه الوحدة"
            : "احفظ الوحدة أولاً لعرض سجل السعر"
        }
        className={cn(
          "inline-flex items-center gap-1 rounded border border-input px-2 py-1 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
      >
        <History aria-hidden className="size-3" />
        سجل السعر
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-5xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <History aria-hidden className="size-4" />
              سجل السعر — {unitName || "وحدة"}
            </DialogTitle>
            <DialogDescription>
              آخر 50 تغييراً مسجّلاً للسعر قبل وبعد، مع المنفّذ والتوقيت والسبب
              أو موجة التسعير.
              {variantLabel ? (
                <span className="font-medium text-foreground">
                  {" "}
                  المتغيّر: {variantLabel}.
                </span>
              ) : null}
            </DialogDescription>
          </DialogHeader>

          {resolveQ.isLoading ? (
            <div className="py-10 text-center text-sm text-muted-foreground">
              جارٍ تحديد الوحدة…
            </div>
          ) : resolveQ.isError ? (
            <ErrorState
              message={resolveQ.error.message}
              onRetry={() => resolveQ.refetch()}
            />
          ) : productUnitId == null ? (
            <div className="rounded-md border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
              لم تعد هذه الوحدة محفوظة بهذا الاسم. احفظ التعديلات ثم أعد
              المحاولة.
            </div>
          ) : historyQ.isLoading ? (
            <div className="py-10 text-center text-sm text-muted-foreground">
              جارٍ تحميل سجل السعر…
            </div>
          ) : historyQ.isError ? (
            <ErrorState
              message={historyQ.error.message}
              onRetry={() => historyQ.refetch()}
            />
          ) : (historyQ.data ?? []).length === 0 ? (
            <div className="rounded-md border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
              لا تغييرات سعر مسجّلة لهذه الوحدة بعد.
            </div>
          ) : (
            <div className="max-h-[60vh] overflow-auto rounded-md border">
              <table className="w-full min-w-[780px] text-sm">
                <thead className="sticky top-0 bg-muted/95 text-xs text-muted-foreground backdrop-blur">
                  <tr>
                    <th className="px-3 py-2 text-right font-medium">متى</th>
                    <th className="px-3 py-2 text-right font-medium">الفئة</th>
                    <th className="px-3 py-2 text-right font-medium">السابق</th>
                    <th className="px-3 py-2 text-right font-medium">الجديد</th>
                    <th className="px-3 py-2 text-right font-medium">من</th>
                    <th className="px-3 py-2 text-right font-medium">
                      السبب / الموجة
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {(historyQ.data ?? []).map((row) => {
                    const display = toPriceHistoryDisplay(row);
                    return (
                      <tr key={row.id} className="border-t align-top">
                        <td
                          className="whitespace-nowrap px-3 py-2 text-xs text-muted-foreground tabular-nums"
                          dir="ltr"
                        >
                          {fmtDateTime(row.createdAt)}
                        </td>
                        <td className="px-3 py-2">{display.tier}</td>
                        <td className="px-3 py-2 tabular-nums" dir="ltr">
                          {display.oldPrice}
                        </td>
                        <td
                          className="px-3 py-2 font-semibold tabular-nums"
                          dir="ltr"
                        >
                          {display.newPrice}
                        </td>
                        <td className="px-3 py-2">{display.actor}</td>
                        <td className="px-3 py-2">
                          <div>{display.reason}</div>
                          {/* اسم الموجة كان نصّاً ميّتاً: ترى أنّ سعراً تغيّر بموجةٍ ولا تصل
                              إليها لترى بقيّة ما مسّته أو لتتراجع عنها. */}
                          <div className="mt-0.5 text-xs text-muted-foreground">
                            {row.waveId != null ? (
                              <Link
                                href={`/inventory?tab=price-waves&wave=${row.waveId}`}
                                className="underline-offset-2 hover:underline"
                                title="فتح موجة التسعير هذه"
                              >
                                {display.source}
                              </Link>
                            ) : (
                              display.source
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              إغلاق
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div
      role="alert"
      className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
    >
      <div className="flex items-start gap-2">
        <AlertCircle aria-hidden className="mt-0.5 size-4 shrink-0" />
        <span>تعذّر تحميل سجل السعر: {message}</span>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="mt-3"
        onClick={onRetry}
      >
        <RefreshCw aria-hidden className="size-3.5" />
        إعادة المحاولة
      </Button>
    </div>
  );
}
