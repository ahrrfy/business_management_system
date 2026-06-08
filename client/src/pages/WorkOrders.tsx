import { CopyInline } from "@/components/CopyButton";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { ListToolbar, RowActions } from "@/components/list";
import { trpc } from "@/lib/trpc";
import { useMemo, useState } from "react";

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
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<string>("");
  const fmt = (s: string | number) => Number(s).toLocaleString("ar-IQ", { maximumFractionDigits: 2 });

  const filtered = useMemo(() => {
    const all = rows.data ?? [];
    const needle = q.trim().toLowerCase();
    return all.filter((w) => {
      if (status && w.status !== status) return false;
      if (!needle) return true;
      const hay = [w.orderNumber, w.title, w.customerName ?? ""].join(" ").toLowerCase();
      return hay.includes(needle);
    });
  }, [rows.data, q, status]);

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">أوامر الشغل/المطبعة</h1>
      <p className="text-sm text-muted-foreground">أوامر الطباعة والتخصيص: من الاستلام إلى التنفيذ والتسليم — فاتورة تلقائية عند التسليم.</p>
      <Card>
        <CardHeader>
          <ListToolbar
            title="القائمة"
            count={filtered.length}
            loading={rows.isLoading}
            search={{
              value: q,
              onChange: setQ,
              placeholder: "بحث (رقم/عنوان/عميل)",
            }}
            filters={
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value)}
                className="h-8 rounded-md border bg-background px-2 text-sm"
              >
                <option value="">كل الحالات</option>
                <option value="RECEIVED">مُستلَم</option>
                <option value="IN_PROGRESS">قيد التنفيذ</option>
                <option value="READY">جاهز للتسليم</option>
                <option value="DELIVERED">مُسلَّم</option>
                <option value="CANCELLED">ملغى</option>
              </select>
            }
            exportSpec={{
              filename: "أوامر-الشغل",
              rows: filtered,
              columns: [
                { key: "orderNumber", header: "رقم الأمر" },
                { key: "title", header: "العنوان" },
                { key: "customerName", header: "العميل", map: (r) => r.customerName ?? "" },
                { key: "quantity", header: "الكمية", map: (r) => Number(r.quantity ?? 0) },
                { key: "salePrice", header: "السعر", map: (r) => Number(r.salePrice ?? 0) },
                { key: "dueDate", header: "الاستحقاق", map: (r) => (r.dueDate ? String(r.dueDate).slice(0, 10) : "") },
                { key: "status", header: "الحالة", map: (r) => STATUS_LABEL[r.status] ?? r.status },
              ],
            }}
            add={{ href: "/work-orders/new", label: "أمر شغل جديد" }}
          />
        </CardHeader>
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
              {filtered.map((w) => (
                <tr key={w.id} className="border-t">
                  <td className="p-2"><CopyInline value={w.orderNumber} /></td>
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
                    <RowActions
                      mode="inline"
                      actions={[
                        { key: "open", label: "فتح", href: `/work-orders/${w.id}` },
                      ]}
                    />
                  </td>
                </tr>
              ))}
              {!rows.isLoading && filtered.length === 0 && (
                <tr><td colSpan={8} className="p-6 text-center text-muted-foreground">لا أوامر شغل مطابقة. ابدأ بـ«أمر شغل جديد».</td></tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
