// المبيعات حسب بُعد — تجميع الفواتير على محور مختار (عميل/فرع/طريقة دفع/كاشير) + إجماليات.
// عرض + تصدير Excel + طباعة A4 (ReportShell + printReportDoc).
import { useMemo, useState } from "react";
import { type ColumnDef } from "@tanstack/react-table";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { ReportShell, type KpiItem } from "@/components/reports/ReportShell";
import { PeriodFilter, DEFAULT_PERIOD, type PeriodValue } from "@/components/reports/PeriodFilter";
import { DataTable } from "@/components/data-table/DataTable";
import { ErrorState } from "@/components/PageState";
import { fmtAr } from "@/lib/money";
import { exportRows } from "@/lib/export";
import { printReportDoc } from "@/lib/printing/reportDoc";

type Row = RouterOutputs["reports"]["salesByDimension"]["rows"][number];
type Dimension = "customer" | "branch" | "paymentMethod" | "cashier" | "product";

const DIM_LABEL: Record<Dimension, string> = {
  customer: "عميل",
  branch: "فرع",
  paymentMethod: "طريقة دفع",
  cashier: "كاشير",
  // بند 9 (٧/٧): بُعد الصنف — ربحية على مستوى بنود الفواتير (المحصَّل/المتبقّي خاصيّتا فاتورة فتُخفيان).
  product: "منتج",
};
const DIM_OPTIONS = Object.keys(DIM_LABEL) as Dimension[];

