// تحليل الربحية الحقيقي — ليس «كم بِعت» بل «أين المال الحقيقي».
// بُعد واحد قابل للتبديل: منتج / فئة / عميل / فرع / كاشير / طريقة دفع — بأعمدة إيراد/تكلفة/ربح/هامش%.
// يكشف تآكل الهامش (بيع عالٍ بهامش منخفض) عبر شارة تحذير على الصفوف منخفضة الهامش.
// يُركّب endpoints موجودة (topProducts/profitByCategory/salesByDimension المُرقّى). عرض + Excel + طباعة A4.
import { useMemo, useState } from "react";
import { AppSelect } from "@/components/ui/AppSelect";
import { AlertTriangle } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { ReportShell, type KpiItem } from "@/components/reports/ReportShell";
import { PeriodFilter, DEFAULT_PERIOD, type PeriodValue } from "@/components/reports/PeriodFilter";
import { Card, CardContent } from "@/components/ui/card";
import { DataTable } from "@/components/data-table/DataTable";
import type { ColumnDef } from "@tanstack/react-table";
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

// بُعد «المنتج» كان محدوداً بأعلى ١٠٠ منتج صامتاً (الكتالوج قد يتجاوز ١٤٥٣ منتجاً — راجع CLAUDE.md
// §٦) فتختفي منتجات دون أي مؤشّر. سقفٌ أعلى معقول + لافتة اقتطاع صريحة عند بلوغه (rows.length===limit).
const PRODUCT_LIMIT = 1500;

