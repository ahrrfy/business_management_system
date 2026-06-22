import { fmtAr } from "@/lib/money";
import { useMemo } from "react";
import { Cell, Pie, PieChart, ResponsiveContainer } from "recharts";

export interface MethodSlice {
  key: string;
  label: string;
  inTotal: string;
  outTotal: string;
  count: number;
}

interface PaymentMethodDonutProps {
  data: MethodSlice[];
  loading?: boolean;
  height?: number;
  /** "in" يَعرض المقبوضات، "out" المدفوعات. */
  direction?: "in" | "out";
}

const COLORS: Record<string, string> = {
  CASH: "#10b981",
  CARD: "#0ea5e9",
  CHECK: "#8b5cf6",
  TRANSFER: "#f59e0b",
  WALLET: "#ec4899",
};

export function PaymentMethodDonut({
  data,
  loading,
  height = 240,
  direction = "in",
}: PaymentMethodDonutProps) {
  const slices = useMemo(
    () =>
      data
        .map((d) => ({
          name: d.label,
          key: d.key,
          value: Number(direction === "in" ? d.inTotal : d.outTotal),
          count: d.count,
        }))
        .filter((d) => d.value > 0),
    [data, direction],
  );

  const total = slices.reduce((sum, s) => sum + s.value, 0);

  if (loading) {
    return (
      <div className="rounded-md border p-4 animate-pulse">
        <div className="h-3 w-32 bg-muted rounded mb-3" />
        <div className="bg-muted rounded-full mx-auto" style={{ width: 180, height: 180 }} />
      </div>
    );
  }

  return (
    <div className="rounded-md border bg-card p-4">
      <h3 className="text-sm font-semibold mb-3">
        {direction === "in" ? "المقبوضات بطرق الدفع" : "المدفوعات بطرق الدفع"}
      </h3>

      {slices.length === 0 ? (
        <div
          className="flex items-center justify-center text-sm text-muted-foreground bg-muted/30 rounded"
          style={{ height }}
        >
          لا حركات في الفترة.
        </div>
      ) : (
        <>
          <div className="relative" style={{ height }}>
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={slices}
                  dataKey="value"
                  innerRadius="60%"
                  outerRadius="85%"
                  paddingAngle={2}
                  isAnimationActive={false}
                >
                  {slices.map((s) => (
                    <Cell key={s.key} fill={COLORS[s.key] ?? "#94a3b8"} stroke="transparent" />
                  ))}
                </Pie>
              </PieChart>
            </ResponsiveContainer>
            <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
              <div className="text-xs text-muted-foreground">الإجمالي</div>
              <div className="text-lg font-bold tabular-nums" dir="ltr">
                {fmtAr(total)}
              </div>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-1.5 mt-3 text-xs">
            {slices.map((s) => {
              const pct = total > 0 ? ((s.value / total) * 100).toFixed(0) : "0";
              return (
                <div key={s.key} className="flex items-center gap-2">
                  <span
                    className="w-2.5 h-2.5 rounded-full shrink-0"
                    style={{ background: COLORS[s.key] ?? "#94a3b8" }}
                  />
                  <span className="flex-1">{s.name}</span>
                  <span className="tabular-nums text-muted-foreground" dir="ltr">
                    {pct}%
                  </span>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
