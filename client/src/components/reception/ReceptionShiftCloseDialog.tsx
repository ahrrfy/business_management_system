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
import {
  SHIFT_VARIANCE_CODES,
  SHIFT_VARIANCE_LABELS,
  type ShiftVarianceCode,
} from "@shared/shiftCashGovernance";
import { ShiftCashReconciliationMini } from "../pos/ShiftCashReconciliationMini";

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
  const [varianceReasonCode, setVarianceReasonCode] = useState<ShiftVarianceCode | "">("");
  const [varianceReason, setVarianceReason] = useState("");
  const [managerApprovedByUserId, setManagerApprovedByUserId] = useState<number | "">("");

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

  // رقم الخادم نفسه الذي يفرضه closeShift (DRAWER فقط)؛ لا نعيد تركيب المعادلة من تقرير طرق الدفع.
  const recExpected = Number(reportQ.data?.expectedCash ?? shift.openingBalance ?? 0);
  // فقدان التركيز من حقل المعدود يُثبّت انتهاء الإدخال ويكشف المطابقة تلقائياً بلا زر إضافي.
  const showRecExpected = isElevatedRole || countEntered;
  const recDiff = showRecExpected && counted ? Number(counted) - recExpected : null;
  const hasRecVariance = recDiff != null && Math.abs(recDiff) >= 0.01;

  const approversQ = trpc.shifts.eligibleVarianceApprovers.useQuery(undefined, {
    enabled: open && hasRecVariance && !isElevatedRole,
  });

  const canCloseWithVariance = isElevatedRole
    ? !!(varianceReasonCode && varianceReason.trim())
    : !!(varianceReasonCode && varianceReason.trim() && managerApprovedByUserId);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      dir="rtl"
      onClick={onClose}
    >
      <div
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-card p-6 shadow-2xl"
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
              ] as [string, string][]
            ).map(([l, v]) => (
              <div key={l} className="flex justify-between border-b py-2 text-sm">
                <span className="text-muted-foreground">{l}</span>
                <span className="font-bold tabular-nums" dir="ltr">
                  {v}
                </span>
              </div>
            ))}

            {/* تفصيل وبيان نقد الوردية ومصادر النقد المتوقع */}
            <ShiftCashReconciliationMini
              cashReconciliation={reportQ.data?.cashReconciliation}
              invoiceCount={reportQ.data?.invoiceCount ?? 0}
              salesTotal={reportQ.data?.salesTotal ?? "0"}
              openingBalance={Number(shift.openingBalance ?? 0)}
              expectedCash={recExpected}
              showExpected={showRecExpected}
            />
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
              <div className="mt-4 space-y-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3.5">
                <div>
                  <p className="text-sm font-extrabold text-foreground">
                    يوجد فرق نقدي ({recDiff != null && recDiff > 0 ? "زيادة" : "عجز"} بقيمة {recDiff != null ? fmt(Math.abs(recDiff)) : 0} د.ع)
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {isElevatedRole
                      ? "بصفتك مديراً/مسؤولاً، يرجى تحديد سبب الفرق وكتابة التبرير لاعتماده وتصفير الدرج."
                      : "إنهاء الوردية بفرق نقدي يتطلب توثيق السبب وبيانه واعتماده من مدير الفرع."}
                  </p>
                </div>

                <div className="space-y-2.5">
                  {!isElevatedRole && (
                    <div>
                      <label className="block text-xs font-bold mb-1">المدير المعتمد للفرق:</label>
                      <select
                        value={managerApprovedByUserId}
                        onChange={(e) => setManagerApprovedByUserId(e.target.value ? Number(e.target.value) : "")}
                        className="w-full h-9 rounded-md border border-input bg-background px-3 py-1 text-xs shadow-sm"
                      >
                        <option value="">-- اختر مديراً للاعتماد --</option>
                        {(approversQ.data ?? []).map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name} ({m.role === "admin" ? "إدارة عامة" : "مدير فرع"})
                          </option>
                        ))}
                      </select>
                    </div>
                  )}

                  <div>
                    <label className="block text-xs font-bold mb-1">سبب الفرق:</label>
                    <select
                      value={varianceReasonCode}
                      onChange={(e) => setVarianceReasonCode(e.target.value as ShiftVarianceCode)}
                      className="w-full h-9 rounded-md border border-input bg-background px-3 py-1 text-xs shadow-sm"
                    >
                      <option value="">-- اختر سبب الفرق --</option>
                      {SHIFT_VARIANCE_CODES.map((code) => (
                        <option key={code} value={code}>
                          {SHIFT_VARIANCE_LABELS[code]}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs font-bold mb-1">بيان وتبرير الفرق:</label>
                    <input
                      type="text"
                      value={varianceReason}
                      onChange={(e) => setVarianceReason(e.target.value)}
                      placeholder="اكتب توضيحاً تفصيلياً لسبب الفرق..."
                      className="w-full h-9 rounded-md border border-input bg-background px-3 py-1 text-xs shadow-sm"
                    />
                  </div>
                </div>
              </div>
            )}
            <div className="mt-5 flex gap-2.5">
              <Button variant="outline" className="flex-1" onClick={onClose}>
                إلغاء
              </Button>
              <Button
                className="flex-1"
                disabled={!counted || closeShiftM.isPending || (hasRecVariance && !canCloseWithVariance)}
                onClick={() =>
                  closeShiftM.mutate({
                    shiftId: shift.id,
                    countedCash: counted,
                    varianceReasonCode: hasRecVariance && varianceReasonCode ? (varianceReasonCode as ShiftVarianceCode) : undefined,
                    varianceReason: hasRecVariance && varianceReason.trim() ? varianceReason.trim() : undefined,
                    managerApprovedByUserId: hasRecVariance && !isElevatedRole && managerApprovedByUserId ? Number(managerApprovedByUserId) : undefined,
                  })
                }
              >
                {closeShiftM.isPending
                  ? "جارٍ الإنهاء…"
                  : hasRecVariance
                  ? canCloseWithVariance
                    ? isElevatedRole
                      ? "تأكيد الإنهاء المعتمد وطباعة الملخص"
                      : "تأكيد الإنهاء باعتماد المدير وطباعة الملخص"
                    : isElevatedRole
                      ? "حدد سبب الفرق وتبريره"
                      : "يتطلب اعتماد المدير وبيان السبب"
                  : "تأكيد الإنهاء وطباعة الملخص"}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
