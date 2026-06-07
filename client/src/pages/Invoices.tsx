import { DataTable } from "@/components/data-table/DataTable";
import { Button } from "@/components/ui/button";
import { exportRows } from "@/lib/export";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import type { ColumnDef } from "@tanstack/react-table";
import { Link } from "wouter";

type Row = RouterOutputs["sales"]["list"][number];

const STATUS: Record<string, string> = {
  PENDING: "معلّقة", PARTIALLY_PAID: "مدفوعة جزئياً", PAID: "مدفوعة",
  CONFIRMED: "مؤكّدة", CANCELLED: "ملغاة", RETURNED: "مرتجعة",
};
const STATUS_CLS: Record<string, string> = {
  PAID: "bg-emerald-100 text-emerald-700", PARTIALLY_PAID: "bg-amber-100 text-amber-700",
  PENDING: "bg-muted text-foreground/70", RETURNED: "bg-rose-100 text-rose-700", CANCELLED: "bg-rose-100 text-rose-700",
};
const SOURCE: Record<string, string> = { POS: "نقطة بيع", ONLINE: "أونلاين", ORDER: "طلب", WORKORDER: "أمر شغل" };
const fmt = (s: string | number) => Number(s).toLocaleString("ar-IQ", { maximumFractionDigits: 2 });

const columns: ColumnDef<Row, unknown>[] = [
  { accessorKey: "invoiceNumber", header: "رقم الفاتورة", cell: (c) => <span className="font-mono text-xs" dir="ltr">{c.getValue() as string}</span> },
  { accessorKey: "invoiceDate", header: "التاريخ", cell: (c) => new Date(c.getValue() as string).toLocaleString("ar-IQ") },
  { accessorKey: "customerName", header: "العميل", cell: (c) => (c.getValue() as string) ?? "—" },
  { accessorKey: "sourceType", header: "المصدر", cell: (c) => SOURCE[c.getValue() as string] ?? (c.getValue() as string) },
  { accessorKey: "total", header: "الإجمالي", cell: (c) => <span className="tabular-nums" dir="ltr">{fmt(c.getValue() as string)}</span> },
  { accessorKey: "paidAmount", header: "المدفوع", cell: (c) => <span className="tabular-nums" dir="ltr">{fmt(c.getValue() as string)}</span> },
  {
    accessorKey: "status", header: "الحالة",
    cell: (c) => {
      const s = c.getValue() as string;
      return <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${STATUS_CLS[s] ?? "bg-muted"}`}>{STATUS[s] ?? s}</span>;
    },
  },
  {
    id: "action", header: "إجراء", enableSorting: false,
    cell: (c) => <Link href={`/invoices/${c.row.original.id}`}><Button variant="outline" size="sm">فتح</Button></Link>,
  },
];

export default function Invoices() {
  const rows = trpc.sales.list.useQuery({ limit: 200 });
  const data = rows.data ?? [];
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">المبيعات</h1>
      <p className="text-sm text-muted-foreground">قائمة الفواتير — فرز بنقرة، بحث فوري، وتصدير. اضغط «فتح» لمتابعة فاتورة أو تسديد دفعة.</p>
      <DataTable
        columns={columns}
        data={data}
        searchPlaceholder="بحث في الفواتير…"
        emptyText={rows.isLoading ? "جارٍ التحميل…" : "لا فواتير بعد."}
        toolbar={
          <Button variant="outline" size="sm" disabled={!data.length}
            onClick={() =>
              exportRows(data, {
                filename: "المبيعات",
                columns: [
                  { key: "invoiceNumber", header: "رقم الفاتورة" },
                  { key: "invoiceDate", header: "التاريخ", map: (r) => new Date(r.invoiceDate).toLocaleDateString("ar-IQ") },
                  { key: "customerName", header: "العميل" },
                  { key: "sourceType", header: "المصدر" },
                  { key: "total", header: "الإجمالي", map: (r) => Number(r.total) },
                  { key: "paidAmount", header: "المدفوع", map: (r) => Number(r.paidAmount) },
                  { key: "status", header: "الحالة" },
                ],
              })
            }>
            تصدير Excel
          </Button>
        }
      />
    </div>
  );
}
