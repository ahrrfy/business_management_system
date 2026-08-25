import InvoiceChannelBadge from "@/components/InvoiceChannelBadge";
import { shiftTypeLabel, sourceTypeLabel } from "@/lib/labels";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/PageHeader";
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
import { InvoiceDispatchDialog } from "@/components/delivery/InvoiceDispatchDialog";
import { CancelDeliveryAssignmentDialog } from "@/components/delivery/CancelDeliveryAssignmentDialog";
import { useEffect, useState } from "react";
import { Link, useLocation, useParams, useSearch } from "wouter";
import {
  ChevronDown,
  FileText,
  FileWarning,
  Gift,
  History,
  Package,
  Paperclip,
  Pencil,
  Printer,
  RotateCcw,
  Truck,
} from "lucide-react";
import { notify } from "@/lib/notify";
import {
  POS_METHODS as METHODS,
  paymentMethodClass,
  paymentMethodLabel,
} from "@/lib/paymentMethod";
import { isPosPaymentMethodEnabled, posPaymentRejectionMessage } from "@shared/posPaymentPolicy";
import { invoiceStatusLabel } from "@shared/invoiceStatus";

const ENABLED_COLLECTION_METHODS = METHODS.filter((method) => isPosPaymentMethodEnabled(method.v));

// التعريب من `@shared/invoiceStatus` وحده (مصدر الحقيقة) — كانت نسخةً محلّية سابعة تنجرف
// عن الـenum عند كل قيمةٍ جديدة. خريطة الأصناف اللونية تبقى محلّية: نطاقها العرض لا التعريب.
const STATUS_CLS: Record<string, string> = {
  PAID: "bg-emerald-100 text-emerald-700",
  PARTIALLY_PAID: "bg-amber-100 text-amber-700",
  PENDING: "bg-muted text-foreground/70",
  RETURNED: "bg-rose-100 text-rose-700",
  CANCELLED: "bg-rose-100 text-rose-700",
  SUPERSEDED: "badge-status-cancelled",
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
  const [, navigate] = useLocation();
  const invoiceId = Number(params.id);
  const utils = trpc.useUtils();
  const inv = trpc.sales.get.useQuery(
    { invoiceId },
    { enabled: Number.isFinite(invoiceId) },
  );
  // الرقم الضريبي للشركة (إعدادات النظام) — يُطبع على الفاتورة بجانب رقم العميل الضريبي إن وُجد.
  const taxSettings = trpc.system.getTaxSettings.useQuery();

  const [payAmount, setPayAmount] = useState("");
  const [payReference, setPayReference] = useState("");
  const [payMethod, setPayMethod] =
    useState<(typeof METHODS)[number]["v"]>("CASH");
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const [printingReceipt, setPrintingReceipt] = useState(false);
  // idempotency: مفتاح ثابت لكل دفعة (يتجدّد بعد النجاح) ⇒ نقرة مزدوجة لا تُسجّل دفعتين.
  const [clientRequestId, setClientRequestId] = useState(() =>
    crypto.randomUUID(),
  );

  // حوار الإلغاء (قرار مالك ١٢/٨): جهة الصرف إلزاميّة + سبب اختياريّ + تأكيد بكتابة رقم الفاتورة.
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelMethod, setCancelMethod] = useState<(typeof METHODS)[number]["v"]>("CASH");
  const [cancelReason, setCancelReason] = useState("");
  const [cancelConfirmText, setCancelConfirmText] = useState("");
  const [cancelRequestId, setCancelRequestId] = useState(() => crypto.randomUUID());

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
      setDone(`تم تسجيل الدفعة. الحالة: ${invoiceStatusLabel(r.status)}.`);
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

  const cancel = trpc.sales.cancel.useMutation({
    onSuccess: async (r) => {
      const refunded = D(r.refundAmount ?? "0");
      const refundMsg = refunded.gt(0)
        ? ` — استُرِدّ ${fmt(refunded.toFixed(2))}${r.refundVoucherNumber ? ` بسند ${r.refundVoucherNumber}` : ""}`
        : "";
      setDone(`أُلغيت الفاتورة ${r.invoiceNumber}${refundMsg}.`);
      setError("");
      setCancelOpen(false);
      setCancelReason("");
      setCancelConfirmText("");
      await Promise.all([
        utils.sales.get.invalidate({ invoiceId }),
        utils.sales.list.invalidate(),
      ]);
      setCancelRequestId(crypto.randomUUID());
    },
    onError: (e) => { setError(e.message); setDone(""); },
  });

  // #28 (تدقيق التثبيت): تسجيل الدفعة = salesCashierProcedure(["cashier","manager"],"sales","FULL").
  // نُخفي لوحة «تسديد دفعة» عمّن يرفضه الخادم (محاسب/مدقّق/مندوب: sales=READ) بدل عرض نموذج يفشل
  // بـ403 — بنفس دالة الخادم moduleAccessAllowed (لا قائمة أدوار حرفية) ⇒ لا تباعُد.
  const me = trpc.auth.me.useQuery();
  // ٢٤/٨ (Codex P2 على PR #744): بوّابتان للروابط المُضافة حديثاً — كلاهما لأدوارٍ فعلاً تستطيع فتح الوجهة.
  const canOpenStatement = !!me.data?.role && moduleAccessAllowed(
    me.data.role as RoleKey,
    (me.data.permissionsOverride ?? null) as PermissionMap | null,
    "reports",
    "READ",
    ["admin", "manager", "accountant", "auditor"],
  );
  const canOpenVouchers = !!me.data?.role && moduleAccessAllowed(
    me.data.role as RoleKey,
    (me.data.permissionsOverride ?? null) as PermissionMap | null,
    "treasury",
    "READ",
    ["admin", "manager", "accountant"],
  );
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
  const [correctionReason, setCorrectionReason] = useState("");
  const [dispatchOpen, setDispatchOpen] = useState(false);
  const [cancelDeliveryOpen, setCancelDeliveryOpen] = useState(false);
  // عكس فاتورة الخدمة الصفريّة (١٩/٨) — المقبوض يبقى أمانةً يردّها سند صرفٍ موثَّق.
  const reverseService = trpc.workOrders.reverseServiceInvoice.useMutation({
    onSuccess: (r) => {
      const refundable = Number((r as { refundableAmount?: string }).refundableAmount ?? 0);
      notify.ok(
        "عُكس التسليم",
        refundable > 0
          ? `الفاتورة مرتجعة. المقبوض ${refundable.toLocaleString()} د.ع يبقى أمانةً — اصرفه للزبون بسند صرفٍ موثَّق.`
          : "الفاتورة مرتجعة وأمر الشغل مُلغى.",
      );
      void utils.sales.get.invalidate();
    },
    onError: (e) => notify.err(e),
  });

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
  // بوّابة الإلغاء (مطابقةٌ لـsalesManagerProcedure على الخادم): مدير قالبياً أو مَن مُنح sales=FULL صراحةً (أو admin).
  // الكاشير مستَبعَد صراحةً — الإلغاء مديريٌّ حصراً (SOD مع البائع الأصلي).
  const canCancelInvoice =
    !!me.data?.role &&
    moduleAccessAllowed(
      me.data.role as RoleKey,
      (me.data.permissionsOverride ?? null) as PermissionMap | null,
      "sales",
      "FULL",
      ["manager"],
    );
  const canDispatchInvoice =
    !!me.data?.role &&
    moduleAccessAllowed(
      me.data.role as RoleKey,
      (me.data.permissionsOverride ?? null) as PermissionMap | null,
      "store",
      "FULL",
      ["manager", "cashier", "sales_rep"],
    ) &&
    (!data.consignmentNumber || data.consignmentStatus === "CANCELLED") &&
    data.status !== "CANCELLED" &&
    data.status !== "RETURNED" &&
    data.status !== "SUPERSEDED" &&
    data.sourceType !== "ONLINE" &&
    data.sourceType !== "WORKORDER";
  const canCancelDelivery =
    !!me.data?.role &&
    moduleAccessAllowed(
      me.data.role as RoleKey,
      (me.data.permissionsOverride ?? null) as PermissionMap | null,
      "store",
      "FULL",
      ["manager"],
    ) &&
    data.consignmentId != null &&
    (data.consignmentParcelStatus === "ASSIGNED" || data.consignmentParcelStatus === "FAILED");
  const isCancellable =
    data.status !== "CANCELLED" &&
    data.status !== "RETURNED" &&
    data.sourceType !== "WORKORDER";
  /**
   * فاتورة أمر شغلٍ حيّة: مخرجها الوحيد هو المرتجع الموثَّق (الإلغاء والتصحيح يرفضهما الخادم
   * لهذا المنشأ). البوّابة مرآةُ `returns.create` = مدير + `sales:FULL`. التوصيلُ النشط يُستثنى:
   * الطرد بيد المندوب ⇒ المخرج هناك «استرجاع الإرسالية» لا مرتجعٌ من هنا.
   */
  /**
   * ١٩/٨ — الفاتورة الصفريّة البنود (أمرُ تخصيصٍ خالصٍ بلا منتجٍ كتالوجيّ) لا يقبلها
   * المرتجع (يشترط أسطراً) ⇒ مخرجها عكسٌ رأسيّ مخصّص. وذاتُ البنود مخرجها المرتجع المُختبَر.
   */
  const isZeroItemServiceInvoice = data.sourceType === "WORKORDER" && data.items.length === 0;
  /** مُعرّف أمر الشغل مشتقٌّ من `sourceId` (`WO-{id}`) — الحقل الرابط الوحيد على الفاتورة. */
  const linkedWorkOrderId = (() => {
    const m = /^WO-(\d+)$/.exec(String(data.sourceId ?? ""));
    return m ? Number(m[1]) : null;
  })();
  const canReverseWorkOrderInvoice =
    data.sourceType === "WORKORDER" &&
    data.status !== "CANCELLED" &&
    data.status !== "RETURNED" &&
    data.status !== "SUPERSEDED" &&
    !data.consignmentNumber &&
    !!me.data?.role &&
    moduleAccessAllowed(
      me.data.role as RoleKey,
      (me.data.permissionsOverride ?? null) as PermissionMap | null,
      "sales",
      "FULL",
      ["manager"],
    );
  const paidAmountForRefund = round2(D(data.paidAmount ?? "0"));
  const hasDiscount = D(data.discountAmount ?? "0").gt(0);
  const hasTax = D(data.taxAmount ?? "0").gt(0);
  // «تصحيح كامل» (عكس وإعادة إصدار، 0168) — أضيق من «تعديل البيانات»: يُقصَر على فاتورة بيعٍ
  // حيّة بلا مرتجعات ولا توصيلٍ نشط ولا أمر شغل (الخادم يرفض البقية برسالةٍ واضحة؛ هذا فلترٌ
  // بصريّ يمنع رحلةً تنتهي برفض). المُصحَّحة سابقاً (SUPERSEDED) والملغاة مستبعَدتان.
  // ⭐ قرار المالك (١٧/٨/٢٦): رُفع شرط `paidAmount == 0`. كان مرآةً لحظر الخادم، وأثرُه أنّ
  //    **كل فاتورة استقبالٍ عليها عربون لا يظهر لها زرّ تصحيحٍ إطلاقاً** — وهو جوهر الشكوى.
  //    الآن المقبوض يُنقل للمصحّحة كما هو، والفرق الزائد يُردّ نقداً أو يُرصَّد (correct.ts خطوة ⑨).
  const canFullCorrect =
    canCorrectInvoice &&
    data.status !== "CANCELLED" &&
    data.status !== "SUPERSEDED" &&
    D(data.returnedTotal ?? "0").isZero() &&
    data.sourceType !== "WORKORDER" &&
    !data.consignmentNumber;

  function openCorrection() {
    setCorrectionNotes(data.notes ?? "");
    setCorrectionDueDate(data.dueDate ? String(data.dueDate).slice(0, 10) : "");
    setCorrectionReason("");
    setCorrectionOpen(true);
  }

  function submitCorrection() {
    correctInvoice.mutate({
      invoiceId,
      notes: correctionNotes,
      dueDate: correctionDueDate || null,
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
    if (!isPosPaymentMethodEnabled(payMethod)) return setError(posPaymentRejectionMessage(payMethod));
    const amt = D(payAmount || "0");
    if (payMethod !== "CASH" && !payReference.trim()) {
      return setError("مرجع عملية البطاقة/التحويل مطلوب — لا يُسجَّل قبضٌ بلا أثرٍ قابلٍ للمطابقة.");
    }
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
      reference: payMethod === "CASH" ? undefined : payReference.trim(),
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
        isGift: it.isGift,
      })),
      deliveryFee: data.deliveryFee,
      deliveryFree: data.deliveryFree,
      deliveryWaivedAmount: data.deliveryWaivedAmount,
      // ٨/٨ — توصيل الاستقبال (COURIER/COD): الأجرة على الإرسالية لا الفاتورة ⇒ نمرّرها للعرض
      // كي تُظهر الفاتورة المطبوعة «المجموع النهائي الذي يدفعه الزبون شاملاً التوصيل».
      courierDelivery: data.courierName && Number(data.courierFee ?? 0) > 0
        ? { partyName: data.courierName, fee: data.courierFee ?? "0", feeCollection: data.courierFeeCollection ?? "COURIER" }
        : null,
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
      {/* ٢٤/٨ (تدقيق): رقم الفاتورة في العنوان — عند فتح تبويباتٍ متعدّدة لفواتير مختلفة كلٌّ منها
          كان يعرض «تفاصيل الفاتورة» ذاتها. الرقم يميّز التبويبات بصرياً وفي `document.title` عبر
          نمطٍ لاحق. */}
      <PageHeader
        title={
          <span>
            تفاصيل الفاتورة <span dir="ltr" className="font-mono text-primary">#{data.invoiceNumber}</span>
          </span>
        }
        backHref="/invoices"
        backLabel="رجوع للمبيعات"
        actionsClassName="sm:w-full sm:shrink"
        actions={<>
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
              returnedTotal: data.returnedTotal,
              remaining: remaining.toFixed(2),
              // بلا الحالة كانت الفاتورة الملغاة/المرتجعة/المستبدلة تُرسِل «المتبقّي» كمطالبة.
              status: data.status,
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
          {canFullCorrect && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => navigate(`/invoices/${invoiceId}/correct`)}
            >
              <FileWarning aria-hidden className="size-4" />
              تصحيح كامل
            </Button>
          )}
          {canDispatchInvoice && (
            <Button variant="outline" size="sm" onClick={() => setDispatchOpen(true)}>
              <Truck aria-hidden className="size-4" />
              إسناد للتوصيل
            </Button>
          )}
          {canCancelDelivery && (
            <Button variant="destructive" size="sm" onClick={() => setCancelDeliveryOpen(true)}>
              <Truck aria-hidden className="size-4" />
              إلغاء إسناد التوصيل
            </Button>
          )}
          {canCorrectInvoice && (
            <Button variant="outline" size="sm" onClick={openCorrection}>
              <Pencil aria-hidden className="size-4" />
              تعديل البيانات
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
          {canCancelInvoice && isCancellable && (
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                setCancelMethod(
                  (data.paymentMethod as (typeof METHODS)[number]["v"] | null) ??
                    "CASH",
                );
                setCancelReason("");
                setCancelConfirmText("");
                setError("");
                setCancelOpen(true);
              }}
            >
              <FileWarning aria-hidden className="size-4" />
              إلغاء الفاتورة
            </Button>
          )}
          {/* ١٨/٨ — مخرج فاتورة أمر الشغل (بلاغ المالك: «لا نستطيع إلغاءها أو التعديل عليها»).
              كانت أزرارُ الإلغاء والتصحيح تُخفى لها **بلا أيّ بديلٍ معروض**: الخادم يرفض
              `sales.cancel` لمنشأ WORKORDER ويحيل إلى إلغاء أمر الشغل، وذاك يرفض المُسلَّم ⇒
              الفاتورة بلا مخرجٍ ظاهر البتّة. المسار المشروع الوحيد هو **المرتجع الموثَّق**
              (returnService يعرف WORKORDER: لا يعيدها للمخزون — منتَجٌ مخصّص لا يُباع لغيره)،
              فنعرضه صراحةً بدل تركِ الموظف أمام شاشةٍ بلا أفعال. */}
          {canReverseWorkOrderInvoice && (isZeroItemServiceInvoice ? (
            <Button
              variant="destructive"
              size="sm"
              title="فاتورة خدمةٍ بلا بنود — تُعكَس رأسياً (لا مخزون لها)"
              disabled={reverseService.isPending || linkedWorkOrderId == null}
              onClick={() => {
                const reason = window.prompt("سبب عكس التسليم (يُوثَّق في الفاتورة وسجلّ التدقيق):")?.trim();
                if (!reason || reason.length < 3) return;
                reverseService.mutate({
                  workOrderId: Number(linkedWorkOrderId),
                  reason,
                  clientRequestId: crypto.randomUUID(),
                });
              }}
            >
              <RotateCcw aria-hidden className="size-4" />
              عكس التسليم (خدمة)
            </Button>
          ) : (
            <Button variant="destructive" size="sm" asChild title="المسار الموثَّق لعكس تسليم أمر شغل">
              <Link href={`/returns?invoiceId=${data.id}`}>
                <RotateCcw aria-hidden className="size-4" />
                إرجاع / عكس التسليم
              </Link>
            </Button>
          ))}
        </>}
      />

      {/* بطاقة الترويسة: بيانات وصفية + لوحة ملخّص مالي */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center justify-between gap-2">
            <CopyInline value={data.invoiceNumber} />
            <div className="flex items-center gap-2">
              {/* بالطريق مع المندوب ⇒ الحقيقة «عند الاستلام» لا طريقة السلة المخزَّنة (بلاغ
                  المالك ١٠/٨: فاتورة توصيل بلا أي قبضٍ كانت تتصدّر بشارة «نقدي»). */}
              {(data.consignmentStatus === "DISPATCHED" || data.consignmentStatus === "PARTIAL") ? (
                <span
                  className="text-xs rounded-full px-2.5 py-0.5 font-semibold badge-stock-low"
                  title={D(data.paidAmount).gt(0) && data.paymentMethod
                    ? `المتبقّي يُحصَّل عند الاستلام — المقبوض سلفاً بطريقة: ${paymentMethodLabel(data.paymentMethod)}`
                    : "تُحصَّل عند الاستلام عبر المندوب ثم تُورَّد"}
                >
                  عند الاستلام (COD)
                </span>
              ) : data.paymentMethod && (
                <span
                  className={`text-xs rounded-full px-2.5 py-0.5 font-semibold ${paymentMethodClass(data.paymentMethod)}`}
                  title="طريقة الدفع المسجّلة على هذه الفاتورة"
                >
                  {paymentMethodLabel(data.paymentMethod)}
                </span>
              )}
              {/* التمييز البصريّ «مُعدَّلة» (طلب المالك ١٧/٨): هذه الفاتورة صدرت تصحيحاً
                  لفاتورةٍ سابقة. `correctionOfInvoiceId` كان يُكتَب ولا يُقرأ من أيّ استعلام. */}
              {data.correctionOfInvoiceId != null && (
                <Link
                  href={`/invoices/${data.correctionOfInvoiceId}`}
                  className="rounded-full bg-[var(--sem-warn-bg)] px-2.5 py-0.5 text-xs font-medium text-[var(--sem-warn)]"
                  title="فاتورةٌ مُعدَّلة — اضغط لعرض الأصل المُستبدَل"
                >
                  مُعدَّلة
                </Link>
              )}
              <span
                className={`text-xs rounded-full px-2.5 py-0.5 font-medium ${STATUS_CLS[data.status] ?? "bg-muted"}`}
              >
                {invoiceStatusLabel(data.status)}
              </span>
            </div>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-5 md:grid-cols-3">
            {/* البيانات الوصفية */}
            <div className="md:col-span-2 grid grid-cols-2 gap-x-6 gap-y-4 text-sm content-start">
              <Field label="القناة">
                <span className="inline-flex items-center gap-1.5">
                  <InvoiceChannelBadge row={data} />
                  <span className="text-xs text-muted-foreground">{sourceTypeLabel(data.sourceType)}</span>
                </span>
              </Field>
              <Field label="العميل">
                {/* ٢٤/٨ (تدقيق + Codex P2): اسمُ العميل رابطٌ لكشف الحساب — لأدوارٍ لها `reports:READ`
                    فقط (Cashier/print/reception يذهبون إلى تبويبٍ محذوف). «عميل نقدي» يبقى نصاً. */}
                {data.customerId && canOpenStatement ? (
                  <Link
                    href={`/customers-statement?id=${data.customerId}`}
                    className="text-primary hover:underline"
                    title="فتح كشف حساب العميل"
                  >
                    {data.customerName ?? `#${data.customerId}`}
                  </Link>
                ) : (
                  data.customerName ?? "عميل نقدي"
                )}
              </Field>
              <Field label="موظف المبيعات">{data.salespersonName ?? "—"}</Field>
              <Field label="الوردية">
                {data.shiftId
                  ? `#${data.shiftId} — ${shiftTypeLabel(data.shiftType)}`
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
              {/* إفصاح التوصيل (0152): أجرةٌ مقبوضة، أو توصيلٌ أُهدي (بقيمته)، أو لا سطر
                  إطلاقاً حين لا توصيل — الصفر الصامت كان يخلط الحالتين الأخيرتين. */}
              {Number(data.deliveryFee ?? 0) > 0 ? (
                <SummaryRow label="أجرة التوصيل" value={data.deliveryFee} />
              ) : data.deliveryFree ? (
                <div className="flex items-center justify-between py-1 text-sm">
                  <span className="text-muted-foreground">التوصيل</span>
                  <span className="badge-status-active rounded-md px-1.5 py-0.5 text-xs font-extrabold">
                    {Number(data.deliveryWaivedAmount ?? 0) > 0
                      ? `مجاناً — قيمته ${fmt(data.deliveryWaivedAmount)} د.ع`
                      : "مجاناً"}
                  </span>
                </div>
              ) : null}
              <div className="border-t pt-2.5">
                <SummaryRow label="الإجمالي" value={data.total} strong />
              </div>
              {/* ٨/٨ — توصيل الاستقبال (COURIER/COD): الأجرة على الإرسالية لا الفاتورة (تمريرٌ لا
                  إيراد) ⇒ خارج «الإجمالي»؛ نعرضها هنا مع «المجموع النهائي» الذي يدفعه الزبون. */}
              {data.courierName && Number(data.courierFee ?? 0) > 0 && (
                <div className="mt-1.5 rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] px-2.5 py-2 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="inline-flex items-center gap-1 font-bold text-[var(--sem-warn)]">
                      <Truck aria-hidden className="size-3.5" /> أجرة التوصيل ({data.courierFeeCollection === "COUNTER" ? "مقبوضة في الاستقبال" : data.courierFeeCollection === "SHOP" ? "على المكتبة" : `يقبضها ${data.courierName}`})
                    </span>
                    <span className="font-black tabular-nums text-[var(--sem-warn)]" dir="ltr">{fmt(data.courierFee)}</span>
                  </div>
                  {data.courierFeeCollection !== "SHOP" && (
                    <div className="mt-1.5 flex items-center justify-between border-t border-[var(--sem-warn)]/30 pt-1.5 font-black text-[var(--sem-warn)]">
                      <span>المجموع النهائي (يدفعه الزبون شاملاً التوصيل)</span>
                      <span className="tabular-nums" dir="ltr">{fmt(round2(D(data.total).plus(D(data.courierFee ?? 0))).toFixed(2))}</span>
                    </div>
                  )}
                </div>
              )}
              {/* ٩/٨ — خيط الإرسالية: الرقم + الحالة + الجهة برابطٍ لمركز التوصيل («وين طلبي؟»
                  كان ينقطع هنا — الاسم والأجرة بلا رقم إرسالية ولا حالة ولا مسار متابعة). */}
              {data.consignmentNumber && (
                <div className="mt-1.5 flex flex-wrap items-center justify-between gap-1.5 rounded-md border px-2.5 py-2 text-sm">
                  <span className="inline-flex items-center gap-1.5">
                    <Truck aria-hidden className="size-3.5 text-muted-foreground" />
                    إرسالية <span className="font-mono font-bold" dir="ltr">{data.consignmentNumber}</span>
                    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${
                      data.consignmentStatus === "DELIVERED"
                        ? "badge-status-active"
                        : data.consignmentStatus === "RETURNED" || data.consignmentStatus === "WRITTEN_OFF" ? "badge-stock-out" : "badge-stock-low"
                    }`}>
                      {data.consignmentStatus === "DISPATCHED" ? "بالطريق"
                        : data.consignmentStatus === "PARTIAL" ? "حُصِّل جزئياً"
                        : data.consignmentStatus === "DELIVERED" ? "سُلِّمت"
                        : data.consignmentStatus === "RETURNED" ? "أُرجعت"
                        : data.consignmentStatus === "WRITTEN_OFF" ? "شُطبت" : data.consignmentStatus}
                    </span>
                  </span>
                  <a className="text-xs font-bold text-primary hover:underline" href={`/delivery?tab=parties&detail=${data.deliveryPartyId ?? ""}`}>
                    {data.courierName ?? "جهة التوصيل"} — كشف الجهة
                  </a>
                </div>
              )}
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
                        {it.isGift && (
                          // وسمُ الهدية على الشاشة: يميّز «مجّانيّ مقصود» عن «سعر صفر بالخطأ»،
                          // ويشرح لماذا لا يزيد هذا السطر إجمالي الفاتورة.
                          <span className="badge-status-active inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-extrabold">
                            <Gift aria-hidden className="size-3" /> هدية
                          </span>
                        )}{" "}
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
                        // ٢٤/٨ (تدقيق + Codex P2): رقمُ السند رابطٌ لصفحة السندات — لأدوار الخزينة
                        // فقط (Cashier يذهب إلى /treasury بلا تبويب vouchers). الفلترُ عبر `q` — العقد
                        // الفعليّ في Vouchers.tsx (لا يتعرّف على `number`).
                        canOpenVouchers ? (
                          <Link
                            href={`/vouchers?q=${encodeURIComponent(p.voucherNumber)}`}
                            className="text-primary hover:underline"
                            title="فتح السند"
                          >
                            {p.voucherNumber}
                          </Link>
                        ) : (
                          <span className="text-muted-foreground">{p.voucherNumber}</span>
                        )
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
                {ENABLED_COLLECTION_METHODS.map((m) => (
                  <option key={m.v} value={m.v}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>
            {payMethod !== "CASH" && (
              <div className="space-y-1">
                <Label htmlFor="invoice-pay-reference">
                  مرجع العملية <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="invoice-pay-reference"
                  dir="ltr"
                  value={payReference}
                  onChange={(e) => setPayReference(e.target.value)}
                  maxLength={100}
                  placeholder="رقم إشعار الجهاز أو رقم التحويل"
                />
                <p className="text-xs text-muted-foreground">
                  لا تُسجَّل دفعة إلكترونية بلا مرجع قابل للمطابقة مع كشف المزوّد.
                </p>
              </div>
            )}
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
              // ⛔ لا `paymentMethod`/`receipts` (تجريد ١٩/٨): كان `sales.correct` يكتبهما
              // **متطابقَين** في طرفَي التدقيق ولا يمسّهما، وهذه الشاشة ترسم لهما سطر
              // «طريقة الدفع: كذا ← كذا» لا يظهر أبداً ⤇ وعدٌ بقدرةٍ لا وجود لها. الصفوف
              // التاريخية قد تحمل المفتاحَين وتُتجاهَلان بلا ضرر (متطابقان فيها أصلاً).
              const oldFields =
                (entry.oldValue as {
                  notes?: string | null;
                  dueDate?: string | null;
                } | null) ?? {};
              const newValue =
                (entry.newValue as {
                  reason?: string;
                  fields?: typeof oldFields;
                  correctedInvoiceNumber?: string;
                  correctedInvoiceId?: number;
                  total?: string;
                  overpay?: string;
                  overpayHandled?: "CREDIT" | "CASH_REFUND" | null;
                } | null) ?? {};
              const newFields = newValue.fields ?? {};
              const isReissue = entry.action === "sale.reissue";
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
                  {isReissue && (
                    <span className="inline-flex w-fit items-center gap-1 rounded-md bg-primary/10 px-1.5 py-0.5 text-[10px] font-extrabold text-primary">
                      <FileWarning aria-hidden className="size-3" />
                      تصحيح كامل (عكس وإعادة إصدار)
                    </span>
                  )}
                  <p>
                    <span className="text-muted-foreground">السبب: </span>
                    {newValue.reason ?? "—"}
                  </p>
                  {isReissue && newValue.correctedInvoiceNumber && (
                    <div className="grid gap-1 text-xs text-muted-foreground">
                      <p>
                        استُبدِلت بالفاتورة{" "}
                        {newValue.correctedInvoiceId ? (
                          <Link
                            href={`/invoices/${newValue.correctedInvoiceId}`}
                            className="font-semibold text-primary hover:underline"
                          >
                            {newValue.correctedInvoiceNumber}
                          </Link>
                        ) : (
                          <span className="font-semibold text-foreground">{newValue.correctedInvoiceNumber}</span>
                        )}
                      </p>
                      {newValue.overpayHandled && (
                        <p>
                          الفرق الزائد:{" "}
                          <span className="text-foreground">
                            {newValue.overpayHandled === "CASH_REFUND" ? "استرداد نقديّ" : "رصيد دائن للعميل"}
                            {newValue.overpay ? ` (${fmt(newValue.overpay)})` : ""}
                          </span>
                        </p>
                      )}
                    </div>
                  )}
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
            <DialogTitle>تعديل بيانات الفاتورة</DialogTitle>
            <DialogDescription>
              الملاحظات وتاريخ الاستحقاق فقط — لا يمسّ البنود ولا المبالغ ولا
              طريقة الدفع. لتغيير البنود أو الأسعار استعمل «تصحيح الفاتورة»
              (عكسٌ وإعادةُ إصدار). متاح للمدير والمالك وحدهما، ويُسجّل السبب
              والقيم قبل وبعد باسمك.
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
            <div className="space-y-1.5">
              <Label htmlFor="invoice-correction-reason">سبب التعديل *</Label>
              <Textarea
                id="invoice-correction-reason"
                value={correctionReason}
                onChange={(event) => setCorrectionReason(event.target.value)}
                placeholder="مثال: تصحيح ملاحظة العميل أو تاريخ الاستحقاق"
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

      {/* حوار الإلغاء (قرار مالك ١٢/٨): جهة صرفٍ إلزاميّة + سبب اختياريّ + تأكيد كتابيٌّ لرقم الفاتورة. */}
      <Dialog open={cancelOpen} onOpenChange={setCancelOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <FileWarning aria-hidden className="size-5" />
              إلغاء الفاتورة {data.invoiceNumber}
            </DialogTitle>
            <DialogDescription className="space-y-2 pt-2 text-start">
              <div>
                إلغاءٌ كامل يعكس القيد المحاسبيّ ويعيد كامل البضاعة إلى المخزون
                {paidAmountForRefund.gt(0) && (
                  <> ويُصدر <strong>سند صرفٍ</strong> باستردادِ {fmt(paidAmountForRefund.toFixed(2))}</>
                )}.
              </div>
              {data.status !== "PENDING" && (
                <div className="rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] p-2 text-xs text-[var(--sem-warn)]">
                  حالة الفاتورة حالياً: <strong>{invoiceStatusLabel(data.status)}</strong> — يُلغى ما تبقّى غير مُرتجَع.
                </div>
              )}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            {paidAmountForRefund.gt(0) && (
              <div className="space-y-1">
                <Label htmlFor="cancel-method">جهة الاسترداد (إلزاميّة)</Label>
                <select
                  id="cancel-method"
                  className={selectCls}
                  value={cancelMethod}
                  onChange={(e) => setCancelMethod(e.target.value as typeof cancelMethod)}
                >
                  {METHODS.map((m) => <option key={m.v} value={m.v}>{m.label}</option>)}
                </select>
                <p className="text-xs text-muted-foreground">
                  النقد يخرج من درج الوردية المفتوحة (أو من الخزينة الإدارية إن كنت مديراً بلا وردية).
                </p>
              </div>
            )}
            <div className="space-y-1">
              <Label htmlFor="cancel-reason">سبب الإلغاء (اختياريّ)</Label>
              <Input
                id="cancel-reason"
                value={cancelReason}
                onChange={(e) => setCancelReason(e.target.value)}
                maxLength={500}
                placeholder="خطأ إدخال / طلب زبون / …"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="cancel-confirm">
                للتأكيد اكتب رقم الفاتورة: <span dir="ltr" className="font-mono font-semibold">{data.invoiceNumber}</span>
              </Label>
              <Input
                id="cancel-confirm"
                value={cancelConfirmText}
                onChange={(e) => setCancelConfirmText(e.target.value)}
                autoComplete="off"
                placeholder={data.invoiceNumber}
              />
            </div>
          </div>

          <DialogFooter className="gap-2 sm:justify-between">
            <Button variant="outline" onClick={() => setCancelOpen(false)}>رجوع</Button>
            <Button
              variant="destructive"
              disabled={cancel.isPending || cancelConfirmText.trim() !== data.invoiceNumber}
              onClick={() => {
                if (cancelConfirmText.trim() !== data.invoiceNumber) return;
                cancel.mutate({
                  invoiceId,
                  refundPaymentMethod: cancelMethod,
                  reason: cancelReason.trim() || undefined,
                  clientRequestId: cancelRequestId,
                });
              }}
            >
              {cancel.isPending ? "جارٍ الإلغاء…" : "إلغاء الفاتورة نهائياً"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <InvoiceDispatchDialog
        open={dispatchOpen}
        onOpenChange={setDispatchOpen}
        invoice={{
          id: data.id,
          invoiceNumber: data.invoiceNumber,
          total: data.total,
          paidAmount: data.paidAmount,
          returnedTotal: data.returnedTotal,
          customerName: data.customerName,
          customerPhone: data.customerPhone,
        }}
      />
      <CancelDeliveryAssignmentDialog
        open={cancelDeliveryOpen}
        onOpenChange={setCancelDeliveryOpen}
        consignment={data.consignmentId ? {
          id: data.consignmentId,
          number: data.consignmentNumber ?? `#${data.consignmentId}`,
        } : null}
      />
    </div>
  );
}
