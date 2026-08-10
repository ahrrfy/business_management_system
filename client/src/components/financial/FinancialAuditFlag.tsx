import type { ComponentProps, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import {
  CircleCheck,
  CircleHelp,
  Info,
  ShieldAlert,
  TriangleAlert,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export type FinancialAuditSeverity =
  | "critical"
  | "warning"
  | "info"
  | "ok"
  | "neutral";

export interface FinancialAuditFlagProps extends Omit<
  ComponentProps<"span">,
  "children" | "title"
> {
  label: ReactNode;
  severity?: FinancialAuditSeverity;
  description?: string | null;
  code?: string | null;
  resolved?: boolean;
  icon?: LucideIcon;
  compact?: boolean;
}

const CONFIG: Record<
  FinancialAuditSeverity,
  {
    variant: "danger" | "warning" | "info" | "success" | "neutral";
    icon: LucideIcon;
  }
> = {
  critical: { variant: "danger", icon: ShieldAlert },
  warning: { variant: "warning", icon: TriangleAlert },
  info: { variant: "info", icon: Info },
  ok: { variant: "success", icon: CircleCheck },
  neutral: { variant: "neutral", icon: CircleHelp },
};

/**
 * شارة تدقيق صغيرة للصفوف والبطاقات المالية. لا تستنتج الحالة؛ المستهلك
 * يمرر نتيجة الفحص صراحةً كي يبقى منطق المطابقة في طبقة البيانات.
 */
export function FinancialAuditFlag({
  label,
  severity = "neutral",
  description,
  code,
  resolved = false,
  icon,
  compact = false,
  className,
  ...props
}: FinancialAuditFlagProps) {
  const effectiveSeverity = resolved ? "ok" : severity;
  const config = CONFIG[effectiveSeverity];
  const Icon = icon ?? config.icon;
  const title = [code, description].filter(Boolean).join(" — ") || undefined;

  return (
    <Badge
      variant={config.variant}
      className={cn(
        "max-w-full gap-1",
        compact ? "h-5 px-1.5 text-[10px]" : "min-h-6",
        className,
      )}
      title={title}
      {...props}
    >
      <Icon aria-hidden className="shrink-0" />
      <span className="truncate">{label}</span>
      {code ? (
        <span className="font-mono text-[0.9em] opacity-70" dir="ltr">
          {code}
        </span>
      ) : null}
    </Badge>
  );
}
