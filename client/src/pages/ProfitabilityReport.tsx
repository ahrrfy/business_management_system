// تحليل الربحية الحقيقي — ليس «كم بِعت» بل «أين المال الحقيقي».
// بُعد واحد قابل للتبديل: منتج / فئة / عميل / فرع / كاشير / طريقة دفع — بأعمدة إيراد/تكلفة/ربح/هامش%.
// يكشف تآكل الهامش (بيع عالٍ بهامش منخفض) عبر شارة تحذير على الصفوف منخفضة الهامش.
// يُركّب endpoints موجودة (topProducts/profitByCategory/salesByDimension المُرقّى). عرض + Excel + طباعة A4.
import { useMemo, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { ReportShell, type KpiItem } from "@/components/reports/ReportShell";
import { PeriodFilter, DEFAULT_PERIOD, type PeriodValue } from "@/components/reports/PeriodFilter";
import { Card, CardContent } from "@/components/ui/card";
import { LoadingState, TableEmptyRow } from "@/components/PageState";
import { exportRows } from "@/lib/export";
import { printReportDoc } from "@/lib/printing/reportDoc";
import { fmtAr, formatIqd, fmtInt, D } from "@/lib/money";
import { fmtDate } from "@/lib/date";

type Dim = "product" | "category" | "customer" | "branch" | "cashier" | "paymentMethod";

const DIM_LABEL: Record<Dim, string> = {
  product: "المنتج",
  category: "الفئة",
  customer: "العميل",
  branch: "الفرع",
  cashier: "الكاشير",
  paymentMethod: "طريقة الدفع",
};
const selectCls =
  "h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

/** صفّ موحّد بعد التطبيع من أي مصدر. */
interface UniRow {
  label: string;
  sub: string; // عمود سياق (كمية/عدد فواتير/أصناف)
  revenue: string;
  cost: string;
  profit: string;
  marginPct: string;
}

/** عتبة تآكل الهامش — أقلّ منها = تحذير «بيع بهامش ضعيف». */
const LOW_MARGIN = 10;

export default function ProfitabilityReport() {
  const [dim, setDim] = useState<Dim>("product");
  const [period, setPeriod] = useState<PeriodValue>(DEFAULT_PERIOD);
  const [branchId, setBranchId] = useState<number | "">("");
  const branchArg = branchId ? Number(branchId) : undefined;
  const range = { from: period.from, to: period.to, branchId: branchArg };

  const branches = trpc.branches.list.useQuery();

  // كل مصدر يُفعَّل فقط حين يُختار بُعده (enabled) ⇒ استدعاء واحد فعّال.
  const products = trpc.reports.topProducts.useQuery(
    { ...range, by: "revenue", limit: 100 },
    { enabled: dim === "product", staleTime: 60_000 },
  );
  const categories = trpc.reports.profitByCategory.useQuery(range, { enabled: dim === "category", staleTime: 60_000 });
  const byDim = trpc.reports.salesByDimension.useQuery(
    { from: period.from, to: period.to, branchId: branchArg, dimension: (dim === "product" || dim === "category" ? "customer" : dim) },
    { enabled: dim !== "product" && dim !== "category", staleTime: 60_000 },
  );

  const loading =
    (dim === "product" && products.isLoading) ||
    (dim === "category" && categories.isLoading) ||
    (dim !== "product" && dim !== "category" && byDim.isLoading);

  const subLabel =
    dim === "product" ? "الكمية" : dim === "category" ? "الأصناف" : "الفواتير";

  const rows: UniRow[] = useMemo(() => {
    if (dim === "product") {
      return (products.data ?? []).map((r) => ({
        label: r.productName, sub: fmtInt(r.qtySold), revenue: r.revenue, cost: r.cost, profit: r.profit, marginPct: r.marginPct,
      }));
    }
    if (dim === "category") {
      return (categories.data ?? []).map((r) => ({
        label: r.categoryName, sub: fmtInt(r.itemsCount), revenue: r.revenue, cost: r.cost, profit: r.profit, marginPct: r.marginPct,
      }));
    }
    return (byDim.data?.rows ?? []).map((r) => ({
      label: r.label, sub: fmtInt(r.invoices), revenue: r.revenue, cost: r.cost, profit: r.profit, marginPct: r.marginPct,
    }));
  }, [dim, products.data, categories.data, byDim.data]);

  // إجماليات (من totals عند توفّرها، وإلا جمع الصفوف).
  const totals = useMemo(() => {
    let rev = D(0), cost = D(0), profit = D(0);
    for (const r of rows) { rev = rev.add(D(r.revenue)); cost = cost.add(D(r.cost)); profit = profit.add(D(r.profit)); }
    const margin = rev.isZero() ? "0.00" : profit.div(rev).times(100).toDecimalPlaces(2).toString();
    return { revenue: rev.toFixed(2), cost: cost.toFixed(2), profit: profit.toFixed(2), marginPct: margin };
  }, [rows]);

  // عدد صفوف تآكل الهامش (إيراد موجب وهامش < العتبة).
  const erosionCount = rows.filter((r) => Number(r.revenue) > 0 && Number(r.marginPct) < LOW_MARGIN).length;

  const kpis: KpiItem[] = rows.length
    ? [
        { label: "الإيراد", value: formatIqd(totals.revenue), tone: "info" },
        { label: "التكلفة", value: formatIqd(totals.cost) },
        { label: "صافي الربح", value: formatIqd(totals.profit), tone: Number(totals.profit) < 0 ? "negative" : "positive" },
        { label: "الهامش", value: `${fmtAr(totals.marginPct)}%`, tone: "info", hint: erosionCount ? `${fmtAr(erosionCount)} بند بهامش ضعيف` : undefined },
      ]
    : [];

  const branchLabel = branchId ? (branches.data?.find((b) => b.id === branchId)?.name ?? String(branchId)) : "الكل";

  function onExport() {
    exportRows(rows, {
      filename: `الربحية-حسب-${DIM_LABEL[dim]}`,
      title: `تحليل الربحية حسب ${DIM_LABEL[dim]}`,
      meta: [
        { label: "الفترة", value: `${period.from} — ${period.to}` },
        { label: "الفرع", value: branchLabel },
      ],
      columns: [
        { key: "label", header: DIM_LABEL[dim] },
        { key: "sub", header: subLabel },
        { key: "revenue", header: "الإيراد", money: true, map: (r) => Number(r.revenue) },
        { key: "cost", header: "التكلفة", money: true, map: (r) => Number(r.cost) },
        { key: "profit", header: "الربح", money: true, map: (r) => Number(r.profit) },
        { key: "marginPct", header: "الهامش %", map: (r) => Number(r.marginPct) },
      ],
      totalsRow: { label: "الإجمالي", revenue: Number(totals.revenue), cost: Number(totals.cost), profit: Number(totals.profit), marginPct: Number(totals.marginPct) },
    });
  }

  function onPrint() {
    printReportDoc({
      title: `تحليل الربحية حسب ${DIM_LABEL[dim]}`,
      headerExtra: [
        { label: "الفترة", value: `${period.from} — ${period.to}` },
        { label: "الفرع", value: branchLabel },
        { label: "كما في", value: fmtDate(new Date()) },
      ],
      columns: [
        { key: "label", label: DIM_LABEL[dim] },
        { key: "sub", label: subLabel, align: "left" },
        { key: "revenue", label: "الإيراد", align: "left" },
        { key: "cost", label: "التكلفة", align: "left" },
        { key: "profit", label: "الربح", align: "left" },
        { key: "margin", label: "الهامش %", align: "left" },
      ],
      rows: rows.map((r) => ({
        label: r.label, sub: r.sub, revenue: fmtAr(r.revenue), cost: fmtAr(r.cost), profit: fmtAr(r.profit), margin: `${fmtAr(r.marginPct)}%`,
      })),
      summary: [
        { label: "الإيراد", value: formatIqd(totals.revenue) },
        { label: "التكلفة", value: formatIqd(totals.cost) },
        { label: "صافي الربح", value: formatIqd(totals.profit), large: true, bold: true },
      ],
    });
  }

  return (
    <ReportShell
      title="تحليل الربحية الحقيقي"
      description="أين المال الحقيقي — ربح وهامش حسب المنتج/الفئة/العميل/الفرع/الكاشير، مع كشف تآكل الهامش."
      kpis={kpis}
      onExport={onExport}
      onPrint={onPrint}
      exportDisabled={!rows.length}
      printDisabled={!rows.length}
      filters={
        <div className="flex flex-wrap items-end gap-4">
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-muted-foreground">البُعد</label>
            <select className={selectCls} value={dim} onChange={(e) => setDim(e.target.value as Dim)}>
              {(Object.keys(DIM_LABEL) as Dim[]).map((d) => (<option key={d} value={d}>{DIM_LABEL[d]}</option>))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-muted-foreground">الفرع</label>
            <select className={selectCls} value={branchId} onChange={(e) => setBranchId(e.target.value ? Number(e.target.value) : "")}>
              <option value="">الكل</option>
              {branches.data?.map((b) => (<option key={b.id} value={b.id}>{b.name}</option>))}
            </select>
          </div>
          <PeriodFilter value={period} onChange={setPeriod} />
        </div>
      }
    >
      <Card>
        <CardContent className="p-0">
          {loading ? (
            <LoadingState />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-xs text-muted-foreground">
                    <th className="p-2.5 text-right font-medium">{DIM_LABEL[dim]}</th>
                    <th className="p-2.5 text-right font-medium">{subLabel}</th>
                    <th className="p-2.5 text-right font-medium">الإيراد</th>
                    <th className="p-2.5 text-right font-medium">التكلفة</th>
                    <th className="p-2.5 text-right font-medium">الربح</th>
                    <th className="p-2.5 text-right font-medium">الهامش %</th>
                  </tr>
                </thead>
                <tbody>
                  {!rows.length ? (
                    <TableEmptyRow colSpan={6} message="لا مبيعات في هذا النطاق." />
                  ) : rows.map((r, i) => {
                    const low = Number(r.revenue) > 0 && Number(r.marginPct) < LOW_MARGIN;
                    return (
                      <tr key={i} className="border-b last:border-0 hover:bg-accent/40">
                        <td className="p-2.5 text-right font-medium">
                          <span className="flex items-center gap-1.5">
                            {r.label}
                            {low && (
                              <span className="inline-flex items-center gap-0.5 rounded-full badge-stock-low px-1.5 py-0.5 text-[10px]" title="هامش ضعيف — تآكل ربح">
                                <AlertTriangle className="size-3" aria-hidden /> هامش ضعيف
                              </span>
                            )}
                          </span>
                        </td>
                        <td className="p-2.5 text-right tabular-nums text-muted-foreground" dir="ltr">{r.sub}</td>
                        <td className="p-2.5 text-right tabular-nums" dir="ltr">{fmtAr(r.revenue)}</td>
                        <td className="p-2.5 text-right tabular-nums text-muted-foreground" dir="ltr">{fmtAr(r.cost)}</td>
                        <td className={`p-2.5 text-right tabular-nums ${Number(r.profit) < 0 ? "text-money-negative" : "text-money-positive"}`} dir="ltr">{fmtAr(r.profit)}</td>
                        <td className={`p-2.5 text-right tabular-nums ${low ? "text-stock-low" : ""}`} dir="ltr">{fmtAr(r.marginPct)}%</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </ReportShell>
  );
}
