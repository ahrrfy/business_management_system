import { CopyInline } from "@/components/CopyButton";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ListToolbar, RowActions } from "@/components/list";
import { PageHeader } from "@/components/PageHeader";
import { TableEmptyRow } from "@/components/PageState";
import { confirm } from "@/lib/confirm";
import { fmt } from "@/lib/money";
import { notify } from "@/lib/notify";
import { printQuotation } from "@/lib/printing/printTemplates";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { trpc } from "@/lib/trpc";
import { useState } from "react";

const STATUS: Record<string, string> = {
  DRAFT: "مسودّة",
  SENT: "مُرسَل",
  ACCEPTED: "مقبول",
  REJECTED: "مرفوض",
  CONVERTED: "محوّل لفاتورة",
  EXPIRED: "منتهٍ",
};
const STATUS_CLS: Record<string, string> = {
  DRAFT: "bg-muted text-muted-foreground",
  SENT: "badge-status-pending",
  ACCEPTED: "badge-status-done",
  REJECTED: "badge-stock-out",
  CONVERTED: "badge-status-active",
  EXPIRED: "badge-stock-low",
};

const selectCls =
  "h-8 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export default function Quotations() {
  const utils = trpc.useUtils();
  const [q, setQ] = useState("");
  // فلاتر خادمية: فترة createdAt + الحالة (لا فلترة محلية تُخفي صفحات الخادم).
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [status, setStatus] = useState("");

  // البحث خادمي الآن (q ممهَّل): رقم العرض/اسم العميل/الملاحظات عبر كل النتائج لا المُحمَّل فقط.
  const dq = useDebouncedValue(q, 250);
  const listInput = {
    from: from || undefined,
    to: to || undefined,
    status: (status || undefined) as "DRAFT" | "SENT" | "ACCEPTED" | "REJECTED" | "CONVERTED" | "EXPIRED" | undefined,
    q: dq.trim() || undefined,
  };
  const rows = trpc.quotations.list.useQuery({ ...listInput, limit: 200 });
  const items = rows.data ?? [];

  // «وضع مُرسَل» من القائمة مباشرة (DRAFT → SENT فقط؛ بقية الانتقالات من شاشة العرض).
  const setStatusMut = trpc.quotations.setStatus.useMutation({
    onSuccess: async () => {
      notify.ok("عُلِّم العرض «مُرسَلاً».");
      await utils.quotations.list.invalidate();
    },
    onError: (e) => notify.err(e),
  });

  // طباعة العرض من القائمة: نجلب التفاصيل (quotations.get) ثم نطبع بنفس قالب شاشة العرض.
  async function printQuote(quotationId: number) {
    try {
      const d = await utils.quotations.get.fetch({ quotationId });
      if (!d) { notify.err("تعذّر جلب عرض السعر"); return; }
      printQuotation({
        quoteNumber: d.quoteNumber,
        quoteDate: d.quoteDate ? String(d.quoteDate).slice(0, 10) : undefined,
        validUntil: d.validUntil ? String(d.validUntil).slice(0, 10) : undefined,
        customerName: d.customerName,
        notes: d.notes,
        items: d.items.map((it) => ({
          productName: it.productName ?? "",
          variantName: it.variantName,
          unitName: it.unitName,
          quantity: it.quantity,
          unitPrice: it.unitPrice,
          total: it.total,
        })),
        subtotal: d.subtotal,
        taxAmount: d.taxAmount,
        total: d.total,
      });
    } catch (e) {
      notify.err(e);
    }
  }

  return (
    <div className="space-y-4">
      <PageHeader title="عروض الأسعار" description="عروض الأسعار مستندات تفاوضية بلا أثر على المخزون حتى تُحوَّل إلى فاتورة." />
      <Card>
        <CardHeader>
          <ListToolbar
            title="القائمة"
            count={items.length}
            loading={rows.isLoading}
            search={{
              value: q,
              onChange: setQ,
              placeholder: "بحث (رقم العرض/العميل/ملاحظات)",
            }}
            filters={
              <>
                <Input type="date" dir="ltr" className="h-8 w-36" value={from} onChange={(e) => setFrom(e.target.value)} title="من تاريخ" />
                <Input type="date" dir="ltr" className="h-8 w-36" value={to} onChange={(e) => setTo(e.target.value)} title="إلى تاريخ" />
                <select className={selectCls} value={status} onChange={(e) => setStatus(e.target.value)}>
                  <option value="">— كل الحالات —</option>
                  {Object.entries(STATUS).map(([k, v]) => (
                    <option key={k} value={k}>{v}</option>
                  ))}
                </select>
              </>
            }
            exportSpec={{
              filename: "عروض الأسعار",
              rows: items,
              fetchAll: () => utils.quotations.list.fetch({ ...listInput, limit: 100000 }).then((arr) => arr ?? []),
              columns: [
                { key: "quoteNumber", header: "رقم العرض" },
                { key: "customerName", header: "العميل" },
                { key: "quoteDate", header: "التاريخ", map: (r) => new Date(r.quoteDate).toLocaleDateString("ar-IQ-u-nu-latn") },
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
              <tr>
                <th className="p-2">رقم العرض</th>
                <th className="p-2">العميل</th>
                <th className="p-2">التاريخ</th>
                <th className="p-2">الصلاحية</th>
                <th className="p-2 text-right">الإجمالي</th>
                <th className="p-2">الحالة</th>
                <th className="p-2 text-center">إجراء</th>
              </tr>
            </thead>
            <tbody>
              {items.map((qr) => (
                <tr key={qr.id} className="border-t">
                  <td className="p-2"><CopyInline value={qr.quoteNumber} /></td>
                  <td className="p-2">{qr.customerName ?? "—"}</td>
                  <td className="p-2">{new Date(qr.quoteDate).toLocaleDateString("ar-IQ-u-nu-latn")}</td>
                  <td className="p-2 text-xs">{qr.validUntil ? String(qr.validUntil).slice(0, 10) : "—"}</td>
                  <td className="p-2 text-right tabular-nums" dir="ltr">{fmt(qr.total)}</td>
                  <td className="p-2">
                    <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${STATUS_CLS[qr.status] ?? "bg-muted"}`}>
                      {STATUS[qr.status] ?? qr.status}
                    </span>
                  </td>
                  <td className="p-2 text-center">
                    <RowActions
                      mode="auto"
                      actions={[
                        { key: "open", label: "فتح", href: `/quotations/${qr.id}` },
                        { key: "print", label: "طباعة", onSelect: () => void printQuote(qr.id) },
                        {
                          key: "send",
                          label: "وضع مُرسَل",
                          onSelect: async () => {
                            if (!(await confirm({
                              variant: "warning",
                              title: "وضع العرض مُرسَلاً",
                              description: `وضع العرض «${qr.quoteNumber}» مُرسَلاً لا يُعكَس من القائمة. متابعة؟`,
                              confirmText: "وضع مُرسَل",
                            }))) return;
                            setStatusMut.mutate({ quotationId: qr.id, status: "SENT" });
                          },
                          hidden: qr.status !== "DRAFT",
                          disabled: setStatusMut.isPending,
                        },
                      ]}
                    />
                  </td>
                </tr>
              ))}
              {!rows.isLoading && items.length === 0 && (
                <TableEmptyRow colSpan={7} message="لا عروض أسعار مطابقة." />
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
