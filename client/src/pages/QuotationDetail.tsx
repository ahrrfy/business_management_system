import { Button } from "@/components/ui/button";
import { AutoPrintOnce } from "@/components/AutoPrintOnce";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/PageHeader";
import { Label } from "@/components/ui/label";
import { notify } from "@/lib/notify";
import { DocumentWhatsAppDialog } from "@/components/DocumentWhatsAppDialog";
import { CopyInline } from "@/components/CopyButton";
import { CopyAsMenu } from "@/lib/copy/CopyAsMenu";
import { formatQuotationAsWhatsApp } from "@/lib/copy/formatters";
import { confirm } from "@/lib/confirm";
import { fmtDate } from "@/lib/date";
import { buildQuotationMessage } from "@/lib/whatsapp";
import { D, fmt, round2 } from "@/lib/money";
import { MoneyInput } from "@/components/form/MoneyInput";
import { PaymentReferenceField } from "@/components/pos/PaymentReferenceField";
import { AppSelect } from "@/components/ui/AppSelect";
import { getDeviceCode } from "@/lib/offline/outbox";
import { allocateLineTax } from "@/components/invoice";
import { cn } from "@/lib/utils";
import { printQuotation } from "@/lib/printing/printTemplates";
import { DataTable } from "@/components/data-table/DataTable";
import type { ColumnDef } from "@tanstack/react-table";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { moduleAccessAllowed, type PermissionMap, type RoleKey,
} from "@shared/permissions";
import { isPosPaymentMethodEnabled, posPaymentRejectionMessage,
} from "@shared/posPaymentPolicy";
import type { ReactNode } from "react";
import { useState } from "react";
import { Link, useParams, useSearch } from "wouter";
import { ACTION_LABELS } from "@shared/actionLabels";
import { paymentMethodTermOptions } from "@shared/terms";
import {
  INBOUND_ENABLED_PAYMENT_METHODS,
  type InboundEnabledPaymentMethod,
} from "@shared/inboundPaymentPolicy";

const STATUS: Record<string, string> = {
  DRAFT: "مسوّدة",
  SENT: "مُرسَل",
  ACCEPTED: "مقبول",
  REJECTED: "مرفوض",
  CONVERTED: "محوّل لفاتورة",
  EXPIRED: "منتهٍ",
};
const TIER: Record<string, string> = { RETAIL: "مفرد", WHOLESALE: "جملة", GOVERNMENT: "حكومي",
};

/** صفُّ بند عرض السعر — مشتقٌّ من عقد `quotations.get`. */
type QuotationItemRow = NonNullable<RouterOutputs["quotations"]["get"]>["items"][number];

/**
 * أعمدة بنود عرض السعر. دالّة لا ثابت لأنّ ذيل «مجموع البنود» يحمل مجموع المستند —
 * ولأنّ الشاشة تخرج مبكّراً قبل توفّر البيانات فلا يصحّ بناؤها بـuseMemo بعد ذلك الخروج.
 */
function quotationItemColumns(subtotal: string): ColumnDef<QuotationItemRow, unknown>[] {
  return [
    {
      id: "product",
      header: "المنتج",
      accessorFn: (it) => `${it.productName}${it.variantName ? ` — ${it.variantName}` : ""}`,
      meta: { width: "wide", wrap: true },
      footer: "مجموع البنود",
      cell: ({ row }) => (
        <span>
          {row.original.productName}{row.original.variantName ? ` — ${row.original.variantName}` : ""}{" "}
          {row.original.sku && <span className="text-xs text-muted-foreground font-mono" dir="ltr">{row.original.sku}</span>}
        </span>
      ),
    },
    { id: "unit", header: "الوحدة", accessorFn: (it) => it.unitName, cell: ({ row }) => <span className="text-muted-foreground">{row.original.unitName}</span> },
    { id: "quantity", header: "الكمية", accessorFn: (it) => it.quantity, meta: { kind: "number", align: "center" }, cell: ({ row }) => row.original.quantity },
    // `accessorFn` نصُّ العرض (للنسخ) ⇒ `sortingFn` صريحٌ بـDecimal: الفرز الافتراضيّ نصّيّ
    // فيقرأ «1,234» أصغر من «999» ويقلب ترتيب البنود.
    { id: "unitPrice", header: "سعر الوحدة", accessorFn: (it) => fmt(it.unitPrice), meta: { kind: "money" }, sortingFn: (a, b) => D(a.original.unitPrice).cmp(D(b.original.unitPrice)), cell: ({ row }) => fmt(row.original.unitPrice) },
    { id: "total", header: "الإجمالي", accessorFn: (it) => fmt(it.total), meta: { kind: "money" }, sortingFn: (a, b) => D(a.original.total).cmp(D(b.original.total)), footer: fmt(subtotal), cell: ({ row }) => fmt(row.original.total) },
  ];
}
const STATUS_CLS: Record<string, string> = {
  DRAFT: "bg-muted text-foreground/70",
  SENT: "bg-[var(--sem-info-bg)] text-[var(--sem-info)]",
  ACCEPTED: "bg-[var(--sem-pos-bg)] text-[var(--sem-pos)]",
  REJECTED: "bg-[var(--sem-neg-bg)] text-[var(--sem-neg)]",
  CONVERTED: "bg-violet-100 text-violet-700",
  EXPIRED: "bg-[var(--sem-warn-bg)] text-[var(--sem-warn)]",
};
/**
 * وصلُ برنامج v2 §٦ ق٦ (٤/٩/٢٦): خياراتُ طريقة الدفع من `shared/terms.ts` مباشرة —
 * كانت مصفوفةً محلّية بأربعة عناصر تنجرف مع نسخ الشاشات الأخرى (`نقدي`/`نقداً` مثالاً حيّ).
 * السياسةُ الحاكمة `INBOUND_ENABLED_PAYMENT_METHODS` (CASH/CARD/TRANSFER/WALLET) — لا
 * CHECK ولا TELECOM في مسار القبض بقرار المالك. حارس `check:vocabulary`.
 */
