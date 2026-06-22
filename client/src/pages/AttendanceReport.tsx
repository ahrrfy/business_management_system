// تقرير الحضور والانصراف — صفوف الحضور في نطاق فترة + فلتر موظف اختياري، مع إجماليات (أيام/ساعات/أجر).
// عرض + تصدير Excel + طباعة A4 (ReportShell + printReportDoc). يكشف الأجور ⇒ صلاحية hr/READ خادمياً.
import { useState } from "react";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { ReportShell, type KpiItem } from "@/components/reports/ReportShell";
import { PeriodFilter, DEFAULT_PERIOD, type PeriodValue } from "@/components/reports/PeriodFilter";
import { Card, CardContent } from "@/components/ui/card";
import { fmtAr } from "@/lib/money";
import { exportRows } from "@/lib/export";
import { printReportDoc } from "@/lib/printing/reportDoc";

type Row = RouterOutputs["attendance"]["report"]["rows"][number];

const STATUS_CLS: Record<string, string> = {
  PRESENT: "badge-status-active",
  ABSENT: "badge-stock-out",
  LATE: "badge-status-pending",
  LEAVE: "bg-sky-100 text-sky-700 dark:bg-sky-950/50 dark:text-sky-300",
};

const selectCls =
  "h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export default function AttendanceReport() {
  const [period, setPeriod] = useState<PeriodValue>(DEFAULT_PERIOD);
  const [employeeId, setEmployeeId] = useState<number | "">("");

  const employees = trpc.employees.list.useQuery({ limit: 200 });
  const q = trpc.attendance.report.useQuery({
    from: period.from,
    to: period.to,
    employeeId: employeeId ? Number(employeeId) : undefined,
  });

  const rows = q.data?.rows ?? [];
  const totals = q.data?.totals;
  const periodLabel = `${period.from} — ${period.to}`;
  const empName = employeeId
    ? employees.data?.rows.find((e) => e.id === employeeId)?.fullName ?? String(employeeId)
    : "الكل";

  const kpis: KpiItem[] = totals
    ? [
        { label: "عدد الأيام", value: totals.days },
        { label: "حاضر", value: totals.present, tone: "positive" },
        { label: "غائب", value: totals.absent, tone: "negative" },
        { label: "إجمالي الساعات", value: fmtAr(totals.hours), tone: "info" },
        { label: "إجمالي الأجر", value: fmtAr(totals.amount), tone: "warning" },
      ]
    : [];

  function onExport() {
    exportRows(rows, {
      filename: `تقرير-الحضور-${period.from}-${period.to}`,
      columns: [
        { key: "date", header: "التاريخ" },
        { key: "employeeName", header: "الموظف" },
        { key: "status", header: "الحالة" },
        { key: "hours", header: "الساعات", map: (r) => Number(r.hours) },
        { key: "amount", header: "الأجر", map: (r) => Number(r.amount) },
      ],
    });
  }

  function onPrint() {
    printReportDoc({
      title: "تقرير الحضور والانصراف",
      headerExtra: [
        { label: "الفترة", value: periodLabel },
        { label: "الموظف", value: empName },
      ],
      columns: [
        { key: "date", label: "التاريخ" },
        { key: "employeeName", label: "الموظف" },
        { key: "status", label: "الحالة" },
        { key: "hours", label: "الساعات", align: "left" },
        { key: "amount", label: "الأجر", align: "left" },
      ],
      rows: rows.map((r) => ({
        date: r.date,
        employeeName: r.employeeName,
        status: r.status,
        hours: fmtAr(r.hours),
        amount: fmtAr(r.amount),
      })),
      summary: totals
        ? [
            { label: "عدد الأيام", value: String(totals.days) },
            { label: "إجمالي الساعات", value: fmtAr(totals.hours) },
            { label: "إجمالي الأجر", value: fmtAr(totals.amount), large: true, bold: true },
          ]
        : undefined,
    });
  }

  return (
    <ReportShell
      title="تقرير الحضور والانصراف"
      description="سجلّ الحضور اليومي في فترة محدّدة مع إجماليات الساعات والأجر."
      backHref="/reports"
      kpis={kpis}
      onExport={onExport}
      onPrint={onPrint}
      exportDisabled={!rows.length}
      printDisabled={!rows.length}
      filters={
        <div className="flex flex-wrap items-end gap-3">
          <PeriodFilter value={period} onChange={setPeriod} />
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-muted-foreground">الموظف</label>
            <select
              className={selectCls}
              value={employeeId}
              onChange={(e) => setEmployeeId(e.target.value ? Number(e.target.value) : "")}
            >
              <option value="">الكل</option>
              {employees.data?.rows.map((e) => (
                <option key={e.id} value={e.id}>{e.fullName}</option>
              ))}
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
            <p className="p-8 text-center text-sm text-muted-foreground">لا سجلّات حضور في هذا النطاق.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-xs text-muted-foreground">
                    <th className="p-2.5 text-end font-medium">التاريخ</th>
                    <th className="p-2.5 text-end font-medium">الموظف</th>
                    <th className="p-2.5 text-end font-medium">الحالة</th>
                    <th className="p-2.5 text-start font-medium">الساعات</th>
                    <th className="p-2.5 text-start font-medium">الأجر</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i} className="border-b last:border-0 hover:bg-accent/40">
                      <td className="p-2.5 text-right tabular-nums" dir="ltr">{r.date}</td>
                      <td className="p-2.5 text-end">{r.employeeName}</td>
                      <td className="p-2.5 text-end">
                        <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${STATUS_CLS[r.statusKey] ?? "bg-muted"}`}>
                          {r.status}
                        </span>
                      </td>
                      <td className="p-2.5 text-left tabular-nums" dir="ltr">{fmtAr(r.hours)}</td>
                      <td className="p-2.5 text-left tabular-nums" dir="ltr">{fmtAr(r.amount)}</td>
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
