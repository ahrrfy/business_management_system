import { FileText, Users, Landmark, Clock3 } from "lucide-react";
import type { ReactNode } from "react";
import { FinancialSourceBadge } from "./FinancialSourceBadge";
import {
  hasValue,
  SectionBlock,
  TraceField,
  ActorCard,
} from "./FinancialTraceFields";
import type {
  FinancialTraceDetailsProps,
  FinancialTraceField,
  FinancialActor,
} from "./financialTraceTypes";

export function FinancialTraceIdentity({
  document,
  parties,
  moneyPath,
  timestamps = [],
  compact,
}: Pick<
  FinancialTraceDetailsProps,
  "document" | "parties" | "moneyPath" | "timestamps" | "compact"
>) {
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
    <>
      {hasValue(document.amount) ? (
        <div className="flex flex-wrap items-end justify-between gap-3 rounded-xl border bg-muted/20 p-3">
          <div className="min-w-0">
            <div className="text-[11px] font-medium text-muted-foreground">
              قيمة الحركة
            </div>
            <div
              className="mt-0.5 break-words text-xl font-extrabold tabular-nums [overflow-wrap:anywhere]"
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

      <div className="grid grid-cols-1 gap-4 @min-[60rem]/financial-trace:grid-cols-2">
        {hasDocumentFields ? (
          <SectionBlock title="هوية المستند" icon={FileText}>
            <div className="grid grid-cols-2 gap-x-4 gap-y-3 @min-[34rem]/financial-trace:grid-cols-3">
              {documentFields.map((field, index) => (
                <TraceField key={index} field={field} compact={compact} />
              ))}
            </div>
          </SectionBlock>
        ) : null}

        {actorItems.length ? (
          <SectionBlock title="الأطراف والمسؤوليات" icon={Users}>
            <div className="grid grid-cols-1 gap-2 @min-[34rem]/financial-trace:grid-cols-2">
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
            <div className="grid grid-cols-2 gap-x-4 gap-y-3 @min-[34rem]/financial-trace:grid-cols-3">
              {moneyFields.map((field, index) => (
                <TraceField key={index} field={field} compact={compact} />
              ))}
            </div>
          </SectionBlock>
        ) : null}

        {timestamps.length ? (
          <SectionBlock title="التوقيتات" icon={Clock3}>
            <div className="grid grid-cols-1 gap-2 @min-[34rem]/financial-trace:grid-cols-2">
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
    </>
  );
}
