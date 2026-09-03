// تقييم المخزون بالتكلفة حسب الفئة — قيمة الرصيد الحالي مجمّعةً (للقراءة فقط).
// عرض + تصدير Excel + طباعة A4 (ReportShell + printReportDoc). فلتر فرع.
// ⚠️ القيمة بالتكلفة (آخر تكلفة، قرار المالك)؛ الكمية بالوحدة الأساس.
import { useState } from "react";
import { DataTable } from "@/components/data-table/DataTable";
import type { ColumnDef } from "@tanstack/react-table";
import { useMemo } from "react";
import { FilterField } from "@/components/list";
import { AppSelect } from "@/components/ui/AppSelect";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { ReportShell, type KpiItem } from "@/components/reports/ReportShell";
import { Card, CardContent } from "@/components/ui/card";

import { fmtAr, fmtInt } from "@/lib/money";
import { fmtDate } from "@/lib/date";
import { exportRows } from "@/lib/export";
import { printReportDoc } from "@/lib/printing/reportDoc";

type Row = RouterOutputs["reports"]["inventoryValuation"]["rows"][number];

const NOTE =
  "القيمة بالتكلفة (آخر تكلفة) لكل وحدة أساس × الكمية الحالية في المخزون؛ الكمية بالوحدة الأساس. لقطة لحظية للرصيد الحالي.";

export default function InventoryValuation() {
  const [branchId, setBranchId] = useState<number | "">("");
  const branches = trpc.branches.list.useQuery();
  const q = trpc.reports.inventoryValuation.useQuery({ branchId: branchId ? Number(branchId) : undefined });

  const rows = q.data?.rows ?? [];
  const totals = q.data?.totals;

  const kpis: KpiItem[] = totals
    ? [
        { label: "عدد المنتجات", value: totals.items, tone: "info" },
        { label: "إجمالي الكمية", value: fmtInt(totals.totalQty) },
        { label: "إجمالي القيمة (بالتكلفة)", value: fmtAr(totals.totalValue), tone: "positive" },
      ]
    : [];

  const branchLabel = branchId ? (branches.data?.find((b) => b.id === branchId)?.name ?? String(branchId)) : "الكل";

  function onExport() {
    exportRows(rows, {
      filename: `تقييم-المخزون${branchId ? `-${branchLabel}` : ""}`,
      columns: [
        { key: "categoryName", header: "الفئة" },
        { key: "items", header: "عدد المنتجات", map: (r) => r.items },
        { key: "totalQty", header: "إجمالي الكمية", map: (r) => r.totalQty },
        { key: "totalValue", header: "القيمة بالتكلفة", map: (r) => Number(r.totalValue) },
      ],
    });
  }

  function onPrint() {
    printReportDoc({
      title: "تقييم المخزون بالتكلفة",
      headerExtra: [
        { label: "كما في", value: fmtDate(new Date()) },
        { label: "الفرع", value: branchLabel },
      ],
      note: NOTE,
      columns: [
        { key: "category", label: "الفئة" },
        { key: "items", label: "عدد المنتجات", align: "left" },
        { key: "qty", label: "إجمالي الكمية", align: "left" },
        { key: "value", label: "القيمة بالتكلفة", align: "left" },
      ],
      rows: rows.map((r) => ({
        category: r.categoryName,
        items: String(r.items),
        qty: fmtInt(r.totalQty),
        value: fmtAr(r.totalValue),
      })),
      summary: totals
        ? [
            { label: "عدد المنتجات", value: String(totals.items) },
            { label: "إجمالي الكمية", value: fmtInt(totals.totalQty) },
            { label: "إجمالي القيمة (بالتكلفة)", value: fmtAr(totals.totalValue), large: true, bold: true },
          ]
        : undefined,
    });
  }
  /** أعمدة تقييم المخزون + ذيل الإجماليات (دعم tfoot في DataTable). */
  const valuationColumns = useMemo<ColumnDef<Row, unknown>[]>(() => [
    {
      id: "categoryName", header: "الفئة",
      accessorFn: (r) => r.categoryName,
      footer: () => (totals ? "الإجمالي" : null),
      meta: { kind: "text", wrap: true },
    },
    {
      id: "items", header: "عدد المنتجات",
      accessorFn: (r) => Number(r.items),
      cell: ({ row }) => fmtInt(row.original.items),
      footer: () => (totals ? fmtInt(totals.items) : null),
      meta: { kind: "number" },
    },
    {
      id: "totalQty", header: "إجمالي الكمية",
      accessorFn: (r) => Number(r.totalQty),
      cell: ({ row }) => fmtInt(row.original.totalQty),
      footer: () => (totals ? fmtInt(totals.totalQty) : null),
      meta: { kind: "number" },
    },
    {
      id: "totalValue", header: "القيمة بالتكلفة",
      accessorFn: (r) => Number(r.totalValue),
      cell: ({ row }) => <span className="font-medium">{fmtAr(row.original.totalValue)}</span>,
      footer: () => (totals ? fmtAr(totals.totalValue) : null),
      meta: { kind: "money" },
    },
  ], [totals]);

  return (
    <ReportShell
      title="تقييم المخزون بالتكلفة"
      description="قيمة الرصيد الحالي مجمّعةً حسب الفئة."
      note={NOTE}
      kpis={kpis}
      onExport={onExport}
      onPrint={onPrint}
      exportDisabled={!rows.length}
      printDisabled={!rows.length}
      filters={
        <FilterField label="الفرع">
          <AppSelect value={branchId === "" ? "" : String(branchId)} onValueChange={(v) => setBranchId(v ? Number(v) : "")}>
            <option value="">الكل</option>
            {branches.data?.map((b) => (<option key={b.id} value={b.id}>{b.name}</option>))}
          </AppSelect>
        </FilterField>
      }
    >
      <Card>
        <CardContent className="p-0">
          <DataTable
            columns={valuationColumns}
            data={rows}
            loading={q.isLoading}
            searchable={false}
            errorState={{ isError: q.isError, message: "تعذّر تحميل التقرير.", onRetry: () => void q.refetch() }}
            emptyText="لا مخزون في هذا النطاق."
          />
        </CardContent>
      </Card>
    </ReportShell>
  );
}
