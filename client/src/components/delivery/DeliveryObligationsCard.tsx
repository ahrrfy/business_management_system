import { useMemo } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { AlertTriangle, Wallet } from "lucide-react";
import { DataTable } from "@/components/data-table/DataTable";
import { EmptyState } from "@/components/EmptyState";
import { fmt } from "@/lib/money";
import { fmtDateTime } from "@/lib/date";
import { cn } from "@/lib/utils";
import type { RouterOutputs } from "@/lib/trpc";
import { DELIVERY_TERMS as DT } from "@shared/deliveryTerminology";
import { PARTY_EXPOSURE_LABEL_AR } from "@shared/partyExposure";
import {
  formatDeliveryAge,
  deliveryAgeLevel,
  DELIVERY_AGE_CLS,
} from "@shared/deliveryAging";

export type PartyObligation = RouterOutputs["delivery"]["obligations"][number];

export function DeliveryObligationsCard({
  obligations,
  staleParties,
  partyId,
  onSelectParty,
}: {
  obligations: {
    data?: PartyObligation[];
    isLoading?: boolean;
    isError?: boolean;
    error?: { message?: string } | null;
    refetch: () => void;
  };
  staleParties?: {
    data?: Array<{
      partyId: number;
      name: string;
      staleParcelCount: number;
      oldestParcelAgeDays: number;
      staleTotalAmount: string;
    }>;
  };
  partyId: string;
  onSelectParty: (partyId: string) => void;
}) {
  const obligationColumns = useMemo<ColumnDef<PartyObligation, unknown>[]>(
    () => [
      {
        id: "party",
        header: "الجهة",
        accessorFn: (p) => p.name,
        meta: { width: "wide" },
        cell: ({ row }) => (
          <div className="flex items-center gap-1.5 font-bold">
            {row.original.name}
            {!row.original.hasPortal && (
              <span className="rounded bg-[var(--sem-info-bg)] px-1 py-px text-[9px] font-bold text-[var(--sem-info)]" title="تُدار بكشف الشركة لا ببوّابة سائق">كشف</span>
            )}
          </div>
        ),
      },
      {
        id: "currentBalance",
        header: "بذمته",
        accessorFn: (p) => fmt(p.currentBalance),
        meta: { kind: "money" },
        cell: ({ row }) => (
          <span className="font-bold" title="مسؤوليّة الدفتر على المندوب (نقدٌ قبضه + عجزٌ قبله ذمّةً بموجب SHORTFALL_ASSIGNED). قد تحوي جزءاً غير نقديّ.">
            {fmt(row.original.currentBalance)}
          </span>
        ),
      },
      {
        id: "openCount",
        header: DT.openParcelsCount.compact,
        accessorFn: (p) => String(p.openCount),
        meta: { align: "end" },
        sortingFn: (a, b) => Number(a.original.openCount) - Number(b.original.openCount),
        cell: ({ row }) => (
          <span title={DT.openParcelsCount.tooltip}>
            <span className="tabular-nums">{row.original.openCount}</span>
            {row.original.deliveredAwaitingRemitCount > 0 && (
              <span
                className="ms-2 rounded-md bg-[var(--sem-pos-bg)] px-1.5 py-0.5 text-[10px] font-black text-[var(--sem-pos)]"
                title={`${row.original.deliveredAwaitingRemitCount} طرود سُلِّمت للعميل — النقد بعدُ بيد المندوب`}
              >
                سلم {row.original.deliveredAwaitingRemitCount}
              </span>
            )}
          </span>
        ),
      },
      {
        id: "codDueTotal",
        header: "قيد التحصيل",
        accessorFn: (p) => fmt(p.codDueTotal),
        meta: { kind: "money" },
        cell: ({ row }) => (
          <span
            className="font-black text-[var(--sem-warn)]"
            title={`متبقّي COD على كلّ الطرود المفتوحة (بالطريق + مسلَّمة بلا قبض). ${DT.deliveredUncollected.tooltip}`}
          >
            {fmt(row.original.codDueTotal)}
          </span>
        ),
      },
      {
        id: "oldestOpenAge",
        header: DT.oldestOpenAge.compact,
        accessorFn: (p) => (p.oldestOpenAgeHours != null ? formatDeliveryAge(p.oldestOpenAgeHours) : "—"),
        meta: { align: "end", width: "status" },
        sortingFn: (a, b) => Number(a.original.oldestOpenAgeHours ?? -1) - Number(b.original.oldestOpenAgeHours ?? -1),
        cell: ({ row }) =>
          row.original.oldestOpenAgeHours != null ? (
            <span
              className={cn("rounded-md border px-1.5 py-0.5 text-[10px] font-black", DELIVERY_AGE_CLS[deliveryAgeLevel(row.original.oldestOpenAgeHours)])}
              dir="ltr"
              title={DT.oldestOpenAge.tooltip}
            >
              {formatDeliveryAge(row.original.oldestOpenAgeHours)}
            </span>
          ) : (
            "—"
          ),
      },
      {
        id: "feeDueTotal",
        header: PARTY_EXPOSURE_LABEL_AR.feesOwedToThem,
        accessorFn: (p) => fmt(p.feeDueTotal),
        meta: { kind: "money" },
        cell: ({ row }) => (
          <span className="text-money-positive" title={DT.feesOwedToCourier.tooltip}>
            {fmt(row.original.feeDueTotal)}
          </span>
        ),
      },
      {
        id: "lastRemittanceAt",
        header: DT.lastRemittanceAt.compact,
        accessorFn: (p) => (p.lastRemittanceAt ? fmtDateTime(p.lastRemittanceAt as unknown as string) : "—"),
        meta: { kind: "datetime", align: "end" },
        cell: ({ row }) => (
          <span className="text-[11px] text-muted-foreground" title={DT.lastRemittanceAt.tooltip}>
            {row.original.lastRemittanceAt ? fmtDateTime(row.original.lastRemittanceAt as unknown as string) : "—"}
          </span>
        ),
      },
    ],
    [],
  );

  const totalObligationExposure = (obligations.data ?? []).reduce((s, p) => s + Number(p.codDueTotal || 0), 0);
  const totalFeesDue = (obligations.data ?? []).reduce((s, p) => s + Number(p.feeDueTotal || 0), 0);
  const stale = staleParties?.data ?? [];

  return (
    <>
      {stale.length > 0 && (
        <div className="rounded-xl border border-[var(--sem-neg)]/40 bg-[var(--sem-neg-bg)] p-4">
          <div className="mb-2 flex items-center gap-2 font-bold text-[var(--sem-neg)]">
            <AlertTriangle aria-hidden className="size-4" />
            جهاتٌ متأخّرة SLA — طرودٌ تجاوزت العتبة بلا توريد ({stale.length})
          </div>
          <p className="mb-2 text-xs text-muted-foreground">
            الحارس التشغيليّ يرفض إسنادَ طرودٍ جديدة على هذه الجهات حتى تُصفّي القديم — لا حاجة لتدخّل مدير.
          </p>
          <div className="grid gap-1.5 text-sm">
            {stale.slice(0, 10).map((sp) => (
              <div key={sp.partyId} className="flex items-center justify-between rounded-md border bg-card px-3 py-1.5">
                <span className="font-bold">{sp.name}</span>
                <span className="flex items-center gap-3 text-xs">
                  <span className="tabular-nums">{sp.staleParcelCount} طرداً</span>
                  <span className="tabular-nums text-[var(--sem-warn)]">أقدم: {sp.oldestParcelAgeDays} يوم</span>
                  <span className="tabular-nums text-destructive" dir="ltr">{fmt(sp.staleTotalAmount)} د.ع</span>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {(obligations.data ?? []).length === 0 ? (
        <EmptyState icon={Wallet} title="لا مسؤوليات مالية مفتوحة" description="كل الجهات سوّت مسؤوليّاتها الماليّة — لا نقدٌ بيد أحدٍ ولا طرودٌ مفتوحة." />
      ) : (
        <div className="rounded-xl border bg-card">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
            <span className="text-sm font-bold">مسؤولية الجهات ({(obligations.data ?? []).length})</span>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span
                className="rounded-md border border-[var(--sem-warn)]/45 bg-[var(--sem-warn-bg)] px-2 py-1 font-bold text-[var(--sem-warn)]"
                title="متبقّي COD على كلّ الطرود المفتوحة (بالطريق للعميل + مسلَّمة بلا قبض) — يشمل كلّ إرساليّة لم تُغلَق ماليّاً بعد."
              >
                إجمالي COD المفتوح: <span className="tabular-nums" dir="ltr">{fmt(totalObligationExposure)}</span> د.ع
              </span>
              <span
                className="rounded-md border border-[var(--sem-info)]/45 bg-[var(--sem-info-bg)] px-2 py-1 font-bold text-[var(--sem-info)]"
                title={DT.feesOwedToCourier.tooltip}
              >
                {DT.feesOwedToCourier.compact}: <span className="tabular-nums" dir="ltr">{fmt(totalFeesDue)}</span> د.ع
              </span>
            </div>
          </div>
          <DataTable<PartyObligation>
            columns={obligationColumns}
            data={obligations.data ?? []}
            embedded
            searchable={false}
            pageSize={Infinity}
            loading={!!obligations.isLoading}
            errorState={{ isError: Boolean(obligations.isError), message: obligations.error?.message, onRetry: () => void obligations.refetch() }}
            onRowClick={(p) => onSelectParty(String(p.partyId))}
            getRowClassName={(p) => (String(p.partyId) === partyId ? "bg-primary/5" : undefined)}
            emptyText="لا مسؤوليات مالية مفتوحة."
          />
        </div>
      )}
    </>
  );
}
