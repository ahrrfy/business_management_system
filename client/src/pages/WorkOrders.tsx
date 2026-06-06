import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";
import { Link } from "wouter";

const STATUS_LABEL: Record<string, string> = {
  RECEIVED: "مُستلَم",
  IN_PROGRESS: "قيد التنفيذ",
  READY: "جاهز للتسليم",
  DELIVERED: "مُسلَّم",
  CANCELLED: "ملغى",
};

const STATUS_CLS: Record<string, string> = {
  RECEIVED: "bg-amber-100 text-amber-700",
  IN_PROGRESS: "bg-blue-100 text-blue-700",
  READY: "bg-violet-100 text-violet-700",
  DELIVERED: "bg-emerald-100 text-emerald-700",
  CANCELLED: "bg-rose-100 text-rose-700",
};

export default function WorkOrders() {
  const rows = trpc.workOrders.list.useQuery({ limit: 200 });
  const fmt = (s: string | number) => Number(s).toLocaleString("ar-IQ", { maximumFractionDigits: 2 });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">أوامر الشغل/المطبعة</h1>
        <Link href="/work-orders/new"><Button>+ أمر شغل جديد</Button></Link>
      </div>
      <p className="text-sm text-muted-foreground">أوامر الطباعة والتخصيص: من الاستلام إلى التنفيذ والتسليم — فاتورة تلقائية عند التسليم.</p>
      <Card>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr className="text-right">
                <th className="p-2">رقم الأمر</th>
                <th className="p-2">العنوان</th>
                <th className="p-2">العميل</th>
                <th className="p-2 text-center">الكمية</th>
                <th className="p-2 text-left">السعر</th>
                <th className="p-2">الاستحقاق</th>
                <th className="p-2">الحالة</th>
                <th className="p-2 text-center">إجراء</th>
              </tr>
            </thead>
            <tbody>
              {(rows.data ?? []).map((w) => (
                <tr key={w.id} className="border-t">
                  <td className="p-2 font-mono text-xs" dir="ltr">{w.orderNumber}</td>
                  <td className="p-2">{w.title}</td>
                  <td className="p-2">{w.customerName ?? "—"}</td>
                  <td className="p-2 text-center">{w.quantity}</td>
                  <td className="p-2 text-left tabular-nums" dir="ltr">{fmt(w.salePrice)}</td>
                  <td className="p-2 text-xs">{w.dueDate ? String(w.dueDate).slice(0, 10) : "—"}</td>
                  <td className="p-2">
                    <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${STATUS_CLS[w.status] ?? "bg-muted"}`}>
                      {STATUS_LABEL[w.status] ?? w.status}
                    </span>
                  </td>
                  <td className="p-2 text-center">
                    <Link href={`/work-orders/${w.id}`}>
                      <Button variant="outline" size="sm">فتح</Button>
                    </Link>
                  </td>
                </tr>
              ))}
              {rows.data && rows.data.length === 0 && (
                <tr><td colSpan={8} className="p-6 text-center text-muted-foreground">لا أوامر شغل بعد. ابدأ بـ«أمر شغل جديد».</td></tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
