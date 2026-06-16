import { DataTable } from "@/components/data-table/DataTable";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { exportRows } from "@/lib/export";
import { printReportDoc } from "@/lib/printing/reportDoc";
import { D, fmtAr, positiveDiff } from "@/lib/money";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import type { ColumnDef } from "@tanstack/react-table";
import { useState } from "react";
import { Link } from "wouter";

type ReportRow = RouterOutputs["reports"]["salesReport"]["rows"][number];
type TopRow = RouterOutputs["reports"]["topProducts"][number];
type SlowRow = RouterOutputs["reports"]["slowMovers"][number];
type CatRow = RouterOutputs["reports"]["profitByCategory"][number];

const STATUS: Record<string, string> = {
  PENDING: "معلّقة",
  PARTIALLY_PAID: "مدفوعة جزئياً",
  PAID: "مدفوعة",
  CONFIRMED: "مؤكّدة",
  CANCELLED: "ملغاة",
  RETURNED: "مرتجعة",
};
const STATUS_CLS: Record<string, string> = {
  PAID: "bg-emerald-100 text-emerald-700",
  PARTIALLY_PAID: "bg-amber-100 text-amber-700",
  PENDING: "bg-muted text-foreground/70",
  RETURNED: "bg-rose-100 text-rose-700",
  CANCELLED: "bg-rose-100 text-rose-700",
};
const SOURCE: Record<string, string> = {
  POS: "نقطة بيع",
  ONLINE: "أونلاين",
  ORDER: "طلب",
  WORKORDER: "أمر شغل",
};

