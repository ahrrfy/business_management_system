import { DataTable } from "@/components/data-table/DataTable";
import { FILTER_LABELS } from "@shared/uiContracts";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/PageHeader";
import { AppSelect } from "@/components/ui/AppSelect";
import { FilterField } from "@/components/list";
import { DEFAULT_PERIOD, PeriodFilter, type PeriodValue, type PresetKey } from "@/components/reports/PeriodFilter";
import { useUrlFilters } from "@/hooks/useUrlFilters";
import { exportRows } from "@/lib/export";
import { fmtDate } from "@/lib/date";
import { sourceTypeLabel } from "@/lib/labels";
import { INVOICE_FILTER_METHODS, METHOD_LABEL, paymentMethodLabel, type InvoiceFilterMethod } from "@/lib/paymentMethod";
import { printSalesReportV2 } from "@/lib/printing/printTemplatesV2";
import { D, fmtAr } from "@/lib/money";
import { canSeeCost } from "@shared/permissions";
import { INVOICE_STATUSES, invoiceStatusLabel, isDeadInvoiceStatus, type InvoiceStatus } from "@shared/invoiceStatus";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import type { ColumnDef } from "@tanstack/react-table";
import { X } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "wouter";

type ReportRow = RouterOutputs["reports"]["salesReport"]["rows"][number];
type TopRow = RouterOutputs["reports"]["topProducts"][number];
type SlowRow = RouterOutputs["reports"]["slowMovers"][number];
type CatRow = RouterOutputs["reports"]["profitByCategory"][number];

// التعريب من `@shared/invoiceStatus` (مصدر الحقيقة الوحيد) — كان قاموساً محلّياً يُسقِط
// `SUPERSEDED` فتُعرَض/تُصدَّر/تُطبَع رمزاً إنجليزياً خاماً عبر `?? s`.
// خريطة الأصناف اللونية تبقى محلّية: نطاقها العرض لا التعريب.
const STATUS_CLS: Record<string, string> = {
  PAID: "badge-status-active",
  PARTIALLY_PAID: "badge-stock-low",
  PENDING: "bg-muted text-muted-foreground",
  RETURNED: "badge-stock-out",
  CANCELLED: "badge-stock-out",
};
// المصادر/طرق الدفع من القواميس المركزية (@/lib/labels + @/lib/paymentMethod) —
// WORKORDER = «أمر شغل» (كان «طلب خدمة» محلياً هنا فخالف بقية الشاشات).
// فاتورة بلا طريقة دفع مسجَّلة تُعرض «آجل» (لا «—») — سياق تقرير مبيعات.
const payMethodOf = (m: string | null | undefined) => (m ? paymentMethodLabel(m) : "آجل");

const fmt = fmtAr;
const invoiceRemaining = (r: Pick<ReportRow, "total" | "paidAmount" | "returnedTotal">) => {
  const value = D(r.total).minus(D(r.paidAmount)).minus(D(r.returnedTotal ?? "0"));
  return value.isNegative() ? D(0) : value;
};
const selectCls =
  "h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

