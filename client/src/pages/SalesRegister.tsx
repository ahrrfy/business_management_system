// سجلّ المبيعات المفصّل — كل بنود الفواتير (سطر-سطر) بفلاتر (تاريخ/فرع) + إجماليات + ترقيم صفحات.
// عرض + تصدير Excel + طباعة A4 (ReportShell + printReportDoc). ترقيم صفحات بالخادم (limit/offset).
import { useState } from "react";
import { ActorCell } from "@/components/data-table/ActorCell";
import { ATTRIBUTION_LABELS } from "@shared/uiContracts";
import { AppSelect } from "@/components/ui/AppSelect";
import { Link } from "wouter";
import { Search } from "lucide-react";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { ReportShell, type KpiItem } from "@/components/reports/ReportShell";
import { PeriodFilter, DEFAULT_PERIOD, type PeriodValue } from "@/components/reports/PeriodFilter";
import { Card, CardContent } from "@/components/ui/card";
import { DataTable } from "@/components/data-table/DataTable";
import type { ColumnDef } from "@tanstack/react-table";
import { Input } from "@/components/ui/input";
import { fmtAr } from "@/lib/money";
import { exportRows } from "@/lib/export";
import { fetchAllPaged } from "@/lib/fetchAllRows";
import { printReportDoc } from "@/lib/printing/reportDoc";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";

type Row = RouterOutputs["reports"]["salesRegister"]["rows"][number];

const PAGE = 200;

const columns: ColumnDef<Row, unknown>[] = [
  { id: "invoiceDate", header: "التاريخ", accessorFn: (r) => r.invoiceDate, meta: { kind: "date" }, cell: ({ row }) => row.original.invoiceDate },
  {
    id: "invoiceNumber",
    header: "الفاتورة",
    accessorFn: (r) => r.invoiceNumber,
    meta: { kind: "code" },
    cell: ({ row }) => (
      <Link href={`/invoices/${row.original.invoiceId}`} className="text-primary underline-offset-2 hover:underline">
        {row.original.invoiceNumber}
      </Link>
    ),
  },
  { id: "customerName", header: "العميل", accessorFn: (r) => r.customerName ?? "—", cell: ({ row }) => row.original.customerName ?? "—" },
  {
    id: "soldByName",
    header: ATTRIBUTION_LABELS.performedBy,
    accessorFn: (r) => r.soldByName ?? "",
    meta: { kind: "actor" },
    cell: ({ row }) => <ActorCell actor={{ name: row.original.soldByName }} />,
  },
  { id: "productName", header: "المنتج", accessorFn: (r) => r.productName, meta: { width: "wide" }, cell: ({ row }) => row.original.productName },
  { id: "quantity", header: "الكمية", accessorFn: (r) => fmtAr(r.quantity), meta: { kind: "number" }, cell: ({ row }) => fmtAr(row.original.quantity) },
  {
    id: "unitPrice",
    header: "السعر",
    accessorFn: (r) => fmtAr(r.unitPrice),
    meta: { kind: "money" },
    cell: ({ row }) => <span className="text-muted-foreground">{fmtAr(row.original.unitPrice)}</span>,
  },
  {
    id: "unitCost",
    header: "التكلفة",
    accessorFn: (r) => fmtAr(r.unitCost),
    meta: { kind: "money" },
    cell: ({ row }) => <span className="text-muted-foreground">{fmtAr(row.original.unitCost)}</span>,
  },
  { id: "total", header: "الإجمالي", accessorFn: (r) => fmtAr(r.total), meta: { kind: "money" }, cell: ({ row }) => fmtAr(row.original.total) },
  { id: "profit", header: "الربح", accessorFn: (r) => fmtAr(r.profit), meta: { kind: "money" }, cell: ({ row }) => fmtAr(row.original.profit) },
];

