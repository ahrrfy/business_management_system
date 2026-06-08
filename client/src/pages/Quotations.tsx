import { CopyInline } from "@/components/CopyButton";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { exportRows } from "@/lib/export";
import { trpc } from "@/lib/trpc";
import { Link } from "wouter";

const STATUS: Record<string, string> = {
  DRAFT: "مسودّة",
  SENT: "مُرسَل",
  ACCEPTED: "مقبول",
  REJECTED: "مرفوض",
  CONVERTED: "محوّل لفاتورة",
  EXPIRED: "منتهٍ",
};
const STATUS_CLS: Record<string, string> = {
  DRAFT: "bg-muted text-foreground/70",
  SENT: "bg-blue-100 text-blue-700",
  ACCEPTED: "bg-violet-100 text-violet-700",
  REJECTED: "bg-rose-100 text-rose-700",
  CONVERTED: "bg-emerald-100 text-emerald-700",
  EXPIRED: "bg-amber-100 text-amber-700",
};

export default function Quotations() {
  const rows = trpc.quotations.list.useQuery({ limit: 200 });
  const fmt = (s: string | number) => Number(s).toLocaleString("ar-IQ", { maximumFractionDigits: 2 });
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">عروض الأسعار</h1>
        <div className="flex gap-2">
          <Button
            variant="outline"
            disabled={!rows.data?.length}
            onClick={() => exportRows(rows.data ?? [], {
              filename: "عروض-الأسعار",
              columns: [
                { key: "quoteNumber", header: "رقم العرض" },
                { key: "customerName", header: "العميل", map: (r) => r.customerName ?? "" },
                { key: "quoteDate", header: "التاريخ", map: (r) => new Date(r.quoteDate).toLocaleDateString("ar-IQ") },
                { key: "validUntil", header: "الصلاحية", map: (r) => r.validUntil ? String(r.validUntil).slice(0, 10) : "" },
                { key: "total", header: "الإجمالي", map: (r) => Number(r.total) },
                { key: "status", header: "الحالة", map: (r) => STATUS[r.status] ?? r.status },
              ],
            })}
          >تصدير Excel</Button>
          <Link href="/quotations/new"><Button>+ عرض سعر جديد</Button></Link>
        </div>
      </div>
      <p className="text-sm text-muted-foreground">عروض الأسعار مستندات تفاوضية بلا أثر على المخزون حتى تُحوَّل إلى فاتورة.</p>
      <Card>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr className="text-right">
                <th className="p-2">رقم العرض</th>
                <th className="p-2">العميل</th>
                <th className="p-2">التاريخ</th>
                <th className="p-2">الصلاحية</th>
                <th className="p-2 text-left">الإجمالي</th>
                <th className="p-2">الحالة</th>
                <th className="p-2 text-center">إجراء</th>
              </tr>
            </thead>
            <tbody>
              {(rows.data ?? []).map((q) => (
                <tr key={q.id} className="border-t">
                  <td className="p-2"><CopyInline value={q.quoteNumber} /></td>
                  <td className="p-2">{q.customerName ?? "—"}</td>
                  <td className="p-2">{new Date(q.quoteDate).toLocaleDateString("ar-IQ")}</td>
                  <td className="p-2 text-xs">{q.validUntil ? String(q.validUntil).slice(0, 10) : "—"}</td>
                  <td className="p-2 text-left tabular-nums" dir="ltr">{fmt(q.total)}</td>
                  <td className="p-2">
                    <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${STATUS_CLS[q.status] ?? "bg-muted"}`}>
                      {STATUS[q.status] ?? q.status}
                    </span>
                  </td>
                  <td className="p-2 text-center">
                    <Link href={`/quotations/${q.id}`}><Button variant="outline" size="sm">فتح</Button></Link>
                  </td>
                </tr>
              ))}
              {rows.data && rows.data.length === 0 && (
                <tr><td colSpan={7} className="p-6 text-center text-muted-foreground">لا عروض أسعار بعد.</td></tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
