/**
 * لوحة الخمسة أعمدة لجهات التوصيل (م١ PR-C): لكلّ جهةٍ خمسة أعمدة نقّالة (مُسنَد · بالطريق · سُلِّم ولم
 * يُورَّد · رجع · أُلغي) + نقدٌ بيده (مع شارة **انحراف** حين يخالف الدفترُ المخزَّن) + أجورٌ له + الصافي +
 * شارة الطرود المتأخّرة (SLA). النقر على عمودٍ يفتح طرود الجهة المطابقة في «قيد التوصيل»، والصفّ
 * يحمل فعله: «سوِّ اليوم» (التسوية اليوميّة بتأكيدٍ واحد) و«استيراد كشف» لشركات التوصيل.
 * البيانات تصل عبر props (`delivery.partyBoard`) — المنطق النقيّ في `partyBoardModel.ts` (الاسم يتفادى تصادم الحالة مع PartyBoard.tsx على ويندوز).
 */
import { useMemo, type ComponentProps } from "react";
import { Link } from "wouter";
import type { ColumnDef } from "@tanstack/react-table";
import { AlertTriangle, Clock3, FileCheck2, Truck, Wallet } from "lucide-react";
import { DataTable } from "@/components/data-table/DataTable";
import { EmptyState } from "@/components/EmptyState";
import { RowActions } from "@/components/list";
import { fmt } from "@/lib/money";
import { cn } from "@/lib/utils";
import { DELIVERY_TERMS } from "@shared/deliveryTerminology";
import { balanceDirection } from "@shared/predicates";
import {
  BOARD_BUCKETS,
  BOARD_MONEY_LABEL,
  boardFlags,
  boardTotals,
  bucketColumnLabel,
  effectiveCashInHand,
  filterOutstanding,
  hubLinkFor,
  partyDetailLinkFor,
  settleLinkFor,
  sortBoardRows,
  toNum,
  type BoardBucketColumn,
  type BoardTone,
  type PartyBoardRow,
} from "./partyBoardModel";

const TONE_TEXT: Record<BoardTone, string> = {
  neutral: "text-foreground",
  warning: "text-[var(--sem-warn)]",
  danger: "text-[var(--sem-neg)]",
  muted: "text-muted-foreground",
};

export interface PartyBoardProps {
  rows: PartyBoardRow[] | undefined;
  loading: boolean;
  isError: boolean;
  /** رسالة الخادم عند الفشل — تُعرض كما هي (الشاشة لا تحجب ما يملكه الخادم). */
  errorMessage?: string | null;
  onRetry: () => void;
  /** «ذمّة قائمة فقط» — يُفلتر الصفوف ويُعيد حساب الرأس منها. */
  outstandingOnly: boolean;
  /**
   * علَمُ `courierLedgerDerived` (من `delivery.deliveryUiFlags`): ON ⇒ «نقد بيده» من الدفتر مع شارة انحراف؛
   * OFF (الافتراض) ⇒ من المخزَّن (`currentBalance`) بلا انحراف — يطابق مصدرَ `net` الخادميّ (Codex #1012 P2).
   */
  ledgerDerived: boolean;
  /** غيابه = لا صلاحية تسوية (مرآة deliveryCashierProcedure) ⇒ الفعل مخفيّ. */
  onSettleToday?: (row: PartyBoardRow) => void;
  onOpenDetail: (row: PartyBoardRow) => void;
  /** أفعال جهات التوصيل القائمة (تسوية العهدة السائبة · طلب شطب) — تبقى لمن يملكها؛ غيابها يخفيها. */
  onSettleLoose?: (row: PartyBoardRow) => void;
  onWriteOff?: (row: PartyBoardRow) => void;
  /** تواصل واتساب من الصفّ (الهاتف عند الأب من `listParties`؛ اللوحة لا تحمله). */
  contactFor?: (row: PartyBoardRow) => ComponentProps<typeof RowActions>["contact"] | null;
}

