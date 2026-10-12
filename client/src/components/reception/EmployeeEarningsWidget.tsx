import { useMemo } from "react";
import { trpc } from "@/lib/trpc";
import { fmtInt } from "@/lib/money";
import { Award, Target, TrendingUp, User, Zap } from "lucide-react";
import { cn } from "@/lib/utils";

interface EmployeeEarningsWidgetProps {
  compact?: boolean;
  className?: string;
}

export function EmployeeEarningsWidget({ compact = false, className }: EmployeeEarningsWidgetProps) {
  const meQ = trpc.auth.me.useQuery();
  const statusQ = trpc.commissions.performance.myStatus.useQuery(undefined, {
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const me = meQ.data;
  const status = statusQ.data;

  const photo = status?.photoUrl || me?.photoUrl;
  const employeeName = status?.employeeName || me?.name || "الموظف";
  const projectedCommission = status?.projectedCommission ? Number(status.projectedCommission) : 0;
  const achievementPct = status?.achievementPct ? Number(status.achievementPct) : null;
  const hasPlan = Boolean(status?.planName);

  if (compact) {
    return (
      <div
        className={cn(
          "inline-flex items-center gap-2 rounded-xl border border-primary/20 bg-primary/5 px-2.5 py-1 text-xs",
          className,
        )}
      >
        <div className="relative size-6 shrink-0 overflow-hidden rounded-full border border-primary/30 bg-primary/10">
          {photo ? (
            <img src={photo} alt={employeeName} className="size-full object-cover" />
          ) : (
            <User aria-hidden className="size-full p-1 text-primary" />
          )}
        </div>
        <div className="flex flex-col">
          <span className="font-bold text-foreground leading-tight">{employeeName}</span>
          <span className="text-[10px] text-muted-foreground font-medium">
            {hasPlan
              ? `عمولة متوقعة: ${fmtInt(projectedCommission)} د.ع`
              : "مسؤول الخدمة والتجهيز"}
          </span>
        </div>
        {achievementPct != null && (
          <span
            className={cn(
              "ms-1 rounded-md px-1.5 py-0.5 text-[10px] font-bold tabular-nums",
              achievementPct >= 100
                ? "bg-[var(--sem-pos-bg)] text-[var(--sem-pos)] border border-[var(--sem-pos)]/30"
                : "bg-muted text-foreground",
            )}
          >
            {achievementPct.toLocaleString("ar-IQ-u-nu-latn", { maximumFractionDigits: 0 })}%
          </span>
        )}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-2xl border border-primary/25 bg-gradient-to-r from-primary/10 via-card to-card p-3.5 shadow-xs",
        className,
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        {/* ملف الموظف والصورة */}
        <div className="flex items-center gap-3">
          <div className="relative size-11 shrink-0 overflow-hidden rounded-xl border-2 border-primary/40 bg-muted shadow-xs">
            {photo ? (
              <img src={photo} alt={employeeName} className="size-full object-cover" />
            ) : (
              <div className="grid size-full place-items-center bg-primary/10 text-primary font-black text-sm">
                {employeeName.slice(0, 2)}
              </div>
            )}
            <div
              className="absolute -bottom-1 -right-1 grid size-4 place-items-center rounded-full bg-primary text-[8px] text-primary-foreground font-black"
              title="موظف معتمد"
            >
              <Zap aria-hidden className="size-2.5" />
            </div>
          </div>

          <div>
            <div className="flex items-center gap-1.5">
              <span className="font-black text-sm text-foreground">{employeeName}</span>
              <span className="rounded-md bg-primary/15 px-1.5 py-0.5 text-[10px] font-bold text-primary">
                {status?.planName || "خطة المبيعات"}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              {status?.target
                ? `هدفك الشهري: ${fmtInt(status.target)} د.ع`
                : "خدمة العملاء وتجهيز الطلبات الفورية"}
            </p>
          </div>
        </div>

        {/* أرقام العمولة والهدف */}
        <div className="flex items-center gap-3">
          {hasPlan && (
            <div className="flex flex-col items-end border-s border-border/80 ps-3">
              <div className="flex items-center gap-1 text-[11px] font-bold text-muted-foreground">
                <Award aria-hidden className="size-3.5 text-primary" />
                <span>العمولة التقديرية</span>
              </div>
              <span className="font-black text-base text-primary tabular-nums">
                {fmtInt(projectedCommission)} د.ع
              </span>
            </div>
          )}

          {achievementPct != null && (
            <div className="flex min-w-[120px] flex-col gap-1 border-s border-border/80 ps-3">
              <div className="flex items-center justify-between text-[11px]">
                <span className="inline-flex items-center gap-1 text-muted-foreground font-bold">
                  <Target aria-hidden className="size-3 text-muted-foreground" />
                  تحقيق الهدف
                </span>
                <span className="font-extrabold tabular-nums text-foreground">
                  {achievementPct.toLocaleString("ar-IQ-u-nu-latn", { maximumFractionDigits: 1 })}%
                </span>
              </div>
              <div
                className="h-2 w-full overflow-hidden rounded-full bg-muted"
                role="progressbar"
                aria-valuenow={Math.round(achievementPct)}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <div
                  className={cn(
                    "h-full rounded-full transition-all duration-500",
                    achievementPct >= 100 ? "bg-[var(--sem-pos)]" : "bg-primary",
                  )}
                  style={{ width: `${Math.min(achievementPct, 100)}%` }}
                />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
