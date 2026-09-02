// قائمة الأرباح والخسائر المبسّطة — إيراد صافٍ − تكلفة المبيعات − مصروفات تشغيلية.
// مع مقارنة فترة اختيارية. عرض + تصدير Excel + طباعة A4 (ReportShell + printReportDoc).
import { useMemo, useState } from "react";
import { AppSelect } from "@/components/ui/AppSelect";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { ReportShell, type KpiItem } from "@/components/reports/ReportShell";
import {
  PeriodFilter, DEFAULT_PERIOD, comparativeRange,
  type PeriodValue, type CompareMode,
} from "@/components/reports/PeriodFilter";
import { Card, CardContent } from "@/components/ui/card";
import { DataTable } from "@/components/data-table/DataTable";
import type { ColumnDef } from "@tanstack/react-table";
import { formatIqd, fmtAr, D } from "@/lib/money";
import { exportRows } from "@/lib/export";
import { printReportDoc } from "@/lib/printing/reportDoc";

type PL = RouterOutputs["reports"]["profitAndLoss"];
type Snap = PL["current"];

/** سطرُ قائمة الأرباح والخسائر — يُستهلَك في العرض والتصدير والطباعة معاً. */
type PLLine = { label: string; cur: string; prev?: string; bold?: boolean; neg?: boolean };

/** مبلغٌ سالبُ الأثر يُعرَض بين قوسين وبلون المال السالب (عرفٌ محاسبيّ قائم). */
function plAmount(value: string, neg?: boolean): string {
  return neg ? `(${fmtAr(value)})` : fmtAr(value);
}

const ASSUMPTIONS =
  "افتراضات مبسّطة: التكلفة = كلفة الفاتورة وقت البيع (آخر تكلفة)، الضريبة 0%. المصروفات = نقدية (سجلّ المصروفات) + رواتب المسيّر + نثرية وتلف المخزون بالكلفة (تشمل هدر الإنتاج). لا تشمل سداد ذمم الموردين. للتفاصيل راجع دفتر الأستاذ.";

