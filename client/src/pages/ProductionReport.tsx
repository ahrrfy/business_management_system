// تقرير الإنتاج — مستندات الإنتاج المؤكَّدة ضمن الفترة: كلفة المواد/العمالة/الهدر/إجمالي الكلفة.
// المصدر: reports.productionReport. عرض + تصدير Excel + طباعة A4 (ReportShell + printReportDoc).
import { useState } from "react";
import { DataTable } from "@/components/data-table/DataTable";
import type { ColumnDef } from "@tanstack/react-table";
import { useMemo } from "react";
import { FilterField } from "@/components/list";
import { AppSelect } from "@/components/ui/AppSelect";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { ReportShell, type KpiItem } from "@/components/reports/ReportShell";
import { PeriodFilter, DEFAULT_PERIOD, type PeriodValue } from "@/components/reports/PeriodFilter";
import { Card, CardContent } from "@/components/ui/card";


import { fmtAr } from "@/lib/money";
import { exportRows } from "@/lib/export";
import { printReportDoc } from "@/lib/printing/reportDoc";

type Row = RouterOutputs["reports"]["productionReport"]["rows"][number];


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
  /** أعمدة تقرير الإنتاج. */
  const productionColumns = useMemo<ColumnDef<Row, unknown>[]>(() => [
    { id: "docNumber", header: "رقم المستند", accessorFn: (r) => r.docNumber ?? "—", meta: { kind: "code" } },
    { id: "date", header: "التاريخ", accessorFn: (r) => r.date, meta: { kind: "date" } },
    {
      id: "branchName", header: "الفرع",
      accessorFn: (r) => r.branchName ?? "—",
      cell: ({ row }) => <span className="text-muted-foreground">{row.original.branchName ?? "—"}</span>,
      meta: { kind: "text" },
    },
    { id: "inputsCost", header: "المواد", accessorFn: (r) => Number(r.inputsCost), cell: ({ row }) => fmtAr(row.original.inputsCost), meta: { kind: "money" } },
    { id: "laborCost", header: "العمالة", accessorFn: (r) => Number(r.laborCost), cell: ({ row }) => fmtAr(row.original.laborCost), meta: { kind: "money" } },
    {
      id: "wasteCost", header: "الهدر",
      accessorFn: (r) => Number(r.wasteCost),
      cell: ({ row }) => <span className="text-money-negative">{fmtAr(row.original.wasteCost)}</span>,
      meta: { kind: "money" },
    },
    {
      id: "totalCost", header: "إجمالي التكلفة",
      accessorFn: (r) => Number(r.totalCost),
      cell: ({ row }) => <span className="font-medium">{fmtAr(row.original.totalCost)}</span>,
      meta: { kind: "money" },
    },
  ], []);

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
          <FilterField label="الفرع">
            <AppSelect value={branchId === "" ? "" : String(branchId)} onValueChange={(v) => setBranchId(v ? Number(v) : "")}>
              <option value="">الكل</option>
              {branches.data?.map((b) => (<option key={b.id} value={b.id}>{b.name}</option>))}
            </AppSelect>
          </FilterField>
        </div>
      }
    >
      <Card>
        <CardContent className="p-0">
          <DataTable
            columns={productionColumns}
            data={rows}
            loading={q.isLoading}
            searchable={false}
            errorState={{ isError: q.isError, message: q.error?.message, onRetry: () => void q.refetch() }}
            emptyText="لا مستندات إنتاج في هذا النطاق."
          />
        </CardContent>
      </Card>
    </ReportShell>
  );
}
