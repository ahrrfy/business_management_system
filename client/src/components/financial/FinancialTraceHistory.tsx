import { Link2, ShieldCheck, History, CircleDot } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { FinancialAuditFlag } from "./FinancialAuditFlag";
import {
  hasValue,
  SectionBlock,
  LinkNode,
  STATUS_VARIANT,
} from "./FinancialTraceFields";
import type { FinancialTraceDetailsProps } from "./financialTraceTypes";

export function FinancialTraceHistory({
  linkChain = [],
  integrityWarnings = [],
  auditTimeline = [],
}: Pick<
  FinancialTraceDetailsProps,
  "linkChain" | "integrityWarnings" | "auditTimeline"
>) {
  return (
    <>
      {linkChain.length ? (
        <SectionBlock title="سلسلة الربط المحاسبي" icon={Link2}>
          <ol
            className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,14rem),1fr))] gap-2"
            aria-label="المستند ثم الإيصال ثم قيد الدفتر"
          >
            {linkChain.map((node, index) => (
              <li
                key={node.id ?? index}
                className="flex min-w-0 items-start gap-2"
              >
                <span
                  aria-hidden
                  className="pt-3 text-xs tabular-nums text-muted-foreground"
                >
                  {index + 1}
                </span>
                <LinkNode node={node} />
              </li>
            ))}
          </ol>
        </SectionBlock>
      ) : null}

      {integrityWarnings.length ? (
        <SectionBlock title="سلامة الربط والتحذيرات" icon={ShieldCheck}>
          <div className="grid gap-2">
            {integrityWarnings.map((warning, index) => (
              <div key={warning.id ?? index} className="min-w-0 space-y-1">
                <FinancialAuditFlag
                  wrap
                  label={warning.title}
                  severity={warning.severity}
                  description={warning.description}
                  code={warning.code}
                  resolved={warning.resolved}
                />
                {hasValue(warning.description) ? (
                  <p className="break-words text-xs text-muted-foreground [overflow-wrap:anywhere]">
                    {warning.description}
                  </p>
                ) : null}
              </div>
            ))}
          </div>
        </SectionBlock>
      ) : null}

      {auditTimeline.length ? (
        <SectionBlock title="التسلسل التدقيقي" icon={History}>
          <ol
            className="space-y-0"
            aria-label="التسلسل الزمني لإجراءات المستند"
          >
            {auditTimeline.map((event, index) => (
              <li
                key={event.id ?? index}
                className="relative flex gap-3 pb-4 last:pb-0"
              >
                {index < auditTimeline.length - 1 ? (
                  <span
                    aria-hidden
                    className="absolute right-[0.4375rem] top-4 h-[calc(100%-0.25rem)] w-px bg-border"
                  />
                ) : null}
                <CircleDot
                  aria-hidden
                  className="relative z-10 mt-0.5 size-4 shrink-0 bg-card text-muted-foreground"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-sm font-semibold">{event.action}</div>
                    {hasValue(event.status) ? (
                      <Badge
                        variant={STATUS_VARIANT[event.tone ?? "neutral"]}
                        className="h-5 text-[10px]"
                      >
                        {event.status}
                      </Badge>
                    ) : null}
                  </div>
                  <div className="mt-0.5 flex flex-wrap gap-x-2 text-[11px] text-muted-foreground">
                    {hasValue(event.actor) ? <span>{event.actor}</span> : null}
                    {hasValue(event.actor) && hasValue(event.at) ? (
                      <Separator orientation="vertical" className="h-3" />
                    ) : null}
                    {hasValue(event.at) ? (
                      <span className="tabular-nums" dir="ltr">
                        {event.at}
                      </span>
                    ) : null}
                  </div>
                  {hasValue(event.detail) ? (
                    <div className="mt-1 text-xs text-muted-foreground">
                      {event.detail}
                    </div>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
        </SectionBlock>
      ) : null}
    </>
  );
}
