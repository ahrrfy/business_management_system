import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import {
  FileText,
  ReceiptText,
  BookOpen,
  Link2,
  UserRound,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type {
  FinancialTraceTone,
  FinancialLinkKind,
  FinancialTraceField,
  FinancialActor,
  FinancialLinkNode,
} from "./financialTraceTypes";

export const STATUS_VARIANT: Record<
  FinancialTraceTone,
  "danger" | "warning" | "info" | "success" | "neutral"
> = {
  critical: "danger",
  warning: "warning",
  info: "info",
  ok: "success",
  neutral: "neutral",
};

const LINK_ICON: Record<FinancialLinkKind, LucideIcon> = {
  DOCUMENT: FileText,
  RECEIPT: ReceiptText,
  LEDGER: BookOpen,
  OTHER: Link2,
};

export function hasValue(value: ReactNode) {
  return (
    value !== null && value !== undefined && value !== "" && value !== false
  );
}

export function directionLabel(direction?: string | null) {
  if (direction === "IN") return "وارد";
  if (direction === "OUT") return "صادر";
  if (direction === "NEUTRAL") return "بلا حركة نقدية";
  return direction;
}

export function SectionBlock({
  title,
  icon: Icon,
  children,
  className,
}: {
  title: ReactNode;
  icon: LucideIcon;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "min-w-0 rounded-xl border bg-card/60 p-3 sm:p-4 [overflow-wrap:anywhere]",
        className,
      )}
    >
      <h3 className="mb-3 flex items-center gap-2 text-sm font-bold">
        <Icon aria-hidden className="size-4 text-muted-foreground" />
        {title}
      </h3>
      {children}
    </section>
  );
}

export function TraceField({
  field,
  compact,
}: {
  field: FinancialTraceField;
  compact?: boolean;
}) {
  if (!hasValue(field.value)) return null;
  return (
    <div className={cn("min-w-0", compact ? "space-y-0.5" : "space-y-1")}>
      <div className="text-[11px] font-medium text-muted-foreground">
        {field.label}
      </div>
      <div
        className={cn(
          "break-words [overflow-wrap:anywhere] text-sm",
          field.emphasis && "font-bold tabular-nums",
        )}
        dir={field.dir}
      >
        {field.value}
      </div>
      {hasValue(field.hint) ? (
        <div className="text-[10px] text-muted-foreground">{field.hint}</div>
      ) : null}
    </div>
  );
}

export function ActorCard({
  label,
  actor,
}: {
  label: ReactNode;
  actor: FinancialActor;
}) {
  return (
    <div className="min-w-0 rounded-lg border bg-muted/20 p-2.5">
      <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
        <UserRound aria-hidden className="size-3.5" />
        {label}
      </div>
      <div className="break-words [overflow-wrap:anywhere] text-sm font-semibold">
        {actor.name ?? "غير موثّق"}
      </div>
      {hasValue(actor.role) || hasValue(actor.id) ? (
        <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-1 text-[10px] text-muted-foreground">
          {hasValue(actor.role) ? (
            <span className="break-words [overflow-wrap:anywhere]">
              {actor.role}
            </span>
          ) : null}
          {hasValue(actor.role) && hasValue(actor.id) ? (
            <span aria-hidden>·</span>
          ) : null}
          {hasValue(actor.id) ? (
            <span className="shrink-0 font-mono" dir="ltr">
              #{actor.id}
            </span>
          ) : null}
        </div>
      ) : null}
      {hasValue(actor.at) ? (
        <div
          className="mt-1 text-[10px] tabular-nums text-muted-foreground"
          dir="ltr"
        >
          {actor.at}
        </div>
      ) : null}
      {hasValue(actor.note) ? (
        <div className="mt-1 text-xs text-muted-foreground">{actor.note}</div>
      ) : null}
    </div>
  );
}

export function LinkNode({ node }: { node: FinancialLinkNode }) {
  const Icon = LINK_ICON[node.kind];
  const className = cn(
    "min-w-0 flex-1 rounded-lg border p-3",
    node.missing
      ? "border-dashed bg-muted/20 text-muted-foreground"
      : "bg-card",
    node.href &&
      "transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
  );
  const body = (
    <>
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
          <Icon aria-hidden className="size-3.5 shrink-0" />
          <span className="break-words [overflow-wrap:anywhere]">
            {node.label}
          </span>
        </div>
        {hasValue(node.status) ? (
          <Badge variant="neutral" className="h-5 text-[10px]">
            {node.status}
          </Badge>
        ) : null}
      </div>
      <div className="mt-1 break-all text-sm font-semibold" dir="auto">
        {node.value ?? (node.missing ? "غير مربوط" : "—")}
      </div>
      {hasValue(node.subtitle) ? (
        <div className="mt-1 text-[10px] text-muted-foreground">
          {node.subtitle}
        </div>
      ) : null}
    </>
  );

  return node.href ? (
    <a href={node.href} className={className}>
      {body}
    </a>
  ) : (
    <div className={className}>{body}</div>
  );
}
