import { DataTable } from "@/components/data-table/DataTable";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { exportRows } from "@/lib/export";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import type { ColumnDef } from "@tanstack/react-table";
import { useState } from "react";
import { Link } from "wouter";

type ReportRow = RouterOutputs["reports"]["salesReport"]["rows"][number];

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

const fmt = (s: string | number) =>
  Number(s).toLocaleString("ar-IQ", { maximumFractionDigits: 2 });
const selectCls =
  "h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

const columns: ColumnDef<ReportRow, unknown>[] = [
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
    cell: (c) => new Date(c.getValue() as string).toLocaleDateString("ar-IQ"),
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
      const total = parseFloat(String(c.row.original.total ?? 0));
      const paid = parseFloat(String(c.row.original.paidAmount ?? 0));
      const unpaid = Math.max(0, total - paid);
      return (
        <span className={`tabular-nums ${unpaid > 0 ? "text-rose-600 font-medium" : ""}`} dir="ltr">
          {fmt(unpaid)}
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

export default function SalesReport() {
  const [from, setFrom] = useState(firstOfMonth());
  const [to, setTo] = useState(today());
  const [branchId, setBranchId] = useState<number | "">("");
  const [sourceType, setSourceType] = useState("");

  const branches = trpc.branches.list.useQuery();
  const report = trpc.reports.salesReport.useQuery({
    from: from || undefined,
    to: to || undefined,
    branchId: branchId ? Number(branchId) : undefined,
    sourceTypes: sourceType
      ? [sourceType as "POS" | "ONLINE" | "ORDER" | "WORKORDER"]
      : undefined,
  });

  const rows = report.data?.rows ?? [];
  const totals = report.data?.totals;

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">تقرير المبيعات</h1>
      <p className="text-sm text-muted-foreground">
        اختر نطاقاً زمنياً لعرض الفواتير مع ملخّص الإجماليات وتصدير Excel.
      </p>

      {/* فلاتر */}
      <Card>
        <CardContent className="pt-4 pb-3">
          <div className="flex flex-wrap gap-3 items-end">
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
          </div>
        </CardContent>
      </Card>

      {/* إجماليات */}
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
              <p className={`text-xl font-bold tabular-nums ${Number(totals.unpaid) > 0 ? "text-rose-600" : "text-foreground"}`} dir="ltr">
                {fmt(totals.unpaid)}
              </p>
            </CardContent>
          </Card>
        </div>
      )}

      {/* الجدول */}
      <DataTable
        columns={columns}
        data={rows}
        searchPlaceholder="بحث في التقرير…"
        emptyText={report.isLoading ? "جارٍ التحميل…" : "لا فواتير في هذا النطاق."}
        toolbar={
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
                    map: (r) => new Date(r.invoiceDate).toLocaleDateString("ar-IQ"),
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
        }
      />
    </div>
  );
}
