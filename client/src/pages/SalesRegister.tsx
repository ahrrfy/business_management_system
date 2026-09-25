// سجلّ المبيعات المفصّل — كل بنود الفواتير (سطر-سطر) بفلاتر (تاريخ/فرع) + إجماليات + ترقيم صفحات.
// عرض + تصدير Excel + طباعة A4 (ReportShell + printReportDoc). ترقيم صفحات بالخادم (limit/offset).
import { useMemo, useState } from "react";
import { ActorCell } from "@/components/data-table/ActorCell";
import { ATTRIBUTION_LABELS } from "@shared/uiContracts";
import { AppSelect } from "@/components/ui/AppSelect";
import { Link, useLocation } from "wouter";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { ReportShell, type KpiItem } from "@/components/reports/ReportShell";
import { PeriodFilter, DEFAULT_PERIOD, type PeriodValue } from "@/components/reports/PeriodFilter";
import { Card, CardContent } from "@/components/ui/card";
import { DataTable } from "@/components/data-table/DataTable";
import { StackedEntityCell } from "@/components/data-table/StackedEntityCell";
import type { ColumnDef } from "@tanstack/react-table";
import { UnifiedSearchInput } from "@/components/search/UnifiedSearchInput";
import { D, fmtAr } from "@/lib/money";
import { exportRows } from "@/lib/export";
import { fetchAllPaged } from "@/lib/fetchAllRows";
import { printReportDoc } from "@/lib/printing/reportDoc";

type Row = RouterOutputs["reports"]["salesRegister"]["rows"][number];

const PAGE = 200;

const selectCls =
  "h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export default function SalesRegister() {
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const [period, setPeriod] = useState<PeriodValue>(DEFAULT_PERIOD);
  const [branchId, setBranchId] = useState<number | "">("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [printing, setPrinting] = useState(false);

  const columns = useMemo<ColumnDef<Row, unknown>[]>(
    () => [
      { id: "invoiceDate", header: "التاريخ", accessorFn: (r) => r.invoiceDate, meta: { kind: "date" }, cell: ({ row }) => row.original.invoiceDate },
      {
        id: "customerAndInvoice",
        header: "العميل / الفاتورة",
        accessorFn: (r) => [r.customerName ?? "—", r.invoiceNumber].filter(Boolean).join(" · "),
        meta: { width: "stacked" },
        cell: ({ row }) => (
          <StackedEntityCell
            primary={row.original.customerName ?? "—"}
            primaryTitle={row.original.customerName ?? undefined}
            secondary={row.original.invoiceNumber}
            secondaryTitle="فتح تفاصيل الفاتورة"
            onSecondaryClick={
              row.original.invoiceId
                ? () => {
                    navigate(`/invoices/${row.original.invoiceId}`);
                  }
                : undefined
            }
            copyValue={row.original.invoiceNumber}
            copyTitle="نسخ رقم الفاتورة"
          />
        ),
      },
      {
        id: "soldByName",
        header: ATTRIBUTION_LABELS.performedBy,
        accessorFn: (r) => r.soldByName ?? "",
        meta: { kind: "actor" },
        cell: ({ row }) => <ActorCell actor={{ name: row.original.soldByName }} />,
      },
      { id: "productName", header: "المنتج", accessorFn: (r) => r.productName, meta: { width: "wide" }, cell: ({ row }) => row.original.productName },
      {
        id: "quantityAndPrice",
        header: "الكمية / السعر",
        accessorFn: (r) => `${fmtAr(r.quantity)} × ${fmtAr(r.unitPrice)}`,
        meta: { kind: "money" },
        sortDescFirst: true,
        sortingFn: (a, b) => D(a.original.quantity || 0).cmp(D(b.original.quantity || 0)),
        cell: ({ row }) => (
          <div className="flex flex-col items-end gap-0.5">
            <span className="font-semibold tabular-nums" dir="ltr">
              {fmtAr(row.original.quantity)}
            </span>
            <span
              className="text-[11px] text-muted-foreground tabular-nums"
              title={`سعر البيع: ${fmtAr(row.original.unitPrice)}`}
            >
              بسعر {fmtAr(row.original.unitPrice)}
            </span>
          </div>
        ),
      },
      { id: "total", header: "الإجمالي", accessorFn: (r) => fmtAr(r.total), meta: { kind: "money" }, cell: ({ row }) => fmtAr(row.original.total) },
      {
        id: "costAndProfit",
        header: "الربح / التكلفة",
        accessorFn: (r) => `${fmtAr(r.profit)} (تكلفة: ${fmtAr(r.unitCost)})`,
        meta: { kind: "money" },
        sortDescFirst: true,
        sortingFn: (a, b) => D(a.original.profit || 0).cmp(D(b.original.profit || 0)),
        cell: ({ row }) => {
          const p = Number(row.original.profit);
          const isPos = p > 0;
          const isNeg = p < 0;
          return (
            <div className="flex flex-col items-end gap-0.5">
              <span
                className={`font-semibold tabular-nums ${
                  isNeg ? "text-money-negative" : isPos ? "text-money-positive" : "text-muted-foreground"
                }`}
                dir="ltr"
              >
                {fmtAr(row.original.profit)}
              </span>
              <span
                className="text-[11px] text-muted-foreground tabular-nums"
                title={`تكلفة الوحدة: ${fmtAr(row.original.unitCost)}`}
              >
                تكلفة: {fmtAr(row.original.unitCost)}
              </span>
            </div>
          );
        },
      },
    ],
    [navigate],
  );

  const branches = trpc.branches.list.useQuery();
  const q = trpc.reports.salesRegister.useQuery({
    from: period.from,
    to: period.to,
    branchId: branchId ? Number(branchId) : undefined,
    q: query.trim() || undefined,
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
      q: query.trim() || undefined,
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
            <UnifiedSearchInput
              value={query}
              onChange={(val) => {
                setQuery(val);
                setPage(0);
              }}
              placeholder="رقم الفاتورة أو العميل أو المنتج…"
              size="compact"
              barcode={false}
              debounceMs={250}
              className="w-56"
            />
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
            externalFiltersActive={query.trim() !== ""}
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
