import { Card, CardContent } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";

const PO_STATUS: Record<string, string> = {
  DRAFT: "مسودّة",
  SENT: "مُرسَل",
  CONFIRMED: "مؤكّد",
  RECEIVED: "مُستلَم",
  CANCELLED: "ملغى",
};

export default function Purchases() {
  const rows = trpc.purchases.list.useQuery({ limit: 200 });
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">المشتريات</h1>
      <p className="text-sm text-muted-foreground">أوامر الشراء وحالتها. (إنشاء أمر شراء واستلامه عبر الواجهة وحدةٌ قادمة — متاح حالياً عبر الـAPI.)</p>
      <Card>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr className="text-right">
                <th className="p-2">رقم الأمر</th>
                <th className="p-2">التاريخ</th>
                <th className="p-2 text-left">الإجمالي</th>
                <th className="p-2 text-left">المدفوع</th>
                <th className="p-2">الحالة</th>
              </tr>
            </thead>
            <tbody>
              {(rows.data ?? []).map((p) => (
                <tr key={p.id} className="border-t">
                  <td className="p-2 font-mono text-xs" dir="ltr">{p.poNumber}</td>
                  <td className="p-2">{new Date(p.orderDate).toLocaleString("ar-IQ")}</td>
                  <td className="p-2 text-left">{p.total}</td>
                  <td className="p-2 text-left">{p.paidAmount}</td>
                  <td className="p-2">{PO_STATUS[p.status] ?? p.status}</td>
                </tr>
              ))}
              {rows.data && rows.data.length === 0 && (
                <tr><td colSpan={5} className="p-6 text-center text-muted-foreground">لا أوامر شراء بعد.</td></tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
