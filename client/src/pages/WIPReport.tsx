/**
 * تقرير WIP (Work-in-Progress) — قيمة المواد المُستهلَكة في طلبات خدمة قيد التنفيذ.
 * managerBranchScopedProcedure.
 */
import { workOrderStatusLabel } from "@shared/workOrderStatus";
import { DataTable } from "@/components/data-table/DataTable";
import type { ColumnDef } from "@tanstack/react-table";
import { useMemo } from "react";

import { trpc } from "@/lib/trpc";
import { fmtDate } from "@/lib/date";
import { fmtAr, formatIqd } from "@/lib/money";
import { ReportShell, type KpiItem } from "@/components/reports/ReportShell";
import { AppSelect } from "@/components/ui/AppSelect";
import { FilterField } from "@/components/list";

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
  /** أعمدة أوامر الشغل قيد التنفيذ. */
  const wipColumns = useMemo<ColumnDef<(typeof rows)[number], unknown>[]>(() => [
    { id: "orderNumber", header: "رقم الأمر", accessorFn: (r) => r.orderNumber, meta: { kind: "code" } },
    { id: "customerName", header: "العميل", accessorFn: (r) => r.customerName ?? "—", meta: { kind: "text", wrap: true } },
    {
      id: "status", header: "الحالة",
      accessorFn: (r) => workOrderStatusLabel(r.status),
      meta: { kind: "status" },
    },
    {
      id: "materialsCost", header: "قيمة المواد",
      accessorFn: (r) => Number(r.materialsCost),
      cell: ({ row }) => <span className="font-semibold">{formatIqd(row.original.materialsCost)}</span>,
      meta: { kind: "money" },
    },
    {
      id: "createdAt", header: "تاريخ الإنشاء",
      accessorFn: (r) => String(r.createdAt ?? ""),
      cell: ({ row }) => <span className="text-muted-foreground">{fmtDate(row.original.createdAt)}</span>,
      meta: { kind: "date" },
    },
  ], []);

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
      <DataTable
        columns={wipColumns}
        data={rows}
        loading={wip.isLoading}
        searchable={false}
        errorState={{ isError: wip.isError, message: wip.error?.message, onRetry: () => void wip.refetch() }}
        emptyText="لا طلبات خدمة قيد التنفيذ"
      />
    </ReportShell>
  );
}
