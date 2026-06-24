import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BarcodeDisplay } from "@/components/BarcodeDisplay";
import { WhatsAppShare } from "@/components/WhatsAppShare";
import { CopyInline } from "@/components/CopyButton";
import { CopyAsMenu } from "@/lib/copy/CopyAsMenu";
import { formatInvoiceAsWhatsApp } from "@/lib/copy/formatters";
import { buildInvoiceMessage } from "@/lib/whatsapp";
import { confirm } from "@/lib/confirm";
import { printInvoiceA4 } from "@/lib/printing/printTemplates";
import { D, fmt, round2 } from "@/lib/money";
import { cn } from "@/lib/utils";
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
const SOURCE: Record<string, string> = { POS: "نقطة بيع", ONLINE: "أونلاين", ORDER: "طلب", WORKORDER: "طلب خدمة" };
const METHOD_LABEL: Record<string, string> = { CASH: "نقدي", CARD: "بطاقة", CHECK: "صك", TRANSFER: "تحويل", WALLET: "محفظة" };
const PAY_STATUS: Record<string, string> = { COMPLETED: "مكتملة", PENDING: "معلّقة", FAILED: "فاشلة", CANCELLED: "ملغاة" };
const METHODS: { v: "CASH" | "CARD" | "CHECK" | "TRANSFER" | "WALLET"; label: string }[] = [
  { v: "CASH", label: "نقدي" },
  { v: "TRANSFER", label: "تحويل" },
  { v: "CARD", label: "بطاقة" },
  { v: "WALLET", label: "محفظة" },
];
const selectCls =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

/** حقل وصفي: عنوان صغير + قيمة. */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-0.5 min-w-0">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="font-medium truncate">{children}</div>
    </div>
  );
}

