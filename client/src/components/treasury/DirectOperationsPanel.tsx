import { Card, CardContent } from "@/components/ui/card";
import { fmtAr, D } from "@/lib/money";
import { ArrowDownLeft, ArrowUpRight, DollarSign, Wallet } from "lucide-react";
import type { RouterOutputs } from "@/lib/trpc";

type DC = RouterOutputs["reports"]["dayCloseReconciliation"];

interface DirectOperationsPanelProps {
  direct: DC["directOperations"];
  totals: DC["totals"];
}

/**
 * لوحة العمليات والتدفقات النقدية المباشرة (خارج أدراج الورديات).
 * توثق سندات القبض RV والمبيعات وسندات الصرف PV المباشرة لمنع الفائض الصامت.
 */
export function DirectOperationsPanel({ direct, totals }: DirectOperationsPanelProps) {
  if (!direct || direct.receiptCount === 0) return null;

  return (
    <Card className="border-primary/20 bg-muted/10">
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b pb-2">
          <div className="flex items-center gap-2">
            <Wallet className="size-4 text-primary" />
            <span className="text-sm font-bold">
              العمليات والتدفقات النقدية المباشرة (خارج أدراج الورديات)
            </span>
            <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-semibold text-primary">
              {direct.receiptCount} حركة نقدية
            </span>
          </div>
          <span className="text-xs text-muted-foreground">
            تشمل سندات القبض RV والتحصيلات والمبيعات والصرف المباشر بالخزينة
          </span>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {/* المقبوضات المباشرة */}
          <div className="rounded-lg border bg-background/50 p-3">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>إجمالي المقبوضات المباشرة</span>
              <ArrowDownLeft className="size-4 text-money-positive" />
            </div>
            <p className="mt-1 text-xl font-bold tabular-nums text-money-positive" dir="ltr">
              {fmtAr(direct.cashIn)}
            </p>
            <div className="mt-2 space-y-0.5 border-t pt-1.5 text-[11px] text-muted-foreground">
              <div className="flex justify-between">
                <span>سندات قبض وتحصيلات:</span>
                <span className="font-semibold tabular-nums text-foreground" dir="ltr">
                  {fmtAr(direct.collectionsCash)}
                </span>
              </div>
              <div className="flex justify-between">
                <span>مبيعات نقدية مباشرة:</span>
                <span className="font-semibold tabular-nums text-foreground" dir="ltr">
                  {fmtAr(direct.salesCash)}
                </span>
              </div>
              {direct.otherIn && !D(direct.otherIn).isZero() && (
                <div className="flex justify-between">
                  <span>مقبوضات أخرى:</span>
                  <span className="font-semibold tabular-nums text-foreground" dir="ltr">
                    {fmtAr(direct.otherIn)}
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* المدفوعات المباشرة */}
          <div className="rounded-lg border bg-background/50 p-3">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>إجمالي المدفوعات المباشرة</span>
              <ArrowUpRight className="size-4 text-money-negative" />
            </div>
            <p className="mt-1 text-xl font-bold tabular-nums text-money-negative" dir="ltr">
              {fmtAr(direct.operatingOut)}
            </p>
            <div className="mt-2 space-y-0.5 border-t pt-1.5 text-[11px] text-muted-foreground">
              <div className="flex justify-between">
                <span>سندات صرف ومصروفات:</span>
                <span className="font-semibold tabular-nums text-foreground" dir="ltr">
                  {fmtAr(direct.expensesCash)}
                </span>
              </div>
              <div className="flex justify-between">
                <span>مرتجعات نقدية:</span>
                <span className="font-semibold tabular-nums text-foreground" dir="ltr">
                  {fmtAr(direct.returnsCash)}
                </span>
              </div>
              {direct.otherOut && !D(direct.otherOut).isZero() && (
                <div className="flex justify-between">
                  <span>مدفوعات أخرى:</span>
                  <span className="font-semibold tabular-nums text-foreground" dir="ltr">
                    {fmtAr(direct.otherOut)}
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* صافي النقد المباشر */}
          <div className="rounded-lg border bg-background/50 p-3">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>صافي الأثر النقدي المباشر</span>
              <DollarSign className="size-4 text-primary" />
            </div>
            <p className="mt-1 text-xl font-bold tabular-nums text-primary" dir="ltr">
              {fmtAr(direct.netCash)}
            </p>
            <p className="mt-2 text-[11px] text-muted-foreground border-t pt-1.5">
              يُضاف إلى نقد الأدراج لحساب إجمالي نقد اليوم الفعلي ({fmtAr(totals?.expected ?? direct.netCash)} د.ع).
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
