// تقرير أرصدة الإجازات — لكل موظف نشِط: أيام الإجازات المعتمدة المستهلكة + المعلّقة (قيد الموافقة).
// عرض + تصدير Excel + طباعة A4 (ReportShell + printReportDoc). صلاحية hr/READ خادمياً.
import { useMemo } from "react";
import { type ColumnDef } from "@tanstack/react-table";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { ReportShell, type KpiItem } from "@/components/reports/ReportShell";
import { DataTable } from "@/components/data-table/DataTable";
import { ErrorState } from "@/components/PageState";
import { exportRows } from "@/lib/export";
import { printReportDoc } from "@/lib/printing/reportDoc";
import { fmtInt } from "@/lib/money";

type Row = RouterOutputs["leaves"]["balanceReport"]["rows"][number];

export default function LeaveReport() {
  const q = trpc.leaves.balanceReport.useQuery();

  const rows = q.data?.rows ?? [];
  const totalUsed = rows.reduce((acc, r) => acc + r.usedDays, 0);
  const totalPending = rows.reduce((acc, r) => acc + r.pendingDays, 0);

  const kpis: KpiItem[] = rows.length
    ? [
        { label: "عدد الموظفين", value: rows.length },
        { label: "أيام معتمدة مستهلكة", value: totalUsed, tone: "info" },
        { label: "أيام معلّقة", value: totalPending, tone: "warning" },
      ]
    : [];

  // أعمدة DataTable — الأيام بفرزٍ رقميّ (accessorFn ⇒ Number لا فرز نصّيّ)، والمعلّقة بلون
  // تنبيه توكن (text-stock-low) بدل var() الخام + fallback "—" كالأصل.
  const cols = useMemo<ColumnDef<Row>[]>(
    () => [
      { header: "الموظف", accessorKey: "employeeName" },
      {
        id: "usedDays",
        header: "أيام مستهلكة (معتمدة)",
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
    ],
    [],
  );

  function onExport() {
    exportRows(rows, {
      filename: "أرصدة-الإجازات",
      columns: [
        { key: "employeeName", header: "الموظف" },
        { key: "usedDays", header: "أيام مستهلكة (معتمدة)", map: (r) => r.usedDays },
        { key: "pendingDays", header: "أيام معلّقة", map: (r) => r.pendingDays },
      ],
    });
  }

  function onPrint() {
    printReportDoc({
      title: "تقرير أرصدة الإجازات",
      columns: [
        { key: "employeeName", label: "الموظف" },
        { key: "usedDays", label: "أيام مستهلكة (معتمدة)", align: "left" },
        { key: "pendingDays", label: "أيام معلّقة", align: "left" },
      ],
      rows: rows.map((r) => ({
        employeeName: r.employeeName,
        usedDays: String(r.usedDays),
        pendingDays: String(r.pendingDays),
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
      description="الأيام المعتمدة المستهلكة والمعلّقة لكل موظف نشِط."
      backHref="/reports"
      kpis={kpis}
      onExport={onExport}
      onPrint={onPrint}
      exportDisabled={!rows.length}
      printDisabled={!rows.length}
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
