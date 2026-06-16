// تقرير الإنتاج — مستندات الإنتاج المؤكَّدة ضمن الفترة: كلفة المواد/العمالة/الهدر/إجمالي الكلفة.
// المصدر: reports.productionReport. عرض + تصدير Excel + طباعة A4 (ReportShell + printReportDoc).
import { useState } from "react";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { ReportShell, type KpiItem } from "@/components/reports/ReportShell";
import { PeriodFilter, DEFAULT_PERIOD, type PeriodValue } from "@/components/reports/PeriodFilter";
import { Card, CardContent } from "@/components/ui/card";
import { fmtAr } from "@/lib/money";
import { exportRows } from "@/lib/export";
import { printReportDoc } from "@/lib/printing/reportDoc";

type Row = RouterOutputs["reports"]["productionReport"]["rows"][number];

const selectCls =
  "h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export default function ProductionReport() {
  const [period, setPeriod] = useState<PeriodValue>(DEFAULT_PERIOD);
  const [branchId, setBranchId] = useState<number | "">("");

  const branches = trpc.branches.list.useQuery();
  const q = trpc.reports.productionReport.useQuery({
    from: period.from,
    to: period.to,
    branchId: branchId ? Number(branchId) : undefined,
  });

  const rows = q.data?.rows ?? [];
  const totals = q.data?.totals;

  const kpis: KpiItem[] = totals
    ? [
        { label: "عدد المستندات", value: totals.count },
        { label: "تكلفة المواد", value: fmtAr(totals.inputsCost), tone: "info" },
        { label: "تكلفة العمالة", value: fmtAr(totals.laborCost), tone: "info" },
        { label: "الهدر", value: fmtAr(totals.wasteCost), tone: "warning" },
        { label: "إجمالي التكلفة", value: fmtAr(totals.totalCost), tone: "negative" },
      ]
    : [];

  const periodLabel = `${period.from} — ${period.to}`;

  function onExport() {
    exportRows(rows, {
      filename: `تقرير-الإنتاج-${period.from}-${period.to}`,
      columns: [
        { key: "docNumber", header: "رقم المستند", map: (r) => r.docNumber ?? "—" },
        { key: "date", header: "التاريخ" },
        { key: "branchName", header: "الفرع", map: (r) => r.branchName ?? "" },
        { key: "inputsCost", header: "تكلفة المواد", map: (r) => Number(r.inputsCost) },
        { key: "laborCost", header: "تكلفة العمالة", map: (r) => Number(r.laborCost) },
        { key: "wasteCost", header: "الهدر", map: (r) => Number(r.wasteCost) },
        { key: "outputsCost", header: "قيمة المخرجات", map: (r) => Number(r.outputsCost) },
        { key: "totalCost", header: "إجمالي التكلفة", map: (r) => Number(r.totalCost) },
      ],
    });
  }

  function onPrint() {
    printReportDoc({
      title: "تقرير الإنتاج",
      headerExtra: [
        { label: "الفترة", value: periodLabel },
        { label: "الفرع", value: branchId ? (branches.data?.find((b) => b.id === branchId)?.name ?? String(branchId)) : "الكل" },
      ],
      columns: [
        { key: "doc", label: "رقم المستند" },
        { key: "date", label: "التاريخ" },
        { key: "branch", label: "الفرع" },
        { key: "inputs", label: "المواد", align: "left" },
        { key: "labor", label: "العمالة", align: "left" },
        { key: "waste", label: "الهدر", align: "left" },
        { key: "total", label: "إجمالي التكلفة", align: "left" },
      ],
      rows: rows.map((r) => ({
        doc: r.docNumber ?? "—",
        date: r.date,
        branch: r.branchName ?? "—",
        inputs: fmtAr(r.inputsCost),
        labor: fmtAr(r.laborCost),
        waste: fmtAr(r.wasteCost),
        total: fmtAr(r.totalCost),
      })),
      summary: totals
        ? [
            { label: "عدد المستندات", value: String(totals.count) },
            { label: "تكلفة المواد", value: fmtAr(totals.inputsCost) },
            { label: "تكلفة العمالة", value: fmtAr(totals.laborCost) },
            { label: "الهدر", value: fmtAr(totals.wasteCost) },
            { label: "إجمالي التكلفة", value: fmtAr(totals.totalCost), large: true, bold: true },
          ]
        : undefined,
    });
  }

  return (
    <ReportShell
      title="تقرير الإنتاج"
      description="مستندات الإنتاج المؤكَّدة ضمن الفترة مع تفصيل كلفة المواد والعمالة والهدر."
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
            <p className="p-8 text-center text-sm text-muted-foreground">جارٍ التحميل…</p>
          ) : !rows.length ? (
            <p className="p-8 text-center text-sm text-muted-foreground">لا مستندات إنتاج في هذا النطاق.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-xs text-muted-foreground">
                    <th className="p-2.5 text-right font-medium">رقم المستند</th>
                    <th className="p-2.5 text-right font-medium">التاريخ</th>
                    <th className="p-2.5 text-right font-medium">الفرع</th>
                    <th className="p-2.5 text-left font-medium">المواد</th>
                    <th className="p-2.5 text-left font-medium">العمالة</th>
                    <th className="p-2.5 text-left font-medium">الهدر</th>
                    <th className="p-2.5 text-left font-medium">إجمالي التكلفة</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r: Row) => (
                    <tr key={r.id} className="border-b last:border-0 hover:bg-accent/40">
                      <td className="p-2.5 text-right">{r.docNumber ?? "—"}</td>
                      <td className="p-2.5 text-right tabular-nums" dir="ltr">{r.date}</td>
                      <td className="p-2.5 text-right text-muted-foreground">{r.branchName ?? "—"}</td>
                      <td className="p-2.5 text-left tabular-nums" dir="ltr">{fmtAr(r.inputsCost)}</td>
                      <td className="p-2.5 text-left tabular-nums" dir="ltr">{fmtAr(r.laborCost)}</td>
                      <td className="p-2.5 text-left tabular-nums text-amber-600" dir="ltr">{fmtAr(r.wasteCost)}</td>
                      <td className="p-2.5 text-left tabular-nums font-medium" dir="ltr">{fmtAr(r.totalCost)}</td>
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
