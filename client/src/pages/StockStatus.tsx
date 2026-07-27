// حالة المخزون / إعادة الطلب — رصيد كل (متغيّر × فرع) مقابل حدّ إعادة الطلب minStock (للقراءة فقط).
// عرض + تصدير Excel + طباعة A4 (ReportShell + printReportDoc). فلتر فرع + مفتاح «التنبيهات فقط».
// الجدول عبر DataTable المشترك (فرز بنقرة + بحث + هيكل تحميل) — البيانات محلّية فالفرز كامل لا صفحيّ.
// الحالة: نفد (qty<=0) · منخفض (qty<=minStock و minStock>0) · طبيعي.
import { useMemo, useState } from "react";
import { type ColumnDef } from "@tanstack/react-table";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { ReportShell, type KpiItem } from "@/components/reports/ReportShell";
import { DataTable } from "@/components/data-table/DataTable";
import { ErrorState } from "@/components/PageState";
import { exportRows } from "@/lib/export";
import { printReportDoc } from "@/lib/printing/reportDoc";
import { fmtInt } from "@/lib/money";
import { fmtDate } from "@/lib/date";

type Row = RouterOutputs["reports"]["stockStatus"]["rows"][number];

const STATUS_LABEL: Record<string, string> = { out: "نفد", low: "منخفض", ok: "طبيعي" };
const STATUS_CLS: Record<string, string> = {
  out: "badge-stock-out",
  low: "badge-stock-low",
  ok: "bg-muted text-muted-foreground",
};
const selectCls =
  "h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export default function StockStatus() {
  const [branchId, setBranchId] = useState<number | "">("");
  const [onlyAlerts, setOnlyAlerts] = useState(false);
  const branches = trpc.branches.list.useQuery();
  const q = trpc.reports.stockStatus.useQuery({
    branchId: branchId ? Number(branchId) : undefined,
    onlyAlerts: onlyAlerts || undefined,
  });

  const rows = q.data?.rows ?? [];
  const totals = q.data?.totals;

  const kpis: KpiItem[] = totals
    ? [
        { label: "نفد من المخزون", value: fmtInt(totals.outCount), tone: "negative" },
        { label: "مخزون منخفض", value: fmtInt(totals.lowCount), tone: "warning" },
        { label: "عدد السطور", value: fmtInt(rows.length), tone: "info" },
      ]
    : [];

  const branchLabel = branchId ? (branches.data?.find((b) => b.id === branchId)?.name ?? String(branchId)) : "الكل";

  // أعمدة DataTable — الكمية/الحدّ بفرزٍ رقميّ (accessorFn ⇒ Number لا فرز نصّيّ)، والحالة شارةٌ
  // ملوّنة بتوكنز المخزون (لا ألوان خام). البيانات محلّية ⇒ الفرز والبحث يشملان كل الصفوف.
  const cols = useMemo<ColumnDef<Row>[]>(
    () => [
      { header: "المنتج", accessorKey: "productName" },
      {
        header: "المتغيّر",
        accessorKey: "variantLabel",
        cell: ({ row }) => <span className="text-muted-foreground">{row.original.variantLabel}</span>,
      },
      {
        header: "الفرع",
        accessorKey: "branchName",
        cell: ({ row }) => <span className="text-muted-foreground">{row.original.branchName ?? "—"}</span>,
      },
      {
        id: "quantity",
        header: "الكمية",
        accessorFn: (r) => Number(r.quantity),
        cell: ({ row }) => (
          <span dir="ltr" className="tabular-nums">{fmtInt(row.original.quantity)}</span>
        ),
      },
      {
        id: "minStock",
        header: "حدّ إعادة الطلب",
        accessorFn: (r) => Number(r.minStock),
        cell: ({ row }) => (
          <span dir="ltr" className="tabular-nums text-muted-foreground">{fmtInt(row.original.minStock)}</span>
        ),
      },
      {
        header: "الحالة",
        accessorKey: "status",
        cell: ({ row }) => (
          <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${STATUS_CLS[row.original.status] ?? "bg-muted"}`}>
            {STATUS_LABEL[row.original.status] ?? row.original.status}
          </span>
        ),
      },
    ],
    [],
  );

  function onExport() {
    exportRows(rows, {
      filename: `حالة-المخزون${onlyAlerts ? "-تنبيهات" : ""}${branchId ? `-${branchLabel}` : ""}`,
      columns: [
        { key: "productName", header: "المنتج" },
        { key: "variantLabel", header: "المتغيّر" },
        { key: "branchName", header: "الفرع", map: (r) => r.branchName ?? "" },
        { key: "quantity", header: "الكمية", map: (r) => r.quantity },
        { key: "minStock", header: "حدّ إعادة الطلب", map: (r) => r.minStock },
        { key: "status", header: "الحالة", map: (r) => STATUS_LABEL[r.status] ?? r.status },
      ],
    });
  }

  function onPrint() {
    printReportDoc({
      title: "حالة المخزون / إعادة الطلب",
      headerExtra: [
        { label: "كما في", value: fmtDate(new Date()) },
        { label: "الفرع", value: branchLabel },
        { label: "النطاق", value: onlyAlerts ? "التنبيهات فقط" : "الكل" },
      ],
      columns: [
        { key: "product", label: "المنتج" },
        { key: "variant", label: "المتغيّر" },
        { key: "branch", label: "الفرع" },
        { key: "qty", label: "الكمية", align: "left" },
        { key: "min", label: "حدّ إعادة الطلب", align: "left" },
        { key: "status", label: "الحالة" },
      ],
      rows: rows.map((r) => ({
        product: r.productName,
        variant: r.variantLabel,
        branch: r.branchName ?? "—",
        qty: fmtInt(r.quantity),
        min: fmtInt(r.minStock),
        status: STATUS_LABEL[r.status] ?? r.status,
      })),
      summary: totals
        ? [
            { label: "نفد من المخزون", value: fmtInt(totals.outCount) },
            { label: "مخزون منخفض", value: fmtInt(totals.lowCount), large: true, bold: true },
          ]
        : undefined,
    });
  }

  return (
    <ReportShell
      title="حالة المخزون / إعادة الطلب"
      description="رصيد كل منتج مقابل حدّ إعادة الطلب مع تمييز النواقص."
      kpis={kpis}
      onExport={onExport}
      onPrint={onPrint}
      exportDisabled={!rows.length}
      printDisabled={!rows.length}
      filters={
        <div className="flex flex-wrap items-end gap-4">
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-muted-foreground">الفرع</label>
            <select className={selectCls} value={branchId} onChange={(e) => setBranchId(e.target.value ? Number(e.target.value) : "")}>
              <option value="">الكل</option>
              {branches.data?.map((b) => (<option key={b.id} value={b.id}>{b.name}</option>))}
            </select>
          </div>
          <label className="flex h-9 cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-4 rounded border-input"
              checked={onlyAlerts}
              onChange={(e) => setOnlyAlerts(e.target.checked)}
            />
            <span>التنبيهات فقط</span>
          </label>
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
          emptyText={onlyAlerts ? "لا تنبيهات في هذا النطاق." : "لا مخزون في هذا النطاق."}
          searchPlaceholder="ابحث بالمنتج/المتغيّر…"
          pageSize={Infinity}
        />
      )}
    </ReportShell>
  );
}
