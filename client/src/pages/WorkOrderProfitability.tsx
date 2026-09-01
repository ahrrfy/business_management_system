// ربحية أوامر الشغل (Job Costing) — أيّ أنواع الأعمال تربح فعلاً؟
// أمرٌ-أمراً: الإيراد (صافٍ قبل الضريبة من الفاتورة المرتبطة) − تكلفة المواد (لقطة
// startWorkOrder) − كلفة عملٍ اختيارية بالزمن الفعلي المُقاس (workSeconds × كلفة الساعة).
// حقل «كلفة ساعة العمل» ماذا-لو: تغييره يُعيد الاستعلام فيعيد حساب الربح/الهامش فوراً.
import { useEffect, useMemo, useState } from "react";
import { DataTable } from "@/components/data-table/DataTable";
import type { ColumnDef } from "@tanstack/react-table";
import { AppSelect } from "@/components/ui/AppSelect";
import { Link } from "wouter";
import { Clock3, FileSpreadsheet, Loader2 } from "lucide-react";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { PageHeader } from "@/components/PageHeader";
import { DateRangeFilter, type DateRange } from "@/components/table/DateRangeFilter";
import { MoneyInput } from "@/components/form/MoneyInput";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { fmtAr } from "@/lib/money";
import { exportRows } from "@/lib/export";
import { fetchAllPaged } from "@/lib/fetchAllRows";

type Row = RouterOutputs["reports"]["workOrderProfitability"]["rows"][number];

const PAGE = 100;
const selectCls =
  "h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

/** YYYY-MM-DD محلّياً (نفس نمط DateRangeFilter — لا toISOString/UTC). */
function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function monthStart(): string {
  const now = new Date();
  return ymd(new Date(now.getFullYear(), now.getMonth(), 1));
}

