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
  compact = false,
}: {
  title: string;
  subtitle?: string;
  metrics: OperationsMetric[];
  footer?: ReactNode;
  loading?: boolean;
  compact?: boolean;
}) {
  if (compact) {
    return (
      <div className="rounded-lg border bg-card/80 px-2.5 py-1.5 space-y-1.5" aria-label={title}>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs font-medium text-muted-foreground me-1" title={subtitle}>
            {title}:
          </span>
          {metrics.map((metric) => {
            const content = (
              <>
                <span className="text-muted-foreground">{metric.label}:</span>
                <strong className="font-semibold tabular-nums text-foreground">
                  {loading ? "…" : metric.value}
                </strong>
                {metric.detail && (
                  <span className="hidden xl:inline text-[11px] text-muted-foreground">
                    ({metric.detail})
                  </span>
                )}
              </>
            );
            const cls = cn(
              "inline-flex items-center gap-1.5 rounded-md border bg-background px-2.5 py-1 text-xs transition-colors",
              toneClass[metric.tone ?? "neutral"],
              metric.onClick &&
                "cursor-pointer hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
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
          {footer && (
            <details className="ms-auto text-xs">
              <summary className="cursor-pointer select-none rounded border px-2 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground">
                تفاصيل التحصيل
              </summary>
              <div className="mt-1.5 rounded-md border bg-background p-2.5 shadow-sm">
                {footer}
              </div>
            </details>
          )}
        </div>
      </div>
    );
  }

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
