/**
 * تقرير WIP (Work-in-Progress) — قيمة المواد المُستهلَكة في طلبات خدمة قيد التنفيذ.
 * managerBranchScopedProcedure.
 */
import { workOrderStatusLabel } from "@shared/workOrderStatus";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { trpc } from "@/lib/trpc";
import { fmtDate } from "@/lib/date";
import { fmtAr, formatIqd } from "@/lib/money";
import { ReportShell, type KpiItem } from "@/components/reports/ReportShell";
import { AppSelect } from "@/components/ui/AppSelect";
import { FilterField } from "@/components/list";
import { ErrorState, TableEmptyRow } from "@/components/PageState";
import { exportRows } from "@/lib/export";
import { printReportDoc } from "@/lib/printing/reportDoc";
import { useState } from "react";


export default function WIPReportPage() {
  const branches = trpc.branches.list.useQuery();
  const [branchId, setBranchId] = useState<number | null>(null);
  const wip = trpc.reports.wipReport.useQuery({ branchId: branchId ?? undefined });

  const rows = wip.data?.rows ?? [];
  const branchLabel = branchId
    ? (branches.data?.find((b) => Number(b.id) === branchId)?.name ?? String(branchId))
    : "الكل";

  const kpis: KpiItem[] = wip.data
    ? [
        { label: "إجمالي الأوامر", value: wip.data.totalCount },
        { label: "قيمة WIP الإجمالية", value: formatIqd(wip.data.totalMaterialsCost), tone: "warning" },
      ]
    : [];

  function onExport() {
    exportRows(rows, {
      filename: "الإنتاج-تحت-التنفيذ-WIP",
      title: "الإنتاج تحت التنفيذ (WIP)",
      meta: [{ label: "الفرع", value: branchLabel }],
      columns: [
        { key: "orderNumber", header: "رقم الأمر" },
        { key: "customerName", header: "العميل", map: (r) => r.customerName ?? "—" },
        { key: "status", header: "الحالة", map: (r) => workOrderStatusLabel(r.status) },
        { key: "materialsCost", header: "قيمة المواد", money: true, map: (r) => Number(r.materialsCost) },
        { key: "createdAt", header: "تاريخ الإنشاء", map: (r) => fmtDate(r.createdAt) },
      ],
    });
  }

  function onPrint() {
    printReportDoc({
      title: "الإنتاج تحت التنفيذ (WIP)",
      headerExtra: [{ label: "الفرع", value: branchLabel }],
      columns: [
        { key: "orderNumber", label: "رقم الأمر" },
        { key: "customerName", label: "العميل" },
        { key: "status", label: "الحالة" },
        { key: "materialsCost", label: "قيمة المواد", align: "left" },
        { key: "createdAt", label: "تاريخ الإنشاء" },
      ],
      rows: rows.map((r) => ({
        orderNumber: r.orderNumber,
        customerName: r.customerName ?? "—",
        status: workOrderStatusLabel(r.status),
        materialsCost: fmtAr(r.materialsCost),
        createdAt: fmtDate(r.createdAt),
      })),
      summary: wip.data
        ? [{ label: "قيمة WIP الإجمالية", value: formatIqd(wip.data.totalMaterialsCost), large: true, bold: true }]
        : undefined,
    });
  }

  return (
    <ReportShell
      title="الإنتاج تحت التنفيذ (WIP)"
      description="المواد المُستهلَكة في طلبات خدمة لم تُسلَّم بعد — قيمة معلَّقة بين «المخزون» و«تكلفة المبيع» (تدخل ضمن تكلفة المبيعات عند التسليم)."
      kpis={kpis}
      onExport={onExport}
      onPrint={onPrint}
      exportDisabled={!rows.length}
      printDisabled={!rows.length}
      filters={
        <FilterField label="الفرع" className="w-48">
          <AppSelect
            value={branchId != null ? String(branchId) : ""}
            onValueChange={(v) => setBranchId(v ? Number(v) : null)}
          >
            <option value="">كل الفروع</option>
            {branches.data?.map((b: any) => (
              <option key={b.id} value={b.id}>{b.name} ({b.code})</option>
            ))}
          </AppSelect>
        </FilterField>
      }
    >
      {wip.isError ? (
        <ErrorState message={wip.error.message} onRetry={() => wip.refetch()} />
      ) : (
        <ScrollTableShell bordered={false}>
          <table className="w-full text-sm border-collapse">
            <thead className="bg-muted">
              <tr>
                <th className="text-right p-2 border">رقم الأمر</th>
                <th className="text-right p-2 border">العميل</th>
                <th className="text-right p-2 border">الحالة</th>
                <th className="text-right p-2 border">قيمة المواد</th>
                <th className="text-right p-2 border">تاريخ الإنشاء</th>
              </tr>
            </thead>
            <tbody>
              {wip.isLoading ? (
                <tr><td colSpan={5} className="p-6 text-center text-muted-foreground">جارٍ التحميل…</td></tr>
              ) : rows.length === 0 ? (
                <TableEmptyRow colSpan={5} message="لا طلبات خدمة قيد التنفيذ" />
              ) : (
                rows.map((r) => (
                  <tr key={r.workOrderId} className="hover:bg-accent/40">
                    <td className="p-2 border font-mono">{r.orderNumber}</td>
                    <td className="p-2 border">{r.customerName ?? "—"}</td>
                    <td className="p-2 border">{workOrderStatusLabel(r.status)}</td>
                    <td className="p-2 border font-semibold">{formatIqd(r.materialsCost)}</td>
                    <td className="p-2 border text-muted-foreground">{fmtDate(r.createdAt)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </ScrollTableShell>
      )}
    </ReportShell>
  );
}
