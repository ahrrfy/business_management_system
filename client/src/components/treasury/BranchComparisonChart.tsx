import { fmtAr } from "@/lib/money";
import { useMemo } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

interface BranchRow {
  branchId: number;
  branchName: string;
  drawer: number;
  treasury?: number; // اختياري للكاشير
}

interface BranchComparisonChartProps {
  data: BranchRow[];
  loading?: boolean;
  showTreasury?: boolean;
  height?: number;
}

const abbreviateNumber = (n: number): string => {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(Math.round(n));
};

interface TooltipPayload {
  name: string;
  value: number;
  color: string;
}

function FmtTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: TooltipPayload[];
  label?: string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const total = payload.reduce((s, p) => s + p.value, 0);
  return (
    <div className="rounded-md border bg-background/95 backdrop-blur-sm shadow-md p-2 text-xs">
      <div className="font-semibold mb-1.5">{label}</div>
      {payload.map((p) => (
        <div key={p.name} className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full" style={{ background: p.color }} />
            <span>{p.name}</span>
          </div>
          <span className="tabular-nums font-medium" dir="ltr">
            {fmtAr(p.value)}
          </span>
        </div>
      ))}
      <div className="border-t border-border mt-1.5 pt-1.5 flex items-center justify-between gap-3">
        <span className="text-muted-foreground">الإجمالي</span>
        <span className="tabular-nums font-bold" dir="ltr">
          {fmtAr(total)}
        </span>
      </div>
    </div>
  );
}

export function BranchComparisonChart({
  data,
  loading,
  showTreasury = true,
  height = 220,
}: BranchComparisonChartProps) {
  const chartData = useMemo(
    () =>
      data.map((d) => ({
        name: d.branchName,
        درج: d.drawer,
        خزينة: showTreasury ? d.treasury ?? 0 : 0,
      })),
    [data, showTreasury],
  );

  if (loading) {
    return (
      <div className="rounded-md border p-4 animate-pulse">
        <div className="h-3 w-32 bg-muted rounded mb-3" />
        <div className="bg-muted rounded" style={{ height }} />
      </div>
    );
  }

  const isEmpty = chartData.every((d) => d.درج === 0 && d.خزينة === 0);

  return (
    <div className="rounded-md border bg-card p-4">
      <h3 className="text-sm font-semibold mb-3">مقارنة أرصدة الفروع</h3>
      {isEmpty ? (
        <div
          className="flex items-center justify-center text-sm text-muted-foreground bg-muted/30 rounded"
          style={{ height }}
        >
          لا أرصدة لعرضها.
        </div>
      ) : (
        <div role="img" aria-label={`مقارنة أرصدة الفروع: ${chartData.map((d) => `${d.name} ${fmtAr(d.درج + d.خزينة)}`).join("، ")} دينار.`}>
        <ResponsiveContainer width="100%" height={height}>
          <BarChart data={chartData} margin={{ top: 5, right: 8, left: -8, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" className="stroke-border/40" />
            <XAxis dataKey="name" tick={{ fontSize: 12 }} />
            <YAxis tickFormatter={abbreviateNumber} tick={{ fontSize: 11 }} />
            <Tooltip content={<FmtTooltip />} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Bar dataKey="درج" stackId="bal" fill="var(--chart-cash)" radius={[0, 0, 0, 0]} />
            {showTreasury && <Bar dataKey="خزينة" stackId="bal" fill="var(--chart-check)" radius={[4, 4, 0, 0]} />}
          </BarChart>
        </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