const selectCls =
  "h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export default function ProfitLoss() {
  const [period, setPeriod] = useState<PeriodValue>(DEFAULT_PERIOD);
  const [compare, setCompare] = useState<CompareMode>("none");
  const [branchId, setBranchId] = useState<number | "">("");

  const branches = trpc.branches.list.useQuery();
  const cmp = compare !== "none" ? comparativeRange(period.from, period.to, compare) : null;

  const q = trpc.reports.profitAndLoss.useQuery({
    from: period.from,
    to: period.to,
    branchId: branchId ? Number(branchId) : undefined,
    compareFrom: cmp?.from,
    compareTo: cmp?.to,
  });

  const cur = q.data?.current;
  const prev = q.data?.previous;

  const kpis: KpiItem[] = cur
    ? [
        { label: "الإيراد", value: fmtAr(cur.revenue), tone: "info" },
        { label: "مجمل الربح", value: fmtAr(cur.grossProfit), tone: "positive", hint: `هامش ${cur.grossMarginPct}%` },
        { label: "المصروفات", value: fmtAr(cur.totalExpenses), tone: "warning" },
        {
          label: "صافي الربح",
          value: fmtAr(cur.netProfit),
          tone: D(cur.netProfit).gte(0) ? "positive" : "negative",
          hint: `هامش ${cur.netMarginPct}%`,
        },
      ]
    : [];

  // صفوف القائمة لإعادة استعمالها في العرض/التصدير/الطباعة.
  const lines = useMemo(() => {
    if (!cur) return [] as PLLine[];
    const prevMap = new Map((prev?.expenseLines ?? []).map((l) => [l.key, l.amount]));
    const rows: PLLine[] = [
      { label: "الإيراد", cur: cur.revenue, prev: prev?.revenue, bold: true },
      { label: "تكلفة المبيعات", cur: cur.cogs, prev: prev?.cogs, neg: true },
      { label: "مجمل الربح", cur: cur.grossProfit, prev: prev?.grossProfit, bold: true },
    ];
    for (const l of cur.expenseLines) {
      rows.push({ label: `— ${l.label}`, cur: l.amount, prev: prevMap.get(l.key), neg: true });
    }
    rows.push({ label: "إجمالي المصروفات التشغيلية", cur: cur.totalExpenses, prev: prev?.totalExpenses, neg: true, bold: true });
    rows.push({ label: "صافي الربح", cur: cur.netProfit, prev: prev?.netProfit, bold: true });
    return rows;
  }, [cur, prev]);

  // عمود «الفترة السابقة» مشروطٌ بوجود مقارنة — كما كان في الجدول الخامّ.
  const columns = useMemo<ColumnDef<PLLine, unknown>[]>(() => {
    const prevColumn: ColumnDef<PLLine, unknown> = {
      id: "prev",
      header: "الفترة السابقة",
      accessorFn: (r) => (r.prev != null ? plAmount(r.prev, r.neg) : "—"),
      meta: { kind: "money" },
      cell: ({ row }) => (
        <span className="text-muted-foreground">{row.original.prev != null ? plAmount(row.original.prev, row.original.neg) : "—"}</span>
      ),
    };
    return [
      {
        id: "label",
        header: "البند",
        accessorFn: (r) => r.label,
        meta: { width: "wide", wrap: true },
        cell: ({ row }) => row.original.label,
      },
      {
        id: "cur",
        header: "الفترة",
        accessorFn: (r) => plAmount(r.cur, r.neg),
        meta: { kind: "money" },
        cell: ({ row }) => (
          <span className={row.original.neg ? "text-money-negative" : undefined}>{plAmount(row.original.cur, row.original.neg)}</span>
        ),
      },
      ...(prev ? [prevColumn] : []),
    ];
  }, [prev]);

  const periodLabel = `${period.from} — ${period.to}`;

  function onExport() {
    exportRows(lines, {
      filename: `أرباح-وخسائر-${period.from}-${period.to}`,
      columns: [
        { key: "label", header: "البند" },
        { key: "cur", header: "الفترة", map: (r) => Number(r.cur) },
        ...(prev ? [{ key: "prev", header: "الفترة السابقة", map: (r: typeof lines[number]) => (r.prev != null ? Number(r.prev) : "") }] : []),
      ],
    });
  }

  function onPrint() {
    printReportDoc({
      title: "قائمة الأرباح والخسائر",
      headerExtra: [
        { label: "الفترة", value: periodLabel },
        { label: "الفرع", value: branchId ? (branches.data?.find((b) => b.id === branchId)?.name ?? String(branchId)) : "الكل" },
        ...(cmp ? [{ label: "مقارنة بـ", value: `${cmp.from} — ${cmp.to}` }] : []),
      ],
      note: ASSUMPTIONS,
      columns: [
        { key: "label", label: "البند" },
        { key: "cur", label: "الفترة", align: "left" },
        ...(prev ? [{ key: "prev", label: "الفترة السابقة", align: "left" as const }] : []),
      ],
      rows: lines.map((r) => ({
        label: r.label,
        cur: (r.neg ? "(" : "") + fmtAr(r.cur) + (r.neg ? ")" : ""),
        prev: r.prev != null ? (r.neg ? "(" : "") + fmtAr(r.prev) + (r.neg ? ")" : "") : "—",
      })),
      showIndex: false,
      summary: cur
        ? [{ label: "صافي الربح", value: formatIqd(cur.netProfit), large: true, bold: true }]
        : undefined,
    });
  }

  return (
    <ReportShell
      title="قائمة الأرباح والخسائر"
      description="إيراد صافٍ − تكلفة المبيعات − مصروفات تشغيلية (مبسّطة)."
      note={ASSUMPTIONS}
      kpis={kpis}
      onExport={onExport}
      onPrint={onPrint}
      exportDisabled={!cur}
      printDisabled={!cur}
      filters={
        <div className="flex flex-wrap items-end gap-3">
          <PeriodFilter value={period} onChange={setPeriod} compare={compare} onCompareChange={setCompare} />
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-muted-foreground">الفرع</label>
            <AppSelect className="h-9" value={String(branchId)} onValueChange={(next) => setBranchId(next ? Number(next) : "")}>
              <option value="">الكل</option>
              {branches.data?.map((b) => (<option key={b.id} value={b.id}>{b.name}</option>))}
            </AppSelect>
          </div>
        </div>
      }
    >
      <Card>
        <CardContent className="p-0">
          {/* قائمةٌ مالية ثابتة الطول داخل بطاقةٍ في ReportShell ⇒ `embedded` (بلا شريط حالةٍ
              ولا منتقي أعمدة) وبلا ترقيمٍ ولا بحث: البنود معدودةٌ ويجب أن تُقرأ كاملةً. */}
          <DataTable<PLLine>
            embedded
            searchable={false}
            bounded={false}
            pageSize={Infinity}
            columns={columns}
            data={lines}
            loading={q.isLoading}
            errorState={{ isError: q.isError, message: q.error?.message, onRetry: () => q.refetch() }}
            getRowClassName={(r) => (r.bold ? "font-bold bg-muted/30" : undefined)}
            emptyText="لا بيانات."
          />
        </CardContent>
      </Card>
    </ReportShell>
  );
}
