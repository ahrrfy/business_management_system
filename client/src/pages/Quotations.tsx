import { CopyInline } from "@/components/CopyButton";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { ListToolbar, RowActions } from "@/components/list";
import { trpc } from "@/lib/trpc";
import { useMemo, useState } from "react";

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
  const [q, setQ] = useState("");
  const fmt = (s: string | number) => Number(s).toLocaleString("ar-IQ", { maximumFractionDigits: 2 });

  const filtered = useMemo(() => {
    const all = rows.data ?? [];
    const needle = q.trim().toLowerCase();
    if (!needle) return all;
    return all.filter((r) =>
      [r.quoteNumber, r.customerName, STATUS[r.status] ?? r.status]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(needle)),
    );
  }, [rows.data, q]);

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">عروض الأسعار</h1>
      <p className="text-sm text-muted-foreground">عروض الأسعار مستندات تفاوضية بلا أثر على المخزون حتى تُحوَّل إلى فاتورة.</p>
      <Card>
        <CardHeader>
          <ListToolbar
            title="القائمة"
            count={filtered.length}
            loading={rows.isLoading}
            search={{
              value: q,
              onChange: setQ,
              placeholder: "بحث (رقم العرض/العميل/الحالة)",
            }}
            exportSpec={{
              filename: "عروض الأسعار",
              rows: filtered,
              columns: [
                { key: "quoteNumber", header: "رقم العرض" },
                { key: "customerName", header: "العميل" },
                { key: "quoteDate", header: "التاريخ", map: (r) => new Date(r.quoteDate).toLocaleDateString("ar-IQ") },
                { key: "validUntil", header: "الصلاحية", map: (r) => (r.validUntil ? String(r.validUntil).slice(0, 10) : "") },
                { key: "total", header: "الإجمالي", map: (r) => Number(r.total ?? 0) },
                { key: "status", header: "الحالة", map: (r) => STATUS[r.status] ?? r.status },
              ],
            }}
            add={{ href: "/quotations/new", label: "عرض سعر جديد" }}
          />
        </CardHeader>
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
              {filtered.map((qr) => (
                <tr key={qr.id} className="border-t">
                  <td className="p-2"><CopyInline value={qr.quoteNumber} /></td>
                  <td className="p-2">{qr.customerName ?? "—"}</td>
                  <td className="p-2">{new Date(qr.quoteDate).toLocaleDateString("ar-IQ")}</td>
                  <td className="p-2 text-xs">{qr.validUntil ? String(qr.validUntil).slice(0, 10) : "—"}</td>
                  <td className="p-2 text-left tabular-nums" dir="ltr">{fmt(qr.total)}</td>
                  <td className="p-2">
                    <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${STATUS_CLS[qr.status] ?? "bg-muted"}`}>
                      {STATUS[qr.status] ?? qr.status}
                    </span>
                  </td>
                  <td className="p-2 text-center">
                    <RowActions
                      mode="inline"
                      actions={[
                        { key: "open", label: "فتح", href: `/quotations/${qr.id}` },
                      ]}
                    />
                  </td>
                </tr>
              ))}
              {!rows.isLoading && filtered.length === 0 && (
                <tr><td colSpan={7} className="p-6 text-center text-muted-foreground">لا عروض أسعار مطابقة.</td></tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