function BucketCell({ row, col }: { row: PartyBoardRow; col: BoardBucketColumn }) {
  const b = row[col.key];
  if (b.count <= 0 && toNum(b.amount) === 0) return <span className="text-muted-foreground">—</span>;
  const label = bucketColumnLabel(col);
  return (
    <Link
      href={hubLinkFor(row, col)}
      className={cn("inline-flex flex-col items-center leading-tight hover:underline", TONE_TEXT[col.tone])}
      title={`${label.tooltip} — افتح طرود «${row.partyName}» في قيد التوصيل`}
    >
      <span className="text-sm font-black tabular-nums">{b.count}</span>
      <span className="text-[10px] font-bold tabular-nums" dir="ltr">{fmt(b.amount)} د.ع</span>
    </Link>
  );
}

export function PartyBoard({ rows, loading, isError, errorMessage = null, onRetry, outstandingOnly, ledgerDerived, onSettleToday, onOpenDetail, onSettleLoose, onWriteOff, contactFor }: PartyBoardProps) {
  const visible = useMemo(() => {
    const base = sortBoardRows(rows ?? []);
    return outstandingOnly ? filterOutstanding(base, ledgerDerived) : base;
  }, [rows, outstandingOnly, ledgerDerived]);
  const totals = useMemo(() => boardTotals(visible, ledgerDerived), [visible, ledgerDerived]);

  const columns: ColumnDef<PartyBoardRow, unknown>[] = [
    {
      id: "الجهة",
      header: "الجهة",
      accessorFn: (r) => r.partyName,
      meta: { width: "wide" },
      cell: ({ row }) => {
        const f = boardFlags(row.original, ledgerDerived);
        return (
          <div className="flex flex-col gap-0.5">
            <button type="button" className="text-start font-bold text-primary hover:underline" onClick={() => onOpenDetail(row.original)}>
              {row.original.partyName}
            </button>
            <span className="flex flex-wrap items-center gap-1 text-[10px] text-muted-foreground">
              <span>{row.original.partyType === "COMPANY" ? "شركة" : "مندوب"}</span>
              {f.stale && (
                <span className="inline-flex items-center gap-0.5 rounded bg-[var(--sem-neg-bg)] px-1.5 py-0.5 font-black text-[var(--sem-neg)]" title={DELIVERY_TERMS.oldestOpenAge.tooltip}>
                  <Clock3 aria-hidden className="size-3" /> {row.original.staleOpenParcels} {DELIVERY_TERMS.openParcelsCount.compact} متأخّرة
                </span>
              )}
            </span>
          </div>
        );
      },
    },
    ...BOARD_BUCKETS.map<ColumnDef<PartyBoardRow, unknown>>((col) => {
      const label = bucketColumnLabel(col);
      return {
        id: label.compact,
        header: () => <span title={label.tooltip}>{label.compact}</span>,
        accessorFn: (r) => r[col.key].count,
        meta: { kind: "number", align: "center" },
        sortDescFirst: true,
        sortingFn: (a, b) => a.original[col.key].count - b.original[col.key].count,
        cell: ({ row }) => <BucketCell row={row.original} col={col} />,
      };
    }),
    {
      id: BOARD_MONEY_LABEL.cashInHand,
      header: () => <span title={DELIVERY_TERMS.cashInHand.tooltip}>{BOARD_MONEY_LABEL.cashInHand}</span>,
      accessorFn: (r) => fmt(effectiveCashInHand(r, ledgerDerived)),
      meta: { kind: "money" },
      sortDescFirst: true,
      sortingFn: (a, b) => toNum(effectiveCashInHand(a.original, ledgerDerived)) - toNum(effectiveCashInHand(b.original, ledgerDerived)),
      cell: ({ row }) => {
        const r = row.original;
        const f = boardFlags(r, ledgerDerived);
        const cash = effectiveCashInHand(r, ledgerDerived);
        return (
          <span className="inline-flex items-center gap-1">
            <span className={cn("font-bold tabular-nums", toNum(cash) > 0 ? "text-foreground" : "text-muted-foreground")} dir="ltr">{fmt(cash)}</span>
            {f.drift && (
              <span
                className="inline-flex items-center gap-0.5 rounded bg-[var(--sem-warn-bg)] px-1.5 py-0.5 text-[10px] font-black text-[var(--sem-warn)]"
                title={`انحراف: الدفتر ${fmt(r.cashInHandLedger)} ≠ المخزَّن ${fmt(r.cashInHandStored)} (الفرق ${fmt(r.cashInHandDrift)}) — يستحقّ تحقيقاً لا تسويةً صامتة`}
              >
                <AlertTriangle aria-hidden className="size-3" /> انحراف
              </span>
            )}
          </span>
        );
      },
    },
    {
      // عمودٌ خامسٌ مستقلّ (Codex #1012 P2): عجزٌ محمَّل على الجهة — ذمّةٌ **غير نقديّة** لا تُخلَط بالنقد الماديّ.
      id: BOARD_MONEY_LABEL.shortfallOwed,
      header: () => <span title={`${BOARD_MONEY_LABEL.shortfallOwed} — نقدٌ لم تقبضه الجهة قطّ وحُمِّل عليها ذمّةً (لا يُخلَط بالنقد بيده)`}>{BOARD_MONEY_LABEL.shortfallOwed}</span>,
      accessorFn: (r) => fmt(r.shortfallOwed),
      meta: { kind: "money" },
      sortDescFirst: true,
      sortingFn: (a, b) => toNum(a.original.shortfallOwed) - toNum(b.original.shortfallOwed),
      cell: ({ row }) => {
        const s = row.original.shortfallOwed;
        return toNum(s) > 0
          ? <span className="font-bold tabular-nums text-[var(--sem-neg)]" dir="ltr">{fmt(s)}</span>
          : <span className="text-muted-foreground">—</span>;
      },
    },
    {
      id: BOARD_MONEY_LABEL.feesOwed,
      header: () => <span title={DELIVERY_TERMS.feesOwedToCourier.tooltip}>{BOARD_MONEY_LABEL.feesOwed}</span>,
      accessorFn: (r) => fmt(r.feesOwed),
      meta: { kind: "money" },
      sortDescFirst: true,
      sortingFn: (a, b) => toNum(a.original.feesOwed) - toNum(b.original.feesOwed),
      cell: ({ row }) => <span className={cn("font-bold tabular-nums", toNum(row.original.feesOwed) > 0 ? "text-[var(--sem-pos)]" : "text-muted-foreground")} dir="ltr">{fmt(row.original.feesOwed)}</span>,
    },
    {
      id: BOARD_MONEY_LABEL.net,
      header: () => <span title={DELIVERY_TERMS.netResponsibility.tooltip}>{BOARD_MONEY_LABEL.net}</span>,
      accessorFn: (r) => fmt(r.net),
      meta: { kind: "money" },
      sortDescFirst: true,
      sortingFn: (a, b) => toNum(a.original.net) - toNum(b.original.net),
      cell: ({ row }) => <span className="font-black tabular-nums text-primary" dir="ltr">{fmt(row.original.net)}</span>,
    },
    {
      id: "actions",
      header: "إجراءات",
      meta: { kind: "actions" },
      enableSorting: false,
      cell: ({ row }) => {
        const r = row.original;
        const f = boardFlags(r, ledgerDerived);
        // العهدةُ المخزَّنةُ الكلّية (نقدٌ ماديّ + عجز) = مصدرُ حقّ فعلَي «العهدة السائبة» و«شطب العجز»:
        // main يطرح العجزَ من `cashInHandStored` (العرض)، فاستعمالُه وحده كان يُعطّل شطبَ عجزٍ خالص (Codex #1012 P2).
        const custodyStored = String(toNum(r.cashInHandStored) + toNum(r.shortfallOwed));
        return (
          <RowActions
            mode="menu"
            contact={contactFor?.(r) ?? undefined}
            actions={[
              {
                key: "settle-today",
                kind: "pay",
                label: "سوِّ اليوم",
                hidden: !onSettleToday,
                disabled: !f.settleReady,
                disabledReason: "لا طرودَ سُلِّمت ولم تُورَّد — الرصيدُ السائب يُسوَّى بـ«تسوية عهدة سائبة»",
                onSelect: () => onSettleToday?.(r),
                gate: { roles: ["cashier", "manager"], module: "store", level: "FULL" },
              },
              {
                key: "statement",
                kind: "view",
                label: "استيراد كشف الشركة",
                hidden: r.partyType !== "COMPANY",
                href: settleLinkFor(r),
                gate: { roles: ["cashier", "manager"], module: "store", level: "FULL" },
              },
              {
                key: "detail",
                kind: "view",
                label: "تفاصيل وكشف",
                href: partyDetailLinkFor(r),
                gate: { module: "store", level: "READ" },
              },
              {
                key: "settle-loose",
                kind: "pay",
                label: "تسوية عهدة سائبة",
                hidden: !onSettleLoose,
                // المسند المشترك (D2): «مدينٌ لنا» على العهدة المخزَّنة الكلّية — لا فحصَ إشارةٍ بيد.
                disabled: balanceDirection({ currentBalance: custodyStored }, "deliveryParty") !== "receivable",
                disabledReason: "لا عهدة سائبة على الجهة",
                onSelect: () => onSettleLoose?.(r),
                gate: { roles: ["cashier", "manager"], module: "store", level: "FULL" },
              },
              {
                key: "write-off",
                kind: "reverse",
                label: "طلب شطب عجز",
                variant: "destructive",
                hidden: !onWriteOff,
                disabled: balanceDirection({ currentBalance: custodyStored }, "deliveryParty") !== "receivable",
                disabledReason: "لا عجز قابل للشطب",
                onSelect: () => onWriteOff?.(r),
                gate: { roles: ["admin"] },
              },
            ]}
          />
        );
      },
    },
  ];

  return (
    <div className="space-y-3">
      {/* رأس اللوحة يُشتقّ من الصفوف المعروضة (المفلترة) — فلترةٌ تغيّر الرأسَ بصدق. */}
      <div className="grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-4" aria-label="مجاميع اللوحة">
        <div className="rounded-lg border bg-card px-3 py-2"><span className="text-muted-foreground">{BOARD_MONEY_LABEL.cashInHand}</span><div className="text-base font-black tabular-nums" dir="ltr">{fmt(totals.cashInHand)} د.ع</div></div>
        <div className="rounded-lg border bg-card px-3 py-2"><span className="text-muted-foreground">{DELIVERY_TERMS.awaitingRemittance.compact}</span><div className="text-base font-black tabular-nums" dir="ltr">{totals.buckets.deliveredUnremitted.count} · {fmt(totals.buckets.deliveredUnremitted.amount)} د.ع</div></div>
        <div className="rounded-lg border bg-card px-3 py-2"><span className="text-muted-foreground">{BOARD_MONEY_LABEL.net}</span><div className="text-base font-black tabular-nums text-primary" dir="ltr">{fmt(totals.net)} د.ع</div></div>
        <div className="rounded-lg border bg-card px-3 py-2">
          <span className="text-muted-foreground">جهات تستحقّ انتباهاً</span>
          <div className="flex items-center gap-2 text-base font-black tabular-nums">
            <span className={cn(totals.staleParties > 0 ? "text-[var(--sem-neg)]" : "text-muted-foreground")} title="طرود أقدم من عتبة SLA بلا توريد">{totals.staleParties} متأخّرة</span>
            <span className="text-muted-foreground">·</span>
            <span className={cn(totals.driftParties > 0 ? "text-[var(--sem-warn)]" : "text-muted-foreground")} title="الدفتر ≠ المخزَّن">{totals.driftParties} انحراف</span>
          </div>
        </div>
      </div>

      <div className="rounded-xl border bg-card">
        <DataTable<PartyBoardRow>
          columns={columns}
          data={visible}
          searchable={false}
          externalFiltersActive={outstandingOnly}
          loading={loading}
          errorState={{ isError, onRetry, message: errorMessage ?? undefined }}
          emptyState={<EmptyState icon={Truck} title="لا جهات توصيل" description="أضِف مندوباً أو شركة توصيل للبدء." />}
          emptyFilteredState={<EmptyState icon={Wallet} title="لا ذمّة قائمة" description="كلّ الجهات مُسوّاة — لا نقد بيد أحد ولا طرود مفتوحة." />}
        />
      </div>
      <p className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
        <FileCheck2 aria-hidden className="size-3" /> إيقاع الشركة بالكشف: من قائمة الصفّ «استيراد كشف الشركة» ⇒ وضع الكشف في «تسوية المناديب» (مطابق/مختلف/مفقود).
      </p>
    </div>
  );
}
