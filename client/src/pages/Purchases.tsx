import { balanceOptionText } from "@/components/BalanceBadge";
import { CopyInline } from "@/components/CopyButton";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ListToolbar, RowActions } from "@/components/list";
import { confirm } from "@/lib/confirm";
import { fmt } from "@/lib/money";
import { notify } from "@/lib/notify";
import { printPO } from "@/lib/printing/printTemplates";
import { trpc } from "@/lib/trpc";
import { useMemo, useState } from "react";

const PO_STATUS: Record<string, string> = {
  DRAFT: "مسودّة",
  SENT: "مُرسَل",
  CONFIRMED: "مؤكّد",
  RECEIVED: "مُستلَم",
  CANCELLED: "ملغى",
};

const selectCls =
  "h-8 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export default function Purchases() {
  const utils = trpc.useUtils();
  const [q, setQ] = useState("");
  // فلاتر خادمية: فترة orderDate + المورد + الحالة (لا فلترة محلية تُخفي صفحات الخادم).
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [supplierId, setSupplierId] = useState<number | "">("");
  const [status, setStatus] = useState("");

  const suppliers = trpc.suppliers.list.useQuery();
  const query = trpc.purchases.list.useQuery({
    limit: 200,
    from: from || undefined,
    to: to || undefined,
    supplierId: supplierId ? Number(supplierId) : undefined,
    status: (status || undefined) as "DRAFT" | "SENT" | "CONFIRMED" | "RECEIVED" | "CANCELLED" | undefined,
  });
  const all = query.data ?? [];

  const cancelMut = trpc.purchases.cancel.useMutation({
    onSuccess: async () => {
      await utils.purchases.list.invalidate();
      notify.ok("أُلغي أمر الشراء");
    },
    onError: (e) => notify.err(e),
  });

  // إلغاء أمر شراء لم يُستلم منه شيء — الحارس النهائي في الخادم (يرفض أي أمر استُلمت منه بضاعة).
  async function cancelOrder(p: { id: number; poNumber: string; total: string }) {
    const ok = await confirm({
      variant: "danger",
      title: "إلغاء أمر الشراء",
      description: `سيُعلَّم الأمر ${p.poNumber} (بإجمالي ${fmt(p.total)} د.ع) «ملغى». لا يُلغى أمرٌ استُلمت منه بضاعة — لذلك استعمل مرتجع شراء. هل تتابع؟`,
      confirmText: "إلغاء الأمر",
      cancelText: "تراجع",
    });
    if (!ok) return;
    cancelMut.mutate({ purchaseOrderId: p.id });
  }

  const rows = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return all;
    return all.filter((p) => {
      const hay = `${p.poNumber ?? ""} ${p.supplierName ?? ""} ${PO_STATUS[p.status] ?? p.status ?? ""}`.toLowerCase();
      return hay.includes(term);
    });
  }, [all, q]);

  // طباعة أمر الشراء من القائمة: نجلب التفاصيل (purchases.get) ثم نطبع بقالب printPO المُعلَّم.
  async function printOrder(purchaseOrderId: number) {
    try {
      const d = await utils.purchases.get.fetch({ purchaseOrderId });
      if (!d) { notify.err("تعذّر جلب أمر الشراء"); return; }
      printPO({
        poNumber: d.poNumber,
        poDate: d.orderDate ? new Date(d.orderDate as unknown as string).toLocaleDateString("en-GB") : undefined,
        supplierName: d.supplierName,
        notes: d.notes,
        items: d.items.map((it) => ({
          productName: it.productName ?? "",
          unitName: it.unitName,
          quantity: it.quantity,
          unitPrice: it.unitPrice,
          total: it.total,
        })),
        subtotal: d.subtotal ?? "0",
        taxAmount: d.taxAmount ?? "0",
        total: d.total ?? "0",
      });
    } catch (e) {
      notify.err(e);
    }
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">المشتريات</h1>
      <p className="text-sm text-muted-foreground">أوامر الشراء وحالتها. أنشئ أمراً ثم استلمه ليُضاف للمخزون وتُسجَّل الذمم.</p>
      <Card>
        <CardHeader>
          <ListToolbar
            title="القائمة"
            count={rows.length}
            loading={query.isLoading}
            search={{
              value: q,
              onChange: setQ,
              placeholder: "بحث (رقم الأمر/المورد/الحالة)",
            }}
            filters={
              <>
                <Input type="date" dir="ltr" className="h-8 w-36" value={from} onChange={(e) => setFrom(e.target.value)} title="من تاريخ" />
                <Input type="date" dir="ltr" className="h-8 w-36" value={to} onChange={(e) => setTo(e.target.value)} title="إلى تاريخ" />
                <select
                  className={selectCls}
                  value={supplierId}
                  onChange={(e) => setSupplierId(e.target.value ? Number(e.target.value) : "")}
                >
                  <option value="">— كل الموردين —</option>
                  {(suppliers.data ?? []).map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                      {balanceOptionText((s as { currentBalance?: string | null }).currentBalance, "supplier")}
                    </option>
                  ))}
                </select>
                <select className={selectCls} value={status} onChange={(e) => setStatus(e.target.value)}>
                  <option value="">— كل الحالات —</option>
                  {Object.entries(PO_STATUS).map(([k, v]) => (
                    <option key={k} value={k}>{v}</option>
                  ))}
                </select>
              </>
            }
            exportSpec={{
              filename: "المشتريات",
              rows,
              columns: [
                { key: "poNumber", header: "رقم الأمر" },
                { key: "supplierName", header: "المورد" },
                { key: "orderDate", header: "التاريخ", map: (r) => new Date(r.orderDate).toLocaleString("ar-IQ-u-nu-latn") },
                { key: "total", header: "الإجمالي", map: (r) => Number(r.total ?? 0) },
                { key: "paidAmount", header: "المدفوع", map: (r) => Number(r.paidAmount ?? 0) },
                { key: "status", header: "الحالة", map: (r) => PO_STATUS[r.status] ?? r.status },
              ],
            }}
            add={{ href: "/purchases/new", label: "أمر شراء جديد" }}
          />
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr className="text-end">
                <th className="p-2">رقم الأمر</th>
                <th className="p-2">المورد</th>
                <th className="p-2">التاريخ</th>
                <th className="p-2 text-start">الإجمالي</th>
                <th className="p-2 text-start">المدفوع</th>
                <th className="p-2">الحالة</th>
                <th className="p-2 text-center">إجراء</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => {
                const terminal = p.status === "RECEIVED" || p.status === "CANCELLED";
                return (
                  <tr key={p.id} className="border-t">
                    <td className="p-2"><CopyInline value={p.poNumber} /></td>
                    <td className="p-2">{p.supplierName ?? "—"}</td>
                    <td className="p-2">{new Date(p.orderDate).toLocaleString("ar-IQ-u-nu-latn")}</td>
                    <td className="p-2 text-left tabular-nums" dir="ltr">{fmt(p.total)}</td>
                    <td className="p-2 text-left tabular-nums" dir="ltr">{fmt(p.paidAmount)}</td>
                    <td className="p-2">{PO_STATUS[p.status] ?? p.status}</td>
                    <td className="p-2 text-center">
                      <RowActions
                        mode="auto"
                        actions={[
                          {
                            key: "receive",
                            label: terminal ? "عرض" : "استلام",
                            href: `/purchases/${p.id}/receive`,
                          },
                          { key: "print", label: "طباعة أمر الشراء", onSelect: () => void printOrder(p.id) },
                          {
                            key: "stmt",
                            label: "كشف حساب المورد",
                            href: `/suppliers-statement?id=${p.supplierId}`,
                            hidden: p.supplierId == null,
                          },
                          {
                            key: "preturn",
                            label: "مرتجع شراء",
                            href: "/purchase-returns/new",
                            // الإرجاع للمورد ممكن فقط بعد استلام البضاعة فعلياً.
                            hidden: p.status !== "RECEIVED",
                          },
                          {
                            key: "cancel",
                            label: "إلغاء الأمر",
                            variant: "destructive",
                            // الحارس النهائي خادمي (يرفض المستلَم جزئياً) — رسالته العربية تظهر عبر notify.err.
                            hidden: p.status === "RECEIVED" || p.status === "CANCELLED",
                            disabled: cancelMut.isPending,
                            onSelect: () => void cancelOrder({ id: p.id, poNumber: p.poNumber, total: String(p.total ?? "0") }),
                          },
                        ]}
                      />
                    </td>
                  </tr>
                );
              })}
              {!query.isLoading && rows.length === 0 && (
                <tr><td colSpan={7} className="p-6 text-center text-muted-foreground">لا أوامر شراء مطابقة.</td></tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