const METHODS = paymentMethodTermOptions(INBOUND_ENABLED_PAYMENT_METHODS);
type QuotationPayMethod = InboundEnabledPaymentMethod;
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
function SummaryRow({ label, value, strong,
}: { label: string; value: string; strong?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className={cn("text-muted-foreground", strong && "font-semibold text-foreground",
        )}>{label}</span>
      <span dir="ltr" className={cn("tabular-nums", strong ? "text-lg font-bold" : "text-sm")}>{fmt(value)}</span>
    </div>
  );
}

export default function QuotationDetail() {
  const params = useParams();
  const search = useSearch();
  const quotationId = Number(params.id);
  const utils = trpc.useUtils();
  const q = trpc.quotations.get.useQuery({ quotationId }, { enabled: Number.isFinite(quotationId) },
  );

  // بوّابة عرض مطابقة للخادم: الكتابة (setStatus/convert) salesManagerProcedure(["manager"],"sales","FULL")
  // — نفس دالة الخادم moduleAccessAllowed (لا قائمة أدوار حرفية) ⇒ لا تباعُد (نمط InvoiceDetail).
  const me = trpc.auth.me.useQuery();
  const canManage = !!me.data?.role &&
    moduleAccessAllowed(me.data.role as RoleKey, (me.data.permissionsOverride ?? null) as PermissionMap | null, "sales", "FULL", ["manager"],
    );

  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const [payAmount, setPayAmount] = useState("");
  const [payMethod, setPayMethod] = useState<QuotationPayMethod>("CASH");
  const [payReference, setPayReference] = useState("");

  const [externalAttempt, setExternalAttempt] = useState<{
    attemptId: number | null;
    requestId: string;
    deviceId: string;
    fingerprint: string;
    confirmed: boolean;
  } | null>(null);
  const initiateExternal = trpc.sales.initiateExternalPayment.useMutation();
  const confirmExternal = trpc.sales.confirmExternalPayment.useMutation();

  const refresh = async () => {
    await Promise.all([utils.quotations.get.invalidate({ quotationId }), utils.quotations.list.invalidate(),
    ]);
  };

  const setStatus = trpc.quotations.setStatus.useMutation({
    onSuccess: async () => { setDone("تم تحديث الحالة."); setError(""); await refresh(); },
    onError: (e) => { setError(e.message); setDone(""); },
  });
  const convert = trpc.quotations.convert.useMutation({
    onSuccess: async (r) => {
      setDone(r.alreadyConverted ? "مُحوّل مسبقاً." : `تم التحويل إلى الفاتورة رقم ${r.invoiceNumber ?? r.invoiceId}.`,
      );
      setError("");
      await refresh();
    },
    onError: (e) => { setError(e.message); setDone(""); },
  });

  if (q.isLoading) return (
      <div className="p-10 text-center text-muted-foreground">{ACTION_LABELS.loading}</div>
    );
  if (!q.data) return (
      <div className="p-10 text-center text-muted-foreground">عرض السعر غير موجود.</div>
    );
  const data = q.data;
  const isOpen = data.status === "DRAFT" || data.status === "SENT" || data.status === "ACCEPTED";
  const hasTax = D(data.taxAmount ?? "0").gt(0);
  const normalizedPayAmount = round2(D(payAmount || "0")).toFixed(2);
  const externalNeeded = D(payAmount).gt(0) && payMethod !== "CASH";
  const externalFingerprint = `SALES_COLLECTION|${data.branchId}|${payMethod}|${normalizedPayAmount}|${payReference.trim()}`;
  const externalConfirmed =
    !externalNeeded ||
    (externalAttempt?.confirmed === true &&
      externalAttempt.fingerprint === externalFingerprint);

  async function confirmQuotationExternalPayment() {
    const reference = payReference.trim();
    if (!reference) return notify.err("أدخل مرجع العملية أولاً.");
    if (!D(payAmount).gt(0))
      return notify.err("أدخل مبلغ الدفعة قبل تأكيد العملية الخارجية.");
    try {
      const prior =
        externalAttempt?.fingerprint === externalFingerprint
          ? externalAttempt
          : null;
      const deviceId = prior?.deviceId ?? (await getDeviceCode());
      const requestId = prior?.requestId ?? crypto.randomUUID();
      let attemptId = prior?.attemptId ?? null;
      if (attemptId == null) {
        const initiated = await initiateExternal.mutateAsync({
          branchId: Number(data.branchId),
          channel: "SALES_COLLECTION",
          method: payMethod as "CARD" | "TRANSFER" | "WALLET",
          amount: normalizedPayAmount,
          reference,
          requestId,
          deviceId,
        });
        attemptId = initiated.attemptId;
        setExternalAttempt({
          attemptId,
          requestId,
          deviceId,
          fingerprint: externalFingerprint,
          confirmed: false,
        });
      }
      await confirmExternal.mutateAsync({
        branchId: Number(data.branchId),
        channel: "SALES_COLLECTION",
        attemptId,
        deviceId,
      });
      setExternalAttempt({
        attemptId,
        requestId,
        deviceId,
        fingerprint: externalFingerprint,
        confirmed: true,
      });
      notify.ok(
        "تأكّد الدفع الخارجي",
        `ثُبّت المرجع ${reference} وأصبح جاهزاً للاستهلاك مرة واحدة.`,
      );
    } catch (err) {
      notify.err(
        err instanceof Error ? err.message : "تعذّر تأكيد الدفع الخارجي",
      );
    }
  }

  function printQuote() {
    const taxableBase = round2(D(data.subtotal).minus(D(data.discountAmount ?? "0")),
    ).toFixed(2);
    const taxShares = allocateLineTax(
      data.items.map((it) => ({ total: String(it.total) })),
      String(data.taxAmount ?? "0"),
      taxableBase,
    );
    printQuotation({
      quoteNumber: data.quoteNumber,
      quoteDate: data.quoteDate ? String(data.quoteDate).slice(0, 10) : undefined,
      validUntil: data.validUntil ? String(data.validUntil).slice(0, 10) : undefined,
      customerName: data.customerName,
      notes: data.notes,
      items: data.items.map((it, index) => ({
        productName: it.productName ?? "",
        variantName: it.variantName,
        unitName: it.unitName,
        quantity: it.quantity,
        unitPrice: it.unitPrice,
        taxAmount: taxShares[index] ?? "0",
        total: it.total,
      })),
      subtotal: data.subtotal,
      discountAmount: data.discountAmount,
      taxAmount: data.taxAmount,
      taxRate: Number(data.taxRatePercent ?? 0),
      total: data.total,
    });
  }

  return (
    <div className="space-y-4 max-w-4xl">
      {new URLSearchParams(search).get("print") === "1" && (
        <AutoPrintOnce onPrint={printQuote} />
      )}
      <PageHeader
        title="عرض سعر"
        backHref="/quotations"
        backLabel="رجوع للعروض"
      />

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
              <Field label="التاريخ">{fmtDate(data.quoteDate)}</Field>
              <Field label="صالح حتى">{data.validUntil ? String(data.validUntil).slice(0, 10) : "—"}</Field>
              {data.convertedInvoiceId && (
                <Field label="الفاتورة">
                  <Link href={`/invoices/${data.convertedInvoiceId}`} className="underline">#{data.convertedInvoiceId}</Link>
                </Field>
              )}
            </div>

            <div className="rounded-lg border bg-muted/30 p-4 space-y-2.5 text-sm self-start">
              <SummaryRow label="المجموع" value={data.subtotal} />
              {D(data.discountAmount ?? "0").gt(0) && (
                <SummaryRow label="الخصم" value={data.discountAmount} />
              )}
              {hasTax && (
                <SummaryRow label={`الضريبة (${data.taxRatePercent ?? "0"}٪)`} value={data.taxAmount} />
              )}
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
          {/* بنود المستند: مُضمَّن (العنوان في رأس البطاقة) وبلا ترقيم — المستند يُقرأ كاملاً.
              صفّ «مجموع البنود» صار `footer` على الأعمدة فيقع تحت عمود الإجمالي مباشرةً. */}
          <DataTable<QuotationItemRow>
            embedded
            searchable={false}
            bounded={false}
            pageSize={Infinity}
            columns={quotationItemColumns(data.subtotal)}
            data={data.items}
            emptyText="لا بنود في عرض السعر."
          />
        </CardContent>
      </Card>

      {data.status === "ACCEPTED" && canManage && (
        <Card>
          <CardHeader><CardTitle className="text-base">تحويل لفاتورة</CardTitle></CardHeader>
          <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-4 items-end">
            <div className="space-y-1">
              <Label>دفعة عند التحويل (اختياري)</Label>
              <MoneyInput value={payAmount} onChange={setPayAmount} placeholder={data.customerName ? "اتركه فارغاً = آجل" : `أقل من ${fmt(data.total)} يتطلّب عميلاً`} />
            </div>
            <div className="space-y-1">
              <Label>طريقة الدفع</Label>
              <AppSelect
                value={payMethod}
                onValueChange={(value) => {
                  if (!isPosPaymentMethodEnabled(value)) return;
                  setPayMethod(value as typeof payMethod);
                  setPayReference("");
                  setExternalAttempt(null);
                }}
              >
                {METHODS.map((m) => (
                  <option key={m.value} value={m.value} disabled={!isPosPaymentMethodEnabled(m.value)}>{m.compact}</option>
                ))}
              </AppSelect>
            </div>
            {payMethod !== "CASH" && (
              <div className="md:col-span-3 rounded-xl border bg-card p-3">
                <PaymentReferenceField
                  value={payReference}
                  onChange={(value) => {
                    setPayReference(value);
                    setExternalAttempt(null);
                  }}
                  method={payMethod}
                  confirmed={externalConfirmed}
                  confirming={
                    initiateExternal.isPending || confirmExternal.isPending
                  }
                  onConfirm={confirmQuotationExternalPayment}
                  inputId="quotation-pay-reference"
                  colors={{
                    border: "var(--border)",
                    muted: "var(--muted)",
                    mutedFg: "var(--muted-foreground)",
                    fg: "var(--foreground)",
                    amber: "var(--sem-warn)",
                    success: "var(--sem-pos)",
                  }}
                />
              </div>
            )}
            <Button
              onClick={async () => {
                const pay = D(payAmount).gt(0);
                if (
                  !(await confirm({
                    variant: "danger",
                    title: "تحويل إلى فاتورة",
                    description: `تحويل عرض السعر ${data.quoteNumber} إلى فاتورة بإجمالي ${fmt(data.total)}${pay ? ` ودفعة ${fmt(payAmount)}` : " (آجل)"}. لا يمكن التراجع.`,
                    confirmText: "تحويل",
                  }))
                )
                  return;
                if (pay && payMethod !== "CASH" && !payReference.trim()) {
                  notify.err("مرجع عملية البطاقة/التحويل مطلوب — لا يُسجَّل قبضٌ بلا أثرٍ قابلٍ للمطابقة.",
                  );
                  return;
                }
                if (
                  pay &&
                  payMethod !== "CASH" &&
                  (!externalConfirmed || externalAttempt?.attemptId == null)
                ) {
                  notify.err(
                    "ثبّت تأكيد الدفع غير النقدي قبل تحويل عرض السعر.",
                  );
                  return;
                }
                convert.mutate({
                  quotationId,
                  payment: pay
                    ? {
                        amount: round2(D(payAmount)).toFixed(2),
                        method: payMethod,
                        reference: payMethod === "CASH" ? undefined : payReference.trim(),
                        ...(payMethod === "CASH"
                          ? {}
                          : {
                              externalPaymentAttemptId: externalAttempt!.attemptId!,
                              externalPaymentDeviceId: externalAttempt!.deviceId,
                            }),
                      }
                    : undefined,
                });
              }}
              disabled={convert.isPending}
            >
              {convert.isPending ? "جارٍ…" : "تحويل وإصدار فاتورة"}
            </Button>
          </CardContent>
        </Card>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}
      {done && <p className="text-sm text-[var(--sem-pos)]">{done}</p>}

      <div className="flex gap-2 flex-wrap">
        {data.status === "DRAFT" && canManage && (
          <Button asChild>
            <Link href={`/quotations/${quotationId}/edit`}>تعديل المسوّدة</Link>
          </Button>
        )}
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
        <DocumentWhatsAppDialog
          kind="QUOTATION"
          documentId={quotationId}
          documentNumber={data.quoteNumber}
          customerName={data.customerName}
          defaultPhone={data.customerPhone}
          autoOpen={new URLSearchParams(search).get("share") === "1"}
          fallbackMessage={buildQuotationMessage({
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
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] as string,
  );
}
