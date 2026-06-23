import { CopyInline } from "@/components/CopyButton";
import { ListToolbar, RowActions } from "@/components/list";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { confirm } from "@/lib/confirm";
import { D, fmt, round2 } from "@/lib/money";
import { trpc } from "@/lib/trpc";
import { useMemo, useState } from "react";
import { Link } from "wouter";

const INVOICE_STATUS: Record<string, string> = {
  PENDING: "معلّقة",
  CONFIRMED: "مؤكّدة",
  PAID: "مدفوعة",
  PARTIALLY_PAID: "مدفوعة جزئياً",
  CANCELLED: "ملغاة",
  RETURNED: "مرتجعة",
};

const METHODS: { v: "CASH" | "CARD" | "CHECK" | "TRANSFER" | "WALLET"; label: string }[] = [
  { v: "CASH", label: "نقدي" },
  { v: "TRANSFER", label: "تحويل" },
  { v: "CARD", label: "بطاقة" },
  { v: "WALLET", label: "محفظة" },
];

const selectCls =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export default function Returns() {
  const utils = trpc.useUtils();

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [qty, setQty] = useState<Record<number, string>>({});
  const [restock, setRestock] = useState(true);
  const [refundAmount, setRefundAmount] = useState("");
  const [refundMethod, setRefundMethod] = useState<(typeof METHODS)[number]["v"]>("CASH");
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const [q, setQ] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("");

  const invoicesQuery = trpc.sales.list.useQuery({ limit: 50 });

  const filteredInvoices = useMemo(() => {
    const all = invoicesQuery.data ?? [];
    const needle = q.trim().toLowerCase();
    return all.filter((inv) => {
      if (statusFilter && inv.status !== statusFilter) return false;
      if (!needle) return true;
      return (
        String(inv.invoiceNumber ?? "").toLowerCase().includes(needle) ||
        String(inv.total ?? "").toLowerCase().includes(needle)
      );
    });
  }, [invoicesQuery.data, q, statusFilter]);
  const detail = trpc.returns.getInvoice.useQuery(
    { invoiceId: selectedId ?? 0 },
    { enabled: !!selectedId },
  );

  function pick(id: number) {
    setSelectedId(id);
    setQty({});
    setRefundAmount("");
    setRefundMethod("CASH");
    setRestock(true);
    setError("");
    setDone("");
  }

  function resetFields() {
    setQty({});
    setRefundAmount("");
    setRefundMethod("CASH");
    setRestock(true);
  }

  const create = trpc.returns.create.useMutation({
    onSuccess: async () => {
      setDone("تمّ تسجيل المرتجع بنجاح.");
      resetFields();
      await Promise.all([
        utils.sales.list.invalidate(),
        utils.returns.getInvoice.invalidate(),
      ]);
    },
    onError: (e) => setError(e.message),
  });

  async function submit() {
    setError("");
    setDone("");
    const data = detail.data;
    if (!data) return;
    if (data.status === "RETURNED" || data.status === "CANCELLED") {
      return setError("الفاتورة ملغاة أو مرتجعة بالكامل — لا يمكن تسجيل مرتجع جديد.");
    }

    // مصدر واحد لقراءة الكمية: نصّ ⇒ تحقّق ⇒ عدد صحيح موجب ضمن المتبقّي.
    const lines: { invoiceItemId: number; baseQuantity: number }[] = [];
    for (const it of data.items) {
      const raw = (qty[it.invoiceItemId] ?? "").trim();
      if (!raw) continue;
      if (!/^\d+$/.test(raw)) {
        return setError(`كمية إرجاع غير صحيحة للمنتج «${it.productName}» — أدخل عدداً صحيحاً موجباً.`);
      }
      const want = parseInt(raw, 10);
      if (want <= 0) continue;
      if (want > it.remaining) {
        return setError(`كمية إرجاع المنتج «${it.productName}» تتجاوز المتبقّي (${it.remaining}).`);
      }
      lines.push({ invoiceItemId: it.invoiceItemId, baseQuantity: want });
    }
    if (!lines.length) return setError("أدخل كمية إرجاع واحدة على الأقل.");

    // مبلغ الاسترداد اختياري — تحقّق من صحّته قبل D() (decimal.js يرمي على غير الرقمي).
    let refund: { amount: string; method: typeof refundMethod } | undefined;
    const refundStr = refundAmount.trim();
    if (refundStr) {
      if (!/^\d+(\.\d+)?$/.test(refundStr)) {
        return setError("مبلغ الاسترداد غير صالح — أدخل رقماً.");
      }
      // حمولة API لا عرض — أرقام صرفة بلا فواصل آلاف (zod moneyStr يرفض الفواصل).
      if (D(refundStr).gt(0)) refund = { amount: round2(D(refundStr)).toFixed(2), method: refundMethod };
    }

    if (
      !(await confirm({
        variant: "danger",
        title: "تأكيد مرتجع البيع",
        description: `تسجيل مرتجع البيع للفاتورة «${data.invoiceNumber}» سينقل المخزون والذمم. متابعة؟`,
        confirmText: "تسجيل",
      }))
    )
      return;

    create.mutate({ invoiceId: data.id, lines, refund, restock });
  }

  return (
    <div className="space-y-4 max-w-4xl">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">المرتجعات</h1>
        <Link href="/invoices" className="text-sm text-muted-foreground">← رجوع للمبيعات</Link>
      </div>
      <p className="text-sm text-muted-foreground">اختر فاتورة، حدّد كميات الإرجاع (بالوحدة الأساس)، ثم أكّد. يُعاد للمخزون اختيارياً ويُسجَّل الاسترداد.</p>

      <Card>
        <CardHeader>
          <ListToolbar
            title="اختيار الفاتورة"
            count={filteredInvoices.length}
            loading={invoicesQuery.isLoading}
            search={{
              value: q,
              onChange: setQ,
              placeholder: "بحث (رقم الفاتورة/الإجمالي)",
            }}
            filters={
              <select
                className={selectCls + " h-8 w-44"}
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
              >
                <option value="">كل الحالات</option>
                {Object.entries(INVOICE_STATUS).map(([v, label]) => (
                  <option key={v} value={v}>{label}</option>
                ))}
              </select>
            }
            exportSpec={{
              filename: "فواتير-للمرتجعات",
              rows: filteredInvoices,
              columns: [
                { key: "invoiceNumber", header: "رقم الفاتورة" },
                { key: "total", header: "الإجمالي", map: (r) => Number(r.total ?? 0) },
                { key: "status", header: "الحالة", map: (r) => INVOICE_STATUS[r.status] ?? r.status },
              ],
            }}
          />
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr className="text-end">
                <th className="p-2">رقم الفاتورة</th>
                <th className="p-2 text-start">الإجمالي</th>
                <th className="p-2">الحالة</th>
                <th className="p-2 text-center">إجراء</th>
              </tr>
            </thead>
            <tbody>
              {filteredInvoices.map((inv) => {
                const id = Number(inv.id);
                const isPicked = selectedId === id;
                return (
                  <tr key={inv.id} className={`border-t ${isPicked ? "bg-muted/40" : ""}`}>
                    <td className="p-2"><CopyInline value={inv.invoiceNumber} /></td>
                    <td className="p-2 text-left" dir="ltr">{fmt(inv.total)}</td>
                    <td className="p-2">{INVOICE_STATUS[inv.status] ?? inv.status}</td>
                    <td className="p-2 text-center">
                      <RowActions
                        mode="inline"
                        actions={[
                          {
                            key: "pick",
                            label: isPicked ? "محدّدة" : "اختيار",
                            disabled: isPicked, // منع مسح الكميات المُدخَلة بنقرة سهو
                            onSelect: () => pick(id),
                          },
                          { key: "view", label: "عرض الفاتورة", href: `/invoices/${id}` },
                        ]}
                      />
                    </td>
                  </tr>
                );
              })}
              {!invoicesQuery.isLoading && filteredInvoices.length === 0 && (
                <tr><td colSpan={4} className="p-6 text-center text-muted-foreground">
                  {(invoicesQuery.data ?? []).length === 0 ? "لا فواتير بعد." : "لا فواتير مطابقة. غيّر البحث أو الفلتر."}
                </td></tr>
              )}
              {invoicesQuery.isLoading && (
                <tr><td colSpan={4} className="p-6 text-center text-muted-foreground">جارٍ التحميل…</td></tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {selectedId && detail.isLoading && (
        <div className="p-6 text-center text-muted-foreground">جارٍ تحميل بنود الفاتورة…</div>
      )}
      {selectedId && !detail.isLoading && !detail.data && (
        <div className="p-6 text-center text-muted-foreground">الفاتورة غير موجودة.</div>
      )}

      {detail.data && (
        <>
          <Card>
            <CardHeader><CardTitle className="text-base">بيانات الفاتورة</CardTitle></CardHeader>
            <CardContent className="grid grid-cols-2 md:grid-cols-5 gap-3 text-sm">
              <div><div className="text-muted-foreground text-xs">رقم الفاتورة</div><div className="font-mono" dir="ltr">{detail.data.invoiceNumber}</div></div>
              <div><div className="text-muted-foreground text-xs">العميل</div><div>{detail.data.customerName ?? "نقدي"}</div></div>
              <div><div className="text-muted-foreground text-xs">الحالة</div><div>{INVOICE_STATUS[detail.data.status] ?? detail.data.status}</div></div>
              <div><div className="text-muted-foreground text-xs">الإجمالي</div><div dir="ltr">{fmt(detail.data.total)}</div></div>
              <div><div className="text-muted-foreground text-xs">المدفوع</div><div dir="ltr">{fmt(detail.data.paidAmount)}</div></div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-base">البنود</CardTitle></CardHeader>
            <CardContent className="p-0">
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr className="text-end">
                    <th className="p-2">المنتج</th>
                    <th className="p-2">الوحدة</th>
                    <th className="p-2 text-center">المُباع (أساس)</th>
                    <th className="p-2 text-center">المُرتجع</th>
                    <th className="p-2 text-center">المتبقّي</th>
                    <th className="p-2 text-start">السعر</th>
                    <th className="p-2 w-32 text-center">إرجاع الآن (أساس)</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.data.items.map((it) => (
                    <tr key={it.invoiceItemId} className="border-t">
                      <td className="p-2">{it.productName}{it.variantLabel ? ` — ${it.variantLabel}` : ""}</td>
                      <td className="p-2 text-muted-foreground">{it.unitName}</td>
                      <td className="p-2 text-center">{it.baseQuantity}</td>
                      <td className="p-2 text-center">{it.returnedBaseQuantity}</td>
                      <td className="p-2 text-center">{it.remaining}</td>
                      <td className="p-2 text-left" dir="ltr">{fmt(it.unitPrice)}</td>
                      <td className="p-2">
                        <Input
                          dir="ltr"
                          className="h-8 text-center"
                          value={qty[it.invoiceItemId] ?? ""}
                          placeholder="0"
                          disabled={it.remaining <= 0}
                          onChange={(e) => setQty((prev) => ({ ...prev, [it.invoiceItemId]: e.target.value }))}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-base">خيارات المرتجع</CardTitle></CardHeader>
            <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-4 items-end">
              <div className="space-y-1">
                <Label>إعادة للمخزون</Label>
                <label className="flex items-center gap-2 h-9 text-sm">
                  <input
                    type="checkbox"
                    className="size-4"
                    checked={restock}
                    onChange={(e) => setRestock(e.target.checked)}
                  />
                  <span className="text-muted-foreground">{restock ? "نعم، تُضاف للمخزون" : "لا تُضاف"}</span>
                </label>
              </div>
              <div className="space-y-1">
                <Label>مبلغ الاسترداد (اختياري)</Label>
                <Input dir="ltr" value={refundAmount} onChange={(e) => setRefundAmount(e.target.value)} placeholder="0" />
              </div>
              <div className="space-y-1">
                <Label>طريقة الاسترداد</Label>
                <select className={selectCls} value={refundMethod} onChange={(e) => setRefundMethod(e.target.value as typeof refundMethod)}>
                  {METHODS.map((m) => <option key={m.v} value={m.v}>{m.label}</option>)}
                </select>
              </div>
            </CardContent>
          </Card>

          {(detail.data.status === "RETURNED" || detail.data.status === "CANCELLED") && (
            <p className="text-sm text-amber-600">هذه الفاتورة {INVOICE_STATUS[detail.data.status]} — لا يمكن تسجيل مرتجع جديد.</p>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
          {done && <p className="text-sm text-emerald-600">{done}</p>}

          <div className="flex gap-2">
            <Button
              onClick={submit}
              disabled={create.isPending || detail.data.status === "RETURNED" || detail.data.status === "CANCELLED"}
            >
              {create.isPending ? "جارٍ التسجيل…" : "تأكيد المرتجع"}
            </Button>
            <Button variant="outline" onClick={() => { resetFields(); setError(""); setDone(""); }}>إعادة ضبط</Button>
          </div>
        </>
      )}
    </div>
  );
}
