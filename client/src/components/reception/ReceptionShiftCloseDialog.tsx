import { useState } from "react";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MoneyInput } from "@/components/form/MoneyInput";
import { fmtDate } from "@/lib/date";
import { fmt, formatIqd } from "@/lib/money";
import { notify } from "@/lib/notify";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { printShiftClose } from "@/lib/printing/print";

export interface ReceptionShiftCloseDialogProps {
  open: boolean;
  onClose: () => void;
  shift: NonNullable<RouterOutputs["shifts"]["current"]>;
  branchName: string;
  cashierName: string;
  isElevatedRole: boolean;
}

export function ReceptionShiftCloseDialog({
  open,
  onClose,
  shift,
  branchName,
  cashierName,
  isElevatedRole,
}: ReceptionShiftCloseDialogProps) {
  const utils = trpc.useUtils();
  const [counted, setCounted] = useState("");
  const [countEntered, setCountEntered] = useState(false);

  // تقرير الوردية (Z) — يُحمَّل فقط عند فتح نافذة الإغلاق.
  const reportQ = trpc.shifts.report.useQuery(
    { shiftId: shift.id },
    { enabled: open, staleTime: 0 }
  );

  const closeShiftM = trpc.shifts.close.useMutation({
    onSuccess: async (r) => {
      const rep = reportQ.data;
      void printShiftClose({
        shiftId: r.shiftId,
        openedAt: shift.openedAt ?? null,
        closedAt: new Date(),
        cashierName,
        branchName,
        openingBalance: r.openingBalance,
        invoiceCount: rep?.invoiceCount ?? 0,
        salesTotal: rep?.salesTotal ?? "0",
        payments: (rep?.payments ?? []).map((p) => ({
          method: p.method,
          direction: p.direction as "IN" | "OUT",
          count: Number(p.count),
          total: p.total,
        })),
        expectedCash: r.expectedCash,
        countedCash: r.countedCash,
        variance: r.variance,
        // ش٤ (I14): إفصاح عرابين الطلبات غير المُثبَّتة على Z المطبوع أيضاً.
        heldDepositsCount: rep?.heldDepositsCount ?? 0,
        heldDepositsTotal: rep?.heldDepositsTotal ?? "0",
        treasuryReturn: r.treasuryReturn
          ? {
              amount: r.countedCash,
              referenceNumber: r.treasuryReturn.handoverNumber,
            }
          : null,
      });
      if (r.treasuryReturn) {
        notify.ok(
          `أُغلقت الوردية ورُحّل ${formatIqd(r.countedCash)} إلى الخزينة تلقائياً`,
          `سند الترحيل ${r.treasuryReturn.handoverNumber}`,
        );
      }
      onClose();
      await utils.shifts.current.invalidate();
    },
    onError: (e) => notify.err(e),
  });

  if (!open) return null;

  // رقم الخادم نفسه الذي يفرضه closeShift (DRAWER فقط)؛ لا نعيد تركيب المعادلة من تقرير طرق الدفع.
  const recExpected = Number(reportQ.data?.expectedCash ?? shift.openingBalance ?? 0);
  // فقدان التركيز من حقل المعدود يُثبّت انتهاء الإدخال ويكشف المطابقة تلقائياً بلا زر إضافي.
  const showRecExpected = isElevatedRole || countEntered;
  const recDiff = showRecExpected && counted ? Number(counted) - recExpected : null;
  const hasRecVariance = recDiff != null && Math.abs(recDiff) >= 0.01;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      dir="rtl"
      onClick={onClose}
    >
      <div
        className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-2xl bg-card p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="mb-1 text-lg font-extrabold">إنهاء الوردية وعدّ النقدية</h3>
        <p className="mb-4 text-xs text-muted-foreground">{fmtDate(new Date())}</p>
        {reportQ.isLoading ? (
          <div className="py-6 text-center text-muted-foreground">جارٍ تجهيز ملخص اليوم…</div>
        ) : (
          <>
            {(
              [
                ["عدد الفواتير", `${reportQ.data?.invoiceCount ?? 0}`],
                ["إجمالي المبيعات", `${fmt(Number(reportQ.data?.salesTotal ?? 0))} د.ع`],
                ...(Number(reportQ.data?.woInvoicesCount ?? 0) > 0
                  ? [
                      [
                        `منها فواتير تسليم طلبات (${reportQ.data?.woInvoicesCount})`,
                        `${fmt(Number(reportQ.data?.woInvoicesTotal ?? 0))} د.ع`,
                      ] as [string, string],
                    ]
                  : []),
                ...(Number(reportQ.data?.heldDepositsCount ?? 0) > 0
                  ? [
                      [
                        `عرابين طلبات لم تُثبَّت (${reportQ.data?.heldDepositsCount})`,
                        `${fmt(Number(reportQ.data?.heldDepositsTotal ?? 0))} د.ع`,
                      ] as [string, string],
                    ]
                  : []),
                ...(Number(reportQ.data?.deliveryInCount ?? 0) > 0
                  ? [
                      [
                        `منها توريدات مناديب (${reportQ.data?.deliveryInCount})`,
                        `${fmt(Number(reportQ.data?.deliveryInTotal ?? 0))} د.ع`,
                      ] as [string, string],
                    ]
                  : []),
                ...(Number(reportQ.data?.deliveryOutCount ?? 0) > 0
                  ? [
                      [
                        `مدفوعات توصيل صادرة (${reportQ.data?.deliveryOutCount})`,
                        `${fmt(Number(reportQ.data?.deliveryOutTotal ?? 0))} د.ع`,
                      ] as [string, string],
                    ]
                  : []),
                ["المبلغ عند بدء الوردية", `${fmt(Number(shift.openingBalance ?? 0))} د.ع`],
                ...(showRecExpected
                  ? [["المبلغ المفترض وجوده في الدرج", `${fmt(recExpected)} د.ع`] as [string, string]]
                  : []),
              ] as [string, string][]
            ).map(([l, v]) => (
              <div key={l} className="flex justify-between border-b py-2 text-sm">
                <span className="text-muted-foreground">{l}</span>
                <span className="font-bold tabular-nums" dir="ltr">
                  {v}
                </span>
              </div>
            ))}
            <div
              className="my-4 space-y-1.5"
              onBlur={() => setCountEntered(counted.trim() !== "")}
            >
              <label htmlFor="rec-counted-cash" className="block text-sm font-bold">
                المبلغ الذي عددته في الدرج (د.ع)
              </label>
              <MoneyInput
                id="rec-counted-cash"
                value={counted}
                onChange={(value) => {
                  setCounted(value);
                  setCountEntered(false);
                }}
                placeholder="0"
                ariaLabel="النقد المعدود عند إغلاق الوردية"
                className="h-12 text-center text-lg font-extrabold"
              />
              {!showRecExpected && (
                <p className="text-xs text-muted-foreground">
                  أدخل ما عددته فعلياً في الصندوق لتظهر نتيجة المطابقة.
                </p>
              )}
            </div>
            {recDiff !== null && (
              <div
                className={cn(
                  "mt-2 inline-flex flex-wrap items-center gap-1 text-sm font-bold",
                  recDiff < 0 ? "text-destructive" : "text-[var(--sem-pos)]",
                )}
              >
                <span>
                  الفرق: {recDiff >= 0 ? "+" : ""}
                  {fmt(recDiff)} د.ع
                </span>
                {recDiff === 0 && (
                  <span className="inline-flex items-center gap-1">
                    <Check aria-hidden className="size-3.5" /> مطابق تماماً
                  </span>
                )}
                {recDiff > 0 && <span>(زيادة)</span>}
                {recDiff < 0 && <span>(عجز)</span>}
              </div>
            )}
            {hasRecVariance && (
              <div className="mt-4 space-y-2 rounded-xl border border-destructive/60 bg-destructive/10 p-3">
                <p className="text-sm font-extrabold text-destructive">
                  لا يمكن إنهاء الوردية لأن المبلغ المعدود لا يطابق المبلغ المسجّل في النظام.
                </p>
                <p className="text-xs text-muted-foreground">
                  أعد عدّ النقدية وراجع عمليات البيع والإرجاع. إذا بقي الفرق، اطلب من المدير المراجعة.
                </p>
              </div>
            )}
            <div className="mt-5 flex gap-2.5">
              <Button variant="outline" className="flex-1" onClick={onClose}>
                إلغاء
              </Button>
              <Button
                className="flex-1"
                disabled={!counted || closeShiftM.isPending || hasRecVariance}
                onClick={() =>
                  closeShiftM.mutate({
                    shiftId: shift.id,
                    countedCash: counted,
                  })
                }
              >
                {closeShiftM.isPending
                  ? "جارٍ الإنهاء…"
                  : hasRecVariance
                  ? "لا يمكن الإنهاء قبل حل الفرق"
                  : "تأكيد الإنهاء وطباعة الملخص"}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