const invoiceColumns: ColumnDef<ReportRow, unknown>[] = [
  {
    accessorKey: "invoiceNumber",
    header: "رقم الفاتورة",
    cell: (c) => (
      <Link href={`/invoices/${c.row.original.id}`}>
        <span className="font-mono text-xs text-primary underline-offset-2 hover:underline" dir="ltr">
          {c.getValue() as string}
        </span>
      </Link>
    ),
  },
  {
    accessorKey: "invoiceDate",
    header: "التاريخ",
    cell: (c) => (
      <div className="leading-tight">
        <div>{fmtDate(c.getValue() as string)}</div>
        <div className="mt-0.5 text-[10px] text-muted-foreground" dir="ltr">
          {new Date(c.getValue() as string).toLocaleTimeString("ar-IQ-u-nu-latn", { hour: "2-digit", minute: "2-digit" })}
        </div>
      </div>
    ),
  },
  {
    accessorKey: "customerName",
    header: "العميل",
    cell: (c) => (c.getValue() as string) ?? "—",
  },
  {
    accessorKey: "sourceType",
    header: "المصدر",
    cell: (c) => sourceTypeLabel(c.getValue() as string),
  },
  { accessorKey: "branchName", header: "الفرع", cell: (c) => (c.getValue() as string) ?? "—" },
  { accessorKey: "salespersonName", header: "الكاشير / البائع", cell: (c) => (c.getValue() as string) ?? "—" },
  { accessorKey: "shiftId", header: "الوردية", cell: (c) => (c.getValue() as number | null) ?? "—" },
  { accessorKey: "posDeviceId", header: "محطة البيع", cell: (c) => (c.getValue() as string) ?? "—" },
  {
    accessorKey: "paymentMethod",
    header: "طريقة الدفع",
    cell: (c) => payMethodOf(c.getValue() as string | null),
  },
  {
    accessorKey: "subtotal",
    header: "قبل الخصم",
    cell: (c) => <span className="tabular-nums" dir="ltr">{fmt(c.getValue() as string)}</span>,
  },
  {
    accessorKey: "discountAmount",
    header: "الخصم",
    cell: (c) => <span className="tabular-nums text-muted-foreground" dir="ltr">{fmt(c.getValue() as string)}</span>,
  },
  {
    accessorKey: "taxAmount",
    header: "الضريبة",
    cell: (c) => <span className="tabular-nums text-muted-foreground" dir="ltr">{fmt(c.getValue() as string)}</span>,
  },
  {
    accessorKey: "total",
    header: "الإجمالي",
    cell: (c) => (
      <span className="tabular-nums" dir="ltr">
        {fmt(c.getValue() as string)}
      </span>
    ),
  },
  {
    accessorKey: "returnedTotal",
    header: "المرتجع",
    cell: (c) => {
      const value = c.getValue() as string;
      return <span className={`tabular-nums ${D(value).gt(0) ? "text-money-negative font-medium" : "text-muted-foreground"}`} dir="ltr">{fmt(value)}</span>;
    },
  },
  {
    accessorKey: "paidAmount",
    header: "المدفوع",
    cell: (c) => (
      <span className="tabular-nums" dir="ltr">
        {fmt(c.getValue() as string)}
      </span>
    ),
  },
  {
    id: "unpaid",
    header: "المتبقّي",
    cell: (c) => {
      // المتبقي الصافي بعد المدفوع والمرتجع، بدقة Decimal.
      const unpaidD = invoiceRemaining(c.row.original);
      const isOwing = unpaidD.gt(0);
      return (
        <span className={`tabular-nums ${isOwing ? "text-money-negative font-medium" : ""}`} dir="ltr">
          {fmt(unpaidD.toString())}
        </span>
      );
    },
  },
  {
    accessorKey: "status",
    header: "الحالة",
    cell: (c) => {
      const s = c.getValue() as string;
      return (
        <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${STATUS_CLS[s] ?? "bg-muted text-muted-foreground"}`}>
          {invoiceStatusLabel(s)}
        </span>
      );
    },
  },
  {
    accessorKey: "costTotal",
    header: "التكلفة المسجلة",
    cell: (c) => <span className="tabular-nums text-muted-foreground" dir="ltr">{fmt(c.getValue() as string)}</span>,
  },
];

const INVOICE_COST_COLUMNS = new Set(["costTotal"]);

/** حالات الفاتورة المتاحة في فلتر التقرير — مرآة enum الخادم عبر المصدر المشترك.
 *  `SUPERSEDED` كانت مفقودةً هنا ⇒ لا سبيل لحصر الفواتير المُصحَّحة من التقرير. */
const STATUS_OPTIONS = INVOICE_STATUSES;
/** مصادر الفاتورة — تشمل ONLINE (كانت مفقودة من الفلتر رغم دعم الخادم لها). */
const SOURCE_OPTIONS = ["POS", "ONLINE", "ORDER", "WORKORDER"] as const;

type Tab = "invoices" | "top" | "slow" | "category";

export default function SalesReport() {
  const [tab, setTab] = useState<Tab>("invoices");
  // فلاتر محفوظة في querystring (useUrlFilters) — تعيش مع فتح التفاصيل والرجوع وتُشارَك رابطاً.
  // التواريخ عبر PeriodFilter الموحّد بصيغة ymd **محلية** (كان toISOString يُرجع يوم أمس UTC
  // قبل ٣ فجراً بتوقيت العراق فينزاح النطاق الافتراضي يوماً كاملاً).
  const [f, setF, resetF] = useUrlFilters({
    from: DEFAULT_PERIOD.from,
    to: DEFAULT_PERIOD.to,
    preset: DEFAULT_PERIOD.preset as string,
    branch: "",
    source: "",
    status: "",
    method: "",
    seller: "",
  });
  const period: PeriodValue = { from: f.from, to: f.to, preset: (f.preset || "custom") as PresetKey };
  const [topBy, setTopBy] = useState<"revenue" | "qty">("revenue");
  const [sinceDays, setSinceDays] = useState(90);

  const me = trpc.auth.me.useQuery();
  const showCost = me.data ? canSeeCost(me.data.role) : true;
  const branches = trpc.branches.list.useQuery();
  // موظفو المبيعات الذين لديهم فواتير (نفس مصدر فلتر شاشة الفواتير) — بلا كشف دليل المستخدمين.
  const salespeople = trpc.sales.salespeople.useQuery(undefined, { retry: false });
  // فلتر الفواتير — مُستخرَج ليُعاد استعماله في التصدير الكامل (جمع كل الصفحات عبر cursor).
  const invoiceFilters = {
    from: f.from || undefined,
    to: f.to || undefined,
    branchId: f.branch ? Number(f.branch) : undefined,
    sourceTypes: f.source ? [f.source as (typeof SOURCE_OPTIONS)[number]] : undefined,
    statuses: f.status ? [f.status as (typeof STATUS_OPTIONS)[number]] : undefined,
    paymentMethods: f.method ? [f.method as InvoiceFilterMethod | "NONE"] : undefined,
    salespersonId: f.seller ? Number(f.seller) : undefined,
  };
  const invoiceQ = trpc.reports.salesReport.useQuery(invoiceFilters, { enabled: tab === "invoices" });
  const topQ = trpc.reports.topProducts.useQuery(
    {
      from: f.from || undefined,
      to: f.to || undefined,
      branchId: f.branch ? Number(f.branch) : undefined,
      limit: 20,
      by: topBy,
    },
    { enabled: tab === "top" }
  );
  const slowQ = trpc.reports.slowMovers.useQuery(
    {
      sinceDays,
      branchId: f.branch ? Number(f.branch) : undefined,
      limit: 50,
    },
    { enabled: tab === "slow" }
  );
  const catQ = trpc.reports.profitByCategory.useQuery(
    {
      from: f.from || undefined,
      to: f.to || undefined,
      branchId: f.branch ? Number(f.branch) : undefined,
    },
    { enabled: tab === "category" }
  );

  // عدّاد الفلاتر النشطة (عدا الفترة) — يُظهر زرّ المسح عند الحاجة فقط.
  const activeCount = [f.branch, f.source, f.status, f.method, f.seller].filter(Boolean).length;

  const invRows = invoiceQ.data?.rows ?? [];
  const totals = invoiceQ.data?.totals;

  return (
    <div className="space-y-4">
      <PageHeader
        title="تقارير المبيعات"
        description="فواتير + أكثر مبيعاً + بطيئات الحركة + ربح حسب الفئة. كل تبويبة بفلاترها وتصدير Excel."
      />

      {/* تبويبات */}
      <div className="flex gap-1 border-b" role="tablist">
        {([
          ["invoices", "الفواتير"],
          ["top", "أكثر مبيعاً"],
          ["slow", "بطيئات الحركة"],
          ["category", "ربح حسب الفئة"],
        ] as const).map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            className={`px-4 py-2 text-sm border-b-2 transition-colors ${
              tab === id
                ? "border-primary text-foreground font-medium"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>

      {/* فلاتر مشتركة */}
      <Card>
        <CardContent className="pt-4 pb-3 space-y-3">
          {tab !== "slow" && (
            <PeriodFilter
              value={period}
              onChange={(v) => setF({ from: v.from, to: v.to, preset: v.preset })}
            />
          )}
          <div className="flex flex-wrap gap-3 items-end">
            <FilterField label="الفرع" className="w-40">
              <AppSelect value={f.branch} onValueChange={(v) => setF({ branch: v })}>
                <option value="">الكل</option>
                {branches.data?.map((b) => (
                  <option key={b.id} value={String(b.id)}>{b.name}</option>
                ))}
              </AppSelect>
            </FilterField>
            {tab === "invoices" && (
              <>
                <FilterField label="نوع الفاتورة" className="w-36">
                  <AppSelect value={f.source} onValueChange={(v) => setF({ source: v })}>
                    <option value="">الكل</option>
                    {SOURCE_OPTIONS.map((s) => (
                      <option key={s} value={s}>{sourceTypeLabel(s)}</option>
                    ))}
                  </AppSelect>
                </FilterField>
                <FilterField label="الحالة" className="w-36">
                  <AppSelect value={f.status} onValueChange={(v) => setF({ status: v })}>
                    <option value="">الكل</option>
                    {STATUS_OPTIONS.map((s) => (
                      <option key={s} value={s}>{invoiceStatusLabel(s)}</option>
                    ))}
                  </AppSelect>
                </FilterField>
                <FilterField label="طريقة الدفع" className="w-40">
                  <AppSelect value={f.method} onValueChange={(v) => setF({ method: v })}>
                    <option value="">الكل</option>
                    {/* طرق الفاتورة وحدها — EXCHANGE طريقةُ سندِ صيرفةٍ لا تُكتب على فاتورة ويرفضها عقد التقرير. */}
                    {INVOICE_FILTER_METHODS.map((m) => (
                      <option key={m} value={m}>{METHOD_LABEL[m]}</option>
                    ))}
                    <option value="NONE">آجل (بلا طريقة مسجَّلة)</option>
                  </AppSelect>
                </FilterField>
                <FilterField label="الكاشير / البائع" className="w-44">
                  <AppSelect value={f.seller} onValueChange={(v) => setF({ seller: v })}>
                    <option value="">— كل الموظفين —</option>
                    {(salespeople.data ?? []).map((u) =>
                      u.id != null ? (
                        <option key={u.id} value={String(u.id)}>{u.name}</option>
                      ) : null,
                    )}
                  </AppSelect>
                </FilterField>
              </>
            )}
            {tab === "top" && (
              <FilterField label="الترتيب" className="w-32">
                <AppSelect value={topBy} onValueChange={(v) => setTopBy(v as "revenue" | "qty")}>
                  <option value="revenue">بالإيراد</option>
                  <option value="qty">بالكمية</option>
                </AppSelect>
              </FilterField>
            )}
            {tab === "slow" && (
              <div className="flex flex-col gap-1">
                <label className="text-xs text-muted-foreground">منذ (يوم)</label>
                <input
                  type="number"
                  min={7}
                  max={365}
                  value={sinceDays}
                  onChange={(e) => setSinceDays(Math.max(1, Math.min(365, Number(e.target.value) || 90)))}
                  className={`${selectCls} w-24 tabular-nums`}
                  dir="ltr"
                />
              </div>
            )}
            {activeCount > 0 && (
              <Button variant="ghost" size="sm" onClick={resetF} className="text-muted-foreground">
                <X aria-hidden className="size-4" />
                {FILTER_LABELS.reset}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {tab === "invoices" && (
        <InvoicesTab
          rows={invRows}
          totals={totals}
          isLoading={invoiceQ.isLoading}
          from={f.from}
          to={f.to}
          branchLabel={f.branch === "" ? "الكل" : branches.data?.find((b) => b.id === Number(f.branch))?.name ?? "—"}
          filters={invoiceFilters}
          truncated={invoiceQ.data?.nextCursor != null}
          showCost={showCost}
        />
      )}
      {tab === "top" && (
        <TopProductsTab
          rows={topQ.data ?? []}
          isLoading={topQ.isLoading}
          by={topBy}
          from={f.from}
          to={f.to}
          showCost={showCost}
        />
      )}
      {tab === "slow" && (
        <SlowMoversTab
          rows={slowQ.data ?? []}
          isLoading={slowQ.isLoading}
          sinceDays={sinceDays}
        />
      )}
      {tab === "category" && (
        <CategoryProfitTab
          rows={catQ.data ?? []}
          isLoading={catQ.isLoading}
          from={f.from}
          to={f.to}
          showCost={showCost}
        />
      )}
    </div>
  );
}

/* ============================ تبويبة الفواتير ============================ */

function InvoicesTab({
  rows,
  totals,
  isLoading,
  from,
  to,
  branchLabel,
  filters,
  truncated,
  showCost,
}: {
  rows: ReportRow[];
  totals: RouterOutputs["reports"]["salesReport"]["totals"] | undefined;
  isLoading: boolean;
  from: string;
  to: string;
  branchLabel: string;
  filters: {
    from?: string;
    to?: string;
    branchId?: number;
    sourceTypes?: ("POS" | "ONLINE" | "ORDER" | "WORKORDER")[];
    statuses?: InvoiceStatus[];
    paymentMethods?: (InvoiceFilterMethod | "NONE")[];
    salespersonId?: number;
  };
  truncated: boolean;
  showCost: boolean;
}) {
  const utils = trpc.useUtils();
  const [exporting, setExporting] = useState(false);
  const visibleInvoiceColumns = useMemo(
    () => showCost ? invoiceColumns : invoiceColumns.filter((c) => !INVOICE_COST_COLUMNS.has(c.id ?? "")),
    [showCost],
  );

  // التصدير/الطباعة الكاملان: حين تتجاوز النتائج حدّ الصفحة (truncated) نجمع كل الصفحات عبر cursor
  // بدل تصدير أوّل ١٠٠٠ صفٍّ صامتاً (تدقيق ١٧/٧). سقف ٢٠٠ صفحة × ٥٠٠٠ = مليون صفّ حارس ضدّ حلقة لا تنتهي.
  async function fetchAllRows(): Promise<ReportRow[]> {
    if (!truncated) return rows;
    const acc: ReportRow[] = [];
    let cursor: number | undefined = undefined;
    for (let page = 0; page < 200; page++) {
      const res: RouterOutputs["reports"]["salesReport"] = await utils.reports.salesReport.fetch({
        ...filters,
        limit: 5000,
        cursor,
      });
      acc.push(...res.rows);
      if (res.nextCursor == null) break;
      cursor = res.nextCursor;
    }
    return acc;
  }

  return (
    <>
      {truncated && (
        <div role="status" className="rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] px-3 py-2 text-xs text-[var(--sem-warn)]">
          النتائج تتجاوز حدّ العرض — البطاقات أعلاه تشمل <strong>كامل النطاق</strong>، أمّا الجدول والطباعة فيعرضان أحدث ١٠٠٠ فاتورة فقط.
          زرّ «تصدير Excel» يجمع <strong>كلّ</strong> الفواتير المطابقة، أو ضيّق النطاق الزمني لعرضٍ كامل على الشاشة.
        </div>
      )}
      {totals && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Card>
            <CardContent className="pt-4 pb-3 text-center">
              <p className="text-xs text-muted-foreground">عدد الفواتير</p>
              <p className="text-2xl font-bold tabular-nums">{totals.count}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-3 text-center">
              <p className="text-xs text-muted-foreground">الإجمالي</p>
              <p className="text-xl font-bold tabular-nums" dir="ltr">{fmt(totals.total)}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-3 text-center">
              <p className="text-xs text-muted-foreground">المحصَّل</p>
              <p className="text-xl font-bold tabular-nums text-money-positive" dir="ltr">{fmt(totals.paid)}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-3 text-center">
              <p className="text-xs text-muted-foreground">المتبقّي</p>
              <p className={`text-xl font-bold tabular-nums ${D(totals.unpaid).gt(0) ? "text-money-negative" : "text-foreground"}`} dir="ltr">
                {fmt(totals.unpaid)}
              </p>
            </CardContent>
          </Card>
        </div>
      )}
      <DataTable
        columns={visibleInvoiceColumns}
        data={rows}
        searchPlaceholder="بحث في التقرير…"
        loading={isLoading}
        emptyText="لا فواتير في هذا النطاق."
        toolbar={
          <>
            <Button
              variant="outline"
              size="sm"
              disabled={!rows.length}
              onClick={() => {
                // القالب عالي الدقّة V2 (gap-audit ٥/٧: printSalesReportV2 كان مكتوباً في PR #140
                // بلا مستهلِك — رُبط هنا بدل الطباعة العامّة السابقة، بمرآة بقيّة قوالب الفواتير).
                printSalesReportV2({
                  periodLabel: `${from} — ${to}`,
                  branchLabel,
                  invoiceCount: totals?.count ?? rows.length,
                  totalSum: totals?.total ?? "0",
                  paidSum: totals?.paid ?? "0",
                  unpaidSum: totals?.unpaid ?? "0",
                  rows: rows.map((r) => ({
                    invoiceNumber: r.invoiceNumber,
                    date: fmtDate(r.invoiceDate),
                    customerName: r.customerName ?? "—",
                    branchName: r.branchName ?? "—",
                    salespersonName: r.salespersonName ?? "—",
                    shiftId: r.shiftId,
                    paymentMethod: payMethodOf(r.paymentMethod),
                    subtotal: r.subtotal,
                    discount: r.discountAmount,
                    tax: r.taxAmount,
                    total: r.total,
                    paid: r.paidAmount,
                    returned: r.returnedTotal,
                    remaining: invoiceRemaining(r).toString(),
                    cost: showCost ? r.costTotal : undefined,
                    status: invoiceStatusLabel(r.status),
                    // الأحمر (#8A1F11 = BRAND.alert) للمستند **الميت** وحده (ملغاة/مرتجعة/مستبدلة).
                    // كان كل ما ليس PAID/PARTIALLY_PAID يُطبَع أحمر ⇒ فاتورةٌ آجلة سليمة (PENDING/CONFIRMED)
                    // تبدو في الورقة المطبوعة كالملغاة تماماً. غير النهائيّ رماديّ محايد (#4E5148 = BRAND.textFaint).
                    statusColor: isDeadInvoiceStatus(r.status)
                      ? "#8A1F11"
                      : r.status === "PAID"
                        ? "#0D6B52"
                        : r.status === "PARTIALLY_PAID"
                          ? "#92400E"
                          : "#4E5148",
                  })),
                });
              }}
            >
              طباعة / PDF
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!rows.length || exporting}
              onClick={async () => {
                // تصدير كامل: يجمع كل الصفحات حين truncated (لا أوّل ١٠٠٠ فقط) — الملف يطابق البطاقات.
                setExporting(true);
                try {
                  const allRows = await fetchAllRows();
                  exportRows(allRows, {
                    filename: `تقرير-المبيعات-${from}-${to}`,
                    columns: [
                      { key: "invoiceNumber", header: "رقم الفاتورة" },
                      {
                        key: "invoiceDate",
                        header: "التاريخ",
                        map: (r) => fmtDate(r.invoiceDate),
                      },
                      { key: "customerName", header: "العميل" },
                      { key: "sourceType", header: "النوع", map: (r) => sourceTypeLabel(r.sourceType) },
                      { key: "branchName", header: "الفرع", map: (r) => r.branchName ?? "" },
                      { key: "salespersonName", header: "الكاشير / البائع", map: (r) => r.salespersonName ?? "" },
                      { key: "shiftId", header: "رقم الوردية", map: (r) => r.shiftId ?? "" },
                      { key: "posDeviceId", header: "محطة البيع", map: (r) => r.posDeviceId ?? "" },
                      { key: "paymentMethod", header: "طريقة الدفع", map: (r) => payMethodOf(r.paymentMethod) },
                      { key: "subtotal", header: "قبل الخصم", map: (r) => Number(r.subtotal) },
                      { key: "discountAmount", header: "الخصم", map: (r) => Number(r.discountAmount) },
                      { key: "taxAmount", header: "الضريبة", map: (r) => Number(r.taxAmount) },
                      { key: "total", header: "الإجمالي", map: (r) => Number(r.total) },
                      { key: "paidAmount", header: "المدفوع", map: (r) => Number(r.paidAmount) },
                      { key: "returnedTotal", header: "المرتجع", map: (r) => Number(r.returnedTotal) },
                      { key: "remaining" as const, header: "المتبقي", map: (r: ReportRow) => invoiceRemaining(r).toNumber() },
                      ...(showCost ? [{
                        key: "costTotal" as const,
                        header: "التكلفة",
                        map: (r: ReportRow) => Number(r.costTotal),
                      }, {
                        key: "profit" as const,
                        header: "الربح",
                        map: (r: ReportRow) => D(r.total).minus(D(r.returnedTotal ?? "0")).minus(D(r.costTotal)).toNumber(),
                      }] : []),
                      { key: "status", header: "الحالة", map: (r) => invoiceStatusLabel(r.status) },
                    ],
                  });
                } finally {
                  setExporting(false);
                }
              }}
            >
              {exporting ? "جارٍ التصدير…" : "تصدير Excel"}
            </Button>
          </>
        }
      />
    </>
  );
}

/* ============================ أكثر المنتجات مبيعاً ============================ */

const topColumns: ColumnDef<TopRow, unknown>[] = [
  { accessorKey: "productName", header: "المنتج" },
  { accessorKey: "categoryName", header: "الفئة", cell: (c) => (c.getValue() as string) ?? "—" },
  {
    accessorKey: "qtySold",
    header: "الكمية المباعة",
    cell: (c) => <span className="tabular-nums" dir="ltr">{fmt(c.getValue() as string)}</span>,
  },
  {
    accessorKey: "revenue",
    header: "الإيراد",
    cell: (c) => <span className="tabular-nums" dir="ltr">{fmt(c.getValue() as string)}</span>,
  },
  {
    accessorKey: "cost",
    header: "التكلفة",
    cell: (c) => <span className="tabular-nums text-muted-foreground" dir="ltr">{fmt(c.getValue() as string)}</span>,
  },
  {
    accessorKey: "profit",
    header: "الربح",
    cell: (c) => {
      const v = c.getValue() as string;
      const cls = Number(v) >= 0 ? "text-money-positive" : "text-money-negative";
      return <span className={`tabular-nums font-medium ${cls}`} dir="ltr">{fmt(v)}</span>;
    },
  },
  {
    accessorKey: "marginPct",
    header: "هامش %",
    cell: (c) => <span className="tabular-nums" dir="ltr">{fmt(c.getValue() as string)}%</span>,
  },
  {
    accessorKey: "invoicesCount",
    header: "عدد الفواتير",
    cell: (c) => <span className="tabular-nums" dir="ltr">{c.getValue() as number}</span>,
  },
];

const COST_KEYS_TOP = new Set(["cost", "profit", "marginPct"]);

function TopProductsTab({
  rows,
  isLoading,
  by,
  from,
  to,
  showCost,
}: {
  rows: TopRow[];
  isLoading: boolean;
  by: "revenue" | "qty";
  from: string;
  to: string;
  showCost: boolean;
}) {
  const cols = useMemo(
    () => showCost ? topColumns : topColumns.filter((c) => !COST_KEYS_TOP.has((c as { accessorKey?: string }).accessorKey ?? "")),
    [showCost],
  );
  return (
    <DataTable
      columns={cols}
      data={rows}
      searchPlaceholder="بحث في المنتجات…"
      loading={isLoading}
      emptyText="لا مبيعات في هذا النطاق."
      toolbar={
        <Button
          variant="outline"
          size="sm"
          disabled={!rows.length}
          onClick={() =>
            exportRows(rows, {
              filename: `أكثر-مبيعاً-${by === "qty" ? "بالكمية" : "بالإيراد"}-${from}-${to}`,
              columns: [
                { key: "productName", header: "المنتج" },
                { key: "categoryName", header: "الفئة", map: (r) => r.categoryName ?? "" },
                { key: "qtySold", header: "الكمية المباعة", map: (r) => Number(r.qtySold) },
                { key: "revenue", header: "الإيراد", map: (r) => Number(r.revenue) },
                ...(showCost ? [
                  { key: "cost" as const, header: "التكلفة", map: (r: TopRow) => Number(r.cost) },
                  { key: "profit" as const, header: "الربح", map: (r: TopRow) => Number(r.profit) },
                  { key: "marginPct" as const, header: "هامش %", map: (r: TopRow) => Number(r.marginPct) },
                ] : []),
                { key: "invoicesCount", header: "عدد الفواتير" },
              ],
            })
          }
        >
          تصدير Excel
        </Button>
      }
    />
  );
}

/* ============================ بطيئات الحركة ============================ */

const slowColumns: ColumnDef<SlowRow, unknown>[] = [
  { accessorKey: "productName", header: "المنتج" },
  { accessorKey: "categoryName", header: "الفئة", cell: (c) => (c.getValue() as string) ?? "—" },
  {
    accessorKey: "qtyInStock",
    header: "المخزون الحالي",
    cell: (c) => <span className="tabular-nums" dir="ltr">{fmt(c.getValue() as string)}</span>,
  },
  {
    accessorKey: "lastSaleDate",
    header: "آخر بيع",
    cell: (c) => {
      const v = c.getValue() as string | null;
      return v ? fmtDate(v) : <span className="text-destructive font-medium">لم يُبَع قط</span>;
    },
  },
  {
    accessorKey: "daysSinceLastSale",
    header: "أيام منذ آخر بيع",
    cell: (c) => {
      const v = c.getValue() as number | null;
      if (v == null) return <span className="text-muted-foreground">—</span>;
      const cls = v > 180 ? "text-destructive font-medium" : v > 90 ? "text-[var(--stock-low)]" : "";
      return <span className={`tabular-nums ${cls}`} dir="ltr">{v}</span>;
    },
  },
];

function SlowMoversTab({
  rows,
  isLoading,
  sinceDays,
}: {
  rows: SlowRow[];
  isLoading: boolean;
  sinceDays: number;
}) {
  return (
    <DataTable
      columns={slowColumns}
      data={rows}
      searchPlaceholder="بحث…"
      loading={isLoading}
      emptyText="لا منتجات بطيئة الحركة في هذا النطاق."
      toolbar={
        <Button
          variant="outline"
          size="sm"
          disabled={!rows.length}
          onClick={() =>
            exportRows(rows, {
              filename: `بطيئات-الحركة-${sinceDays}يوم`,
              columns: [
                { key: "productName", header: "المنتج" },
                { key: "categoryName", header: "الفئة", map: (r) => r.categoryName ?? "" },
                { key: "qtyInStock", header: "المخزون الحالي", map: (r) => Number(r.qtyInStock) },
                {
                  key: "lastSaleDate",
                  header: "آخر بيع",
                  map: (r) => (r.lastSaleDate ? fmtDate(r.lastSaleDate) : "لم يُبَع قط"),
                },
                { key: "daysSinceLastSale", header: "أيام منذ آخر بيع", map: (r) => r.daysSinceLastSale ?? "" },
              ],
            })
          }
        >
          تصدير Excel
        </Button>
      }
    />
  );
}

/* ============================ ربح حسب الفئة ============================ */

const catColumns: ColumnDef<CatRow, unknown>[] = [
  { accessorKey: "categoryName", header: "الفئة" },
  {
    accessorKey: "revenue",
    header: "الإيراد",
    cell: (c) => <span className="tabular-nums" dir="ltr">{fmt(c.getValue() as string)}</span>,
  },
  {
    accessorKey: "cost",
    header: "التكلفة",
    cell: (c) => <span className="tabular-nums text-muted-foreground" dir="ltr">{fmt(c.getValue() as string)}</span>,
  },
  {
    accessorKey: "profit",
    header: "الربح",
    cell: (c) => {
      const v = c.getValue() as string;
      const cls = Number(v) >= 0 ? "text-money-positive" : "text-money-negative";
      return <span className={`tabular-nums font-medium ${cls}`} dir="ltr">{fmt(v)}</span>;
    },
  },
  {
    accessorKey: "marginPct",
    header: "هامش %",
    cell: (c) => <span className="tabular-nums" dir="ltr">{fmt(c.getValue() as string)}%</span>,
  },
  {
    accessorKey: "itemsCount",
    header: "عدد البنود",
    cell: (c) => <span className="tabular-nums" dir="ltr">{c.getValue() as number}</span>,
  },
];

const COST_KEYS_CAT = new Set(["cost", "profit", "marginPct"]);

function CategoryProfitTab({
  rows,
  isLoading,
  from,
  to,
  showCost,
}: {
  rows: CatRow[];
  isLoading: boolean;
  from: string;
  to: string;
  showCost: boolean;
}) {
  const cols = useMemo(
    () => showCost ? catColumns : catColumns.filter((c) => !COST_KEYS_CAT.has((c as { accessorKey?: string }).accessorKey ?? "")),
    [showCost],
  );
  return (
    <DataTable
      columns={cols}
      data={rows}
      searchPlaceholder="بحث في الفئات…"
      loading={isLoading}
      emptyText="لا بيانات في هذا النطاق."
      toolbar={
        <Button
          variant="outline"
          size="sm"
          disabled={!rows.length}
          onClick={() =>
            exportRows(rows, {
              filename: `ربح-حسب-الفئة-${from}-${to}`,
              columns: [
                { key: "categoryName", header: "الفئة" },
                { key: "revenue", header: "الإيراد", map: (r) => Number(r.revenue) },
                ...(showCost ? [
                  { key: "cost" as const, header: "التكلفة", map: (r: CatRow) => Number(r.cost) },
                  { key: "profit" as const, header: "الربح", map: (r: CatRow) => Number(r.profit) },
                  { key: "marginPct" as const, header: "هامش %", map: (r: CatRow) => Number(r.marginPct) },
                ] : []),
                { key: "itemsCount", header: "عدد البنود" },
              ],
            })
          }
        >
          تصدير Excel
        </Button>
      }
    />
  );
}
