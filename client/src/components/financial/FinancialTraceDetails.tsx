import type { ComponentProps, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import {
  ArrowDownLeft,
  ArrowLeft,
  ArrowUpRight,
  BookOpen,
  CircleDot,
  Clock3,
  FileText,
  History,
  Landmark,
  Link2,
  ReceiptText,
  ShieldCheck,
  UserRound,
  Users,
} from "lucide-react";

import {
  FinancialAuditFlag,
  type FinancialAuditSeverity,
} from "./FinancialAuditFlag";
import { FinancialSourceBadge } from "./FinancialSourceBadge";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

export type FinancialTraceTone = FinancialAuditSeverity;

export interface FinancialDocumentIdentity {
  id?: ReactNode;
  number?: ReactNode;
  type?: ReactNode;
  title?: ReactNode;
  status?: ReactNode;
  statusTone?: FinancialTraceTone;
  direction?: "IN" | "OUT" | "NEUTRAL" | string | null;
  amount?: ReactNode;
  currency?: ReactNode;
  branch?: ReactNode;
  reference?: ReactNode;
  description?: ReactNode;
  extra?: FinancialTraceField[];
}

export interface FinancialActor {
  name?: ReactNode;
  id?: ReactNode;
  role?: ReactNode;
  at?: ReactNode;
  note?: ReactNode;
}

export interface FinancialTraceParties {
  recordedBy?: FinancialActor | null;
  executedBy?: FinancialActor | null;
  beneficiary?: FinancialActor | null;
  approvedBy?: FinancialActor | null;
  receivedBy?: FinancialActor | null;
  reversedBy?: FinancialActor | null;
  extra?: Array<FinancialActor & { label: ReactNode }>;
}

export interface FinancialTraceField {
  label: ReactNode;
  value?: ReactNode;
  hint?: ReactNode;
  dir?: "rtl" | "ltr" | "auto";
  emphasis?: boolean;
}

export interface FinancialMoneyPath {
  paymentMethod?: string | null;
  source?: string | null;
  cashBucket?: string | null;
  branch?: ReactNode;
  shiftId?: ReactNode;
  shiftLabel?: ReactNode;
  shiftOwner?: ReactNode;
  from?: ReactNode;
  to?: ReactNode;
  device?: ReactNode;
  externalReference?: ReactNode;
  balanceBefore?: ReactNode;
  balanceAfter?: ReactNode;
  extra?: FinancialTraceField[];
}

export type FinancialLinkKind = "DOCUMENT" | "RECEIPT" | "LEDGER" | "OTHER";

export interface FinancialLinkNode {
  id?: string | number;
  kind: FinancialLinkKind;
  label: ReactNode;
  value?: ReactNode;
  subtitle?: ReactNode;
  href?: string;
  status?: ReactNode;
  missing?: boolean;
}

export interface FinancialTimestamp {
  id?: string | number;
  label: ReactNode;
  value?: ReactNode;
  actor?: ReactNode;
  note?: ReactNode;
}

export interface FinancialIntegrityWarning {
  id?: string | number;
  severity: FinancialAuditSeverity;
  title: ReactNode;
  description?: string | null;
  code?: string | null;
  resolved?: boolean;
}

export interface FinancialAuditEvent {
  id?: string | number;
  action: ReactNode;
  actor?: ReactNode;
  at?: ReactNode;
  detail?: ReactNode;
  status?: ReactNode;
  tone?: FinancialTraceTone;
}

export interface FinancialTraceDetailsProps extends Omit<
  ComponentProps<"section">,
  "title"
> {
  document: FinancialDocumentIdentity;
  parties?: FinancialTraceParties;
  moneyPath?: FinancialMoneyPath;
  linkChain?: FinancialLinkNode[];
  timestamps?: FinancialTimestamp[];
  integrityWarnings?: FinancialIntegrityWarning[];
  auditTimeline?: FinancialAuditEvent[];
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  compact?: boolean;
  contentClassName?: string;
}

const STATUS_VARIANT: Record<
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

function hasValue(value: ReactNode) {
  return (
    value !== null && value !== undefined && value !== "" && value !== false
  );
}

function directionLabel(direction?: string | null) {
  if (direction === "IN") return "وارد";
  if (direction === "OUT") return "صادر";
  if (direction === "NEUTRAL") return "بلا حركة نقدية";
  return direction;
}

function SectionBlock({
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
      className={cn("rounded-xl border bg-card/60 p-3 sm:p-4", className)}
    >
      <h3 className="mb-3 flex items-center gap-2 text-sm font-bold">
        <Icon aria-hidden className="size-4 text-muted-foreground" />
        {title}
      </h3>
      {children}
    </section>
  );
}

function TraceField({
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
          "break-words text-sm",
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

function ActorCard({
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
      <div className="truncate text-sm font-semibold">
        {actor.name ?? "غير موثّق"}
      </div>
      {hasValue(actor.role) || hasValue(actor.id) ? (
        <div className="mt-0.5 flex min-w-0 items-center gap-1 truncate text-[10px] text-muted-foreground">
          {hasValue(actor.role) ? (
            <span className="truncate">{actor.role}</span>
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

function LinkNode({ node }: { node: FinancialLinkNode }) {
  const Icon = LINK_ICON[node.kind];
  const className = cn(
    "min-w-[10rem] flex-1 rounded-lg border p-3",
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
          <span className="truncate">{node.label}</span>
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
  const documentFields: FinancialTraceField[] = [
    { label: "نوع المستند", value: document.type },
    {
      label: "رقم المستند",
      value: document.number,
      dir: "auto",
      emphasis: true,
    },
    { label: "المعرّف الداخلي", value: document.id, dir: "ltr" },
    { label: "الفرع", value: document.branch },
    { label: "المرجع الخارجي", value: document.reference, dir: "auto" },
    ...(document.extra ?? []),
  ];

  const actorItems: Array<{
    key: string;
    label: ReactNode;
    actor?: FinancialActor | null;
  }> = [
    { key: "recorded", label: "سجّل العملية", actor: parties?.recordedBy },
    { key: "executed", label: "نفّذ الحركة", actor: parties?.executedBy },
    {
      key: "beneficiary",
      label: "المستفيد / الطرف",
      actor: parties?.beneficiary,
    },
    { key: "approved", label: "اعتمد", actor: parties?.approvedBy },
    { key: "received", label: "استلم", actor: parties?.receivedBy },
    { key: "reversed", label: "عكس / ألغى", actor: parties?.reversedBy },
    ...(parties?.extra ?? []).map((actor, index) => ({
      key: `extra-${index}`,
      label: actor.label,
      actor,
    })),
  ].filter((item) => item.actor != null);

  const moneyFields: FinancialTraceField[] = moneyPath
    ? [
        { label: "الفرع", value: moneyPath.branch },
        { label: "من", value: moneyPath.from },
        { label: "إلى", value: moneyPath.to },
        {
          label: "الوردية",
          value: hasValue(moneyPath.shiftLabel) ? (
            moneyPath.shiftLabel
          ) : hasValue(moneyPath.shiftId) ? (
            <span className="font-mono" dir="ltr">
              #{moneyPath.shiftId}
            </span>
          ) : null,
          dir: "auto",
        },
        { label: "صاحب الوردية / الدرج", value: moneyPath.shiftOwner },
        { label: "المحطة / الجهاز", value: moneyPath.device, dir: "auto" },
        {
          label: "المرجع المالي",
          value: moneyPath.externalReference,
          dir: "auto",
        },
        {
          label: "الرصيد قبل الحركة",
          value: moneyPath.balanceBefore,
          dir: "ltr",
          emphasis: true,
        },
        {
          label: "الرصيد بعد الحركة",
          value: moneyPath.balanceAfter,
          dir: "ltr",
          emphasis: true,
        },
        ...(moneyPath.extra ?? []),
      ]
    : [];

  const hasDocumentFields = documentFields.some((field) =>
    hasValue(field.value),
  );
  const hasMoneyFields = moneyFields.some((field) => hasValue(field.value));
  const hasMoneySource =
    moneyPath &&
    (hasValue(moneyPath.paymentMethod) ||
      hasValue(moneyPath.source) ||
      hasValue(moneyPath.cashBucket));

  return (
    <Card className={cn("gap-0 py-0", className)}>
      <section dir="rtl" aria-label="تفاصيل التتبّع المالي" {...props}>
        <CardHeader
          className={cn("border-b py-4", compact ? "px-4" : "px-4 sm:px-6")}
        >
          <div className="flex min-w-0 items-start gap-3">
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
          {actions ? <CardAction>{actions}</CardAction> : null}
        </CardHeader>

        <CardContent
          className={cn(
            "space-y-4 py-4",
            compact ? "px-4" : "px-4 sm:px-6",
            contentClassName,
          )}
        >
          {hasValue(document.amount) ? (
            <div className="flex flex-wrap items-end justify-between gap-3 rounded-xl border bg-muted/20 p-3">
              <div>
                <div className="text-[11px] font-medium text-muted-foreground">
                  قيمة الحركة
                </div>
                <div
                  className="mt-0.5 text-xl font-extrabold tabular-nums"
                  dir="ltr"
                >
                  {document.amount} {document.currency}
                </div>
              </div>
              {hasMoneySource ? (
                <FinancialSourceBadge
                  source={moneyPath?.source}
                  paymentMethod={moneyPath?.paymentMethod}
                  cashBucket={moneyPath?.cashBucket}
                />
              ) : null}
            </div>
          ) : null}

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            {hasDocumentFields ? (
              <SectionBlock title="هوية المستند" icon={FileText}>
                <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
                  {documentFields.map((field, index) => (
                    <TraceField key={index} field={field} compact={compact} />
                  ))}
                </div>
              </SectionBlock>
            ) : null}

            {actorItems.length ? (
              <SectionBlock title="الأطراف والمسؤوليات" icon={Users}>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {actorItems.map((item) => (
                    <ActorCard
                      key={item.key}
                      label={item.label}
                      actor={item.actor!}
                    />
                  ))}
                </div>
              </SectionBlock>
            ) : null}

            {moneyPath && (hasMoneyFields || hasMoneySource) ? (
              <SectionBlock title="مسار المال" icon={Landmark}>
                {hasMoneySource && !hasValue(document.amount) ? (
                  <div className="mb-3">
                    <FinancialSourceBadge
                      source={moneyPath.source}
                      paymentMethod={moneyPath.paymentMethod}
                      cashBucket={moneyPath.cashBucket}
                    />
                  </div>
                ) : null}
                <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
                  {moneyFields.map((field, index) => (
                    <TraceField key={index} field={field} compact={compact} />
                  ))}
                </div>
              </SectionBlock>
            ) : null}

            {timestamps.length ? (
              <SectionBlock title="التوقيتات" icon={Clock3}>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {timestamps.map((timestamp, index) => (
                    <div
                      key={timestamp.id ?? index}
                      className="rounded-lg border bg-muted/20 p-2.5"
                    >
                      <div className="text-[11px] font-medium text-muted-foreground">
                        {timestamp.label}
                      </div>
                      <div
                        className="mt-1 text-sm font-semibold tabular-nums"
                        dir="auto"
                      >
                        {timestamp.value ?? "غير موثّق"}
                      </div>
                      {hasValue(timestamp.actor) ? (
                        <div className="mt-1 text-xs text-muted-foreground">
                          بواسطة {timestamp.actor}
                        </div>
                      ) : null}
                      {hasValue(timestamp.note) ? (
                        <div className="mt-1 text-[10px] text-muted-foreground">
                          {timestamp.note}
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
              </SectionBlock>
            ) : null}
          </div>

          {linkChain.length ? (
            <SectionBlock title="سلسلة الربط المحاسبي" icon={Link2}>
              <div
                className="flex flex-col items-stretch gap-2 md:flex-row md:items-center"
                aria-label="المستند ثم الإيصال ثم قيد الدفتر"
              >
                {linkChain.map((node, index) => (
                  <div key={node.id ?? index} className="contents">
                    {index > 0 ? (
                      <ArrowLeft
                        aria-hidden
                        className="mx-auto size-4 shrink-0 rotate-[-90deg] text-muted-foreground md:rotate-0"
                      />
                    ) : null}
                    <LinkNode node={node} />
                  </div>
                ))}
              </div>
            </SectionBlock>
          ) : null}

          {integrityWarnings.length ? (
            <SectionBlock title="سلامة الربط والتحذيرات" icon={ShieldCheck}>
              <div className="flex flex-wrap gap-2">
                {integrityWarnings.map((warning, index) => (
                  <FinancialAuditFlag
                    key={warning.id ?? index}
                    label={warning.title}
                    severity={warning.severity}
                    description={warning.description}
                    code={warning.code}
                    resolved={warning.resolved}
                  />
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
                        <div className="text-sm font-semibold">
                          {event.action}
                        </div>
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
                        {hasValue(event.actor) ? (
                          <span>{event.actor}</span>
                        ) : null}
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
        </CardContent>
      </section>
    </Card>
  );
}
