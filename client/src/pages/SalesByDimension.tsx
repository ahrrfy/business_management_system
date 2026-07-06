// المبيعات حسب بُعد — تجميع الفواتير على محور مختار (عميل/فرع/طريقة دفع/كاشير) + إجماليات.
// عرض + تصدير Excel + طباعة A4 (ReportShell + printReportDoc).
import { useState } from "react";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { ReportShell, type KpiItem } from "@/components/reports/ReportShell";
import { PeriodFilter, DEFAULT_PERIOD, type PeriodValue } from "@/components/reports/PeriodFilter";
import { Card, CardContent } from "@/components/ui/card";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { LoadingState } from "@/components/PageState";
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
  product: "صنف",
};
const DIM_OPTIONS = Object.keys(DIM_LABEL) as Dimension[];

const selectCls =
  "h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export default function SalesByDimension() {
  const [period, setPeriod] = useState<PeriodValue>(DEFAULT_PERIOD);
  const [branchId, setBranchId] = useState<number | "">("");
  const [dimension, setDimension] = useState<Dimension>("customer");

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

  const kpis: KpiItem[] = totals
    ? [
        { label: "إجمالي الإيراد", value: fmtAr(totals.revenue), tone: "info" },
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

  function onExport() {
    exportRows(rows, {
      filename: `المبيعات-حسب-${dimLabel}-${period.from}-${period.to}`,
      columns: [
        { key: "label", header: dimLabel },
        { key: "invoices", header: "عدد الفواتير", map: (r) => r.invoices },
        { key: "revenue", header: "الإيراد", map: (r) => Number(r.revenue) },
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
        { key: "revenue", label: "الإيراد", align: "left" },
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
        revenue: fmtAr(r.revenue),
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
            { label: "إجمالي الإيراد", value: fmtAr(totals.revenue), large: true, bold: true },
          ]
        : undefined,
    });
  }

  return (
    <ReportShell
      title="المبيعات حسب بُعد"
      description="تجميع المبيعات على محور مختار (عميل/فرع/طريقة دفع/كاشير/صنف) مع التكلفة والربح والهامش."
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
      <Card>
        <CardContent className="p-0">
          {q.isLoading ? (
            <LoadingState />
          ) : !rows.length ? (
            <p className="p-8 text-center text-sm text-muted-foreground">لا مبيعات في هذا النطاق.</p>
          ) : (
            <ScrollTableShell bordered={false}>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-xs text-muted-foreground">
                    <th className="p-2.5 text-end font-medium">{dimLabel}</th>
                    <th className="p-2.5 text-right font-medium">عدد الفواتير</th>
                    <th className="p-2.5 text-right font-medium">الإيراد</th>
                    {showPaidCols && <th className="p-2.5 text-right font-medium">المحصّل</th>}
                    {showPaidCols && <th className="p-2.5 text-right font-medium">المتبقّي</th>}
                    <th className="p-2.5 text-right font-medium">التكلفة</th>
                    <th className="p-2.5 text-right font-medium">الربح</th>
                    <th className="p-2.5 text-right font-medium">الهامش %</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r: Row) => (
                    <tr key={r.key} className="border-b last:border-0 hover:bg-accent/40">
                      <td className="p-2.5 text-end">{r.label}</td>
                      <td className="p-2.5 text-right tabular-nums" dir="ltr">{r.invoices}</td>
                      <td className="p-2.5 text-right tabular-nums" dir="ltr">{fmtAr(r.revenue)}</td>
                      {showPaidCols && (
                        <td className="p-2.5 text-right tabular-nums text-money-positive" dir="ltr">{fmtAr(r.paid)}</td>
                      )}
                      {showPaidCols && (
                        <td className="p-2.5 text-right tabular-nums text-money-negative" dir="ltr">{fmtAr(r.unpaid)}</td>
                      )}
                      <td className="p-2.5 text-right tabular-nums" dir="ltr">{fmtAr(r.cost)}</td>
                      <td
                        className={`p-2.5 text-right tabular-nums ${Number(r.profit) < 0 ? "text-destructive" : "text-money-positive"}`}
                        dir="ltr"
                      >
                        {fmtAr(r.profit)}
                      </td>
                      <td className="p-2.5 text-right tabular-nums" dir="ltr">{r.marginPct}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ScrollTableShell>
          )}
        </CardContent>
      </Card>
    </ReportShell>
  );
}
