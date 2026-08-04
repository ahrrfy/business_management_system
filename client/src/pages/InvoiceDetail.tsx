import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { AutoPrintOnce } from "@/components/AutoPrintOnce";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { MoneyInput } from "@/components/form/MoneyInput";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { BarcodeDisplay } from "@/components/BarcodeDisplay";
import { DocumentWhatsAppDialog } from "@/components/DocumentWhatsAppDialog";
import { CopyInline } from "@/components/CopyButton";
import { CopyAsMenu } from "@/lib/copy/CopyAsMenu";
import { formatInvoiceAsWhatsApp } from "@/lib/copy/formatters";
import { buildInvoiceMessage } from "@/lib/whatsapp";
import { fmtDate, fmtDateTime } from "@/lib/date";
import { confirm } from "@/lib/confirm";
import { printInvoiceA4 } from "@/lib/printing/printTemplates";
import { printWarehouseSlipV2 } from "@/lib/printing/printTemplatesV2";
import { printReceipt } from "@/lib/printing/print";
import { invoiceToReceipt } from "@/lib/printing/invoiceReceipt";
import { allocateLineTax } from "@/components/invoice";
import { D, fmt, round2 } from "@/lib/money";
import { cn } from "@/lib/utils";
import { trpc } from "@/lib/trpc";
import {
  hasModuleAccess,
  moduleAccessAllowed,
  type PermissionMap,
  type RoleKey,
} from "@shared/permissions";
import { InvoiceDigitalCards } from "@/components/digitalCards/InvoiceDigitalCards";
import { useEffect, useState } from "react";
import { Link, useParams, useSearch } from "wouter";
import {
  ChevronDown,
  FileText,
  History,
  Package,
  Paperclip,
  Pencil,
  Printer,
} from "lucide-react";
import { notify } from "@/lib/notify";
import {
  POS_METHODS as METHODS,
  paymentMethodClass,
  paymentMethodLabel,
} from "@/lib/paymentMethod";

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
const SOURCE: Record<string, string> = {
  POS: "نقطة بيع",
  ONLINE: "أونلاين",
  ORDER: "طلب",
  WORKORDER: "طلب خدمة",
};
// METHOD_LABEL / METHODS → مستوردة من lib/paymentMethod.ts (مصدر واحد مع POS + Invoices + حوار الوردية).
const PAY_STATUS: Record<string, string> = {
  COMPLETED: "مكتملة",
  PENDING: "معلّقة",
  FAILED: "فاشلة",
  CANCELLED: "ملغاة",
};
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
      <span
        className={cn(
          "text-muted-foreground",
          strong && "font-semibold text-foreground",
        )}
      >
        {label}
      </span>
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
  const search = useSearch();
  const invoiceId = Number(params.id);
  const utils = trpc.useUtils();
  const inv = trpc.sales.get.useQuery(
    { invoiceId },
    { enabled: Number.isFinite(invoiceId) },
  );
  // الرقم الضريبي للشركة (إعدادات النظام) — يُطبع على الفاتورة بجانب رقم العميل الضريبي إن وُجد.
  const taxSettings = trpc.system.getTaxSettings.useQuery();

  const [payAmount, setPayAmount] = useState("");
  const [payMethod, setPayMethod] =
    useState<(typeof METHODS)[number]["v"]>("CASH");
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const [printingReceipt, setPrintingReceipt] = useState(false);
  // idempotency: مفتاح ثابت لكل دفعة (يتجدّد بعد النجاح) ⇒ نقرة مزدوجة لا تُسجّل دفعتين.
  const [clientRequestId, setClientRequestId] = useState(() =>
    crypto.randomUUID(),
  );

  // Default the payment amount to remaining balance once data loads.
  useEffect(() => {
    if (!inv.data) return;
    // #1 (تدقيق التثبيت): المتبقّي = total − returnedTotal − paidAmount؛ تجاهُل المرتجعات كان
    // يُملأ بمبلغٍ أكبر من الحقيقي ⇒ تحصيل زائد ورصيد عميل سالب (ذمة وهمية).
    const remaining = round2(
      D(inv.data.total)
        .minus(D(inv.data.returnedTotal ?? "0"))
        .minus(D(inv.data.paidAmount)),
    );
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
    onError: (e) => {
      setError(e.message);
      setDone("");
    },
  });

  // #28 (تدقيق التثبيت): تسجيل الدفعة = salesCashierProcedure(["cashier","manager"],"sales","FULL").
  // نُخفي لوحة «تسديد دفعة» عمّن يرفضه الخادم (محاسب/مدقّق/مندوب: sales=READ) بدل عرض نموذج يفشل
  // بـ403 — بنفس دالة الخادم moduleAccessAllowed (لا قائمة أدوار حرفية) ⇒ لا تباعُد.
  const me = trpc.auth.me.useQuery();
  const canCorrectInvoice =
    !!me.data?.role &&
    (me.data.role === "admin" || me.data.role === "manager") &&
    hasModuleAccess(
      me.data.role as RoleKey,
      (me.data.permissionsOverride ?? null) as PermissionMap | null,
      "sales",
      "FULL",
    );
  const corrections = trpc.sales.correctionHistory.useQuery(
    { invoiceId },
    { enabled: Number.isFinite(invoiceId) && canCorrectInvoice, retry: false },
  );
  const [correctionOpen, setCorrectionOpen] = useState(false);
  const [correctionNotes, setCorrectionNotes] = useState("");
  const [correctionDueDate, setCorrectionDueDate] = useState("");
  const [correctionMethods, setCorrectionMethods] = useState<
    Record<number, (typeof METHODS)[number]["v"]>
  >({});
  const [correctionReason, setCorrectionReason] = useState("");
  const correctInvoice = trpc.sales.correct.useMutation({
    onSuccess: async () => {
      setCorrectionOpen(false);
      setCorrectionReason("");
      notify.ok("تم تصحيح الفاتورة", "حُفظ التعديل وسجلّه باسمك.");
      await Promise.all([
        utils.sales.get.invalidate({ invoiceId }),
        utils.sales.list.invalidate(),
        utils.sales.listPage.invalidate(),
        utils.sales.listSummary.invalidate(),
        utils.sales.correctionHistory.invalidate({ invoiceId }),
      ]);
    },
    onError: (error) => notify.err(error),
  });

  // ش١٠: لقطات الكروت الرقمية للفاتورة — بدونها تفقد **إعادة** الطباعة مراجع الكروت وبيانات
  // الطالب التي طُبعت أوّل مرّة (الإيصال الأصلي يأخذها من ردّ `finalize`). محجوبة خلف صلاحية
  // الوحدة بنفس دالة الخادم فلا يُطلق مَن لا يملكها نداءً يعود بـ403.
  const canReadDigital =
    !!me.data?.role &&
    hasModuleAccess(
      me.data.role as RoleKey,
      (me.data.permissionsOverride ?? null) as PermissionMap | null,
      "digital_cards",
      "READ",
    );
  const digitalPrint = trpc.digitalCards.sales.printDetails.useQuery(
    { invoiceId },
    { enabled: Number.isFinite(invoiceId) && canReadDigital, retry: false },
  );

  if (inv.isLoading)
    return (
      <div className="p-10 text-center text-muted-foreground">
        جارٍ التحميل…
      </div>
    );
  if (!inv.data)
    return (
      <div className="p-10 text-center text-muted-foreground">
        الفاتورة غير موجودة.
      </div>
    );
  const data = inv.data;
  // #1: المتبقّي الحقيقي = total − returnedTotal − paidAmount (يمنع التحصيل الزائد بعد مرتجع جزئي).
  const remaining = round2(
    D(data.total)
      .minus(D(data.returnedTotal ?? "0"))
      .minus(D(data.paidAmount)),
  );
  const canPay = data.status === "PENDING" || data.status === "PARTIALLY_PAID";
  // بوّابة عرض مطابقة للخادم: كاشير/مدير قالبياً أو مَن مُنح sales=FULL صراحةً (أو admin).
  const canRecordPayment =
    !!me.data?.role &&
    moduleAccessAllowed(
      me.data.role as RoleKey,
      (me.data.permissionsOverride ?? null) as PermissionMap | null,
      "sales",
      "FULL",
      ["cashier", "manager"],
    );
  const hasDiscount = D(data.discountAmount ?? "0").gt(0);
  const hasTax = D(data.taxAmount ?? "0").gt(0);

  function openCorrection() {
    setCorrectionNotes(data.notes ?? "");
    setCorrectionDueDate(data.dueDate ? String(data.dueDate).slice(0, 10) : "");
    setCorrectionMethods(
      Object.fromEntries(
        (data.payments ?? []).map((payment) => [
          payment.id,
          payment.paymentMethod as (typeof METHODS)[number]["v"],
        ]),
      ),
    );
    setCorrectionReason("");
    setCorrectionOpen(true);
  }

  function submitCorrection() {
    const receiptMethods = (data.payments ?? [])
      .filter(
        (payment) =>
          correctionMethods[payment.id] &&
          correctionMethods[payment.id] !== payment.paymentMethod,
      )
      .map((payment) => ({
        receiptId: payment.id,
        method: correctionMethods[payment.id],
      }));
    correctInvoice.mutate({
      invoiceId,
      notes: correctionNotes,
      dueDate: correctionDueDate || null,
      receiptMethods,
      reason: correctionReason,
    });
  }

  async function reprintThermal() {
    if (printingReceipt) return;
    setPrintingReceipt(true);
    try {
      const result = await printReceipt({
        ...invoiceToReceipt(data),
        digitalDetails: digitalPrint.data?.length ? digitalPrint.data : null,
      });
      if (result.via === "server") {
        notify.ok(
          "تمت إعادة الطباعة",
          `أُرسلت الفاتورة ${data.invoiceNumber} إلى طابعة الكاشير`,
        );
      } else if (result.via === "thermal") {
        notify.ok(
          "تمت إعادة الطباعة الحرارية",
          `أُرسلت الفاتورة ${data.invoiceNumber} إلى الطابعة المربوطة`,
        );
      } else {
        notify.warn(
          "الطابعة المباشرة غير متاحة",
          "افتُتحت نافذة الطباعة الحرارية البديلة",
        );
      }
    } catch (e) {
      notify.err(e);
    } finally {
      setPrintingReceipt(false);
    }
  }

  async function submit() {
    setError("");
    setDone("");
    const amt = D(payAmount || "0");
    if (amt.lte(0)) return setError("أدخل مبلغاً موجباً.");
    if (amt.gt(remaining))
      return setError(`المبلغ يتجاوز المتبقّي (${fmt(remaining.toFixed(2))}).`);
    const methodLabel = paymentMethodLabel(payMethod);
    if (
      !(await confirm({
        variant: "info",
        title: "تسجيل دفعة على الفاتورة؟",
        description: `سيُسجَّل دفع مبلغ ${fmt(amt.toFixed(2))} (${methodLabel}) على الفاتورة ${data.invoiceNumber}. المتبقّي بعدها: ${fmt(round2(remaining.minus(amt)).toFixed(2))}.`,
        confirmText: "تسجيل الدفعة",
      }))
    )
      return;
    pay.mutate({
      invoiceId,
      amount: amt.toFixed(2),
      method: payMethod,
      clientRequestId,
    });
  }

  async function printApprovedA4() {
    // توزيع ضريبة الفاتورة على السطور لعمود «الضريبة» في القالب الرسمي.
    const afterDisc = round2(
      D(data.subtotal).minus(D(data.discountAmount ?? "0")),
    ).toFixed(2);
    const shares = allocateLineTax(
      data.items.map((it) => ({ total: String(it.total) })),
      String(data.taxAmount ?? "0"),
      afterDisc,
    );
    await printInvoiceA4({
      invoiceNumber: data.invoiceNumber,
      invoiceDate: data.invoiceDate,
      customerName: data.customerName,
      salespersonName: data.salespersonName,
      companyTaxId: taxSettings.data?.taxRegistrationNumber ?? null,
      paymentMethod: paymentMethodLabel(data.paymentMethod),
      subtotal: data.subtotal,
      discountAmount: data.discountAmount,
      taxAmount: data.taxAmount,
      taxRate: Number(data.taxRatePercent ?? 0),
      total: data.total,
      paidAmount: data.paidAmount,
      items: data.items.map((it, i) => ({
        productName: it.productName ?? "",
        unitName: it.unitName,
        quantity: it.quantity,
        unitPrice: it.unitPrice,
        total: it.total,
        taxAmount: shares[i] ?? "0",
      })),
    });
  }

  function printWarehouseSlip() {
    printWarehouseSlipV2({
      invoiceNumber: data.invoiceNumber,
      invoiceDate: data.invoiceDate,
      customerName: data.customerName,
      customerPhone: data.customerPhone,
      salesRep: data.salespersonName,
      items: data.items.map((it) => ({
        productName: it.productName ?? "",
        unitName: it.unitName,
        quantity: it.quantity,
      })),
      notes: data.notes,
    });
  }

  return (
    <div className="space-y-4 max-w-4xl">
      {new URLSearchParams(search).get("print") === "1" && (
        <AutoPrintOnce onPrint={() => void printApprovedA4()} />
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">تفاصيل الفاتورة</h1>
        <div className="flex flex-wrap items-center gap-2">
          <DocumentWhatsAppDialog
            kind="INVOICE"
            documentId={invoiceId}
            documentNumber={data.invoiceNumber}
            customerName={data.customerName}
            defaultPhone={data.customerPhone}
            autoOpen={new URLSearchParams(search).get("share") === "1"}
            fallbackMessage={buildInvoiceMessage({
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
          {canCorrectInvoice && (
            <Button variant="outline" size="sm" onClick={openCorrection}>
              <Pencil aria-hidden className="size-4" />
              تصحيح الفاتورة
            </Button>
          )}
          <Button
            size="sm"
            disabled={printingReceipt}
            onClick={() => void reprintThermal()}
          >
            <Printer aria-hidden className="size-4" />
            {printingReceipt ? "جارٍ إعادة الطباعة…" : "إعادة طباعة حرارية"}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                <Printer aria-hidden className="size-4" />
                طباعة A4
                <ChevronDown aria-hidden className="size-3 ms-1 opacity-60" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => void printApprovedA4()}>
                <FileText aria-hidden className="size-4" />
                فاتورة الزبون
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => printWarehouseSlip()}>
                <Package aria-hidden className="size-4" />
                سند تجهيز مخزني
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Link
            href="/invoices"
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            ← رجوع للمبيعات
          </Link>
        </div>
      </div>

      {/* بطاقة الترويسة: بيانات وصفية + لوحة ملخّص مالي */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center justify-between gap-2">
            <CopyInline value={data.invoiceNumber} />
            <div className="flex items-center gap-2">
              {data.paymentMethod && (
                <span
                  className={`text-xs rounded-full px-2.5 py-0.5 font-semibold ${paymentMethodClass(data.paymentMethod)}`}
                  title="طريقة الدفع المسجّلة على هذه الفاتورة"
                >
                  {paymentMethodLabel(data.paymentMethod)}
                </span>
              )}
              <span
                className={`text-xs rounded-full px-2.5 py-0.5 font-medium ${STATUS_CLS[data.status] ?? "bg-muted"}`}
              >
                {STATUS[data.status] ?? data.status}
              </span>
            </div>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-5 md:grid-cols-3">
            {/* البيانات الوصفية */}
            <div className="md:col-span-2 grid grid-cols-2 gap-x-6 gap-y-4 text-sm content-start">
              <Field label="المصدر">
                {SOURCE[data.sourceType] ?? data.sourceType}
              </Field>
              <Field label="العميل">{data.customerName ?? "عميل نقدي"}</Field>
              <Field label="موظف المبيعات">{data.salespersonName ?? "—"}</Field>
              <Field label="الوردية">
                {data.shiftId
                  ? `#${data.shiftId} — ${data.shiftType ?? "—"}`
                  : "—"}
              </Field>
              <Field label="محطة البيع">
                <span dir="ltr" className="font-mono text-xs">
                  {data.deviceId ?? "—"}
                </span>
              </Field>
              <Field label="التاريخ">{fmtDate(data.invoiceDate)}</Field>
              <Field label="الاستحقاق">
                {data.dueDate ? String(data.dueDate).slice(0, 10) : "—"}
              </Field>
              {data.customerId && (
                <div className="col-span-2 space-y-0.5">
                  <div className="text-xs text-muted-foreground">
                    ذمة العميل الحالية
                  </div>
                  <div className="font-medium tabular-nums" dir="ltr">
                    <CopyInline
                      value={data.customerBalance ?? "0"}
                      display={fmt(data.customerBalance ?? "0")}
                      mono={false}
                    />
                  </div>
                </div>
              )}
            </div>

            {/* لوحة الملخّص المالي */}
            <div className="rounded-lg border bg-muted/30 p-4 space-y-2.5 text-sm self-start">
              <SummaryRow label="قبل الضريبة" value={data.subtotal} />
              {hasDiscount && (
                <SummaryRow label="الخصم" value={data.discountAmount} />
              )}
              {hasTax && (
                <SummaryRow
                  label={`الضريبة (${data.taxRatePercent ?? "0"}٪)`}
                  value={data.taxAmount}
                />
              )}
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
          {data.status === "CANCELLED" && (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
              ألغيت بواسطة:{" "}
              <strong>{data.cancelledByName ?? "غير موثّق"}</strong>
              {data.cancelledAt ? ` — ${fmtDateTime(data.cancelledAt)}` : ""}
            </div>
          )}
        </CardContent>
      </Card>

      {(data.returns ?? []).length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">سجل المرتجعات ومنفّذها</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">التاريخ</th>
                    <th className="px-3 py-2 font-medium">منفّذ المرتجع</th>
                    <th className="px-3 py-2 font-medium text-right">القيمة</th>
                  </tr>
                </thead>
                <tbody>
                  {data.returns.map((r) => (
                    <tr key={r.id} className="border-t">
                      <td className="px-3 py-2" dir="ltr">
                        {fmtDateTime(r.createdAt)}
                      </td>
                      <td className="px-3 py-2">
                        {r.performedByName ?? "غير موثّق"}
                      </td>
                      <td
                        className="px-3 py-2 text-right tabular-nums"
                        dir="ltr"
                      >
                        {fmt(D(r.amount).abs().toString())}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">البنود</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">المنتج</th>
                  <th className="px-3 py-2 font-medium">الوحدة</th>
                  <th className="px-3 py-2 font-medium text-center">الكمية</th>
                  <th className="px-3 py-2 font-medium text-right">
                    سعر الوحدة
                  </th>
                  <th className="px-3 py-2 font-medium text-right">
                    إجمالي السطر
                  </th>
                  <th className="px-3 py-2 font-medium text-center">مرتجع</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((it) => {
                  const returned = Number(it.returnedBaseQuantity) > 0;
                  return (
                    <tr key={it.id} className="border-t hover:bg-muted/30">
                      <td className="px-3 py-2">
                        {it.productName ?? "—"}
                        {it.variantName ? ` — ${it.variantName}` : ""}{" "}
                        {it.sku && (
                          <span
                            className="text-xs text-muted-foreground font-mono"
                            dir="ltr"
                          >
                            {it.sku}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {it.unitName ?? "—"}
                      </td>
                      <td
                        className="px-3 py-2 text-center tabular-nums"
                        dir="ltr"
                      >
                        {it.quantity}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        <CopyInline
                          value={it.unitPrice}
                          display={fmt(it.unitPrice)}
                        />
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        <CopyInline value={it.total} display={fmt(it.total)} />
                      </td>
                      <td
                        className="px-3 py-2 text-center text-xs tabular-nums"
                        dir="ltr"
                      >
                        <span
                          className={
                            returned
                              ? "text-amber-600 font-medium"
                              : "text-muted-foreground"
                          }
                        >
                          {it.returnedBaseQuantity}/{it.baseQuantity}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="border-t-2 bg-muted/40 font-semibold">
                  <td className="px-3 py-2" colSpan={4}>
                    مجموع البنود
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums" dir="ltr">
                    {fmt(data.subtotal)}
                  </td>
                  <td className="px-3 py-2"></td>
                </tr>
              </tfoot>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* ش١٢: الكروت الرقمية ومسار عكسها — لا تُعرض إن لم تكن الفاتورة تحوي كروتاً. */}
      <InvoiceDigitalCards invoiceId={invoiceId} />

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">سجل الدفعات</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">التاريخ</th>
                  <th className="px-3 py-2 font-medium">الاتجاه</th>
                  <th className="px-3 py-2 font-medium">الطريقة</th>
                  <th className="px-3 py-2 font-medium text-right">المبلغ</th>
                  <th className="px-3 py-2 font-medium">الحالة</th>
                  <th className="px-3 py-2 font-medium">سند/مرفق</th>
                </tr>
              </thead>
              <tbody>
                {(data.payments ?? []).map((p) => (
                  <tr key={p.id} className="border-t hover:bg-muted/30">
                    <td
                      className="px-3 py-2 whitespace-nowrap tabular-nums"
                      dir="ltr"
                    >
                      {fmtDateTime(p.createdAt)}
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={cn(
                          "inline-flex rounded-full px-2 py-0.5 text-xs font-medium",
                          p.direction === "IN"
                            ? "bg-emerald-100 text-emerald-700"
                            : "bg-rose-100 text-rose-700",
                        )}
                      >
                        {p.direction === "IN" ? "وارد" : "صادر"}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      {paymentMethodLabel(p.paymentMethod)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      <CopyInline value={p.amount} display={fmt(p.amount)} />
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {PAY_STATUS[p.status] ?? p.status}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {p.voucherNumber && (
                        <span className="text-muted-foreground">
                          {p.voucherNumber}
                        </span>
                      )}
                      {p.attachmentUrl && (
                        <a
                          href={p.attachmentUrl}
                          target="_blank"
                          rel="noreferrer"
                          title="فتح المُرفق"
                          className="ms-1 inline-block"
                        >
                          <Paperclip
                            aria-hidden
                            className="size-3.5 text-emerald-700 inline"
                          />
                        </a>
                      )}
                      {!p.voucherNumber && !p.attachmentUrl && "—"}
                    </td>
                  </tr>
                ))}
                {(data.payments ?? []).length === 0 && (
                  <tr>
                    <td
                      colSpan={6}
                      className="p-4 text-center text-muted-foreground"
                    >
                      لا دفعات بعد.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {canPay && remaining.gt(0) && canRecordPayment && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">تسديد دفعة</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-4 items-end">
            <div className="space-y-1">
              <Label>
                المبلغ (المتبقّي:{" "}
                <CopyInline
                  value={remaining.toFixed(2)}
                  display={fmt(remaining.toFixed(2))}
                  mono={false}
                />
                )
              </Label>
              <MoneyInput
                value={payAmount}
                onChange={setPayAmount}
                ariaLabel="مبلغ الدفعة"
              />
            </div>
            <div className="space-y-1">
              <Label>طريقة الدفع</Label>
              <select
                className={selectCls}
                value={payMethod}
                onChange={(e) =>
                  setPayMethod(e.target.value as typeof payMethod)
                }
              >
                {METHODS.map((m) => (
                  <option key={m.v} value={m.v}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>
            <Button onClick={submit} disabled={pay.isPending}>
              {pay.isPending ? "جارٍ…" : "تسجيل الدفعة"}
            </Button>
          </CardContent>
        </Card>
      )}

      {/* باركود + QR الفاتورة */}
      {data.qrPayload && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">باركود الفاتورة</CardTitle>
          </CardHeader>
          <CardContent className="flex justify-center py-4">
            <BarcodeDisplay
              barcodeSet={{
                barcode128: data.invoiceNumber,
                qrPayload: data.qrPayload,
                displayLabel: `فاتورة: ${data.invoiceNumber}\n${fmtDate(data.invoiceDate)} — ${fmt(data.total)} د.ع`,
              }}
              size="md"
            />
          </CardContent>
        </Card>
      )}

      {canCorrectInvoice && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <History aria-hidden className="size-4" />
              سجل تصحيحات الفاتورة
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {corrections.isLoading && (
              <p className="text-sm text-muted-foreground">
                جارٍ تحميل سجل التعديل…
              </p>
            )}
            {!corrections.isLoading &&
              (corrections.data ?? []).length === 0 && (
                <p className="text-sm text-muted-foreground">
                  لا توجد تعديلات مسجّلة على هذه الفاتورة.
                </p>
              )}
            {(corrections.data ?? []).map((entry) => {
              const oldFields =
                (entry.oldValue as {
                  notes?: string | null;
                  dueDate?: string | null;
                  paymentMethod?: string | null;
                  receipts?: { receiptId: number; method: string }[];
                } | null) ?? {};
              const newValue =
                (entry.newValue as {
                  reason?: string;
                  fields?: typeof oldFields;
                } | null) ?? {};
              const newFields = newValue.fields ?? {};
              return (
                <div
                  key={entry.id}
                  className="rounded-md border bg-muted/20 p-3 text-sm space-y-2"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-semibold">
                      {entry.userName ?? "مستخدم محذوف"}
                    </span>
                    <span
                      className="text-xs text-muted-foreground tabular-nums"
                      dir="ltr"
                    >
                      {fmtDateTime(entry.createdAt)}
                    </span>
                  </div>
                  <p>
                    <span className="text-muted-foreground">السبب: </span>
                    {newValue.reason ?? "—"}
                  </p>
                  <div className="grid gap-1 text-xs text-muted-foreground">
                    {oldFields.notes !== newFields.notes && (
                      <p>
                        الملاحظات:{" "}
                        <span className="line-through">
                          {oldFields.notes || "—"}
                        </span>{" "}
                        ←{" "}
                        <span className="text-foreground">
                          {newFields.notes || "—"}
                        </span>
                      </p>
                    )}
                    {oldFields.dueDate !== newFields.dueDate && (
                      <p>
                        تاريخ الاستحقاق:{" "}
                        <span className="line-through" dir="ltr">
                          {oldFields.dueDate || "—"}
                        </span>{" "}
                        ←{" "}
                        <span className="text-foreground" dir="ltr">
                          {newFields.dueDate || "—"}
                        </span>
                      </p>
                    )}
                    {(newFields.receipts ?? []).map((receipt) => {
                      const oldReceipt = oldFields.receipts?.find(
                        (old) => old.receiptId === receipt.receiptId,
                      );
                      if (!oldReceipt || oldReceipt.method === receipt.method)
                        return null;
                      return (
                        <p key={receipt.receiptId}>
                          طريقة الدفع:{" "}
                          <span className="line-through">
                            {paymentMethodLabel(oldReceipt.method)}
                          </span>{" "}
                          ←{" "}
                          <span className="text-foreground">
                            {paymentMethodLabel(receipt.method)}
                          </span>
                        </p>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      <Dialog open={correctionOpen} onOpenChange={setCorrectionOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>تصحيح الفاتورة</DialogTitle>
            <DialogDescription>
              متاح للمدير والمالك فقط. يُسجَّل السبب والقيم قبل وبعد التعديل
              باسمك.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="invoice-correction-notes">ملاحظات الفاتورة</Label>
              <Textarea
                id="invoice-correction-notes"
                value={correctionNotes}
                onChange={(event) => setCorrectionNotes(event.target.value)}
                rows={3}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="invoice-correction-due-date">
                تاريخ الاستحقاق
              </Label>
              <Input
                id="invoice-correction-due-date"
                type="date"
                value={correctionDueDate}
                onChange={(event) => setCorrectionDueDate(event.target.value)}
              />
            </div>
            {(data.payments ?? []).length > 0 && (
              <div className="space-y-2">
                <Label>طريقة الدفع لكل دفعة</Label>
                <p className="text-xs text-muted-foreground">
                  يُحدَّث سند القبض نفسه لكي تنعكس الطريقة الصحيحة في تقارير
                  الصندوق والبطاقة والتحويل.
                </p>
                {(data.payments ?? []).map((payment) => (
                  <div
                    key={payment.id}
                    className="grid grid-cols-[1fr_auto] items-center gap-3 rounded-md border p-2.5"
                  >
                    <span className="text-sm">
                      <span dir="ltr">{fmt(payment.amount)}</span> —{" "}
                      {fmtDateTime(payment.createdAt)}
                    </span>
                    <select
                      className={selectCls}
                      value={
                        correctionMethods[payment.id] ?? payment.paymentMethod
                      }
                      onChange={(event) =>
                        setCorrectionMethods((current) => ({
                          ...current,
                          [payment.id]: event.target
                            .value as (typeof METHODS)[number]["v"],
                        }))
                      }
                    >
                      {METHODS.map((item) => (
                        <option key={item.v} value={item.v}>
                          {item.label}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="invoice-correction-reason">سبب التعديل *</Label>
              <Textarea
                id="invoice-correction-reason"
                value={correctionReason}
                onChange={(event) => setCorrectionReason(event.target.value)}
                placeholder="مثال: العميل طلب التحويل بدلاً من البطاقة قبل الطباعة"
                rows={2}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setCorrectionOpen(false)}
              disabled={correctInvoice.isPending}
            >
              إلغاء
            </Button>
            <Button
              onClick={submitCorrection}
              disabled={
                correctInvoice.isPending || correctionReason.trim().length < 3
              }
            >
              {correctInvoice.isPending ? "جارٍ الحفظ…" : "حفظ التصحيح"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {error && <p className="text-sm text-destructive">{error}</p>}
      {done && <p className="text-sm text-emerald-600">{done}</p>}
    </div>
  );
}
