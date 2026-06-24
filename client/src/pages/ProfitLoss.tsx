// قائمة الأرباح والخسائر المبسّطة — إيراد صافٍ − تكلفة المبيعات − مصروفات تشغيلية.
// مع مقارنة فترة اختيارية. عرض + تصدير Excel + طباعة A4 (ReportShell + printReportDoc).
import { useMemo, useState } from "react";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { ReportShell, type KpiItem } from "@/components/reports/ReportShell";
import {
  PeriodFilter, DEFAULT_PERIOD, comparativeRange,
  type PeriodValue, type CompareMode,
} from "@/components/reports/PeriodFilter";
import { Card, CardContent } from "@/components/ui/card";
import { LoadingState, ErrorState } from "@/components/PageState";
import { formatIqd, fmtAr, D } from "@/lib/money";
import { exportRows } from "@/lib/export";
import { printReportDoc } from "@/lib/printing/reportDoc";

type PL = RouterOutputs["reports"]["profitAndLoss"];
type Snap = PL["current"];

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
    if (!cur) return [] as { label: string; cur: string; prev?: string; bold?: boolean; neg?: boolean }[];
    const prevMap = new Map((prev?.expenseLines ?? []).map((l) => [l.key, l.amount]));
    const rows: { label: string; cur: string; prev?: string; bold?: boolean; neg?: boolean }[] = [
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
            <select className={selectCls} value={branchId} onChange={(e) => setBranchId(e.target.value ? Number(e.target.value) : "")}>
              <option value="">الكل</option>
              {branches.data?.map((b) => (<option key={b.id} value={b.id}>{b.name}</option>))}
            </select>
          </div>
        </div>
      }
    >
      <Card>
        <CardContent className="p-0">
          {q.isLoading ? (
            <LoadingState />
          ) : q.isError ? (
            <ErrorState message={q.error?.message} onRetry={() => q.refetch()} />
          ) : !cur ? (
            <p className="p-8 text-center text-sm text-muted-foreground">لا بيانات.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-xs text-muted-foreground">
                  <th className="p-3 text-right font-medium">البند</th>
                  <th className="p-3 text-right font-medium">الفترة</th>
                  {prev && <th className="p-3 text-right font-medium">الفترة السابقة</th>}
                </tr>
              </thead>
              <tbody>
                {lines.map((r, i) => (
                  <tr key={i} className={`border-b last:border-0 ${r.bold ? "font-bold bg-muted/30" : ""}`}>
                    <td className="p-3 text-right">{r.label}</td>
                    <td className={`p-3 text-right tabular-nums ${r.neg ? "text-money-negative" : ""}`} dir="ltr">
                      {r.neg ? `(${fmtAr(r.cur)})` : fmtAr(r.cur)}
                    </td>
                    {prev && (
                      <td className="p-3 text-right tabular-nums text-muted-foreground" dir="ltr">
                        {r.prev != null ? (r.neg ? `(${fmtAr(r.prev)})` : fmtAr(r.prev)) : "—"}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </ReportShell>
  );
}