export default function WorkOrderProfitability() {
  const utils = trpc.useUtils();
  // الافتراضي: من أول الشهر إلى اليوم (الـAPI يتطلب from/to).
  const [range, setRange] = useState<DateRange>({ from: monthStart(), to: ymd(new Date()) });
  const [branchId, setBranchId] = useState<number | "">("");
  // كلفة ساعة العمل — نصّ مالي؛ يُطبَّق على الاستعلام بعد مهلة قصيرة (debounce) كي لا
  // نقصف الخادم بكل خانة تُكتب، ويبقى «يعيد الاستعلام عند تغييره» محسوساً فورياً.
  const [laborRate, setLaborRate] = useState("");
  const [appliedRate, setAppliedRate] = useState("");
  const [page, setPage] = useState(0);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => {
      setAppliedRate(laborRate);
      setPage(0);
    }, 400);
    return () => clearTimeout(t);
  }, [laborRate]);

  const branches = trpc.branches.list.useQuery();
  const rangeReady = Boolean(range.from && range.to);
  const queryInput = {
    from: range.from,
    to: range.to,
    branchId: branchId ? Number(branchId) : undefined,
    laborRatePerHour: appliedRate || undefined,
  };
  const q = trpc.reports.workOrderProfitability.useQuery(
    { ...queryInput, limit: PAGE, offset: page * PAGE },
    { enabled: rangeReady },
  );

  const rows = q.data?.rows ?? [];
  const totals = q.data?.totals;
  const totalCount = q.data?.totalCount ?? 0;
  const pages = Math.max(1, Math.ceil(totalCount / PAGE));
  const hasRate = Boolean(appliedRate);

  function changeRange(r: DateRange) {
    setRange(r);
    setPage(0);
  }

  async function onExport() {
    setExporting(true);
    try {
      const all = await fetchAllPaged<Row>(
        (offset, limit) =>
          utils.reports.workOrderProfitability
            .fetch({ ...queryInput, limit, offset })
            .then((r) => ({ rows: r.rows, total: r.totalCount })),
        { pageSize: 500 },
      );
      exportRows(all, {
        filename: `ربحية-أوامر-الشغل-${range.from}-${range.to}`,
        title: "ربحية أوامر الشغل",
        meta: [
          { label: "الفترة", value: `${range.from} — ${range.to}` },
          {
            label: "الفرع",
            value: branchId
              ? (branches.data?.find((b) => b.id === Number(branchId))?.name ?? String(branchId))
              : "الكل",
          },
          { label: "كلفة ساعة العمل", value: hasRate ? `${appliedRate} د.ع` : "غير محدّدة" },
        ],
        columns: [
          { key: "deliveredAt", header: "تاريخ التسليم" },
          { key: "orderNumber", header: "رقم الأمر" },
          { key: "title", header: "العمل" },
          { key: "customerName", header: "العميل", map: (r) => r.customerName ?? "" },
          { key: "branchName", header: "الفرع", map: (r) => r.branchName ?? "" },
          { key: "invoiceNumber", header: "الفاتورة", map: (r) => r.invoiceNumber ?? "" },
          { key: "revenue", header: "الإيراد", money: true, map: (r) => Number(r.revenue) },
          { key: "materialsCost", header: "تكلفة المواد", money: true, map: (r) => Number(r.materialsCost) },
          { key: "hours", header: "ساعات العمل", map: (r) => (r.hours == null ? "" : Number(r.hours)) },
          { key: "laborCost", header: "كلفة العمل", money: true, map: (r) => (r.laborCost == null ? "" : Number(r.laborCost)) },
          { key: "profit", header: "الربح", money: true, map: (r) => Number(r.profit) },
          { key: "marginPct", header: "الهامش %", map: (r) => (r.marginPct == null ? "" : Number(r.marginPct)) },
        ],
        totalsRow: totals
          ? {
              deliveredAt: "الإجمالي",
              orderNumber: `${totals.count} أمر`,
              revenue: Number(totals.revenue),
              materialsCost: Number(totals.materialsCost),
              hours: Number(totals.hours),
              laborCost: totals.laborCost == null ? "" : Number(totals.laborCost),
              profit: Number(totals.profit),
              marginPct: totals.marginPct == null ? "" : Number(totals.marginPct),
            }
          : undefined,
      });
    } finally {
      setExporting(false);
    }
  }
  /**
   * أعمدة ربحية أوامر الشغل — ومعها **ذيلُ الإجماليات** عبر `footer` في ColumnDef
   * (دعمٌ أُضيف إلى DataTable في هذه الشريحة؛ كان غيابه يمنع تحويل هذه الشاشة أصلاً).
   * ⚠️ الذيل في TanStack **لكل عمود**: الخليّة المدموجة السابقة (`colSpan={5}`) صارت
   * تسميةً على العمود الأوّل وخلايا فارغة بعدها — نفس المحاذاة بلا دمج.
   */
  const profitColumns = useMemo<ColumnDef<Row, unknown>[]>(() => [
    {
      id: "deliveredAt", header: "تاريخ التسليم",
      accessorFn: (r) => r.deliveredAt,
      footer: () => (totals ? `الإجمالي (${fmtAr(String(totals.count))} أمر)` : null),
      meta: { kind: "date" },
    },
    {
      id: "orderNumber", header: "رقم الأمر",
      accessorFn: (r) => r.orderNumber,
      cell: ({ row }) => (
        <Link href={`/work-orders/${row.original.id}`} className="text-primary underline-offset-2 hover:underline">
          {row.original.orderNumber}
        </Link>
      ),
      meta: { kind: "code" },
    },
    {
      id: "title", header: "العمل",
      accessorFn: (r) => r.title,
      cell: ({ row }) => <span className="block max-w-56 truncate" title={row.original.title}>{row.original.title}</span>,
      meta: { kind: "text" },
    },
    { id: "customerName", header: "العميل", accessorFn: (r) => r.customerName ?? "—", meta: { kind: "text", wrap: true } },
    {
      id: "invoice", header: "الفاتورة",
      accessorFn: (r) => r.invoiceNumber ?? (r.invoiceId ? String(r.invoiceId) : "—"),
      cell: ({ row }) => row.original.invoiceId ? (
        <Link href={`/invoices/${row.original.invoiceId}`} className="text-primary underline-offset-2 hover:underline">
          {row.original.invoiceNumber ?? String(row.original.invoiceId)}
        </Link>
      ) : "—",
      meta: { kind: "code" },
    },
    {
      id: "revenue", header: "الإيراد",
      accessorFn: (r) => Number(r.revenue),
      cell: ({ row }) => fmtAr(row.original.revenue),
      footer: () => (totals ? fmtAr(totals.revenue) : null),
      meta: { kind: "money" },
    },
    {
      id: "materialsCost", header: "تكلفة المواد",
      accessorFn: (r) => Number(r.materialsCost),
      cell: ({ row }) => <span className="text-muted-foreground">{fmtAr(row.original.materialsCost)}</span>,
      footer: () => (totals ? fmtAr(totals.materialsCost) : null),
      meta: { kind: "money" },
    },
    {
      id: "hours", header: "ساعات العمل",
      accessorFn: (r) => (r.hours == null ? -1 : Number(r.hours)),
      cell: ({ row }) => row.original.hours == null ? "—" : fmtAr(row.original.hours),
      footer: () => (totals ? fmtAr(totals.hours) : null),
      meta: { kind: "number" },
    },
    {
      id: "laborCost", header: "كلفة العمل",
      accessorFn: (r) => (r.laborCost == null ? -1 : Number(r.laborCost)),
      cell: ({ row }) => <span className="text-muted-foreground">{row.original.laborCost == null ? "—" : fmtAr(row.original.laborCost)}</span>,
      footer: () => (totals ? (totals.laborCost == null ? "—" : fmtAr(totals.laborCost)) : null),
      meta: { kind: "money" },
    },
    {
      id: "profit", header: "الربح",
      accessorFn: (r) => Number(r.profit),
      cell: ({ row }) => (
        <span className={row.original.profit.startsWith("-") ? "text-destructive font-medium" : "font-medium"}>
          {fmtAr(row.original.profit)}
        </span>
      ),
      footer: () => totals ? (
        <span className={totals.profit.startsWith("-") ? "text-destructive" : ""}>{fmtAr(totals.profit)}</span>
      ) : null,
      meta: { kind: "money" },
    },
    {
      id: "marginPct", header: "الهامش %",
      accessorFn: (r) => (r.marginPct == null ? -1 : Number(r.marginPct)),
      cell: ({ row }) => row.original.marginPct == null ? "—" : `${fmtAr(row.original.marginPct)}%`,
      footer: () => (totals ? (totals.marginPct == null ? "—" : `${fmtAr(totals.marginPct)}%`) : null),
      meta: { kind: "number" },
    },
  ], [totals]);

  return (
    <div className="space-y-4">
      <PageHeader
        title="ربحية أوامر الشغل"
        description="إيراد كل أمر مُسلَّم مقابل تكلفة مواده وزمن تنفيذه الفعلي — لمعرفة أي الأعمال تربح فعلاً."
        icon={<Clock3 aria-hidden className="size-6 text-muted-foreground" />}
        actions={
          <Button variant="outline" size="sm" disabled={!rows.length || exporting} onClick={onExport}>
            {exporting ? (
              <Loader2 aria-hidden className="size-4 animate-spin" />
            ) : (
              <FileSpreadsheet aria-hidden className="size-4" />
            )}
            تصدير Excel
          </Button>
        }
      />

      <div className="flex flex-wrap items-end gap-3">
        <DateRangeFilter value={range} onChange={changeRange} />
        <div className="flex flex-col gap-1">
          <Label className="text-xs text-muted-foreground">الفرع</Label>
          <AppSelect
            className="h-9"
            value={String(branchId)}
            onValueChange={(next) => {
              setBranchId(next ? Number(next) : "");
              setPage(0);
            }}
          >
            <option value="">الكل</option>
            {branches.data?.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </AppSelect>
        </div>
        <div className="flex flex-col gap-1">
          <Label className="text-xs text-muted-foreground">كلفة ساعة العمل (د.ع) — اختياري</Label>
          <MoneyInput
            value={laborRate}
            onChange={setLaborRate}
            placeholder="مثال: 5000"
            className="h-9 w-44"
            ariaLabel="كلفة ساعة العمل بالدينار العراقي"
          />
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          {!rangeReady ? (
            <p className="p-8 text-center text-sm text-muted-foreground">حدّد مدى التاريخ (من/إلى) لعرض التقرير.</p>
          ) : q.isLoading ? (
            <p className="p-8 text-center text-sm text-muted-foreground">جارٍ التحميل…</p>
          ) : !rows.length ? (
            <p className="p-8 text-center text-sm text-muted-foreground">لا أوامر مُسلَّمة في هذا النطاق.</p>
          ) : (
            <DataTable
              columns={profitColumns}
              data={rows}
              loading={q.isLoading}
              searchable={false}
              emptyText="لا أوامر مُسلَّمة في هذا النطاق."
              /* ترقيمٌ خادميّ ⇒ يُعطَّل الفرزُ تلقائياً فلا يفرز صفحةً واحدة ويبدو شاملاً. */
              serverPagination={{ page, onPageChange: setPage, pageSize: PAGE, total: totalCount }}
            />
          )}
        </CardContent>
      </Card>

      {!hasRate && rows.length > 0 && (
        <p className="text-xs text-muted-foreground">
          الربح المعروض = الإيراد − تكلفة المواد. أدخل «كلفة ساعة العمل» أعلاه لاحتساب كلفة الزمن الفعلي أيضاً.
        </p>
      )}

      {pages > 1 && (
        <div className="flex items-center justify-center gap-3 text-sm">
          <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
            السابق
          </Button>
          <span className="text-muted-foreground tabular-nums">
            صفحة {page + 1} من {pages}
          </span>
          <Button variant="outline" size="sm" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>
            التالي
          </Button>
        </div>
      )}
    </div>
  );
}
