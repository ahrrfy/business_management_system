// تقرير الحضور والانصراف — صفوف الحضور في نطاق فترة + فلتر موظف اختياري، مع إجماليات (أيام/ساعات/أجر).
// عرض + تصدير Excel + طباعة A4 (ReportShell + printReportDoc). يكشف الأجور ⇒ صلاحية hr/READ خادمياً.
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

type Row = RouterOutputs["attendance"]["report"]["rows"][number];

const STATUS_CLS: Record<string, string> = {
  PRESENT: "badge-status-active",
  ABSENT: "badge-stock-out",
  LATE: "badge-status-pending",
  LEAVE: "badge-status-pending",
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

  // أعمدة DataTable — التاريخ نصّي LTR (يُفرز صحيحاً أبجدياً لصيغة YYYY-MM-DD)، الحالة شارةٌ
  // ملوّنة بتوكنز badge-status-*/badge-stock-out حسب statusKey، والساعات/الأجر بفرزٍ رقميّ.
  const cols = useMemo<ColumnDef<Row>[]>(
    () => [
      {
        header: "التاريخ",
        accessorKey: "date",
        cell: ({ row }) => <span dir="ltr" className="tabular-nums">{row.original.date}</span>,
      },
      { header: "الموظف", accessorKey: "employeeName" },
      {
        header: "الحالة",
        accessorKey: "status",
        cell: ({ row }) => (
          <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${STATUS_CLS[row.original.statusKey] ?? "bg-muted"}`}>
            {row.original.status}
          </span>
        ),
      },
      {
        id: "hours",
        header: "الساعات",
        accessorFn: (r) => Number(r.hours),
        cell: ({ row }) => <span dir="ltr" className="tabular-nums">{fmtAr(row.original.hours)}</span>,
      },
      {
        id: "amount",
        header: "الأجر",
        accessorFn: (r) => Number(r.amount),
        cell: ({ row }) => <span dir="ltr" className="tabular-nums">{fmtAr(row.original.amount)}</span>,
      },
    ],
    [],
  );

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
      {q.isError ? (
        <ErrorState message="تعذّر تحميل التقرير." onRetry={() => void q.refetch()} />
      ) : (
        <DataTable
          columns={cols}
          data={rows}
          loading={q.isLoading}
          emptyText="لا سجلّات حضور في هذا النطاق."
          pageSize={Infinity}
        />
      )}
    </ReportShell>
  );
}