export default function ProfitabilityReport() {
  const [dim, setDim] = useState<Dim>("product");
  const [period, setPeriod] = useState<PeriodValue>(DEFAULT_PERIOD);
  const [branchId, setBranchId] = useState<number | "">("");
  const branchArg = branchId ? Number(branchId) : undefined;
  const range = { from: period.from, to: period.to, branchId: branchArg };

  const branches = trpc.branches.list.useQuery();

  // كل مصدر يُفعَّل فقط حين يُختار بُعده (enabled) ⇒ استدعاء واحد فعّال.
  const products = trpc.reports.topProducts.useQuery(
    { ...range, by: "revenue", limit: PRODUCT_LIMIT },
    { enabled: dim === "product", staleTime: 60_000 },
  );
  // اقتطاع صامت سابقاً: النتائج تساوي الحدّ المطلوب بالضبط ⇒ قد تكون هناك منتجات أخرى لم تظهر.
  const productsTruncated = dim === "product" && (products.data?.length ?? 0) === PRODUCT_LIMIT;
  const categories = trpc.reports.profitByCategory.useQuery(range, { enabled: dim === "category", staleTime: 60_000 });
  const byDim = trpc.reports.salesByDimension.useQuery(
    { from: period.from, to: period.to, branchId: branchArg, dimension: (dim === "product" || dim === "category" ? "customer" : dim) },
    { enabled: dim !== "product" && dim !== "category", staleTime: 60_000 },
  );

  const loading =
    (dim === "product" && products.isLoading) ||
    (dim === "category" && categories.isLoading) ||
    (dim !== "product" && dim !== "category" && byDim.isLoading);

  const error =
    (dim === "product" && products.isError) ||
    (dim === "category" && categories.isError) ||
    (dim !== "product" && dim !== "category" && byDim.isError);

  function refetchActive() {
    if (dim === "product") return products.refetch();
    if (dim === "category") return categories.refetch();
    return byDim.refetch();
  }

  const subLabel =
    dim === "product" ? "الكمية" : dim === "category" ? "المنتجات" : "الفواتير";

  // أعمدة التقرير — رأسا العمودَين الأوّلَين يتبعان البُعد المختار، فتُعاد بناؤها معه.
  // ⚠️ `accessorFn` يُرجع النصّ المعروض (للنسخ) ⇒ كل عمودٍ رقميّ يلزمه `sortingFn` صريحٌ
  // بـDecimal: الفرز الافتراضيّ نصّيّ فيقرأ «1,234» أصغر من «999» ويقلب ترتيب الربحية
  // (نفس علاج `moneyCol` في ARAging و`stmtMoneyCol` في CustomerStatement).
  const profitColumns = useMemo<ColumnDef<UniRow, unknown>[]>(() => [
    {
      id: "label",
      header: DIM_LABEL[dim],
      accessorFn: (r) => r.label,
      meta: { width: "wide", wrap: true },
      cell: ({ row }) => {
        const r = row.original;
        const low = Number(r.revenue) > 0 && Number(r.marginPct) < LOW_MARGIN;
        return (
          <span className="flex items-center gap-1.5 font-medium">
            {r.label}
            {low && (
              <span className="inline-flex items-center gap-0.5 rounded-full badge-stock-low px-1.5 py-0.5 text-[10px]" title="هامش ضعيف — تآكل ربح">
                <AlertTriangle className="size-3" aria-hidden /> هامش ضعيف
              </span>
            )}
          </span>
        );
      },
    },
    { id: "sub", header: subLabel, accessorFn: (r) => r.sub, meta: { kind: "number" }, sortDescFirst: true, sortingFn: (a, b) => D(a.original.sub || 0).cmp(D(b.original.sub || 0)), cell: ({ row }) => <span className="text-muted-foreground">{row.original.sub}</span> },
    { id: "revenue", header: "الإيراد", accessorFn: (r) => fmtAr(r.revenue), meta: { kind: "money" }, sortDescFirst: true, sortingFn: (a, b) => D(a.original.revenue || 0).cmp(D(b.original.revenue || 0)), cell: ({ row }) => fmtAr(row.original.revenue) },
    { id: "cost", header: "التكلفة", accessorFn: (r) => fmtAr(r.cost), meta: { kind: "money" }, sortDescFirst: true, sortingFn: (a, b) => D(a.original.cost || 0).cmp(D(b.original.cost || 0)), cell: ({ row }) => <span className="text-muted-foreground">{fmtAr(row.original.cost)}</span> },
    {
      id: "profit",
      header: "الربح",
      accessorFn: (r) => fmtAr(r.profit),
      meta: { kind: "money" },
      sortDescFirst: true,
      sortingFn: (a, b) => D(a.original.profit || 0).cmp(D(b.original.profit || 0)),
      cell: ({ row }) => <span className={Number(row.original.profit) < 0 ? "text-money-negative" : "text-money-positive"}>{fmtAr(row.original.profit)}</span>,
    },
    {
      id: "marginPct",
      header: "الهامش %",
      accessorFn: (r) => `${fmtAr(r.marginPct)}%`,
      meta: { kind: "number" },
      sortDescFirst: true,
      sortingFn: (a, b) => D(a.original.marginPct || 0).cmp(D(b.original.marginPct || 0)),
      cell: ({ row }) => {
        const r = row.original;
        const low = Number(r.revenue) > 0 && Number(r.marginPct) < LOW_MARGIN;
        return <span className={low ? "text-stock-low" : undefined}>{fmtAr(r.marginPct)}%</span>;
      },
    },
  ], [dim, subLabel]);

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
      note={
        productsTruncated
          ? `تُعرض أعلى ${fmtInt(PRODUCT_LIMIT)} منتجاً فقط — قد توجد منتجات إضافية لم تظهر. ضيّق الفترة أو استعمل بُعداً آخر لرؤية بقية الكتالوج.`
          : undefined
      }
      kpis={kpis}
      onExport={onExport}
      onPrint={onPrint}
      exportDisabled={!rows.length}
      printDisabled={!rows.length}
      filters={
        <div className="flex flex-wrap items-end gap-4">
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-muted-foreground">البُعد</label>
            <AppSelect className="h-9" value={dim} onValueChange={(next) => setDim(next as Dim)}>
              {(Object.keys(DIM_LABEL) as Dim[]).map((d) => (<option key={d} value={d}>{DIM_LABEL[d]}</option>))}
            </AppSelect>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-muted-foreground">الفرع</label>
            <AppSelect className="h-9" value={String(branchId)} onValueChange={(next) => setBranchId(next ? Number(next) : "")}>
              <option value="">الكل</option>
              {branches.data?.map((b) => (<option key={b.id} value={b.id}>{b.name}</option>))}
            </AppSelect>
          </div>
          <PeriodFilter value={period} onChange={setPeriod} />
        </div>
      }
    >
      <Card>
        <CardContent className="p-0">
          {/* فلاتر البُعد/الفرع/الفترة في `ReportShell` أعلاه — فأيّ فراغٍ هنا سببه نطاقُها. */}
          <DataTable<UniRow>
            columns={profitColumns}
            data={rows}
            searchPlaceholder={`بحث في ${DIM_LABEL[dim]}…`}
            externalFiltersActive
            loading={loading}
            errorState={{ isError: error, message: "تعذّر تحميل التقرير.", onRetry: () => void refetchActive() }}
            emptyText="لا مبيعات في هذا النطاق."
            viewKey="profitability-report"
          />
        </CardContent>
      </Card>
    </ReportShell>
  );
}
