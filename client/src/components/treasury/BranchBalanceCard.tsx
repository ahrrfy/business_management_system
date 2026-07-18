import { Card } from "@/components/ui/card";
import { fmtAr } from "@/lib/money";
import { cn } from "@/lib/utils";
import { Building2, Wallet, Vault } from "lucide-react";

interface BranchBalanceCardProps {
  branchId: number;
  branchName: string;
  branchTypeBadge?: "MAIN" | "SALES";
  drawer: {
    expected: string;
    opening: string;
    openShifts: number;
  };
  treasury?: {
    balance: string;
  } | null;
  alerts?: Array<{
    severity: "warning" | "danger" | "info";
    text: string;
  }>;
}

const SEVERITY_CLS = {
  warning: "bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-950/30 dark:text-amber-300 dark:border-amber-900",
  danger: "bg-rose-50 text-rose-800 border-rose-200 dark:bg-rose-950/30 dark:text-rose-300 dark:border-rose-900",
  info: "bg-[var(--sem-info-bg)] text-[var(--sem-info)] border-[var(--sem-info)]",
};

export function BranchBalanceCard({
  branchName,
  branchTypeBadge,
  drawer,
  treasury,
  alerts,
}: BranchBalanceCardProps) {
  return (
    <Card className="p-5">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <div className="h-9 w-9 rounded-lg bg-primary/10 flex items-center justify-center">
            <Building2 className="h-5 w-5 text-primary" />
          </div>
          <div>
            <div className="font-semibold">{branchName}</div>
            {branchTypeBadge && (
              <div className="text-[10px] text-muted-foreground">{branchTypeBadge}</div>
            )}
          </div>
        </div>
      </div>

      <div className={cn("grid gap-3", treasury ? "grid-cols-2" : "grid-cols-1")}>
        {/* DRAWER */}
        <div className="rounded-lg border bg-muted/30 p-3">
          <div className="flex items-center gap-1.5 mb-1.5">
            <Wallet className="h-3.5 w-3.5 text-emerald-600" />
            <span className="text-xs text-muted-foreground">نقد الدرج</span>
          </div>
          <div className="text-xl font-bold tabular-nums mb-1" dir="ltr">
            {fmtAr(drawer.expected)}
          </div>
          <div className="text-[11px] text-muted-foreground">
            افتتاحي: <span dir="ltr" className="tabular-nums">{fmtAr(drawer.opening)}</span>
            <span className="mx-1">·</span>
            {drawer.openShifts.toLocaleString("ar-IQ-u-nu-latn")} وردية مفتوحة
          </div>
        </div>

        {/* TREASURY (مخفي للكاشير) */}
        {treasury && (
          <div className="rounded-lg border bg-muted/30 p-3">
            <div className="flex items-center gap-1.5 mb-1.5">
              <Vault className="h-3.5 w-3.5 text-violet-600" />
              <span className="text-xs text-muted-foreground">نقد الخزينة</span>
            </div>
            <div className="text-xl font-bold tabular-nums mb-1" dir="ltr">
              {fmtAr(treasury.balance)}
            </div>
            <div className="text-[11px] text-muted-foreground">رصيد تراكمي</div>
          </div>
        )}
      </div>

      {/* تنبيهات */}
      {alerts && alerts.length > 0 && (
        <div className="mt-3 space-y-1.5">
          {alerts.map((a, i) => (
            <div key={i} className={cn("text-[11px] border rounded-md px-2 py-1.5", SEVERITY_CLS[a.severity])}>
              {a.text}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
