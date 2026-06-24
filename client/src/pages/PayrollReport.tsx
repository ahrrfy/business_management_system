// تقرير الرواتب — ملخّص مسيّرات الرواتب الشهرية (إجمالي/صافي) بفلتر شهر اختياري.
// عرض + تصدير Excel + طباعة A4 (ReportShell + printReportDoc). يكشف الرواتب ⇒ صلاحية hr/READ خادمياً.
import { useState } from "react";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { ReportShell, type KpiItem } from "@/components/reports/ReportShell";
import { Card, CardContent } from "@/components/ui/card";
import { LoadingState } from "@/components/PageState";
import { fmtAr } from "@/lib/money";
import { exportRows } from "@/lib/export";
import { printReportDoc } from "@/lib/printing/reportDoc";

type Row = RouterOutputs["payroll"]["summaryReport"]["rows"][number];

const STATUS_LABEL: Record<string, string> = {
  draft: "مسودّة",
  approved: "معتمد",
  paid: "مدفوع",
};
const STATUS_CLS: Record<string, string> = {
  draft: "badge-status-cancelled",
  approved: "badge-status-pending",
  paid: "badge-status-active",
};

const inputCls =
  "h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export default function PayrollReport() {
  const [period, setPeriod] = useState(""); // YYYY-MM أو فارغ = الكل

  const q = trpc.payroll.summaryReport.useQuery({ period: period || undefined });

  const rows = q.data?.rows ?? [];
  const totals = q.data?.totals;

  const kpis: KpiItem[] = totals
    ? [
        { label: "عدد المسيّرات", value: totals.runs },
        { label: "إجمالي الرواتب", value: fmtAr(totals.gross), tone: "info" },
        { label: "صافي المدفوع", value: fmtAr(totals.net), tone: "positive" },
      ]
    : [];

  function onExport() {
    exportRows(rows, {
      filename: `تقرير-الرواتب${period ? "-" + period : ""}`,
      columns: [
        { key: "period", header: "الشهر" },
        { key: "status", header: "الحالة", map: (r) => STATUS_LABEL[r.status] ?? r.status },
        { key: "employees", header: "عدد الموظفين", map: (r) => r.employees },
        { key: "gross", header: "إجمالي الرواتب", map: (r) => Number(r.gross) },
        { key: "net", header: "الصافي", map: (r) => Number(r.net) },
      ],
    });
  }

  function onPrint() {
    printReportDoc({
      title: "تقرير الرواتب",
      headerExtra: [{ label: "الشهر", value: period || "كل الأشهر" }],
      columns: [
        { key: "period", label: "الشهر" },
        { key: "status", label: "الحالة" },
        { key: "employees", label: "عدد الموظفين", align: "left" },
        { key: "gross", label: "إجمالي الرواتب", align: "left" },
        { key: "net", label: "الصافي", align: "left" },
      ],
      rows: rows.map((r) => ({
        period: r.period,
        status: STATUS_LABEL[r.status] ?? r.status,
        employees: String(r.employees),
        gross: fmtAr(r.gross),
        net: fmtAr(r.net),
      })),
      summary: totals
        ? [
            { label: "عدد المسيّرات", value: String(totals.runs) },
            { label: "إجمالي الرواتب", value: fmtAr(totals.gross) },
            { label: "صافي المدفوع", value: fmtAr(totals.net), large: true, bold: true },
          ]
        : undefined,
    });
  }

  return (
    <ReportShell
      title="تقرير الرواتب"
      description="ملخّص مسيّرات الرواتب الشهرية (إجمالي وصافي) بحسب الحالة."
      backHref="/reports"
      kpis={kpis}
      onExport={onExport}
      onPrint={onPrint}
      exportDisabled={!rows.length}
      printDisabled={!rows.length}
      filters={
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-muted-foreground">الشهر (YYYY-MM)</label>
            <input type="month" value={period} onChange={(e) => setPeriod(e.target.value)} className={inputCls} />
          </div>
          {period && (
            <button
              type="button"
              onClick={() => setPeriod("")}
              className="h-9 rounded-md px-3 text-xs text-muted-foreground hover:bg-accent"
            >
              عرض الكل
            </button>
          )}
        </div>
      }
    >
      <Card>
        <CardContent className="p-0">
          {q.isLoading ? (
            <LoadingState />
          ) : !rows.length ? (
            <p className="p-8 text-center text-sm text-muted-foreground">لا مسيّرات رواتب في هذا النطاق.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-xs text-muted-foreground">
                    <th className="p-2.5 text-right font-medium">الشهر</th>
                    <th className="p-2.5 text-right font-medium">الحالة</th>
                    <th className="p-2.5 text-left font-medium">عدد الموظفين</th>
                    <th className="p-2.5 text-left font-medium">إجمالي الرواتب</th>
                    <th className="p-2.5 text-left font-medium">الصافي</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="border-b last:border-0 hover:bg-accent/40">
                      <td className="p-2.5 text-right tabular-nums" dir="ltr">{r.period}</td>
                      <td className="p-2.5 text-right">
                        <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${STATUS_CLS[r.status] ?? "bg-muted"}`}>
                          {STATUS_LABEL[r.status] ?? r.status}
                        </span>
                      </td>
                      <td className="p-2.5 text-left tabular-nums" dir="ltr">{r.employees}</td>
                      <td className="p-2.5 text-left tabular-nums" dir="ltr">{fmtAr(r.gross)}</td>
                      <td className="p-2.5 text-left tabular-nums font-medium" dir="ltr">{fmtAr(r.net)}</td>
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
