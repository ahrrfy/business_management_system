import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { exportRows } from "@/lib/export";
import { trpc } from "@/lib/trpc";
import { Link } from "wouter";

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
const SOURCE: Record<string, string> = { POS: "نقطة بيع", ONLINE: "أونلاين", ORDER: "طلب", WORKORDER: "أمر شغل" };

export default function Invoices() {
  const rows = trpc.sales.list.useQuery({ limit: 200 });
  const fmt = (s: string | number) => Number(s).toLocaleString("ar-IQ", { maximumFractionDigits: 2 });
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">المبيعات</h1>
        <Button
          variant="outline"
          size="sm"
          disabled={!rows.data?.length}
          onClick={() =>
            exportRows(rows.data ?? [], {
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
          }
        >
          تصدير Excel
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">قائمة الفواتير. اضغط على فاتورة لمتابعتها أو تسديد دفعة.</p>
      <Card>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr className="text-right">
                <th className="p-2">رقم الفاتورة</th>
                <th className="p-2">التاريخ</th>
                <th className="p-2">العميل</th>
                <th className="p-2">المصدر</th>
                <th className="p-2 text-left">الإجمالي</th>
                <th className="p-2 text-left">المدفوع</th>
                <th className="p-2">الحالة</th>
                <th className="p-2 text-center">إجراء</th>
              </tr>
            </thead>
            <tbody>
              {(rows.data ?? []).map((i) => (
                <tr key={i.id} className="border-t">
                  <td className="p-2 font-mono text-xs" dir="ltr">{i.invoiceNumber}</td>
                  <td className="p-2">{new Date(i.invoiceDate).toLocaleString("ar-IQ")}</td>
                  <td className="p-2">{i.customerName ?? "—"}</td>
                  <td className="p-2">{SOURCE[i.sourceType] ?? i.sourceType}</td>
                  <td className="p-2 text-left tabular-nums" dir="ltr">{fmt(i.total)}</td>
                  <td className="p-2 text-left tabular-nums" dir="ltr">{fmt(i.paidAmount)}</td>
                  <td className="p-2">
                    <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${STATUS_CLS[i.status] ?? "bg-muted"}`}>
                      {STATUS[i.status] ?? i.status}
                    </span>
                  </td>
                  <td className="p-2 text-center">
                    <Link href={`/invoices/${i.id}`}>
                      <Button variant="outline" size="sm">فتح</Button>
                    </Link>
                  </td>
                </tr>
              ))}
              {rows.data && rows.data.length === 0 && (
                <tr><td colSpan={8} className="p-6 text-center text-muted-foreground">لا فواتير بعد.</td></tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
