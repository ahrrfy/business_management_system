import {
  ActorCell,
  actorLabel,
  type OperationActor,
} from "@/components/data-table/ActorCell";
import { fmtDateTime } from "@/lib/date";
import { cn } from "@/lib/utils";
import { Clock3, FilePenLine } from "lucide-react";

export type OperationSubject = {
  type?: string | null;
  label?: string | null;
  id?: string | number | null;
};

/** العقد البصري الموحد: من قام، ماذا فعل، على ماذا، ومتى. */
export type OperationAttribution = {
  actor: OperationActor | null | undefined;
  action: {
    code?: string | null;
    label: string;
  };
  subject?: OperationSubject | null;
  at?: string | Date | null;
};

export function operationActionLabel(operation: OperationAttribution): string {
  return (
    operation.action.label.trim() ||
    operation.action.code?.trim() ||
    "عملية غير مسمّاة"
  );
}

export function operationSubjectLabel(
  subject: OperationSubject | null | undefined,
): string {
  if (!subject) return "هدف غير محدد";
  const label = subject.label?.trim() || subject.type?.trim() || "سجل";
  return subject.id == null || String(subject.id).trim() === ""
    ? label
    : `${label} #${String(subject.id).trim()}`;
}

export function operationTimeLabel(at: OperationAttribution["at"]): string {
  return at ? fmtDateTime(at) : "وقت غير موثّق";
}

export function OperationActionCell({
  operation,
}: {
  operation: OperationAttribution;
}) {
  const label = operationActionLabel(operation);
  return (
    <span
      className="inline-flex max-w-52 items-center gap-1.5 text-start"
      title={operation.action.code ?? label}
    >
      <FilePenLine
        aria-hidden
        className="size-3.5 shrink-0 text-muted-foreground"
      />
      <span className="whitespace-normal [overflow-wrap:anywhere]">
        {label}
      </span>
    </span>
  );
}

export function OperationSubjectCell({
  subject,
}: {
  subject: OperationSubject | null | undefined;
}) {
  const label = operationSubjectLabel(subject);
  return (
    <span
      className="inline-flex max-w-52 items-center gap-1.5 text-start"
      title={label}
    >
      <span className="truncate">
        {subject?.label?.trim() || subject?.type?.trim() || "هدف غير محدد"}
      </span>
      {subject?.id != null && (
        <bdi className="shrink-0 font-mono text-xs text-muted-foreground">
          #{String(subject.id)}
        </bdi>
      )}
    </span>
  );
}

export function OperationTimeCell({ at }: { at: OperationAttribution["at"] }) {
  const label = operationTimeLabel(at);
  return (
    <span
      className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs"
      title={label}
    >
      <Clock3 aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <bdi dir="ltr">{label}</bdi>
    </span>
  );
}

/** عرض مدمج للجداول التشغيلية العريضة؛ يحافظ على ترابط المعلومات داخل خلية واحدة. */
export function OperationAttributionCell({
  operation,
  className,
}: {
  operation: OperationAttribution;
  className?: string;
}) {
  const action = operationActionLabel(operation);
  const subject = operationSubjectLabel(operation.subject);
  const time = operationTimeLabel(operation.at);
  const title = `من قام: ${actorLabel(operation.actor)}\nماذا فعل: ${action}\nعلى ماذا: ${subject}\nمتى: ${time}`;
  return (
    <div
      className={cn("min-w-56 space-y-1 text-start", className)}
      title={title}
      aria-label={title.replaceAll("\n", "، ")}
    >
      <ActorCell actor={operation.actor} className="max-w-56 font-medium" />
      <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        <FilePenLine aria-hidden className="size-3.5 shrink-0" />
        <span className="truncate">{action}</span>
        <span aria-hidden>·</span>
        <span className="truncate">{subject}</span>
      </div>
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Clock3 aria-hidden className="size-3.5 shrink-0" />
        <bdi dir="ltr">{time}</bdi>
      </div>
    </div>
  );
}