const selectCls =
  "h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export default function SalesRegister() {
  const utils = trpc.useUtils();
  const [period, setPeriod] = useState<PeriodValue>(DEFAULT_PERIOD);
  const [branchId, setBranchId] = useState<number | "">("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [printing, setPrinting] = useState(false);

  const dq = useDebouncedValue(query, 250);
  const branches = trpc.branches.list.useQuery();
  const q = trpc.reports.salesRegister.useQuery({
    from: period.from,
    to: period.to,
    branchId: branchId ? Number(branchId) : undefined,
    q: dq.trim() || undefined,
    limit: PAGE,
    offset: page * PAGE,
  });

  const rows = q.data?.rows ?? [];
  const totals = q.data?.totals;
  const total = q.data?.total ?? 0;

  const kpis: KpiItem[] = totals
    ? [
        { label: "عدد البنود", value: total },
        { label: "إجمالي الإيراد", value: fmtAr(totals.revenue), tone: "info" },
        { label: "إجمالي التكلفة", value: fmtAr(totals.cost), tone: "warning" },
        { label: "صافي الربح", value: fmtAr(totals.profit), tone: Number(totals.profit) < 0 ? "negative" : "positive" },
      ]
    : [];

  const periodLabel = `${period.from} — ${period.to}`;

  // إعادة ضبط الصفحة عند تغيّر الفلاتر.
  function changePeriod(p: PeriodValue) { setPeriod(p); setPage(0); }

  // فلتر الاستعلام الحالي (بلا limit/offset) — يُكرَّر عبر offset لجلب كامل المطابق لا الصفحة فقط
  // (يُستعمل في التصدير والطباعة معاً حتى يبقى المطبوع مطابقاً للمُصدَّر لا الصفحة المعروضة فقط).
  function currentFilter() {
    return {
      from: period.from,
      to: period.to,
      branchId: branchId ? Number(branchId) : undefined,
      q: dq.trim() || undefined,
    };
  }

  async function onExport() {
    setExporting(true);
    try {
      const all = await fetchAllPaged<Row>(
        (offset, limit) =>
          utils.reports.salesRegister
            .fetch({ ...currentFilter(), limit, offset })
            .then((r) => ({ rows: r.rows, total: r.total })),
        { pageSize: 500 },
      );
      exportRows(all, {
        filename: `سجلّ-المبيعات-${period.from}-${period.to}`,
        columns: [
          { key: "invoiceDate", header: "التاريخ" },
          { key: "invoiceNumber", header: "الفاتورة" },
          { key: "customerName", header: "العميل", map: (r) => r.customerName ?? "" },
          { key: "soldByName", header: ATTRIBUTION_LABELS.performedBy, map: (r) => r.soldByName ?? "" },
          { key: "productName", header: "المنتج" },
          { key: "quantity", header: "الكمية", map: (r) => Number(r.quantity) },
          { key: "unitPrice", header: "سعر الوحدة", map: (r) => Number(r.unitPrice) },
          { key: "unitCost", header: "تكلفة الوحدة", map: (r) => Number(r.unitCost) },
          { key: "total", header: "الإجمالي", map: (r) => Number(r.total) },
          { key: "profit", header: "الربح", map: (r) => Number(r.profit) },
        ],
      });
    } finally {
      setExporting(false);
    }
  }

  // الطباعة كانت تطبع الصفحة المعروضة فقط (limit=200) بمظهر تقريرٍ كامل — الآن تجلب كل الصفحات
  // المطابقة للفلتر الحالي (نمط onExport) قبل الطباعة.
  async function onPrint() {
    setPrinting(true);
    try {
      const all = await fetchAllPaged<Row>(
        (offset, limit) =>
          utils.reports.salesRegister
            .fetch({ ...currentFilter(), limit, offset })
            .then((r) => ({ rows: r.rows, total: r.total })),
        { pageSize: 500 },
      );
      printReportDoc({
        title: "سجلّ المبيعات المفصّل",
        headerExtra: [
          { label: "الفترة", value: periodLabel },
          { label: "الفرع", value: branchId ? (branches.data?.find((b) => b.id === branchId)?.name ?? String(branchId)) : "الكل" },
        ],
        columns: [
          { key: "date", label: "التاريخ" },
          { key: "invoice", label: "الفاتورة" },
          { key: "customer", label: "العميل" },
          { key: "soldBy", label: ATTRIBUTION_LABELS.performedBy },
          { key: "product", label: "المنتج" },
          { key: "qty", label: "الكمية", align: "left" },
          { key: "price", label: "السعر", align: "left" },
          { key: "cost", label: "التكلفة", align: "left" },
          { key: "total", label: "الإجمالي", align: "left" },
          { key: "profit", label: "الربح", align: "left" },
        ],
        rows: all.map((r) => ({
          date: r.invoiceDate,
          invoice: r.invoiceNumber,
          customer: r.customerName ?? "—",
          soldBy: r.soldByName ?? "—",
          product: r.productName,
          qty: fmtAr(r.quantity),
          price: fmtAr(r.unitPrice),
          cost: fmtAr(r.unitCost),
          total: fmtAr(r.total),
          profit: fmtAr(r.profit),
        })),
        summary: totals
          ? [
              { label: "إجمالي الإيراد", value: fmtAr(totals.revenue) },
              { label: "إجمالي التكلفة", value: fmtAr(totals.cost) },
              { label: "صافي الربح", value: fmtAr(totals.profit), large: true, bold: true },
            ]
          : undefined,
      });
    } finally {
      setPrinting(false);
    }
  }

  return (
    <ReportShell
      title="سجلّ المبيعات المفصّل"
      description="كل بنود الفواتير سطراً سطراً بفلاتر وتنقّل لمستند المصدر."
      kpis={kpis}
      onExport={onExport}
      onPrint={onPrint}
      exportDisabled={!rows.length || exporting}
      printDisabled={!rows.length || printing}
      filters={
        <div className="flex flex-wrap items-end gap-3">
          <PeriodFilter value={period} onChange={changePeriod} />
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-muted-foreground">الفرع</label>
            <AppSelect className="h-9" value={String(branchId)} onValueChange={(value) => { setBranchId(value ? Number(value) : ""); setPage(0); }}>
              <option value="">الكل</option>
              {branches.data?.map((b) => (<option key={b.id} value={b.id}>{b.name}</option>))}
            </AppSelect>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-muted-foreground">بحث</label>
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 right-2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input
                value={query}
                onChange={(e) => { setQuery(e.target.value); setPage(0); }}
                placeholder="رقم الفاتورة أو العميل أو المنتج…"
                className="h-9 w-56 pr-8"
              />
            </div>
          </div>
        </div>
      }
    >
      <Card>
        <CardContent className="p-0">
          {/* الترقيم خادميّ (limit/offset) ⇒ يُدار داخل الجدول بشريطٍ واحد؛ الشريط المنفصل
              الذي كان تحت البطاقة حُذف كي لا يقفز ترقيمان بمقدارَين فتُتخطّى صفوفٌ صامتاً.
              والبحث في شريط الفلاتر أعلاه (يغذّي الاستعلام) ⇒ لا بحثَ داخليّ. */}
          <DataTable<Row>
            columns={columns}
            data={rows}
            searchable={false}
            externalFiltersActive={dq.trim() !== ""}
            loading={q.isLoading}
            errorState={{ isError: q.isError, message: "تعذّر تحميل التقرير.", onRetry: () => void q.refetch() }}
            emptyText="لا مبيعات في هذا النطاق."
            serverPagination={{ page, onPageChange: setPage, pageSize: PAGE, total, isFetching: q.isFetching }}
          />
        </CardContent>
      </Card>
    </ReportShell>
  );
}
