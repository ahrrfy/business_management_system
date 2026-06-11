import { CopyInline } from "@/components/CopyButton";
import { DataTable } from "@/components/data-table/DataTable";
import { RowActions } from "@/components/list";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { exportRows } from "@/lib/export";
import { fmt } from "@/lib/money";
import { notify } from "@/lib/notify";
import { printInvoiceA4 } from "@/lib/printing/printTemplates";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import type { ColumnDef } from "@tanstack/react-table";
import { useMemo, useState } from "react";

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

const selectCls =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export default function Invoices() {
  const utils = trpc.useUtils();
  // فلاتر خادمية (لا فلترة محلية تُخفي صفحات الخادم): فترة invoiceDate + الحالة.
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [status, setStatus] = useState("");

  const rows = trpc.sales.list.useQuery({
    limit: 200,
    from: from || undefined,
    to: to || undefined,
    status: (status || undefined) as Row["status"] | undefined,
  });
  const data = rows.data ?? [];

  // طباعة A4 من القائمة: نجلب التفاصيل (sales.get) ثم نطبع بنفس قالب شاشة الفاتورة.
  async function printA4(invoiceId: number) {
    try {
      const d = await utils.sales.get.fetch({ invoiceId });
      if (!d) { notify.err("تعذّر جلب الفاتورة"); return; }
      await printInvoiceA4({
        invoiceNumber: d.invoiceNumber,
        invoiceDate: d.invoiceDate,
        customerName: d.customerName,
        subtotal: d.subtotal,
        discountAmount: d.discountAmount,
        taxAmount: d.taxAmount,
        total: d.total,
        paidAmount: d.paidAmount,
        items: d.items.map((it) => ({ productName: it.productName ?? "", unitName: it.unitName, quantity: it.quantity, unitPrice: it.unitPrice, total: it.total })),
      });
    } catch (e) {
      notify.err(e);
    }
  }

  const columns = useMemo<ColumnDef<Row, unknown>[]>(() => [
    { accessorKey: "invoiceNumber", header: "رقم الفاتورة", cell: (c) => <CopyInline value={c.getValue() as string} /> },
    { accessorKey: "invoiceDate", header: "التاريخ", cell: (c) => new Date(c.getValue() as string).toLocaleString("ar-IQ-u-nu-latn") },
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
      cell: (c) => {
        const r = c.row.original;
        // مسوّاة = لا دفعات بعدها؛ غير قابلة للإرجاع = ملغاة/مرتجعة بالكامل.
        const settled = r.status === "PAID" || r.status === "CANCELLED" || r.status === "RETURNED";
        const returnable = r.status !== "CANCELLED" && r.status !== "RETURNED";
        return (
          <RowActions
            mode="auto"
            actions={[
              { key: "view", label: "عرض", href: `/invoices/${r.id}` },
              { key: "print", label: "طباعة A4", onSelect: () => void printA4(r.id) },
              { key: "pay", label: "تسديد دفعة", href: `/invoices/${r.id}`, hidden: settled },
              { key: "return", label: "إرجاع", href: "/returns", hidden: !returnable },
            ]}
          />
        );
      },
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], []);

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">المبيعات</h1>
      <p className="text-sm text-muted-foreground">قائمة الفواتير — فرز بنقرة، بحث فوري، وتصدير. اضغط «عرض» لمتابعة فاتورة أو تسديد دفعة.</p>

      <Card>
        <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-3 pt-6">
          <div className="space-y-1">
            <Label className="text-xs">من تاريخ</Label>
            <Input type="date" dir="ltr" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">إلى تاريخ</Label>
            <Input type="date" dir="ltr" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">الحالة</Label>
            <select className={selectCls} value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">— كل الحالات —</option>
              {Object.entries(STATUS).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </select>
          </div>
        </CardContent>
      </Card>

      <DataTable
        columns={columns}
        data={data}
        searchPlaceholder="بحث في الفواتير…"
        emptyText={rows.isLoading ? "جارٍ التحميل…" : "لا فواتير مطابقة."}
        toolbar={
          <Button variant="outline" size="sm" disabled={!data.length}
            onClick={() =>
              exportRows(data, {
                filename: "المبيعات",
                columns: [
                  { key: "invoiceNumber", header: "رقم الفاتورة" },
                  { key: "invoiceDate", header: "التاريخ", map: (r) => new Date(r.invoiceDate).toLocaleDateString("ar-IQ-u-nu-latn") },
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
