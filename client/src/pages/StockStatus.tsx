// حالة المخزون / إعادة الطلب — رصيد كل (متغيّر × فرع) مقابل حدّ إعادة الطلب minStock (للقراءة فقط).
// عرض + تصدير Excel + طباعة A4 (ReportShell + printReportDoc). فلتر فرع + مفتاح «التنبيهات فقط».
// الجدول عبر DataTable المشترك (فرز بنقرة + بحث + هيكل تحميل) — البيانات محلّية فالفرز كامل لا صفحيّ.
// الحالة: نفد (qty<=0) · منخفض (qty<=minStock و minStock>0) · طبيعي.
import { useMemo, useState } from "react";
import { AppSelect } from "@/components/ui/AppSelect";
import { Link } from "wouter";
import { type ColumnDef } from "@tanstack/react-table";
import { ArrowUpRight, ListTree, X } from "lucide-react";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { ReportShell, type KpiItem } from "@/components/reports/ReportShell";
import { DataTable } from "@/components/data-table/DataTable";
import { ErrorState } from "@/components/PageState";
import { Button } from "@/components/ui/button";
import { exportRows } from "@/lib/export";
import { printReportDoc } from "@/lib/printing/reportDoc";
import { fmtInt } from "@/lib/money";
import { fmtDate } from "@/lib/date";

type Row = RouterOutputs["reports"]["stockStatus"]["rows"][number];
type StatusTab = "all" | "out" | "low" | "ok";

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
  const [statusTab, setStatusTab] = useState<StatusTab>("all");
  // بطاقة منتج مباشرة: ?variantId= من رابطٍ عميق (شاشة المنتجات/بطاقة الصنف) يقصر العرض على
  // هذا الصنف عبر كل الفروع — بديلاً عن جدولٍ كاملٍ حين يريد المستخدم صنفاً واحداً بعينه.
  const [singleVariantId] = useState<number | null>(() => {
    const v = Number(new URLSearchParams(window.location.search).get("variantId"));
    return Number.isInteger(v) && v > 0 ? v : null;
  });
  const [showSingle, setShowSingle] = useState(() => singleVariantId != null);
  const branches = trpc.branches.list.useQuery();
  const q = trpc.reports.stockStatus.useQuery({
    branchId: branchId ? Number(branchId) : undefined,
    onlyAlerts: onlyAlerts || undefined,
  });

  const allRows = q.data?.rows ?? [];
  const singleRow = showSingle && singleVariantId != null ? allRows.find((r) => r.variantId === singleVariantId) : undefined;
  const scopedRows = showSingle && singleVariantId != null ? allRows.filter((r) => r.variantId === singleVariantId) : allRows;
  const rows = statusTab === "all" ? scopedRows : scopedRows.filter((r) => r.status === statusTab);
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
      {
        id: "actions",
        header: "",
        enableSorting: false,
        cell: ({ row }) => (
          <div className="flex items-center gap-1">
            <Button asChild variant="ghost" size="sm" title="حركات المخزون لهذا الصنف">
              <Link href={`/inventory-movements?variantId=${row.original.variantId}`}>
                <ArrowUpRight aria-hidden className="size-3.5" />
              </Link>
            </Button>
            <Button asChild variant="ghost" size="sm" title="بطاقة المنتج (Kardex)">
              <Link href={`/reports/item-ledger?variantId=${row.original.variantId}`}>
                <ListTree aria-hidden className="size-3.5" />
              </Link>
            </Button>
          </div>
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
            <AppSelect className="h-9" value={String(branchId)} onValueChange={(next) => setBranchId(next ? Number(next) : "")}>
              <option value="">الكل</option>
              {branches.data?.map((b) => (<option key={b.id} value={b.id}>{b.name}</option>))}
            </AppSelect>
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
          {/* فصل نفد/منخفض/طبيعي بوضوح — بدل قراءة عمود «الحالة» صفّاً صفّاً في جدولٍ طويل. */}
          <div className="flex h-9 items-center gap-1 rounded-md border p-0.5">
            {([
              ["all", "الكل"],
              ["out", "نفد"],
              ["low", "منخفض"],
              ["ok", "طبيعي"],
            ] as Array<[StatusTab, string]>).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setStatusTab(key)}
                className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                  statusTab === key ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      }
    >
      {showSingle && singleVariantId != null && (
        <div className="flex items-center justify-between gap-3 rounded-md border bg-muted/40 px-3 py-2 text-sm">
          <span>
            عرض صنفٍ واحد فقط{singleRow ? `: ${singleRow.productName} — ${singleRow.variantLabel}` : ` (رقم ${singleVariantId})`} عبر كل الفروع.
          </span>
          <Button variant="ghost" size="sm" onClick={() => setShowSingle(false)}>
            <X aria-hidden className="size-3.5" /> إظهار الكل
          </Button>
        </div>
      )}
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
