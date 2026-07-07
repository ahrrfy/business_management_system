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
import { D, fmt } from "@/lib/money";
import { cn } from "@/lib/utils";
import { printQuotation } from "@/lib/printing/printTemplates";
import { trpc } from "@/lib/trpc";
import { moduleAccessAllowed, type PermissionMap, type RoleKey } from "@shared/permissions";
import type { ReactNode } from "react";
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
const STATUS_CLS: Record<string, string> = {
  DRAFT: "bg-muted text-foreground/70",
  SENT: "bg-blue-100 text-blue-700",
  ACCEPTED: "bg-emerald-100 text-emerald-700",
  REJECTED: "bg-rose-100 text-rose-700",
  CONVERTED: "bg-violet-100 text-violet-700",
  EXPIRED: "bg-amber-100 text-amber-700",
};
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

/** سطر في لوحة الملخّص المالي: تسمية يميناً + مبلغ يساراً (LTR، بلا اقتطاع). */
function SummaryRow({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className={cn("text-muted-foreground", strong && "font-semibold text-foreground")}>{label}</span>
      <span dir="ltr" className={cn("tabular-nums", strong ? "text-lg font-bold" : "text-sm")}>{fmt(value)}</span>
    </div>
  );
}

export default function QuotationDetail() {
  const params = useParams();
  const quotationId = Number(params.id);
  const utils = trpc.useUtils();
  const q = trpc.quotations.get.useQuery({ quotationId }, { enabled: Number.isFinite(quotationId) });

  // بوّابة عرض مطابقة للخادم: الكتابة (setStatus/convert) salesManagerProcedure(["manager"],"sales","FULL")
  // — نفس دالة الخادم moduleAccessAllowed (لا قائمة أدوار حرفية) ⇒ لا تباعُد (نمط InvoiceDetail).
  const me = trpc.auth.me.useQuery();
  const canManage = !!me.data?.role &&
    moduleAccessAllowed(me.data.role as RoleKey, (me.data.permissionsOverride ?? null) as PermissionMap | null, "sales", "FULL", ["manager"]);

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
  const hasTax = D(data.taxAmount ?? "0").gt(0);

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
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center justify-between gap-2">
            <CopyInline value={data.quoteNumber} />
            <span className={`text-xs rounded-full px-2.5 py-0.5 font-medium ${STATUS_CLS[data.status] ?? "bg-muted"}`}>
              {STATUS[data.status] ?? data.status}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-5 md:grid-cols-3">
            <div className="md:col-span-2 grid grid-cols-2 gap-x-6 gap-y-4 text-sm content-start">
              <Field label="العميل">{data.customerName ?? "—"}</Field>
              <Field label="فئة السعر">{TIER[data.priceTier] ?? data.priceTier}</Field>
              <Field label="التاريخ">{new Date(data.quoteDate).toLocaleDateString("ar-IQ-u-nu-latn")}</Field>
              <Field label="صالح حتى">{data.validUntil ? String(data.validUntil).slice(0, 10) : "—"}</Field>
              {data.convertedInvoiceId && (
                <Field label="الفاتورة">
                  <Link href={`/invoices/${data.convertedInvoiceId}`} className="underline">#{data.convertedInvoiceId}</Link>
                </Field>
              )}
            </div>

            <div className="rounded-lg border bg-muted/30 p-4 space-y-2.5 text-sm self-start">
              <SummaryRow label="المجموع" value={data.subtotal} />
              {hasTax && <SummaryRow label="الضريبة" value={data.taxAmount} />}
              <div className="border-t pt-2.5">
                <SummaryRow label="الإجمالي" value={data.total} strong />
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-base">البنود</CardTitle></CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium text-start">المنتج</th>
                  <th className="px-3 py-2 font-medium text-start">الوحدة</th>
                  <th className="px-3 py-2 font-medium text-center">الكمية</th>
                  <th className="px-3 py-2 font-medium text-right">سعر الوحدة</th>
                  <th className="px-3 py-2 font-medium text-right">الإجمالي</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((it) => (
                  <tr key={it.id} className="border-t hover:bg-muted/30">
                    <td className="px-3 py-2">{it.productName}{it.variantName ? ` — ${it.variantName}` : ""}{" "}
                      {it.sku && <span className="text-xs text-muted-foreground font-mono" dir="ltr">{it.sku}</span>}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">{it.unitName}</td>
                    <td className="px-3 py-2 text-center tabular-nums" dir="ltr">{it.quantity}</td>
                    <td className="px-3 py-2 text-right tabular-nums" dir="ltr">{fmt(it.unitPrice)}</td>
                    <td className="px-3 py-2 text-right tabular-nums" dir="ltr">{fmt(it.total)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 bg-muted/40 font-semibold">
                  <td className="px-3 py-2" colSpan={4}>مجموع البنود</td>
                  <td className="px-3 py-2 text-right tabular-nums" dir="ltr">{fmt(data.subtotal)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </CardContent>
      </Card>

      {data.status === "ACCEPTED" && canManage && (
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
        {data.status === "DRAFT" && canManage && (
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
        {isOpen && data.status !== "ACCEPTED" && canManage && (
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
        {isOpen && canManage && (
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
