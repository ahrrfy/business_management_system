import { Button } from "@/components/ui/button";
import { D, fmt } from "@/lib/money";
import { trpc, type RouterOutputs } from "@/lib/trpc";
type PartyRow = RouterOutputs["delivery"]["listParties"][number];

export function PartyFinancialSummary({
  party,
  onOrders,
  onStatement,
}: {
  party: PartyRow;
  onStatement: () => void;
  onOrders: (
    state:
      | "ALL"
      | "IN_TRANSIT"
      | "DELIVERED_UNCOLLECTED"
      | "COLLECTED_UNREMITTED",
  ) => void;
}) {
  const q = trpc.delivery.partyFinancials.useQuery(
    { partyId: party.id },
    { staleTime: 15_000 },
  );
  const s = q.data?.summary;
  const cards: Array<{
    label: string;
    value: string;
    state:
      | "ALL"
      | "IN_TRANSIT"
      | "DELIVERED_UNCOLLECTED"
      | "COLLECTED_UNREMITTED";
    note: string;
    statement?: boolean;
  }> = [
    {
      label: "متبقي تسوية الإرساليات",
      value: s?.remainingSettlement ?? "",
      state: "ALL",
      note: "المتبقي على الإرساليات المفتوحة وفق سجل التسوية",
    },
    {
      label: "نقد بيد الجهة",
      value: s?.cashInCustody ?? party.cashInHandLedger,
      state: "COLLECTED_UNREMITTED",
      note: "نقد قبضته من العملاء ولم تورده",
    },
    {
      label: "طرود بالطريق",
      value: party.parcelsInTransitAmount,
      state: "IN_TRANSIT",
      note: "قيمة الطلبات التي لم تصل العميل",
    },
    {
      label: "سلم ولم يحصل",
      value: party.deliveredUncollectedAmount,
      state: "DELIVERED_UNCOLLECTED",
      note: "مبالغ لم تحصل من العملاء",
    },
    {
      label: "عجز على الجهة",
      statement: true,
      value: s?.shortfallAssigned ?? party.shortfallOwedAmount,
      state: "ALL",
      note: "ذمة على الجهة، منفصلة عن النقد",
    },
    {
      label: "أجور مستحقة لها",
      statement: true,
      value: s?.feeDue ?? party.feesOwedAmount,
      state: "ALL",
      note: "أجور على المكتبة، منفصلة عن التحصيل",
    },
  ];
  return (
    <div className="mb-4 space-y-3">
      <div className="grid grid-cols-2 gap-2 sm:gap-3 xl:grid-cols-3">
        {cards.map((card) => (
          <button
            key={card.label}
            className="rounded-md border bg-card p-3 text-start hover:bg-muted/30 sm:p-4"
            title={card.note}
            onClick={() =>
              card.statement ? onStatement() : onOrders(card.state)
            }
          >
            <div className="text-sm font-bold">{card.label}</div>
            <div className="my-2 text-xl font-extrabold tabular-nums" dir="ltr">
              {card.value ? `${fmt(card.value)} د.ع` : "—"}
            </div>
            <div className="hidden text-xs text-muted-foreground sm:block">
              {card.note}
            </div>
          </button>
        ))}
      </div>
      {q.isError && (
        <p role="alert" className="text-sm text-destructive">
          {q.error.message}{" "}
          <Button variant="outline" size="sm" onClick={() => void q.refetch()}>
            إعادة المحاولة
          </Button>
        </p>
      )}
      {s && (
        <details className="rounded-md border bg-muted/20 p-3 text-sm">
          <summary className="cursor-pointer font-bold">
            الإجماليات التاريخية
          </summary>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              النقد المستلم فعلا: <b dir="ltr">{fmt(s.cashReceived)} د.ع</b>
            </div>
            <div>
              إجمالي التسوية: <b dir="ltr">{fmt(s.grossSettled)} د.ع</b>
            </div>
            <div>
              أجور مكتسبة: <b dir="ltr">{fmt(s.feeEarned)} د.ع</b>
            </div>
            <div>
              أجور مدفوعة: <b dir="ltr">{fmt(s.feePaid)} د.ع</b>
            </div>
          </div>
          {D(s.feeDueRaw).lt(0) && (
            <p className="mt-2 text-[var(--sem-warn)]">
              أجور مدفوعة زيادة: {fmt(D(s.feeDueRaw).abs().toFixed(2))} د.ع.
              راجع سندات الأجور التاريخية.
            </p>
          )}
        </details>
      )}
    </div>
  );
}
