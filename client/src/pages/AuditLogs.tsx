import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { trpc } from "@/lib/trpc";
import { useMemo, useState } from "react";

const selectCls =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

const ACTION_AR: Record<string, string> = {
  "sale.create": "بيع", "sale.pay": "تسديد فاتورة", "return.create": "مرتجع",
  "purchase.createOrder": "أمر شراء", "purchase.receive": "استلام مشتريات",
  "inventory.transfer": "تحويل مخزون", "inventory.adjust": "تسوية مخزون",
  "product.create": "إنشاء منتج", "product.update": "تعديل منتج", "product.assignBarcode": "ربط باركود",
  "customer.create": "إنشاء عميل", "customer.update": "تعديل عميل", "customer.deactivate": "تعطيل عميل", "customer.activate": "تفعيل عميل",
  "supplier.create": "إنشاء مورّد", "supplier.update": "تعديل مورّد", "supplier.deactivate": "تعطيل مورّد", "supplier.activate": "تفعيل مورّد",
  "shift.open": "فتح وردية", "shift.close": "إغلاق وردية",
  "expense.create": "مصروف", "expense.cancel": "إلغاء مصروف",
  "workOrder.create": "أمر شغل", "workOrder.deliver": "تسليم أمر شغل", "workOrder.cancel": "إلغاء أمر شغل",
};

function dt(d: string | Date | null | undefined): string {
  if (!d) return "—";
  return new Date(d).toLocaleString("ar-IQ", { dateStyle: "short", timeStyle: "short" });
}

export default function AuditLogs() {
  const [action, setAction] = useState("");
  const [entityType, setEntityType] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(0);
  const limit = 50;

  const input = useMemo(
    () => ({
      action: action.trim() || undefined,
      entityType: entityType || undefined,
      from: from || undefined,
      to: to || undefined,
      limit,
      offset: page * limit,
    }),
    [action, entityType, from, to, page],
  );

  const facets = trpc.audit.facets.useQuery();
  const list = trpc.audit.list.useQuery(input);
  const rows = list.data?.rows ?? [];
  const total = list.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / limit));

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">سجلّ التدقيق</h1>
      <p className="text-sm text-muted-foreground">كل عملية حسّاسة: من نفّذها، ماذا، متى، ومن أيّ جهاز (IP). للأدمن فقط.</p>

      <Card>
        <CardHeader><CardTitle className="text-base">الفلاتر</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-4 gap-3 items-end">
          <div className="space-y-1">
            <Label>الفعل</Label>
            <Input value={action} onChange={(e) => { setAction(e.target.value); setPage(0); }} placeholder="مثل sale أو product" />
          </div>
          <div className="space-y-1">
            <Label>نوع الكيان</Label>
            <select className={selectCls} value={entityType} onChange={(e) => { setEntityType(e.target.value); setPage(0); }}>
              <option value="">الكل</option>
              {(facets.data?.entityTypes ?? []).map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <Label>من تاريخ</Label>
            <Input type="date" dir="ltr" value={from} onChange={(e) => { setFrom(e.target.value); setPage(0); }} />
          </div>
          <div className="space-y-1">
            <Label>إلى تاريخ</Label>
            <Input type="date" dir="ltr" value={to} onChange={(e) => { setTo(e.target.value); setPage(0); }} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle className="text-base">السجلّات</CardTitle>
          <div className="text-xs text-muted-foreground">{list.isLoading ? "جارٍ التحميل…" : `الإجمالي: ${total.toLocaleString("ar-IQ")}`}</div>
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr className="text-right">
                <th className="p-2">التاريخ والوقت</th>
                <th className="p-2">المستخدم</th>
                <th className="p-2">الفعل</th>
                <th className="p-2">الكيان</th>
                <th className="p-2">المعرّف</th>
                <th className="p-2">التفاصيل</th>
                <th className="p-2">IP</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={Number(r.id)} className="border-t align-top">
                  <td className="p-2 text-xs whitespace-nowrap" dir="ltr">{dt(r.createdAt as unknown as string)}</td>
                  <td className="p-2 text-xs">{r.userName ?? (r.userId ? `#${r.userId}` : "—")}</td>
                  <td className="p-2 text-xs font-medium">{ACTION_AR[r.action] ?? r.action}</td>
                  <td className="p-2 text-xs">{r.entityType}</td>
                  <td className="p-2 text-xs font-mono" dir="ltr">{r.entityId ?? "—"}</td>
                  <td className="p-2 text-xs text-muted-foreground max-w-[18rem] truncate" dir="ltr" title={JSON.stringify(r.newValue ?? r.oldValue ?? {})}>
                    {r.newValue ? JSON.stringify(r.newValue) : "—"}
                  </td>
                  <td className="p-2 text-xs font-mono" dir="ltr">{r.ipAddress ?? "—"}</td>
                </tr>
              ))}
              {!list.isLoading && rows.length === 0 && (
                <tr><td colSpan={7} className="p-6 text-center text-muted-foreground">لا سجلّات مطابقة.</td></tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {pages > 1 && (
        <div className="flex items-center justify-between text-sm">
          <Button variant="outline" size="sm" disabled={page <= 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>← السابق</Button>
          <div className="text-muted-foreground">صفحة {page + 1} من {pages}</div>
          <Button variant="outline" size="sm" disabled={page >= pages - 1} onClick={() => setPage((p) => p + 1)}>التالي →</Button>
        </div>
      )}
    </div>
  );
}