const selectCls =
  "h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export default function SalesByDimension() {
  const [period, setPeriod] = useState<PeriodValue>(DEFAULT_PERIOD);
  const [branchId, setBranchId] = useState<number | "">("");
  const [dimension, setDimension] = useState<Dimension>("cashier");

  const branches = trpc.branches.list.useQuery();
  const q = trpc.reports.salesByDimension.useQuery({
    from: period.from,
    to: period.to,
    branchId: branchId ? Number(branchId) : undefined,
    dimension,
  });

  const rows = q.data?.rows ?? [];
  const totals = q.data?.totals;
  // المحصَّل/المتبقّي خاصيّتا فاتورة — لا معنى لهما في بُعد الصنف (الخادم يعيدهما صفرين).
  const showPaidCols = dimension !== "product";
  const showSalesAuditCols = dimension !== "product";

  const kpis: KpiItem[] = totals
    ? [
        { label: "إجمالي المبيعات", value: fmtAr(totals.grossSales), tone: "info" },
        ...(showSalesAuditCols
          ? [
              { label: "الخصومات", value: fmtAr(totals.discounts), tone: "warning" as const },
              { label: "المرتجعات", value: fmtAr(totals.returns), tone: "warning" as const },
              { label: "صافي المبيعات", value: fmtAr(totals.netSales), tone: "positive" as const },
            ]
          : []),
        // بند 9 (٧/٧): الربح والهامش كانا في ردّ الخادم بلا عرض — سؤال «أين نكسب؟» صار مرئياً.
        { label: "الربح", value: fmtAr(totals.profit), tone: Number(totals.profit) < 0 ? "warning" : "positive" },
        { label: "الهامش", value: `${totals.marginPct}%`, tone: "info" },
        ...(showPaidCols
          ? [
              { label: "المحصّل", value: fmtAr(totals.paid), tone: "positive" as const },
              { label: "المتبقّي", value: fmtAr(totals.unpaid), tone: "warning" as const },
            ]
          : []),
      ]
    : [];

  const periodLabel = `${period.from} — ${period.to}`;
  const dimLabel = DIM_LABEL[dimension];

  // أعمدة DataTable — كل أعمدة الأرقام/المال بفرزٍ رقميّ (accessorFn ⇒ Number). عمودا المحصّل/
  // المتبقّي مشروطان بـshowPaidCols (بلا معنى في بُعد الصنف) ⇒ يُبنى المصفوف ببناء تدريجي typed
  // بدل ترنري+spread داخل حرفي المصفوف (يتفادى استدلال `any` الضمني — نفس درس onExport أدناه).
  const cols = useMemo<ColumnDef<Row>[]>(() => {
    const base: ColumnDef<Row>[] = [
      { header: dimLabel, accessorKey: "label" },
      {
        id: "invoices",
        header: "عدد الفواتير",
        accessorFn: (r) => Number(r.invoices),
        cell: ({ row }) => <span dir="ltr" className="tabular-nums">{row.original.invoices}</span>,
      },
      {
        id: "grossSales",
        header: showSalesAuditCols ? "إجمالي المبيعات" : "الإيراد",
        accessorFn: (r) => Number(showSalesAuditCols ? r.grossSales : r.revenue),
        cell: ({ row }) => <span dir="ltr" className="tabular-nums">{fmtAr(showSalesAuditCols ? row.original.grossSales : row.original.revenue)}</span>,
      },
    ];
    if (showSalesAuditCols) {
      base.push(
        {
          id: "discounts",
          header: "الخصومات",
          accessorFn: (r) => Number(r.discounts),
          cell: ({ row }) => <span dir="ltr" className="tabular-nums text-[var(--sem-warning)]">{fmtAr(row.original.discounts)}</span>,
        },
        {
          id: "returns",
          header: "المرتجعات",
          accessorFn: (r) => Number(r.returns),
          cell: ({ row }) => <span dir="ltr" className="tabular-nums text-destructive">{fmtAr(row.original.returns)}</span>,
        },
        {
          id: "netSales",
          header: "صافي المبيعات",
          accessorFn: (r) => Number(r.netSales),
          cell: ({ row }) => <span dir="ltr" className="tabular-nums font-medium text-money-positive">{fmtAr(row.original.netSales)}</span>,
        },
      );
    }
    if (showPaidCols) {
      base.push(
        {
          id: "paid",
          header: "المحصّل",
          accessorFn: (r) => Number(r.paid),
          cell: ({ row }) => (
            <span dir="ltr" className="tabular-nums text-money-positive">{fmtAr(row.original.paid)}</span>
          ),
        },
        {
          id: "unpaid",
          header: "المتبقّي",
          accessorFn: (r) => Number(r.unpaid),
          cell: ({ row }) => (
            <span dir="ltr" className="tabular-nums text-money-negative">{fmtAr(row.original.unpaid)}</span>
          ),
        },
      );
    }
    base.push(
      {
        id: "cost",
        header: "التكلفة",
        accessorFn: (r) => Number(r.cost),
        cell: ({ row }) => <span dir="ltr" className="tabular-nums">{fmtAr(row.original.cost)}</span>,
      },
      {
        id: "profit",
        header: "الربح",
        accessorFn: (r) => Number(r.profit),
        cell: ({ row }) => (
          <span
            dir="ltr"
            className={`tabular-nums ${Number(row.original.profit) < 0 ? "text-destructive" : "text-money-positive"}`}
          >
            {fmtAr(row.original.profit)}
          </span>
        ),
      },
      {
        id: "marginPct",
        header: "الهامش %",
        accessorFn: (r) => Number(r.marginPct),
        cell: ({ row }) => <span dir="ltr" className="tabular-nums">{row.original.marginPct}%</span>,
      },
    );
    return base;
  }, [showPaidCols, showSalesAuditCols, dimLabel]);

  function onExport() {
    exportRows(rows, {
      filename: `المبيعات-حسب-${dimLabel}-${period.from}-${period.to}`,
      columns: [
        { key: "label", header: dimLabel },
        { key: "invoices", header: "عدد الفواتير", map: (r) => r.invoices },
        { key: "grossSales", header: showSalesAuditCols ? "إجمالي المبيعات" : "الإيراد", map: (r) => Number(showSalesAuditCols ? r.grossSales : r.revenue) },
        ...(showSalesAuditCols
          ? [
              { key: "discounts", header: "الخصومات", map: (r: Row) => Number(r.discounts) },
              { key: "returns", header: "المرتجعات", map: (r: Row) => Number(r.returns) },
              { key: "netSales", header: "صافي المبيعات", map: (r: Row) => Number(r.netSales) },
            ]
          : []),
        ...(showPaidCols
          ? [
              { key: "paid", header: "المحصّل", map: (r: Row) => Number(r.paid) },
              { key: "unpaid", header: "المتبقّي", map: (r: Row) => Number(r.unpaid) },
            ]
          : []),
        { key: "cost", header: "التكلفة", map: (r) => Number(r.cost) },
        { key: "profit", header: "الربح", map: (r) => Number(r.profit) },
        { key: "marginPct", header: "الهامش %", map: (r) => Number(r.marginPct) },
      ],
    });
  }

  function onPrint() {
    printReportDoc({
      title: `المبيعات حسب ${dimLabel}`,
      headerExtra: [
        { label: "الفترة", value: periodLabel },
        { label: "الفرع", value: branchId ? (branches.data?.find((b) => b.id === branchId)?.name ?? String(branchId)) : "الكل" },
        { label: "المحور", value: dimLabel },
      ],
      columns: [
        { key: "label", label: dimLabel },
        { key: "invoices", label: "عدد الفواتير", align: "left" },
        { key: "grossSales", label: showSalesAuditCols ? "إجمالي المبيعات" : "الإيراد", align: "left" },
        ...(showSalesAuditCols
          ? [
              { key: "discounts", label: "الخصومات", align: "left" as const },
              { key: "returns", label: "المرتجعات", align: "left" as const },
              { key: "netSales", label: "صافي المبيعات", align: "left" as const },
            ]
          : []),
        ...(showPaidCols
          ? [
              { key: "paid", label: "المحصّل", align: "left" as const },
              { key: "unpaid", label: "المتبقّي", align: "left" as const },
            ]
          : []),
        { key: "cost", label: "التكلفة", align: "left" },
        { key: "profit", label: "الربح", align: "left" },
        { key: "marginPct", label: "الهامش %", align: "left" },
      ],
      rows: rows.map((r) => ({
        label: r.label,
        invoices: String(r.invoices),
        grossSales: fmtAr(showSalesAuditCols ? r.grossSales : r.revenue),
        discounts: fmtAr(r.discounts),
        returns: fmtAr(r.returns),
        netSales: fmtAr(r.netSales),
        paid: fmtAr(r.paid),
        unpaid: fmtAr(r.unpaid),
        cost: fmtAr(r.cost),
        profit: fmtAr(r.profit),
        marginPct: `${r.marginPct}%`,
      })),
      summary: totals
        ? [
            ...(showPaidCols
              ? [
                  { label: "المحصّل", value: fmtAr(totals.paid) },
                  { label: "المتبقّي", value: fmtAr(totals.unpaid) },
                ]
              : []),
            { label: "الربح", value: fmtAr(totals.profit) },
            ...(showSalesAuditCols
              ? [
                  { label: "الخصومات", value: fmtAr(totals.discounts) },
                  { label: "المرتجعات", value: fmtAr(totals.returns) },
                ]
              : []),
            { label: showSalesAuditCols ? "صافي المبيعات" : "إجمالي الإيراد", value: fmtAr(showSalesAuditCols ? totals.netSales : totals.revenue), large: true, bold: true },
          ]
        : undefined,
    });
  }

  return (
    <ReportShell
      title="المبيعات حسب بُعد"
      description="أداء موظفي المبيعات أو أي محور آخر: الفواتير والخصومات والمرتجعات وصافي المبيعات والتكلفة والربح."
      kpis={kpis}
      onExport={onExport}
      onPrint={onPrint}
      exportDisabled={!rows.length}
      printDisabled={!rows.length}
      filters={
        <div className="flex flex-wrap items-end gap-3">
          <PeriodFilter value={period} onChange={setPeriod} />
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-muted-foreground">المحور</label>
            <select className={selectCls} value={dimension} onChange={(e) => setDimension(e.target.value as Dimension)}>
              {DIM_OPTIONS.map((d) => (<option key={d} value={d}>{DIM_LABEL[d]}</option>))}
            </select>
          </div>
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
      {q.isError ? (
        <ErrorState message="تعذّر تحميل التقرير." onRetry={() => void q.refetch()} />
      ) : (
        <DataTable
          columns={cols}
          data={rows}
          loading={q.isLoading}
          emptyText="لا مبيعات في هذا النطاق."
          pageSize={Infinity}
        />
      )}
    </ReportShell>
  );
}
