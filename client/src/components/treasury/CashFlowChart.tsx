import { fmtAr } from "@/lib/money";
import { useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export interface DailyPoint {
  day: string;
  inflow: string;
  outflow: string;
  net: string;
}

interface CashFlowChartProps {
  data: DailyPoint[];
  loading?: boolean;
  height?: number;
}

type Variant = "area" | "line" | "bar";

const shortDate = (d: string) => {
  // d = YYYY-MM-DD ⇒ "MM/DD" بـالأرقام اللاتينية (للقراءة السريعة في chart).
  const [, m, dd] = d.split("-");
  return `${m}/${dd}`;
};

const abbreviateNumber = (n: number): string => {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
};

export function CashFlowChart({ data, loading, height = 300 }: CashFlowChartProps) {
  const [variant, setVariant] = useState<Variant>("area");

  const chartData = useMemo(
    () =>
      data.map((d) => ({
        day: shortDate(d.day),
        inflow: Number(d.inflow),
        outflow: Number(d.outflow),
        net: Number(d.net),
      })),
    [data],
  );

  if (loading) {
    return (
      <div className="rounded-md border p-4 animate-pulse">
        <div className="h-3 w-32 bg-muted rounded mb-3" />
        <div className="bg-muted rounded" style={{ height }} />
      </div>
    );
  }

  const isEmpty = chartData.every((d) => d.inflow === 0 && d.outflow === 0);

  return (
    <div className="rounded-md border bg-card p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold">التدفّق النقدي — {data.length} يوماً</h3>
        <div className="flex items-center gap-0.5 text-xs rounded-md border bg-background p-0.5">
          {[
            { k: "area", label: "منطقة" },
            { k: "line", label: "خط" },
            { k: "bar", label: "أعمدة" },
          ].map((opt) => (
            <button
              key={opt.k}
              onClick={() => setVariant(opt.k as Variant)}
              className={
                variant === opt.k
                  ? "px-2.5 py-1 rounded-sm bg-primary text-primary-foreground"
                  : "px-2.5 py-1 rounded-sm text-muted-foreground hover:text-foreground"
              }
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {isEmpty ? (
        <div
          className="flex items-center justify-center text-sm text-muted-foreground bg-muted/30 rounded"
          style={{ height }}
        >
          لا حركات نقدية في الفترة المعروضة.
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={height}>
          {variant === "bar" ? (
            <BarChart data={chartData} margin={{ top: 5, right: 8, left: -8, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border/40" />
              <XAxis dataKey="day" reversed tick={{ fontSize: 11 }} />
              <YAxis tickFormatter={abbreviateNumber} tick={{ fontSize: 11 }} />
              <Tooltip content={<FmtTooltip />} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Bar dataKey="inflow" name="مقبوضات" fill="var(--money-positive)" radius={[4, 4, 0, 0]} />
              <Bar dataKey="outflow" name="مدفوعات" fill="var(--money-negative)" radius={[4, 4, 0, 0]} />
            </BarChart>
          ) : variant === "line" ? (
            <LineChart data={chartData} margin={{ top: 5, right: 8, left: -8, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border/40" />
              <XAxis dataKey="day" reversed tick={{ fontSize: 11 }} />
              <YAxis tickFormatter={abbreviateNumber} tick={{ fontSize: 11 }} />
              <Tooltip content={<FmtTooltip />} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Line type="monotone" dataKey="inflow" name="مقبوضات" stroke="var(--money-positive)" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="outflow" name="مدفوعات" stroke="var(--money-negative)" strokeWidth={2} dot={false} />
            </LineChart>
          ) : (
            <AreaChart data={chartData} margin={{ top: 5, right: 8, left: -8, bottom: 0 }}>
              <defs>
                <linearGradient id="gradIn" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--money-positive)" stopOpacity={0.3} />
                  <stop offset="100%" stopColor="var(--money-positive)" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="gradOut" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--money-negative)" stopOpacity={0.3} />
                  <stop offset="100%" stopColor="var(--money-negative)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border/40" />
              <XAxis dataKey="day" reversed tick={{ fontSize: 11 }} />
              <YAxis tickFormatter={abbreviateNumber} tick={{ fontSize: 11 }} />
              <Tooltip content={<FmtTooltip />} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Area
                type="monotone"
                dataKey="inflow"
                name="مقبوضات"
                stroke="var(--money-positive)"
                strokeWidth={2}
                fill="url(#gradIn)"
              />
              <Area
                type="monotone"
                dataKey="outflow"
                name="مدفوعات"
                stroke="var(--money-negative)"
                strokeWidth={2}
                fill="url(#gradOut)"
              />
            </AreaChart>
          )}
        </ResponsiveContainer>
      )}
    </div>
  );
}

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
  return (
    <div className="rounded-md border bg-background/95 backdrop-blur-sm shadow-md p-2 text-xs">
      <div className="font-semibold mb-1.5 tabular-nums" dir="ltr">
        {label}
      </div>
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
    </div>
  );
}
