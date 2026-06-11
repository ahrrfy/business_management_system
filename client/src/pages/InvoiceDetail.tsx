import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BarcodeDisplay } from "@/components/BarcodeDisplay";
import { WhatsAppShare } from "@/components/WhatsAppShare";
import { buildInvoiceMessage } from "@/lib/whatsapp";
import { printInvoiceA4 } from "@/lib/printing/printTemplates";
import { D, fmt, round2 } from "@/lib/money";
import { trpc } from "@/lib/trpc";
import { useEffect, useState } from "react";
import { Link, useParams } from "wouter";

const STATUS: Record<string, string> = {
  PENDING: "معلّقة",
  PARTIALLY_PAID: "مدفوعة جزئياً",
  PAID: "مدفوعة",
  CONFIRMED: "مؤكّدة",
  CANCELLED: "ملغاة",
  RETURNED: "مرتجعة",
};
const STATUS_CLS: Record<string, string> = {
  PAID: "bg-emerald-100 text-emerald-700",
  PARTIALLY_PAID: "bg-amber-100 text-amber-700",
  PENDING: "bg-muted text-foreground/70",
  RETURNED: "bg-rose-100 text-rose-700",
  CANCELLED: "bg-rose-100 text-rose-700",
};
const SOURCE: Record<string, string> = { POS: "نقطة بيع", ONLINE: "أونلاين", ORDER: "طلب", WORKORDER: "أمر شغل" };
const METHOD_LABEL: Record<string, string> = { CASH: "نقد", CARD: "بطاقة", CHECK: "صك", TRANSFER: "تحويل", WALLET: "محفظة" };
const METHODS: { v: "CASH" | "CARD" | "CHECK" | "TRANSFER" | "WALLET"; label: string }[] = [
  { v: "CASH", label: "نقد" },
  { v: "TRANSFER", label: "تحويل" },
  { v: "CHECK", label: "صك" },
  { v: "CARD", label: "بطاقة" },
  { v: "WALLET", label: "محفظة" },
];
const selectCls =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export default function InvoiceDetail() {
  const params = useParams();
  const invoiceId = Number(params.id);
  const utils = trpc.useUtils();
  const inv = trpc.sales.get.useQuery({ invoiceId }, { enabled: Number.isFinite(invoiceId) });

  const [payAmount, setPayAmount] = useState("");
  const [payMethod, setPayMethod] = useState<(typeof METHODS)[number]["v"]>("CASH");
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  // idempotency: مفتاح ثابت لكل دفعة (يتجدّد بعد النجاح) ⇒ نقرة مزدوجة لا تُسجّل دفعتين.
  const [clientRequestId, setClientRequestId] = useState(() => crypto.randomUUID());

  // Default the payment amount to remaining balance once data loads.
  useEffect(() => {
    if (!inv.data) return;
    const remaining = round2(D(inv.data.total).minus(D(inv.data.paidAmount)));
    setPayAmount(remaining.gt(0) ? remaining.toFixed(2) : "");
  }, [inv.data]);

  const pay = trpc.sales.pay.useMutation({
    onSuccess: async (r) => {
      setDone(`تم تسجيل الدفعة. الحالة: ${STATUS[r.status] ?? r.status}.`);
      setError("");
      await Promise.all([
        utils.sales.get.invalidate({ invoiceId }),
        utils.sales.list.invalidate(),
      ]);
      setClientRequestId(crypto.randomUUID()); // مفتاح جديد للدفعة التالية
    },
    onError: (e) => { setError(e.message); setDone(""); },
  });

  if (inv.isLoading) return <div className="p-10 text-center text-muted-foreground">جارٍ التحميل…</div>;
  if (!inv.data) return <div className="p-10 text-center text-muted-foreground">الفاتورة غير موجودة.</div>;
  const data = inv.data;
  const remaining = round2(D(data.total).minus(D(data.paidAmount)));
  const canPay = data.status === "PENDING" || data.status === "PARTIALLY_PAID";

  function submit() {
    setError("");
    setDone("");
    const amt = D(payAmount || "0");
    if (amt.lte(0)) return setError("أدخل مبلغاً موجباً.");
    if (amt.gt(remaining)) return setError(`المبلغ يتجاوز المتبقّي (${fmt(remaining.toFixed(2))}).`);
    pay.mutate({ invoiceId, amount: amt.toFixed(2), method: payMethod, clientRequestId });
  }

  return (
    <div className="space-y-4 max-w-4xl">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">تفاصيل الفاتورة</h1>
        <div className="flex items-center gap-3">
          <WhatsAppShare
            phone={data.customerPhone}
            message={buildInvoiceMessage({
              invoiceNumber: data.invoiceNumber,
              invoiceDate: String(data.invoiceDate),
              customerName: data.customerName,
              items: data.items.map((it) => ({
                productName: it.productName ?? "",
                quantity: it.quantity,
                unitName: it.unitName,
                total: it.total,
              })),
              total: data.total,
              paidAmount: data.paidAmount,
              remaining: remaining.toFixed(2),
            })}
          />
          <Button variant="outline" size="sm" onClick={async () => printInvoiceA4({
            invoiceNumber: data.invoiceNumber,
            invoiceDate: data.invoiceDate,
            customerName: data.customerName,
            subtotal: data.subtotal,
            discountAmount: data.discountAmount,
            taxAmount: data.taxAmount,
            total: data.total,
            paidAmount: data.paidAmount,
            items: data.items.map((it) => ({ productName: it.productName ?? "", unitName: it.unitName, quantity: it.quantity, unitPrice: it.unitPrice, total: it.total })),
          })}>طباعة A4 / حفظ PDF</Button>
          <Link href="/invoices" className="text-sm text-muted-foreground">← رجوع للمبيعات</Link>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center justify-between">
            <span className="font-mono" dir="ltr">{data.invoiceNumber}</span>
            <span className={`text-xs rounded-full px-2 py-0.5 ${STATUS_CLS[data.status] ?? "bg-muted"}`}>
              {STATUS[data.status] ?? data.status}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
          <div><div className="text-muted-foreground text-xs">المصدر</div><div>{SOURCE[data.sourceType] ?? data.sourceType}</div></div>
          <div><div className="text-muted-foreground text-xs">العميل</div><div>{data.customerName ?? "عميل عابر"}</div></div>
          <div><div className="text-muted-foreground text-xs">التاريخ</div><div>{new Date(data.invoiceDate).toLocaleString("ar-IQ-u-nu-latn")}</div></div>
          <div><div className="text-muted-foreground text-xs">الاستحقاق</div><div>{data.dueDate ? String(data.dueDate).slice(0, 10) : "—"}</div></div>
          <div><div className="text-muted-foreground text-xs">قبل الضريبة</div><div dir="ltr" className="tabular-nums">{fmt(data.subtotal)}</div></div>
          <div><div className="text-muted-foreground text-xs">الضريبة</div><div dir="ltr" className="tabular-nums">{fmt(data.taxAmount)}</div></div>
          <div><div className="text-muted-foreground text-xs">الإجمالي</div><div dir="ltr" className="tabular-nums font-semibold">{fmt(data.total)}</div></div>
          <div><div className="text-muted-foreground text-xs">المدفوع / المتبقّي</div><div dir="ltr" className="tabular-nums">{fmt(data.paidAmount)} / <span className={remaining.gt(0) ? "text-amber-600" : "text-emerald-600"}>{fmt(remaining.toFixed(2))}</span></div></div>
          {data.customerId && (
            <div className="md:col-span-4"><div className="text-muted-foreground text-xs">ذمة العميل الحالية</div><div dir="ltr" className="tabular-nums">{fmt(data.customerBalance ?? "0")}</div></div>
          )}
          {data.notes && (
            <div className="md:col-span-4"><div className="text-muted-foreground text-xs">ملاحظات</div><div className="whitespace-pre-wrap">{data.notes}</div></div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">البنود</CardTitle></CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr className="text-right">
                <th className="p-2">الصنف</th>
                <th className="p-2">الوحدة</th>
                <th className="p-2 text-center">الكمية</th>
                <th className="p-2 text-left">سعر الوحدة</th>
                <th className="p-2 text-left">إجمالي السطر</th>
                <th className="p-2 text-center">مرتجع</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((it) => (
                <tr key={it.id} className="border-t">
                  <td className="p-2">{it.productName ?? "—"}{it.variantName ? ` — ${it.variantName}` : ""} <span className="text-xs text-muted-foreground font-mono" dir="ltr">{it.sku ?? ""}</span></td>
                  <td className="p-2 text-muted-foreground">{it.unitName ?? "—"}</td>
                  <td className="p-2 text-center tabular-nums" dir="ltr">{it.quantity}</td>
                  <td className="p-2 text-left tabular-nums" dir="ltr">{fmt(it.unitPrice)}</td>
                  <td className="p-2 text-left tabular-nums" dir="ltr">{fmt(it.total)}</td>
                  <td className="p-2 text-center text-xs">{it.returnedBaseQuantity}/{it.baseQuantity}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">سجل الدفعات</CardTitle></CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr className="text-right">
                <th className="p-2">التاريخ</th>
                <th className="p-2">الاتجاه</th>
                <th className="p-2">الطريقة</th>
                <th className="p-2 text-left">المبلغ</th>
                <th className="p-2">الحالة</th>
              </tr>
            </thead>
            <tbody>
              {(data.payments ?? []).map((p) => (
                <tr key={p.id} className="border-t">
                  <td className="p-2">{new Date(p.createdAt).toLocaleString("ar-IQ-u-nu-latn")}</td>
                  <td className="p-2">{p.direction === "IN" ? "وارد" : "صادر"}</td>
                  <td className="p-2">{METHOD_LABEL[p.paymentMethod] ?? p.paymentMethod}</td>
                  <td className="p-2 text-left tabular-nums" dir="ltr">{fmt(p.amount)}</td>
                  <td className="p-2 text-xs text-muted-foreground">{p.status}</td>
                </tr>
              ))}
              {(data.payments ?? []).length === 0 && (
                <tr><td colSpan={5} className="p-4 text-center text-muted-foreground">لا دفعات بعد.</td></tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {canPay && remaining.gt(0) && (
        <Card>
          <CardHeader><CardTitle className="text-base">تسديد دفعة</CardTitle></CardHeader>
          <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-4 items-end">
            <div className="space-y-1">
              <Label>المبلغ (المتبقّي: <span dir="ltr">{fmt(remaining.toFixed(2))}</span>)</Label>
              <Input dir="ltr" value={payAmount} onChange={(e) => setPayAmount(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>طريقة الدفع</Label>
              <select className={selectCls} value={payMethod} onChange={(e) => setPayMethod(e.target.value as typeof payMethod)}>
                {METHODS.map((m) => <option key={m.v} value={m.v}>{m.label}</option>)}
              </select>
            </div>
            <Button onClick={submit} disabled={pay.isPending}>{pay.isPending ? "جارٍ…" : "تسجيل الدفعة"}</Button>
          </CardContent>
        </Card>
      )}

      {/* باركود + QR الفاتورة */}
      {data.qrPayload && (
        <Card>
          <CardHeader><CardTitle className="text-base">باركود الفاتورة</CardTitle></CardHeader>
          <CardContent className="flex justify-center py-4">
            <BarcodeDisplay
              barcodeSet={{
                barcode128: data.invoiceNumber,
                qrPayload: data.qrPayload,
                displayLabel: `فاتورة: ${data.invoiceNumber}\n${new Date(data.invoiceDate).toLocaleDateString("ar-IQ-u-nu-latn")} — ${fmt(data.total)} د.ع`,
              }}
              size="md"
            />
          </CardContent>
        </Card>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}
      {done && <p className="text-sm text-emerald-600">{done}</p>}
    </div>
  );
}