const fmt = fmtAr;
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
    cell: (c) => new Date(c.getValue() as string).toLocaleDateString("ar-IQ-u-nu-latn"),
  },
  {
    accessorKey: "customerName",
    header: "العميل",
    cell: (c) => (c.getValue() as string) ?? "—",
  },
  {
    accessorKey: "sourceType",
    header: "المصدر",
    cell: (c) => SOURCE[c.getValue() as string] ?? (c.getValue() as string),
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
      // §٥: نستعمل positiveDiff (Decimal) بدلاً من parseFloat+Math.max ⇒ لا انجراف float.
      const unpaidD = positiveDiff(c.row.original.total, c.row.original.paidAmount);
      const isOwing = unpaidD.gt(0);
      return (
        <span className={`tabular-nums ${isOwing ? "text-rose-600 font-medium" : ""}`} dir="ltr">
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
        <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${STATUS_CLS[s] ?? "bg-muted"}`}>
          {STATUS[s] ?? s}
        </span>
      );
    },
  },
];

function today() {
  return new Date().toISOString().slice(0, 10);
}
function firstOfMonth() {
  const d = new Date();
  d.setDate(1);
  return d.toISOString().slice(0, 10);
}

type Tab = "invoices" | "top" | "slow" | "category";

export default function SalesReport() {
  const [tab, setTab] = useState<Tab>("invoices");
  const [from, setFrom] = useState(firstOfMonth());
  const [to, setTo] = useState(today());
  const [branchId, setBranchId] = useState<number | "">("");
  const [sourceType, setSourceType] = useState("");
  const [topBy, setTopBy] = useState<"revenue" | "qty">("revenue");
  const [sinceDays, setSinceDays] = useState(90);

  const branches = trpc.branches.list.useQuery();
  const invoiceQ = trpc.reports.salesReport.useQuery(
    {
      from: from || undefined,
      to: to || undefined,
      branchId: branchId ? Number(branchId) : undefined,
      sourceTypes: sourceType
        ? [sourceType as "POS" | "ONLINE" | "ORDER" | "WORKORDER"]
        : undefined,
    },
    { enabled: tab === "invoices" }
  );
  const topQ = trpc.reports.topProducts.useQuery(
    {
      from: from || undefined,
      to: to || undefined,
      branchId: branchId ? Number(branchId) : undefined,
      limit: 20,
      by: topBy,
    },
    { enabled: tab === "top" }
  );
  const slowQ = trpc.reports.slowMovers.useQuery(
    {
      sinceDays,
      branchId: branchId ? Number(branchId) : undefined,
      limit: 50,
    },
    { enabled: tab === "slow" }
  );
  const catQ = trpc.reports.profitByCategory.useQuery(
    {
      from: from || undefined,
      to: to || undefined,
      branchId: branchId ? Number(branchId) : undefined,
    },
    { enabled: tab === "category" }
  );

  const invRows = invoiceQ.data?.rows ?? [];
  const totals = invoiceQ.data?.totals;

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">تقارير المبيعات</h1>
      <p className="text-sm text-muted-foreground">
        فواتير + أكثر مبيعاً + بطيئات الحركة + ربح حسب الفئة. كل تبويبة بفلاترها وتصدير Excel.
      </p>

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
        <CardContent className="pt-4 pb-3">
          <div className="flex flex-wrap gap-3 items-end">
            {tab !== "slow" && (
              <>
                <div className="flex flex-col gap-1">
                  <label className="text-xs text-muted-foreground">من تاريخ</label>
                  <input
                    type="date"
                    value={from}
                    onChange={(e) => setFrom(e.target.value)}
                    className={selectCls}
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-xs text-muted-foreground">إلى تاريخ</label>
                  <input
                    type="date"
                    value={to}
                    onChange={(e) => setTo(e.target.value)}
                    className={selectCls}
                  />
                </div>
              </>
            )}
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted-foreground">الفرع</label>
              <select
                className={selectCls}
                value={branchId}
                onChange={(e) => setBranchId(e.target.value ? Number(e.target.value) : "")}
              >
                <option value="">الكل</option>
                {branches.data?.map((b) => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </select>
            </div>
            {tab === "invoices" && (
              <div className="flex flex-col gap-1">
                <label className="text-xs text-muted-foreground">نوع الفاتورة</label>
                <select
                  className={selectCls}
                  value={sourceType}
                  onChange={(e) => setSourceType(e.target.value)}
                >
                  <option value="">الكل</option>
                  <option value="POS">نقطة بيع</option>
                  <option value="WORKORDER">أمر شغل</option>
                  <option value="ORDER">طلب</option>
                </select>
              </div>
            )}
            {tab === "top" && (
              <div className="flex flex-col gap-1">
                <label className="text-xs text-muted-foreground">الترتيب</label>
                <select
                  className={selectCls}
                  value={topBy}
                  onChange={(e) => setTopBy(e.target.value as "revenue" | "qty")}
                >
                  <option value="revenue">بالإيراد</option>
                  <option value="qty">بالكمية</option>
                </select>
              </div>
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
          </div>
        </CardContent>
      </Card>

      {tab === "invoices" && (
        <InvoicesTab
          rows={invRows}
          totals={totals}
          isLoading={invoiceQ.isLoading}
          from={from}
          to={to}
        />
      )}
      {tab === "top" && (
        <TopProductsTab
          rows={topQ.data ?? []}
          isLoading={topQ.isLoading}
          by={topBy}
          from={from}
          to={to}
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
          from={from}
          to={to}
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
}: {
  rows: ReportRow[];
  totals: RouterOutputs["reports"]["salesReport"]["totals"] | undefined;
  isLoading: boolean;
  from: string;
  to: string;
}) {
  return (
    <>
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
              <p className="text-xl font-bold tabular-nums text-emerald-600" dir="ltr">{fmt(totals.paid)}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-3 text-center">
              <p className="text-xs text-muted-foreground">المتبقّي</p>
              <p className={`text-xl font-bold tabular-nums ${D(totals.unpaid).gt(0) ? "text-rose-600" : "text-foreground"}`} dir="ltr">
                {fmt(totals.unpaid)}
              </p>
            </CardContent>
          </Card>
        </div>
      )}
      <DataTable
        columns={invoiceColumns}
        data={rows}
        searchPlaceholder="بحث في التقرير…"
        emptyText={isLoading ? "جارٍ التحميل…" : "لا فواتير في هذا النطاق."}
        toolbar={
          <>
            <Button
              variant="outline"
              size="sm"
              disabled={!rows.length}
              onClick={() =>
                printReportDoc({
                  title: "تقرير المبيعات",
                  headerExtra: [{ label: "الفترة", value: `${from} — ${to}` }],
                  columns: [
                    { key: "num", label: "رقم الفاتورة" },
                    { key: "date", label: "التاريخ" },
                    { key: "customer", label: "العميل" },
                    { key: "source", label: "المصدر" },
                    { key: "total", label: "الإجمالي", align: "left" },
                    { key: "paid", label: "المدفوع", align: "left" },
                    { key: "unpaid", label: "المتبقّي", align: "left" },
                    { key: "status", label: "الحالة" },
                  ],
                  rows: rows.map((r) => ({
                    num: r.invoiceNumber,
                    date: new Date(r.invoiceDate).toLocaleDateString("ar-IQ-u-nu-latn"),
                    customer: r.customerName ?? "—",
                    source: SOURCE[r.sourceType] ?? r.sourceType,
                    total: fmt(r.total),
                    paid: fmt(r.paidAmount),
                    unpaid: fmt(positiveDiff(r.total, r.paidAmount).toString()),
                    status: STATUS[r.status] ?? r.status,
                  })),
                  summary: totals
                    ? [
                        { label: "عدد الفواتير", value: String(totals.count) },
                        { label: "الإجمالي", value: fmt(totals.total) },
                        { label: "المحصَّل", value: fmt(totals.paid) },
                        { label: "المتبقّي", value: fmt(totals.unpaid), large: true, bold: true },
                      ]
                    : undefined,
                })
              }
            >
              طباعة / PDF
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!rows.length}
              onClick={() =>
                exportRows(rows, {
                  filename: `تقرير-المبيعات-${from}-${to}`,
                  columns: [
                    { key: "invoiceNumber", header: "رقم الفاتورة" },
                    {
                      key: "invoiceDate",
                      header: "التاريخ",
                      map: (r) => new Date(r.invoiceDate).toLocaleDateString("ar-IQ-u-nu-latn"),
                    },
                    { key: "customerName", header: "العميل" },
                    { key: "sourceType", header: "النوع", map: (r) => SOURCE[r.sourceType] ?? r.sourceType },
                    { key: "total", header: "الإجمالي", map: (r) => Number(r.total) },
                    { key: "paidAmount", header: "المدفوع", map: (r) => Number(r.paidAmount) },
                    {
                      key: "costTotal",
                      header: "التكلفة",
                      map: (r) => Number(r.costTotal),
                    },
                    { key: "status", header: "الحالة", map: (r) => STATUS[r.status] ?? r.status },
                  ],
                })
              }
            >
              تصدير Excel
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
      const cls = Number(v) >= 0 ? "text-emerald-600" : "text-rose-600";
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

function TopProductsTab({
  rows,
  isLoading,
  by,
  from,
  to,
}: {
  rows: TopRow[];
  isLoading: boolean;
  by: "revenue" | "qty";
  from: string;
  to: string;
}) {
  return (
    <DataTable
      columns={topColumns}
      data={rows}
      searchPlaceholder="بحث في المنتجات…"
      emptyText={isLoading ? "جارٍ التحميل…" : "لا مبيعات في هذا النطاق."}
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
                { key: "cost", header: "التكلفة", map: (r) => Number(r.cost) },
                { key: "profit", header: "الربح", map: (r) => Number(r.profit) },
                { key: "marginPct", header: "هامش %", map: (r) => Number(r.marginPct) },
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
      return v ? new Date(v).toLocaleDateString("ar-IQ-u-nu-latn") : <span className="text-rose-600 font-medium">لم يُبَع قط</span>;
    },
  },
  {
    accessorKey: "daysSinceLastSale",
    header: "أيام منذ آخر بيع",
    cell: (c) => {
      const v = c.getValue() as number | null;
      if (v == null) return <span className="text-muted-foreground">—</span>;
      const cls = v > 180 ? "text-rose-600 font-medium" : v > 90 ? "text-amber-600" : "";
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
      emptyText={isLoading ? "جارٍ التحميل…" : "لا منتجات بطيئة الحركة في هذا النطاق."}
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
                  map: (r) => (r.lastSaleDate ? new Date(r.lastSaleDate).toLocaleDateString("ar-IQ-u-nu-latn") : "لم يُبَع قط"),
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
      const cls = Number(v) >= 0 ? "text-emerald-600" : "text-rose-600";
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

function CategoryProfitTab({
  rows,
  isLoading,
  from,
  to,
}: {
  rows: CatRow[];
  isLoading: boolean;
  from: string;
  to: string;
}) {
  return (
    <DataTable
      columns={catColumns}
      data={rows}
      searchPlaceholder="بحث في الفئات…"
      emptyText={isLoading ? "جارٍ التحميل…" : "لا بيانات في هذا النطاق."}
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
                { key: "cost", header: "التكلفة", map: (r) => Number(r.cost) },
                { key: "profit", header: "الربح", map: (r) => Number(r.profit) },
                { key: "marginPct", header: "هامش %", map: (r) => Number(r.marginPct) },
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
