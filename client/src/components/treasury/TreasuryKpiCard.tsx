import { Card } from "@/components/ui/card";
import { fmtAr } from "@/lib/money";
import { cn } from "@/lib/utils";
import { ArrowDownRight, ArrowUpRight, Minus, type LucideIcon } from "lucide-react";
import { Area, AreaChart, ResponsiveContainer } from "recharts";

type Accent = "green" | "red" | "blue" | "amber" | "purple";

const ACCENT_BG: Record<Accent, string> = {
  green: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300",
  red: "bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300",
  blue: "bg-[var(--sem-info-bg)] text-[var(--sem-info)]",
  amber: "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300",
  purple: "bg-violet-50 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300",
};

// مَربوطة بـtokens.css ⇒ تَتنفّس مع .dark.
const SPARK_COLOR: Record<Accent, string> = {
  green: "var(--money-positive)",
  red: "var(--money-negative)",
  blue: "var(--chart-card)",
  amber: "var(--chart-transfer)",
  purple: "var(--chart-check)",
};

interface TreasuryKpiCardProps {
  icon: LucideIcon;
  label: string;
  value: string; // pre-formatted أو خام (يُمرّر بـnumber)
  rawNumeric?: boolean; // false ⇒ value يَمرّ بـfmtAr، true ⇒ يُعرض كما هو (للعدّاد)
  deltaPct: number | null | undefined; // null ⇒ "—"، 0 ⇒ "مستقرّ"
  deltaLabel?: string;
  sparkline?: number[];
  accent?: Accent;
  suffix?: string;
  loading?: boolean;
}

export function TreasuryKpiCard({
  icon: Icon,
  label,
  value,
  rawNumeric = false,
  deltaPct,
  deltaLabel = "عن الأمس",
  sparkline,
  accent = "blue",
  suffix,
  loading,
}: TreasuryKpiCardProps) {
  if (loading) {
    return (
      <Card className="p-5 animate-pulse">
        <div className="h-10 w-10 rounded-full bg-muted mb-3" />
        <div className="h-3 w-24 bg-muted rounded mb-2" />
        <div className="h-8 w-32 bg-muted rounded mb-2" />
        <div className="h-3 w-20 bg-muted rounded" />
      </Card>
    );
  }

  const formatted = rawNumeric ? value : fmtAr(value);
  const trendIcon =
    deltaPct == null ? (
      <Minus className="h-3.5 w-3.5" />
    ) : deltaPct >= 5 ? (
      <ArrowUpRight className="h-3.5 w-3.5" />
    ) : deltaPct <= -5 ? (
      <ArrowDownRight className="h-3.5 w-3.5" />
    ) : (
      <Minus className="h-3.5 w-3.5" />
    );
  const trendCls =
    deltaPct == null
      ? "text-muted-foreground"
      : deltaPct >= 5
        ? "text-emerald-600 dark:text-emerald-400"
        : deltaPct <= -5
          ? "text-rose-600 dark:text-rose-400"
          : "text-muted-foreground";
  const deltaTxt =
    deltaPct == null
      ? "—"
      : deltaPct === 0
        ? "مستقرّ"
        : `${deltaPct > 0 ? "+" : ""}${deltaPct.toLocaleString("ar-IQ-u-nu-latn", { maximumFractionDigits: 1 })}%`;

  const sparkData =
    sparkline && sparkline.length > 0 ? sparkline.map((v, i) => ({ i, v })) : [];

  return (
    <Card className="relative overflow-hidden p-5 transition-shadow hover:shadow-md">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className={cn("h-10 w-10 rounded-full flex items-center justify-center", ACCENT_BG[accent])}>
          <Icon className="h-5 w-5" />
        </div>
        <div className={cn("text-xs flex items-center gap-1 font-medium", trendCls)} title={deltaLabel}>
          {trendIcon}
          <span className="tabular-nums" dir="ltr">
            {deltaTxt}
          </span>
        </div>
      </div>

      <div className="text-xs text-muted-foreground mb-1">{label}</div>
      <div className="flex items-baseline gap-1.5">
        <div className="text-2xl md:text-3xl font-bold tabular-nums tracking-tight" dir="ltr">
          {formatted}
        </div>
        {suffix && <div className="text-xs text-muted-foreground">{suffix}</div>}
      </div>

      <div className="text-[10px] text-muted-foreground mt-1">{deltaLabel}</div>

      {sparkData.length >= 2 && (
        <div className="absolute bottom-0 left-0 right-0 h-12 opacity-70 pointer-events-none">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={sparkData} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id={`spark-${accent}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={SPARK_COLOR[accent]} stopOpacity={0.35} />
                  <stop offset="100%" stopColor={SPARK_COLOR[accent]} stopOpacity={0} />
                </linearGradient>
              </defs>
              <Area
                type="monotone"
                dataKey="v"
                stroke={SPARK_COLOR[accent]}
                strokeWidth={1.5}
                fill={`url(#spark-${accent})`}
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </Card>
  );
}
