import { ArrowUpRight, ArrowDownLeft, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";
import {
  hasValue,
  directionLabel,
  STATUS_VARIANT,
} from "./FinancialTraceFields";
import { FinancialTraceIdentity } from "./FinancialTraceIdentity";
import { FinancialTraceHistory } from "./FinancialTraceHistory";
import type { FinancialTraceDetailsProps } from "./financialTraceTypes";
export type * from "./financialTraceTypes";

/**
 * عرض موحّد لسلسلة التتبّع المالي. جميع القيم منسّقة مسبقاً من الصفحة؛
 * المكوّن لا يجلب بيانات ولا يحسب أرصدة أو صلاحيات.
 */
export function FinancialTraceDetails({
  document,
  parties,
  moneyPath,
  linkChain = [],
  timestamps = [],
  integrityWarnings = [],
  auditTimeline = [],
  title = "تفاصيل التتبّع المالي",
  description,
  actions,
  compact = false,
  className,
  contentClassName,
  ...props
}: FinancialTraceDetailsProps) {
  return (
    <Card className={cn("@container/financial-trace gap-0 py-0", className)}>
      <section dir="rtl" aria-label="تفاصيل التتبّع المالي" {...props}>
        <CardHeader
          className={cn(
            "flex flex-wrap items-start justify-between gap-3 border-b py-4",
            compact ? "px-4" : "px-4 sm:px-6",
          )}
        >
          <div className="flex min-w-0 flex-1 basis-56 items-start gap-3">
            <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
              <ShieldCheck aria-hidden className="size-4.5" />
            </div>
            <div className="min-w-0">
              <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                <span>{title}</span>
                {hasValue(document.status) ? (
                  <Badge
                    variant={STATUS_VARIANT[document.statusTone ?? "neutral"]}
                  >
                    {document.status}
                  </Badge>
                ) : null}
                {hasValue(document.direction) ? (
                  <Badge
                    variant={
                      document.direction === "OUT"
                        ? "danger"
                        : document.direction === "IN"
                          ? "success"
                          : "neutral"
                    }
                  >
                    {document.direction === "OUT" ? (
                      <ArrowUpRight aria-hidden />
                    ) : document.direction === "IN" ? (
                      <ArrowDownLeft aria-hidden />
                    ) : null}
                    {directionLabel(document.direction)}
                  </Badge>
                ) : null}
              </CardTitle>
              <CardDescription className="mt-1">
                {description ??
                  document.description ??
                  "هوية المستند، مسار المال، والآثار المرتبطة به."}
              </CardDescription>
            </div>
          </div>
          {actions ? (
            <CardAction className="max-w-full">{actions}</CardAction>
          ) : null}
        </CardHeader>

        <CardContent
          className={cn(
            "space-y-4 py-4",
            compact ? "px-4" : "px-4 sm:px-6",
            contentClassName,
          )}
        >
          <FinancialTraceIdentity
            document={document}
            parties={parties}
            moneyPath={moneyPath}
            timestamps={timestamps}
            compact={compact}
          />
          <FinancialTraceHistory
            linkChain={linkChain}
            integrityWarnings={integrityWarnings}
            auditTimeline={auditTimeline}
          />
        </CardContent>
      </section>
    </Card>
  );
}
