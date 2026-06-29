// تقرير أرصدة الإجازات — لكل موظف نشِط: أيام الإجازات المعتمدة المستهلكة + المعلّقة (قيد الموافقة).
// عرض + تصدير Excel + طباعة A4 (ReportShell + printReportDoc). صلاحية hr/READ خادمياً.
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { ReportShell, type KpiItem } from "@/components/reports/ReportShell";
import { Card, CardContent } from "@/components/ui/card";
import { LoadingState } from "@/components/PageState";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { exportRows } from "@/lib/export";
import { printReportDoc } from "@/lib/printing/reportDoc";

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
      <Card>
        <CardContent className="p-0">
          {q.isLoading ? (
            <LoadingState />
          ) : !rows.length ? (
            <p className="p-8 text-center text-sm text-muted-foreground">لا موظفين نشِطين.</p>
          ) : (
            <ScrollTableShell bordered={false}>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-xs text-muted-foreground">
                    <th className="p-2.5 text-right font-medium">الموظف</th>
                    <th className="p-2.5 text-right font-medium">أيام مستهلكة (معتمدة)</th>
                    <th className="p-2.5 text-right font-medium">أيام معلّقة</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.employeeId} className="border-b last:border-0 hover:bg-accent/40">
                      <td className="p-2.5 text-right">{r.employeeName}</td>
                      <td className="p-2.5 text-right tabular-nums" dir="ltr">{r.usedDays}</td>
                      <td className="p-2.5 text-right tabular-nums text-[var(--stock-low)]" dir="ltr">
                        {r.pendingDays || "—"}
                      </td>
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
