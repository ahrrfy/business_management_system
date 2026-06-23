import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { WhatsAppShare } from "@/components/WhatsAppShare";
import { CopyInline } from "@/components/CopyButton";
import { CopyAsMenu } from "@/lib/copy/CopyAsMenu";
import { formatQuotationAsWhatsApp } from "@/lib/copy/formatters";
import { confirm } from "@/lib/confirm";
import { buildQuotationMessage } from "@/lib/whatsapp";
import { fmt } from "@/lib/money";
import { printQuotation } from "@/lib/printing/printTemplates";
import { trpc } from "@/lib/trpc";
import { useState } from "react";
import { Link, useParams } from "wouter";

const STATUS: Record<string, string> = {
  DRAFT: "مسودّة",
  SENT: "مُرسَل",
  ACCEPTED: "مقبول",
  REJECTED: "مرفوض",
  CONVERTED: "محوّل لفاتورة",
  EXPIRED: "منتهٍ",
};
const TIER: Record<string, string> = { RETAIL: "مفرد", WHOLESALE: "جملة", GOVERNMENT: "حكومي" };
const METHODS: { v: "CASH" | "CARD" | "CHECK" | "TRANSFER" | "WALLET"; label: string }[] = [
  { v: "CASH", label: "نقدي" },
  { v: "TRANSFER", label: "تحويل" },
  { v: "CARD", label: "بطاقة" },
  { v: "WALLET", label: "محفظة" },
];
const selectCls =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export default function QuotationDetail() {
  const params = useParams();
  const quotationId = Number(params.id);
  const utils = trpc.useUtils();
  const q = trpc.quotations.get.useQuery({ quotationId }, { enabled: Number.isFinite(quotationId) });

  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const [payAmount, setPayAmount] = useState("");
  const [payMethod, setPayMethod] = useState<(typeof METHODS)[number]["v"]>("CASH");

  const refresh = async () => {
    await Promise.all([utils.quotations.get.invalidate({ quotationId }), utils.quotations.list.invalidate()]);
  };

  const setStatus = trpc.quotations.setStatus.useMutation({
    onSuccess: async () => { setDone("تم تحديث الحالة."); setError(""); await refresh(); },
    onError: (e) => { setError(e.message); setDone(""); },
  });
  const convert = trpc.quotations.convert.useMutation({
    onSuccess: async (r) => {
      setDone(r.alreadyConverted ? "مُحوّل مسبقاً." : `تم التحويل فاتورة ${r.invoiceNumber ?? r.invoiceId}.`);
      setError("");
      await refresh();
    },
    onError: (e) => { setError(e.message); setDone(""); },
  });

  if (q.isLoading) return <div className="p-10 text-center text-muted-foreground">جارٍ التحميل…</div>;
  if (!q.data) return <div className="p-10 text-center text-muted-foreground">عرض السعر غير موجود.</div>;
  const data = q.data;
  const isOpen = data.status === "DRAFT" || data.status === "SENT" || data.status === "ACCEPTED";

  function printQuote() {
    printQuotation({
      quoteNumber: data.quoteNumber,
      quoteDate: data.quoteDate ? String(data.quoteDate).slice(0, 10) : undefined,
      validUntil: data.validUntil ? String(data.validUntil).slice(0, 10) : undefined,
      customerName: data.customerName,
      notes: data.notes,
      items: data.items.map((it) => ({
        productName: it.productName ?? "",
        variantName: it.variantName,
        unitName: it.unitName,
        quantity: it.quantity,
        unitPrice: it.unitPrice,
        total: it.total,
      })),
      subtotal: data.subtotal,
      taxAmount: data.taxAmount,
      total: data.total,
    });
  }

  return (
    <div className="space-y-4 max-w-4xl">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">عرض سعر</h1>
        <Link href="/quotations" className="text-sm text-muted-foreground">← رجوع للعروض</Link>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center justify-between">
            <CopyInline value={data.quoteNumber} />
            <span className="text-xs rounded-full px-2 py-0.5 bg-muted">{STATUS[data.status] ?? data.status}</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
          <div><div className="text-muted-foreground text-xs">العميل</div><div>{data.customerName ?? "—"}</div></div>
          <div><div className="text-muted-foreground text-xs">فئة السعر</div><div>{TIER[data.priceTier] ?? data.priceTier}</div></div>
          <div><div className="text-muted-foreground text-xs">التاريخ</div><div>{new Date(data.quoteDate).toLocaleDateString("ar-IQ-u-nu-latn")}</div></div>
          <div><div className="text-muted-foreground text-xs">صالح حتى</div><div>{data.validUntil ? String(data.validUntil).slice(0, 10) : "—"}</div></div>
          <div><div className="text-muted-foreground text-xs">المجموع</div><div dir="ltr" className="tabular-nums">{fmt(data.subtotal)}</div></div>
          <div><div className="text-muted-foreground text-xs">الضريبة</div><div dir="ltr" className="tabular-nums">{fmt(data.taxAmount)}</div></div>
          <div><div className="text-muted-foreground text-xs">الإجمالي</div><div dir="ltr" className="tabular-nums font-semibold">{fmt(data.total)}</div></div>
          {data.convertedInvoiceId && (
            <div><div className="text-muted-foreground text-xs">الفاتورة</div><Link href={`/invoices/${data.convertedInvoiceId}`} className="underline">#{data.convertedInvoiceId}</Link></div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">البنود</CardTitle></CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr className="text-right">
                <th className="p-2">المنتج</th>
                <th className="p-2">الوحدة</th>
                <th className="p-2 text-center">الكمية</th>
                <th className="p-2 text-left">سعر الوحدة</th>
                <th className="p-2 text-left">الإجمالي</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((it) => (
                <tr key={it.id} className="border-t">
                  <td className="p-2">{it.productName}{it.variantName ? ` — ${it.variantName}` : ""} <span className="text-xs text-muted-foreground font-mono" dir="ltr">{it.sku}</span></td>
                  <td className="p-2 text-muted-foreground">{it.unitName}</td>
                  <td className="p-2 text-center tabular-nums" dir="ltr">{it.quantity}</td>
                  <td className="p-2 text-left tabular-nums" dir="ltr">{fmt(it.unitPrice)}</td>
                  <td className="p-2 text-left tabular-nums" dir="ltr">{fmt(it.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {data.status === "ACCEPTED" && (
        <Card>
          <CardHeader><CardTitle className="text-base">تحويل لفاتورة</CardTitle></CardHeader>
          <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-4 items-end">
            <div className="space-y-1">
              <Label>دفعة عند التحويل (اختياري)</Label>
              <Input dir="ltr" value={payAmount} onChange={(e) => setPayAmount(e.target.value)} placeholder={data.customerName ? "اتركه فارغاً = آجل" : `أقل من ${fmt(data.total)} يتطلّب عميلاً`} />
            </div>
            <div className="space-y-1">
              <Label>طريقة الدفع</Label>
              <select className={selectCls} value={payMethod} onChange={(e) => setPayMethod(e.target.value as typeof payMethod)}>
                {METHODS.map((m) => <option key={m.v} value={m.v}>{m.label}</option>)}
              </select>
            </div>
            <Button
              onClick={async () => {
                const pay = Number(payAmount) > 0;
                if (
                  !(await confirm({
                    variant: "danger",
                    title: "تحويل إلى فاتورة",
                    description: `تحويل عرض السعر ${data.quoteNumber} إلى فاتورة بإجمالي ${fmt(data.total)}${pay ? ` ودفعة ${fmt(String(Number(payAmount)))}` : " (آجل)"}. لا يمكن التراجع.`,
                    confirmText: "تحويل",
                  }))
                )
                  return;
                convert.mutate({ quotationId, payment: pay ? { amount: String(Number(payAmount)), method: payMethod } : undefined });
              }}
              disabled={convert.isPending}
            >
              {convert.isPending ? "جارٍ…" : "تحويل وإصدار فاتورة"}
            </Button>
          </CardContent>
        </Card>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}
      {done && <p className="text-sm text-emerald-600">{done}</p>}

      <div className="flex gap-2 flex-wrap">
        {data.status === "DRAFT" && (
          <Button
            variant="outline"
            onClick={async () => {
              if (
                !(await confirm({
                  variant: "info",
                  title: "وضع علامة «مُرسَل»",
                  description: `تعليم عرض السعر ${data.quoteNumber} كمُرسَل للعميل؟`,
                  confirmText: "مُرسَل",
                }))
              )
                return;
              setStatus.mutate({ quotationId, status: "SENT" });
            }}
            disabled={setStatus.isPending}
          >
            وضع علامة «مُرسَل»
          </Button>
        )}
        {isOpen && data.status !== "ACCEPTED" && (
          <Button
            variant="outline"
            onClick={async () => {
              if (
                !(await confirm({
                  variant: "info",
                  title: "قبول العرض",
                  description: `قبول عرض السعر ${data.quoteNumber} بإجمالي ${fmt(data.total)}؟ سيُتاح بعدها تحويله إلى فاتورة.`,
                  confirmText: "قبول",
                }))
              )
                return;
              setStatus.mutate({ quotationId, status: "ACCEPTED" });
            }}
            disabled={setStatus.isPending}
          >
            قبول
          </Button>
        )}
        {isOpen && (
          <Button
            variant="outline"
            onClick={async () => {
              if (
                !(await confirm({
                  variant: "warning",
                  title: "رفض العرض",
                  description: `رفض عرض السعر ${data.quoteNumber}؟ لن يعود قابلاً للتحويل إلى فاتورة.`,
                  confirmText: "رفض",
                }))
              )
                return;
              setStatus.mutate({ quotationId, status: "REJECTED" });
            }}
            disabled={setStatus.isPending}
          >
            رفض
          </Button>
        )}
        <Button variant="outline" onClick={printQuote}>طباعة العرض</Button>
        <CopyAsMenu
          label="نسخ العرض"
          plain={data.quoteNumber}
          whatsapp={formatQuotationAsWhatsApp({
            number: data.quoteNumber,
            date: data.quoteDate ? String(data.quoteDate) : undefined,
            validUntil: data.validUntil ? String(data.validUntil) : undefined,
            customer: data.customerName,
            items: data.items.map((it) => ({
              name: `${it.productName ?? ""}${it.variantName ? ` — ${it.variantName}` : ""}`,
              qty: it.quantity,
              unit: it.unitName,
              price: it.unitPrice,
              total: it.total,
            })),
            subtotal: data.subtotal,
            tax: data.taxAmount,
            total: data.total,
            notes: data.notes,
          })}
        />
        <WhatsAppShare
          message={buildQuotationMessage({
            quoteNumber: data.quoteNumber,
            quoteDate: data.quoteDate ? String(data.quoteDate) : undefined,
            validUntil: data.validUntil ? String(data.validUntil) : undefined,
            customerName: data.customerName,
            items: data.items.map((it) => ({
              productName: it.productName ?? "",
              quantity: it.quantity,
              unitName: it.unitName,
              total: it.total,
            })),
            total: data.total,
            notes: data.notes,
          })}
        />
      </div>
    </div>
  );
}

function esc(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] as string));
}
