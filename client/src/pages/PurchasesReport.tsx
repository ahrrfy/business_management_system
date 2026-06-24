// تقرير المشتريات — ملخّص حسب المورّد (مرآة تقرير المبيعات). عرض + تصدير Excel + طباعة A4.
// المصدر: reports.purchasesReport (أوامر شراء ملتزمة CONFIRMED/RECEIVED ضمن الفترة).
import { useState } from "react";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { ReportShell, type KpiItem } from "@/components/reports/ReportShell";
import { PeriodFilter, DEFAULT_PERIOD, type PeriodValue } from "@/components/reports/PeriodFilter";
import { Card, CardContent } from "@/components/ui/card";
import { fmtAr } from "@/lib/money";
import { exportRows } from "@/lib/export";
import { printReportDoc } from "@/lib/printing/reportDoc";
import { LoadingState, ErrorState } from "@/components/PageState";

type Row = RouterOutputs["reports"]["purchasesReport"]["rows"][number];

const selectCls =
  "h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export default function PurchasesReport() {
  const [period, setPeriod] = useState<PeriodValue>(DEFAULT_PERIOD);
  const [branchId, setBranchId] = useState<number | "">("");

  const branches = trpc.branches.list.useQuery();
  const q = trpc.reports.purchasesReport.useQuery({
    from: period.from,
    to: period.to,
    branchId: branchId ? Number(branchId) : undefined,
  });

  const rows = q.data?.rows ?? [];
  const totals = q.data?.totals;

  const kpis: KpiItem[] = totals
    ? [
        { label: "عدد الأوامر", value: totals.count },
        { label: "الإجمالي", value: fmtAr(totals.total), tone: "info" },
        { label: "المدفوع", value: fmtAr(totals.paid), tone: "positive" },
        { label: "المتبقّي", value: fmtAr(totals.unpaid), tone: "warning" },
      ]
    : [];

  const periodLabel = `${period.from} — ${period.to}`;

  function onExport() {
    exportRows(rows, {
      filename: `تقرير-المشتريات-${period.from}-${period.to}`,
      columns: [
        { key: "supplierName", header: "المورّد", map: (r) => r.supplierName ?? "—" },
        { key: "orders", header: "عدد الأوامر", map: (r) => r.orders },
        { key: "total", header: "الإجمالي", map: (r) => Number(r.total) },
        { key: "paid", header: "المدفوع", map: (r) => Number(r.paid) },
        { key: "unpaid", header: "المتبقّي", map: (r) => Number(r.unpaid) },
      ],
    });
  }

  function onPrint() {
    printReportDoc({
      title: "تقرير المشتريات (حسب المورّد)",
      headerExtra: [
        { label: "الفترة", value: periodLabel },
        { label: "الفرع", value: branchId ? (branches.data?.find((b) => b.id === branchId)?.name ?? String(branchId)) : "الكل" },
      ],
      columns: [
        { key: "supplier", label: "المورّد" },
        { key: "orders", label: "عدد الأوامر", align: "left" },
        { key: "total", label: "الإجمالي", align: "left" },
        { key: "paid", label: "المدفوع", align: "left" },
        { key: "unpaid", label: "المتبقّي", align: "left" },
      ],
      rows: rows.map((r) => ({
        supplier: r.supplierName ?? "—",
        orders: String(r.orders),
        total: fmtAr(r.total),
        paid: fmtAr(r.paid),
        unpaid: fmtAr(r.unpaid),
      })),
      summary: totals
        ? [
            { label: "عدد الأوامر", value: String(totals.count) },
            { label: "المدفوع", value: fmtAr(totals.paid) },
            { label: "المتبقّي", value: fmtAr(totals.unpaid) },
            { label: "الإجمالي", value: fmtAr(totals.total), large: true, bold: true },
          ]
        : undefined,
    });
  }

  return (
    <ReportShell
      title="تقرير المشتريات"
      description="إجمالي المشتريات حسب المورّد (أوامر شراء مؤكَّدة/مستلَمة)."
      kpis={kpis}
      onExport={onExport}
      onPrint={onPrint}
      exportDisabled={!rows.length}
      printDisabled={!rows.length}
      filters={
        <div className="flex flex-wrap items-end gap-3">
          <PeriodFilter value={period} onChange={setPeriod} />
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
            <ErrorState message="تعذّر تحميل تقرير المشتريات." onRetry={() => q.refetch()} />
          ) : !rows.length ? (
            <p className="p-8 text-center text-sm text-muted-foreground">لا مشتريات في هذا النطاق.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-xs text-muted-foreground">
                    <th className="p-2.5 text-right font-medium">المورّد</th>
                    <th className="p-2.5 text-left font-medium">عدد الأوامر</th>
                    <th className="p-2.5 text-left font-medium">الإجمالي</th>
                    <th className="p-2.5 text-left font-medium">المدفوع</th>
                    <th className="p-2.5 text-left font-medium">المتبقّي</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r: Row) => (
                    <tr key={r.supplierId ?? r.supplierName ?? Math.random()} className="border-b last:border-0 hover:bg-accent/40">
                      <td className="p-2.5 text-right">{r.supplierName ?? "—"}</td>
                      <td className="p-2.5 text-left tabular-nums" dir="ltr">{r.orders}</td>
                      <td className="p-2.5 text-left tabular-nums" dir="ltr">{fmtAr(r.total)}</td>
                      <td className="p-2.5 text-left tabular-nums text-money-positive" dir="ltr">{fmtAr(r.paid)}</td>
                      <td className="p-2.5 text-left tabular-nums text-[var(--stock-low)]" dir="ltr">{fmtAr(r.unpaid)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </ReportShell>
  );
}
