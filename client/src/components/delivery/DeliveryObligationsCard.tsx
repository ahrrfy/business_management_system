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
        header: PARTY_EXPOSURE_LABEL_AR.cashInHand,
        accessorFn: (p) => fmt(p.cashInHandStored ?? p.currentBalance),
        meta: { kind: "money" },
        cell: ({ row }) => {
          const val = Number(
            row.original.cashInHandStored ?? row.original.currentBalance ?? 0,
          );
          const shortfall = Number(row.original.shortfallOwedAmount ?? 0);
          return (
            <span
              className={cn(
                "font-bold tabular-nums",
                val > 0 ? "text-[var(--sem-pos)] font-black" : "text-muted-foreground",
              )}
              title="النقد المادي الذي قبضه المندوب من الطرود المسلَّمة ولم يُورِّده للدرج بعد."
            >
              {fmt(val)}
              {shortfall > 0 && (
                <span
                  className="ms-1.5 rounded bg-[var(--sem-neg-bg)] px-1 py-0.5 text-[10px] font-bold text-[var(--sem-neg)]"
                  title="عجز محمَّل ذمّةً غير نقدية على الجهة"
                >
                  عجز {fmt(shortfall)}
                </span>
              )}
            </span>
          );
        },
      },
      {
        id: "openCount",
        header: DT.openParcelsCount.compact,
        accessorFn: (p) => String(p.openCount),
        meta: { align: "end" },
        sortingFn: (a, b) => Number(a.original.openCount) - Number(b.original.openCount),
        cell: ({ row }) => {
          const delivered = Number(row.original.deliveredAwaitingRemitCount ?? 0);
          const open = Number(row.original.openCount ?? 0);
          const inStreet = Math.max(0, open - delivered);
          return (
            <span title={DT.openParcelsCount.tooltip}>
              <span className="tabular-nums font-bold">{open}</span>
              {delivered > 0 && (
                <span
                  className="ms-2 rounded-md bg-[var(--sem-pos-bg)] px-1.5 py-0.5 text-[10px] font-black text-[var(--sem-pos)]"
                  title={`${delivered} طرود سُلِّمت للعميل — النقد بيد المندوب جاهز للتوريد`}
                >
                  سلم {delivered}
                </span>
              )}
              {delivered > 0 && inStreet > 0 && (
                <span
                  className="ms-1 rounded-md bg-[var(--sem-warn-bg)] px-1.5 py-0.5 text-[10px] font-bold text-[var(--sem-warn)]"
                  title={`${inStreet} طرود ما زالت بالطريق قيد التوصيل`}
                >
                  بالطريق {inStreet}
                </span>
              )}
            </span>
          );
        },
      },
      {
        id: "parcelsInTransit",
        header: PARTY_EXPOSURE_LABEL_AR.parcelsInTransit,
        accessorFn: (p) =>
          fmt(
            Number(p.parcelsInTransitAmount ?? 0) +
              Number(p.deliveredUncollectedAmount ?? 0),
          ),
        meta: { kind: "money" },
        cell: ({ row }) => {
          const hasExplicit =
            row.original.parcelsInTransitAmount !== undefined ||
            row.original.deliveredUncollectedAmount !== undefined;
          const transitVal = hasExplicit
            ? Number(row.original.parcelsInTransitAmount ?? 0) +
              Number(row.original.deliveredUncollectedAmount ?? 0)
            : Math.max(
                0,
                Number(row.original.codDueTotal ?? 0) -
                  Number(row.original.currentBalance ?? 0),
              );
          return (
            <span
              className="font-bold text-[var(--sem-warn)] tabular-nums"
              title="قيمة COD للطرود التي ما زالت في الطريق مع المندوب/الشركة ولم يُثبَت تسليمها بعد."
            >
              {fmt(transitVal)}
            </span>
          );
        },
      },
      {
        id: "codDueTotal",
        header: "إجمالي COD المفتوح",
        accessorFn: (p) => fmt(p.codDueTotal),
        meta: { kind: "money" },
        cell: ({ row }) => (
          <span
            className="font-black text-foreground tabular-nums"
            title={`إجمالي ذمة الطرود المفتوحة (نقد بيده + طرود بالطريق). ${DT.deliveredUncollected.tooltip}`}
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

  const totalCashInHand = (obligations.data ?? []).reduce(
    (s, p) => s + Number(p.cashInHandStored ?? p.currentBalance ?? 0),
    0,
  );
  const totalInTransitExposure = (obligations.data ?? []).reduce((s, p) => {
    const hasExplicit =
      p.parcelsInTransitAmount !== undefined ||
      p.deliveredUncollectedAmount !== undefined;
    const transit = hasExplicit
      ? Number(p.parcelsInTransitAmount ?? 0) +
        Number(p.deliveredUncollectedAmount ?? 0)
      : Math.max(0, Number(p.codDueTotal ?? 0) - Number(p.currentBalance ?? 0));
    return s + transit;
  }, 0);
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
            <span
              className="text-sm font-bold"
              title="يعرض هذا الجدول الجهات التي عليها ذمة مفتوحة حالياً (نقد بيدها أو طرود بالطريق أو أجور مستحقة)."
            >
              مسؤولية الجهات ({(obligations.data ?? []).length})
            </span>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span
                className="rounded-md border border-[var(--sem-pos)]/45 bg-[var(--sem-pos-bg)] px-2 py-1 font-bold text-[var(--sem-pos)]"
                title="النقد المادي المحصَّل بيد الجهات بعد تسليم الطرود وبانتظار التوريد للدرج."
              >
                {PARTY_EXPOSURE_LABEL_AR.cashInHand}: <span className="tabular-nums" dir="ltr">{fmt(totalCashInHand)}</span> د.ع
              </span>
              <span
                className="rounded-md border border-[var(--sem-warn)]/45 bg-[var(--sem-warn-bg)] px-2 py-1 font-bold text-[var(--sem-warn)]"
                title="قيمة COD للطرود التي ما زالت بالطريق قيد التوصيل مع المناديب والشركات."
              >
                {PARTY_EXPOSURE_LABEL_AR.parcelsInTransit}: <span className="tabular-nums" dir="ltr">{fmt(totalInTransitExposure)}</span> د.ع
              </span>
              <span
                className="rounded-md border bg-muted/40 px-2 py-1 font-bold text-foreground"
                title="إجمالي متبقّي COD على كلّ الطرود المفتوحة (نقد بيده + طرود بالطريق)."
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