/** سطر في لوحة الملخّص المالي: تسمية يميناً + مبلغ يساراً (LTR، بلا اقتطاع، قابل للنسخ). */
function SummaryRow({
  label,
  value,
  strong,
  tone,
}: {
  label: string;
  value: string;
  strong?: boolean;
  tone?: "amber" | "emerald";
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className={cn("text-muted-foreground", strong && "font-semibold text-foreground")}>{label}</span>
      <span
        dir="ltr"
        className={cn(
          "tabular-nums",
          strong ? "text-lg font-bold" : "text-sm",
          tone === "amber" && "text-amber-600",
          tone === "emerald" && "text-emerald-600",
        )}
      >
        <CopyInline value={value} display={fmt(value)} mono={false} />
      </span>
    </div>
  );
}

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
  const hasDiscount = D(data.discountAmount ?? "0").gt(0);
  const hasTax = D(data.taxAmount ?? "0").gt(0);

  async function submit() {
    setError("");
    setDone("");
    const amt = D(payAmount || "0");
    if (amt.lte(0)) return setError("أدخل مبلغاً موجباً.");
    if (amt.gt(remaining)) return setError(`المبلغ يتجاوز المتبقّي (${fmt(remaining.toFixed(2))}).`);
    const methodLabel = METHOD_LABEL[payMethod] ?? payMethod;
    if (
      !(await confirm({
        variant: "info",
        title: "تسجيل دفعة على الفاتورة؟",
        description: `سيُسجَّل دفع مبلغ ${fmt(amt.toFixed(2))} (${methodLabel}) على الفاتورة ${data.invoiceNumber}. المتبقّي بعدها: ${fmt(round2(remaining.minus(amt)).toFixed(2))}.`,
        confirmText: "تسجيل الدفعة",
      }))
    )
      return;
    pay.mutate({ invoiceId, amount: amt.toFixed(2), method: payMethod, clientRequestId });
  }

  return (
    <div className="space-y-4 max-w-4xl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">تفاصيل الفاتورة</h1>
        <div className="flex flex-wrap items-center gap-2">
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
          <CopyAsMenu
            label="نسخ الفاتورة"
            plain={data.invoiceNumber}
            whatsapp={formatInvoiceAsWhatsApp({
              number: data.invoiceNumber,
              date: data.invoiceDate,
              customer: data.customerName,
              items: data.items.map((it) => ({
                name: `${it.productName ?? ""}${it.variantName ? ` — ${it.variantName}` : ""}`,
                qty: it.quantity,
                unit: it.unitName,
                price: it.unitPrice,
                total: it.total,
              })),
              subtotal: data.subtotal,
              discount: data.discountAmount,
              tax: data.taxAmount,
              total: data.total,
              paid: data.paidAmount,
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
          <Link href="/invoices" className="text-sm text-muted-foreground hover:text-foreground">← رجوع للمبيعات</Link>
        </div>
      </div>

      {/* بطاقة الترويسة: بيانات وصفية + لوحة ملخّص مالي */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center justify-between gap-2">
            <CopyInline value={data.invoiceNumber} />
            <span className={`text-xs rounded-full px-2.5 py-0.5 font-medium ${STATUS_CLS[data.status] ?? "bg-muted"}`}>
              {STATUS[data.status] ?? data.status}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-5 md:grid-cols-3">
            {/* البيانات الوصفية */}
            <div className="md:col-span-2 grid grid-cols-2 gap-x-6 gap-y-4 text-sm content-start">
              <Field label="المصدر">{SOURCE[data.sourceType] ?? data.sourceType}</Field>
              <Field label="العميل">{data.customerName ?? "عميل نقدي"}</Field>
              <Field label="التاريخ">{new Date(data.invoiceDate).toLocaleString("ar-IQ-u-nu-latn")}</Field>
              <Field label="الاستحقاق">{data.dueDate ? String(data.dueDate).slice(0, 10) : "—"}</Field>
              {data.customerId && (
                <div className="col-span-2 space-y-0.5">
                  <div className="text-xs text-muted-foreground">ذمة العميل الحالية</div>
                  <div className="font-medium tabular-nums" dir="ltr">
                    <CopyInline value={data.customerBalance ?? "0"} display={fmt(data.customerBalance ?? "0")} mono={false} />
                  </div>
                </div>
              )}
            </div>

            {/* لوحة الملخّص المالي */}
            <div className="rounded-lg border bg-muted/30 p-4 space-y-2.5 text-sm self-start">
              <SummaryRow label="قبل الضريبة" value={data.subtotal} />
              {hasDiscount && <SummaryRow label="الخصم" value={data.discountAmount} />}
              {hasTax && <SummaryRow label="الضريبة" value={data.taxAmount} />}
              <div className="border-t pt-2.5">
                <SummaryRow label="الإجمالي" value={data.total} strong />
              </div>
              <SummaryRow label="المدفوع" value={data.paidAmount} />
              <SummaryRow
                label="المتبقّي"
                value={remaining.toFixed(2)}
                tone={remaining.gt(0) ? "amber" : "emerald"}
              />
            </div>
          </div>

          {data.notes && (
            <div className="rounded-md bg-muted/40 p-3 text-sm">
              <div className="text-xs text-muted-foreground mb-1">ملاحظات</div>
              <div className="whitespace-pre-wrap">{data.notes}</div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-base">البنود</CardTitle></CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">المنتج</th>
                  <th className="px-3 py-2 font-medium">الوحدة</th>
                  <th className="px-3 py-2 font-medium text-center">الكمية</th>
                  <th className="px-3 py-2 font-medium text-left">سعر الوحدة</th>
                  <th className="px-3 py-2 font-medium text-left">إجمالي السطر</th>
                  <th className="px-3 py-2 font-medium text-center">مرتجع</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((it) => {
                  const returned = Number(it.returnedBaseQuantity) > 0;
                  return (
                    <tr key={it.id} className="border-t hover:bg-muted/30">
                      <td className="px-3 py-2">
                        {it.productName ?? "—"}{it.variantName ? ` — ${it.variantName}` : ""}{" "}
                        {it.sku && <span className="text-xs text-muted-foreground font-mono" dir="ltr">{it.sku}</span>}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">{it.unitName ?? "—"}</td>
                      <td className="px-3 py-2 text-center tabular-nums" dir="ltr">{it.quantity}</td>
                      <td className="px-3 py-2 text-left tabular-nums"><CopyInline value={it.unitPrice} display={fmt(it.unitPrice)} /></td>
                      <td className="px-3 py-2 text-left tabular-nums"><CopyInline value={it.total} display={fmt(it.total)} /></td>
                      <td className="px-3 py-2 text-center text-xs tabular-nums" dir="ltr">
                        <span className={returned ? "text-amber-600 font-medium" : "text-muted-foreground"}>
                          {it.returnedBaseQuantity}/{it.baseQuantity}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="border-t-2 bg-muted/40 font-semibold">
                  <td className="px-3 py-2" colSpan={4}>مجموع البنود</td>
                  <td className="px-3 py-2 text-left tabular-nums" dir="ltr">{fmt(data.subtotal)}</td>
                  <td className="px-3 py-2"></td>
                </tr>
              </tfoot>
            </table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-base">سجل الدفعات</CardTitle></CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">التاريخ</th>
                  <th className="px-3 py-2 font-medium">الاتجاه</th>
                  <th className="px-3 py-2 font-medium">الطريقة</th>
                  <th className="px-3 py-2 font-medium text-left">المبلغ</th>
                  <th className="px-3 py-2 font-medium">الحالة</th>
                </tr>
              </thead>
              <tbody>
                {(data.payments ?? []).map((p) => (
                  <tr key={p.id} className="border-t hover:bg-muted/30">
                    <td className="px-3 py-2">{new Date(p.createdAt).toLocaleString("ar-IQ-u-nu-latn")}</td>
                    <td className="px-3 py-2">
                      <span className={cn(
                        "inline-flex rounded-full px-2 py-0.5 text-xs font-medium",
                        p.direction === "IN" ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700",
                      )}>
                        {p.direction === "IN" ? "وارد" : "صادر"}
                      </span>
                    </td>
                    <td className="px-3 py-2">{METHOD_LABEL[p.paymentMethod] ?? p.paymentMethod}</td>
                    <td className="px-3 py-2 text-left tabular-nums"><CopyInline value={p.amount} display={fmt(p.amount)} /></td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">{PAY_STATUS[p.status] ?? p.status}</td>
                  </tr>
                ))}
                {(data.payments ?? []).length === 0 && (
                  <tr><td colSpan={5} className="p-4 text-center text-muted-foreground">لا دفعات بعد.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {canPay && remaining.gt(0) && (
        <Card>
          <CardHeader className="pb-3"><CardTitle className="text-base">تسديد دفعة</CardTitle></CardHeader>
          <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-4 items-end">
            <div className="space-y-1">
              <Label>المبلغ (المتبقّي: <CopyInline value={remaining.toFixed(2)} display={fmt(remaining.toFixed(2))} mono={false} />)</Label>
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
          <CardHeader className="pb-3"><CardTitle className="text-base">باركود الفاتورة</CardTitle></CardHeader>
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
