import type { ReactNode } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export interface OperationsMetric {
  key: string;
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  tone?: "neutral" | "danger" | "success" | "warning" | "info";
  onClick?: () => void;
  active?: boolean;
}

const toneClass: Record<NonNullable<OperationsMetric["tone"]>, string> = {
  neutral: "border-border",
  danger: "border-[var(--money-negative)]/50",
  success: "border-[var(--money-positive)]/50",
  warning: "border-[var(--stock-low)]/55",
  info: "border-primary/40",
};

export function OperationsSummary({
  title,
  subtitle,
  metrics,
  footer,
  loading,
}: {
  title: string;
  subtitle?: string;
  metrics: OperationsMetric[];
  footer?: ReactNode;
  loading?: boolean;
}) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{title}</CardTitle>
        {subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          {metrics.map((metric) => {
            const content = (
              <>
                <span className="text-xs text-muted-foreground">{metric.label}</span>
                <strong className="mt-1 block text-lg tabular-nums">{loading ? "…" : metric.value}</strong>
                {metric.detail && <span className="mt-1 block text-[11px] text-muted-foreground">{metric.detail}</span>}
              </>
            );
            const cls = cn(
              "rounded-lg border bg-card p-3 text-start transition-colors",
              toneClass[metric.tone ?? "neutral"],
              metric.onClick && "cursor-pointer hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              metric.active && "bg-accent ring-2 ring-primary/40",
            );
            return metric.onClick ? (
              <button key={metric.key} type="button" className={cls} onClick={metric.onClick}>
                {content}
              </button>
            ) : (
              <div key={metric.key} className={cls}>
                {content}
              </div>
            );
          })}
        </div>
        {footer}
      </CardContent>
    </Card>
  );
}
