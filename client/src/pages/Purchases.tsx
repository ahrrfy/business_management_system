import { CopyInline } from "@/components/CopyButton";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { exportRows } from "@/lib/export";
import { trpc } from "@/lib/trpc";
import { Link } from "wouter";

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
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">المشتريات</h1>
        <div className="flex gap-2">
          <Button
            variant="outline"
            disabled={!rows.data?.length}
            onClick={() => exportRows(rows.data ?? [], {
              filename: "المشتريات",
              columns: [
                { key: "poNumber", header: "رقم الأمر" },
                { key: "supplierName", header: "المورد", map: (r) => r.supplierName ?? "" },
                { key: "orderDate", header: "التاريخ", map: (r) => new Date(r.orderDate).toLocaleDateString("ar-IQ") },
                { key: "total", header: "الإجمالي", map: (r) => Number(r.total) },
                { key: "paidAmount", header: "المدفوع", map: (r) => Number(r.paidAmount) },
                { key: "status", header: "الحالة", map: (r) => PO_STATUS[r.status] ?? r.status },
              ],
            })}
          >تصدير Excel</Button>
          <Link href="/purchases/new"><Button>+ أمر شراء جديد</Button></Link>
        </div>
      </div>
      <p className="text-sm text-muted-foreground">أوامر الشراء وحالتها. أنشئ أمراً ثم استلمه ليُضاف للمخزون وتُسجَّل الذمم.</p>
      <Card>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr className="text-right">
                <th className="p-2">رقم الأمر</th>
                <th className="p-2">المورد</th>
                <th className="p-2">التاريخ</th>
                <th className="p-2 text-left">الإجمالي</th>
                <th className="p-2 text-left">المدفوع</th>
                <th className="p-2">الحالة</th>
                <th className="p-2 text-center">إجراء</th>
              </tr>
            </thead>
            <tbody>
              {(rows.data ?? []).map((p) => (
                <tr key={p.id} className="border-t">
                  <td className="p-2"><CopyInline value={p.poNumber} /></td>
                  <td className="p-2">{p.supplierName ?? "—"}</td>
                  <td className="p-2">{new Date(p.orderDate).toLocaleString("ar-IQ")}</td>
                  <td className="p-2 text-left">{p.total}</td>
                  <td className="p-2 text-left">{p.paidAmount}</td>
                  <td className="p-2">{PO_STATUS[p.status] ?? p.status}</td>
                  <td className="p-2 text-center">
                    <Link href={`/purchases/${p.id}/receive`}>
                      <Button variant="outline" size="sm">
                        {p.status === "RECEIVED" || p.status === "CANCELLED" ? "عرض" : "استلام"}
                      </Button>
                    </Link>
                  </td>
                </tr>
              ))}
              {rows.data && rows.data.length === 0 && (
                <tr><td colSpan={7} className="p-6 text-center text-muted-foreground">لا أوامر شراء بعد.</td></tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
