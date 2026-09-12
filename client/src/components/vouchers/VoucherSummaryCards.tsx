import { Card, CardContent } from "@/components/ui/card";
import { fmt } from "@/lib/money";
import { ShieldQuestion } from "lucide-react";
import type Decimal from "decimal.js";

interface VoucherSummaryCardsProps {
  totalIn: string | number;
  totalOut: string | number;
  netTotal: Decimal;
  filterType: string;
  reversedCount?: number;
  pendingTotal?: string | null;
  pendingCount?: number;
}

export function VoucherSummaryCards({
  totalIn,
  totalOut,
  netTotal,
  filterType,
  reversedCount = 0,
  pendingTotal = "0",
  pendingCount = 0,
}: VoucherSummaryCardsProps) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
      <Card>
        <CardContent className="p-4">
          <div className="text-xs text-muted-foreground">
            إجمالي القبض (مُعتمَد)
          </div>
          <div
            className="text-xl font-bold text-money-positive tabular-nums"
            dir="ltr"
          >
            {fmt(totalIn)}
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="p-4">
          <div className="text-xs text-muted-foreground">
            إجمالي الصرف (معتمد ومصروف)
          </div>
          <div
            className="text-xl font-bold text-money-negative tabular-nums"
            dir="ltr"
          >
            {fmt(totalOut)}
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="p-4">
          <div className="text-xs text-muted-foreground">الصافي</div>
          <div
            className={`text-xl font-bold tabular-nums ${netTotal.gte(0) ? "text-money-positive" : "text-money-negative"}`}
            dir="ltr"
          >
            {fmt(netTotal.toFixed(2))}
          </div>
          {reversedCount > 0 && (
            <div className="text-[11px] text-muted-foreground mt-0.5">
              {reversedCount.toLocaleString("ar-IQ-u-nu-latn")} سند مُلغى في النطاق
            </div>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardContent className="p-4">
          <div className="text-xs text-muted-foreground inline-flex items-center gap-1">
            <ShieldQuestion aria-hidden className="size-3.5" />
            {filterType === "PAYMENT"
              ? "بانتظار اعتماد وصرف (بلا أَثَر)"
              : filterType === "RECEIPT"
                ? "بانتظار اعتماد (بلا أَثَر)"
                : "بانتظار اعتماد / صرف (بلا أَثَر)"}
          </div>
          <div
            className="text-xl font-bold text-[var(--sem-warn)] tabular-nums"
            dir="ltr"
          >
            {fmt(pendingTotal)}
          </div>
          <div className="text-[11px] text-muted-foreground mt-0.5">
            {pendingCount.toLocaleString("ar-IQ-u-nu-latn")} سند معلّق
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
