import { Card, CardContent } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";

const STATUS: Record<string, string> = {
  PENDING: "معلّقة",
  PARTIALLY_PAID: "مدفوعة جزئياً",
  PAID: "مدفوعة",
  CONFIRMED: "مؤكّدة",
  CANCELLED: "ملغاة",
  RETURNED: "مرتجعة",
};
const SOURCE: Record<string, string> = { POS: "نقطة بيع", ONLINE: "أونلاين", ORDER: "طلب", WORKORDER: "أمر شغل" };

export default function Invoices() {
  const rows = trpc.sales.list.useQuery({ limit: 200 });
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">المبيعات</h1>
      <Card>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr className="text-right">
                <th className="p-2">رقم الفاتورة</th>
                <th className="p-2">التاريخ</th>
                <th className="p-2">المصدر</th>
                <th className="p-2 text-left">الإجمالي</th>
                <th className="p-2 text-left">المدفوع</th>
                <th className="p-2">الحالة</th>
              </tr>
            </thead>
            <tbody>
              {(rows.data ?? []).map((i) => (
                <tr key={i.id} className="border-t">
                  <td className="p-2 font-mono text-xs" dir="ltr">{i.invoiceNumber}</td>
                  <td className="p-2">{new Date(i.invoiceDate).toLocaleString("ar-IQ")}</td>
                  <td className="p-2">{SOURCE[i.sourceType] ?? i.sourceType}</td>
                  <td className="p-2 text-left">{i.total}</td>
                  <td className="p-2 text-left">{i.paidAmount}</td>
                  <td className="p-2">{STATUS[i.status] ?? i.status}</td>
                </tr>
              ))}
              {rows.data && rows.data.length === 0 && (
                <tr><td colSpan={6} className="p-6 text-center text-muted-foreground">لا فواتير بعد.</td></tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
