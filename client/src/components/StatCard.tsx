import * as React from "react";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { LucideIcon } from "lucide-react";

type Tone = "default" | "positive" | "negative" | "warning" | "info";

/** يلوّن الرقم البطل دلالياً عبر توكنز tokens.css (لا ألوان خام). */
const TONE_VALUE_CLS: Record<Tone, string> = {
  default: "",
  positive: "text-money-positive",
  negative: "text-money-negative",
  warning: "text-stock-low",
  info: "text-[var(--status-pending)]",
};

type StatCardProps = {
  label: React.ReactNode;
  value: React.ReactNode;
  /** نصّ فرعي أسفل الرقم (وحدة/سياق مثل «د.ع»). */
  sub?: React.ReactNode;
  icon?: LucideIcon;
  /** لون الرقم البطل دلالياً. */
  tone?: Tone;
  /** يجعل البطاقة قابلة للنقر (يضيف إبراز hover ومؤشّراً). */
  onClick?: () => void;
  className?: string;
};

/**
 * بطاقة مؤشّر قانونية موحّدة (KPI). فلسفة «الرقم هو البطل»:
 * عنوان صغير هادئ فوق رقم بارز بأرقام جدولية (tabular-nums) لمنع الاهتزاز.
 *
 * توحّد النسخ المتفرّقة (lib/assets/ui · Attendance · Payroll · TreasuryKpiCard).
 * استعملها داخل شبكة: `grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3`.
 */
export function StatCard({ label, value, sub, icon: Icon, tone = "default", onClick, className }: StatCardProps) {
  const interactive = typeof onClick === "function";
  return (
    <Card
      className={cn(interactive && "cursor-pointer transition-colors hover:bg-accent/50", className)}
      onClick={onClick}
      {...(interactive ? { role: "button", tabIndex: 0 } : {})}
    >
      <CardContent className="p-4">
        <div className="mb-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
          {Icon && <Icon className="size-4 shrink-0" aria-hidden="true" />}
          <span className="truncate">{label}</span>
        </div>
        <div className={cn("text-xl font-bold tabular-nums", TONE_VALUE_CLS[tone])} dir="auto">
          {value}
        </div>
        {sub && <div className="mt-0.5 text-[11px] text-muted-foreground">{sub}</div>}
      </CardContent>
    </Card>
  );
}
