// تقرير أرصدة الإجازات — لكل موظف نشِط: أيام الإجازات المعتمدة المستهلكة والمعلّقة **ضمن سنةٍ
// محدَّدة** (افتراضياً السنة الحالية كاملةً — لا مدى ضيّق) + الرصيد المتبقي الحالي (سنوية/مرضية).
// عرض + تصدير Excel + طباعة A4 (ReportShell + printReportDoc). صلاحية hr/READ خادمياً.
import { useMemo, useState } from "react";
import { type ColumnDef } from "@tanstack/react-table";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { ReportShell, type KpiItem } from "@/components/reports/ReportShell";
import { DataTable } from "@/components/data-table/DataTable";
import { ErrorState } from "@/components/PageState";
import { Button } from "@/components/ui/button";
import { exportRows } from "@/lib/export";
import { printReportDoc } from "@/lib/printing/reportDoc";
import { fmtInt } from "@/lib/money";
import { ChevronLeft, ChevronRight } from "lucide-react";

type Row = RouterOutputs["leaves"]["balanceReport"]["rows"][number];

const CURRENT_YEAR = new Date().getUTCFullYear();

export default function LeaveReport() {
  const [year, setYear] = useState(CURRENT_YEAR);
  const q = trpc.leaves.balanceReport.useQuery({ year });

  const rows = q.data?.rows ?? [];
  const totalUsed = rows.reduce((acc, r) => acc + r.usedDays, 0);
  const totalPending = rows.reduce((acc, r) => acc + r.pendingDays, 0);
  const totalAnnualRemaining = rows.reduce((acc, r) => acc + (r.annualLeaveBalance ?? 0), 0);

  const kpis: KpiItem[] = rows.length
    ? [
        { label: "عدد الموظفين", value: rows.length },
        { label: `أيام معتمدة مستهلكة (${year})`, value: totalUsed, tone: "info" },
        { label: "أيام معلّقة", value: totalPending, tone: "warning" },
        { label: "الرصيد السنوي المتبقي (إجمالي)", value: totalAnnualRemaining, tone: "positive" },
      ]
    : [];

  // أعمدة DataTable — الأيام بفرزٍ رقميّ (accessorFn ⇒ Number لا فرز نصّيّ)، والمعلّقة بلون
  // تنبيه توكن (text-stock-low) بدل var() الخام + fallback "—" كالأصل.
  const cols = useMemo<ColumnDef<Row>[]>(
    () => [
      { header: "الموظف", accessorKey: "employeeName" },
      { header: "القسم", accessorFn: (r) => r.department ?? "—" },
      {
        id: "usedDays",
        header: `أيام مستهلكة (معتمدة، ${year})`,
        accessorFn: (r) => Number(r.usedDays),
        cell: ({ row }) => <span dir="ltr" className="tabular-nums">{fmtInt(row.original.usedDays)}</span>,
      },
      {
        id: "pendingDays",
        header: "أيام معلّقة",
        accessorFn: (r) => Number(r.pendingDays),
        cell: ({ row }) => (
          <span dir="ltr" className="tabular-nums text-stock-low">
            {row.original.pendingDays ? fmtInt(row.original.pendingDays) : "—"}
          </span>
        ),
      },
      {
        id: "annualLeaveBalance",
        header: "الرصيد السنوي المتبقي",
        accessorFn: (r) => Number(r.annualLeaveBalance ?? 0),
        cell: ({ row }) => <span dir="ltr" className="tabular-nums">{fmtInt(row.original.annualLeaveBalance ?? 0)}</span>,
      },
      {
        id: "sickLeaveBalance",
        header: "الرصيد المرضي المتبقي",
        accessorFn: (r) => Number(r.sickLeaveBalance ?? 0),
        cell: ({ row }) => <span dir="ltr" className="tabular-nums">{fmtInt(row.original.sickLeaveBalance ?? 0)}</span>,
      },
    ],
    [year],
  );

  function onExport() {
    exportRows(rows, {
      filename: `أرصدة-الإجازات-${year}`,
      columns: [
        { key: "employeeName", header: "الموظف" },
        { key: "department", header: "القسم", map: (r) => r.department ?? "" },
        { key: "usedDays", header: "أيام مستهلكة (معتمدة)", map: (r) => r.usedDays },
        { key: "pendingDays", header: "أيام معلّقة", map: (r) => r.pendingDays },
        { key: "annualLeaveBalance", header: "الرصيد السنوي المتبقي", map: (r) => r.annualLeaveBalance ?? 0 },
        { key: "sickLeaveBalance", header: "الرصيد المرضي المتبقي", map: (r) => r.sickLeaveBalance ?? 0 },
      ],
    });
  }

  function onPrint() {
    printReportDoc({
      title: `تقرير أرصدة الإجازات — سنة ${year}`,
      columns: [
        { key: "employeeName", label: "الموظف" },
        { key: "department", label: "القسم" },
        { key: "usedDays", label: "أيام مستهلكة (معتمدة)", align: "left" },
        { key: "pendingDays", label: "أيام معلّقة", align: "left" },
        { key: "annualLeaveBalance", label: "الرصيد السنوي المتبقي", align: "left" },
        { key: "sickLeaveBalance", label: "الرصيد المرضي المتبقي", align: "left" },
      ],
      rows: rows.map((r) => ({
        employeeName: r.employeeName,
        department: r.department ?? "—",
        usedDays: String(r.usedDays),
        pendingDays: String(r.pendingDays),
        annualLeaveBalance: String(r.annualLeaveBalance ?? 0),
        sickLeaveBalance: String(r.sickLeaveBalance ?? 0),
      })),
      summary: [
        { label: "إجمالي المستهلك", value: String(totalUsed) },
        { label: "إجمالي المعلّق", value: String(totalPending), large: true, bold: true },
      ],
    });
  }

  return (
    <ReportShell
      title="تقرير أرصدة الإجازات"
      description="الأيام المعتمدة المستهلكة والمعلّقة لكل موظف نشِط ضمن السنة المحدَّدة، والرصيد المتبقي الحالي."
      backHref="/reports"
      kpis={kpis}
      onExport={onExport}
      onPrint={onPrint}
      exportDisabled={!rows.length}
      printDisabled={!rows.length}
      filters={
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground ms-1">السنة</span>
          <Button variant="outline" size="icon" className="size-8" onClick={() => setYear((y) => y - 1)} aria-label="السنة السابقة">
            <ChevronRight className="size-4" aria-hidden />
          </Button>
          <span className="min-w-12 text-center font-bold tabular-nums" dir="ltr">{year}</span>
          <Button
            variant="outline"
            size="icon"
            className="size-8"
            disabled={year >= CURRENT_YEAR}
            onClick={() => setYear((y) => Math.min(CURRENT_YEAR, y + 1))}
            aria-label="السنة التالية"
          >
            <ChevronLeft className="size-4" aria-hidden />
          </Button>
          {year !== CURRENT_YEAR && (
            <Button variant="ghost" size="sm" onClick={() => setYear(CURRENT_YEAR)}>السنة الحالية</Button>
          )}
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
          emptyText="لا موظفين نشِطين."
          pageSize={Infinity}
        />
      )}
    </ReportShell>
  );
}
