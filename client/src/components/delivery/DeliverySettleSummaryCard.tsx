import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CashCounter } from "@/components/CashCounter";
import { fmt } from "@/lib/money";
import { cn } from "@/lib/utils";
import { DELIVERY_TERMS as DT } from "@shared/deliveryTerminology";

export function DeliverySettleSummaryCard({
  totals,
  countedCash,
  countedBreakdown,
  onCountedChange,
  canRemit,
  isPending,
  listStillLoading,
  statementMode,
  statementNumber,
  onSubmit,
}: {
  totals: {
    collected: number;
    fees: number;
    net: number;
    deductions: number;
    shortfall: number;
    expected: number;
    leftInTransit: number;
    selectedCount: number;
  };
  countedCash: number;
  countedBreakdown: Record<number, number>;
  onCountedChange: (breakdown: Record<number, number>, total: string) => void;
  canRemit: boolean;
  isPending: boolean;
  listStillLoading: boolean;
  statementMode: boolean;
  statementNumber: string;
  onSubmit: () => void;
}) {
  const cashDiff = countedCash - totals.net;
  const isMatch = Math.abs(cashDiff) < 0.01;
  const needsInput = totals.net > 0.01 && countedCash === 0;
  const tone = needsInput
    ? "text-muted-foreground"
    : isMatch
      ? "text-money-positive"
      : "text-money-negative";
  const label = needsInput
    ? "أدخل النقد المعدود لبدء التسوية"
    : isMatch
      ? "النقد المعدود مطابق للصافي"
      : "فرق العد — سو المعدود قبل التسوية";

  const isBlocked = isPending || listStillLoading || !isMatch;

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <div className="rounded-xl border bg-card p-4 text-sm">
        <div className="flex justify-between border-b py-1.5">
          <span className="text-muted-foreground">إجمالي التحصيل (COD)</span>
          <span dir="ltr" className="font-bold tabular-nums">{fmt(String(totals.collected))} د.ع</span>
        </div>
        <div className="flex justify-between border-b py-1.5">
          <span className="font-bold">النقد المتوقَّع توريده</span>
          <span dir="ltr" className="font-extrabold tabular-nums text-primary">{fmt(String(totals.net))} د.ع</span>
        </div>
        {totals.shortfall > 0.01 && (
          <div className="flex items-center justify-between border-b py-1.5 font-bold text-[var(--sem-warn)]">
            <span className="inline-flex items-center gap-1" title={DT.requestedFromCustomer.tooltip}>
              <AlertTriangle aria-hidden className="size-3.5" />
              متبقٍّ على العميل (لم يُقبَض من المندوب بعد)
            </span>
            <span dir="ltr" className="tabular-nums">{fmt(String(totals.shortfall))} د.ع</span>
          </div>
        )}
        <div className={cn("flex items-center justify-between border-t py-1.5 font-bold", tone)}>
          <span>{label}</span>
          <span dir="ltr" className="tabular-nums">{needsInput ? "—" : `${fmt(String(cashDiff))} د.ع`}</span>
        </div>
        {canRemit && (
          <Button
            className="mt-3 w-full"
            variant={isBlocked ? "secondary" : "default"}
            onClick={onSubmit}
            disabled={isBlocked}
            title={
              listStillLoading
                ? "جارٍ تحميل باقي الإرساليات — التوريد بعد اكتمال العدّ"
                : needsInput
                  ? "أدخل النقد المعدود المطابق للصافي المتوقَّع قبل التوريد"
                  : !isMatch
                    ? "النقد المعدود لا يطابق الصافي — سو الفرق قبل التوريد"
                    : undefined
            }
          >
            {isPending
              ? "جار…"
              : listStillLoading
                ? "جار تحميل باقي الإرساليات…"
                : statementMode
                  ? `تسجيل كشف الشركة ${statementNumber.trim()} وتوريد الصافي`
                  : "تأكيد التسوية وتوريد الصافي"}
          </Button>
        )}
      </div>
      <CashCounter value={countedBreakdown} onChange={onCountedChange} />
    </div>
  );
}
