import { PageHeader } from "@/components/PageHeader";
import { ErrorState } from "@/components/PageState";
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
import { PaymentDeviceReferenceField } from "@/components/form/PaymentDeviceReferenceField";
import { PaymentReferenceField } from "@/components/pos/PaymentReferenceField";
import { AppSelect } from "@/components/ui/AppSelect";
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
import { fmtDate } from "@/lib/date";
import { confirm } from "@/lib/confirm";
import { printInvoiceA4 } from "@/lib/printing/printTemplates";
import { printWarehouseSlipV2 } from "@/lib/printing/printTemplatesV2";
import { printReceipt } from "@/lib/printing/print";
import { invoiceToReceipt } from "@/lib/printing/invoiceReceipt";
import { allocateLineTax } from "@/components/invoice";
import { D, fmt, round2 } from "@/lib/money";
import { DataTable } from "@/components/data-table/DataTable";
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
import ReverseDeliveryRequestDialog from "@/components/workorder/ReverseDeliveryRequestDialog";
import { useEffect, useState } from "react";
import { Link, useLocation, useParams, useSearch } from "wouter";
import {
  ChevronDown,
  Download,
  FileText,
  FileWarning,
  Package,
  Pencil,
  Printer,
  Truck,
} from "lucide-react";
import { downloadOfficialPdf } from "@/lib/exportPdf";
import { notify } from "@/lib/notify";
import { getDeviceCode } from "@/lib/offline/outbox";
import { ACTION_LABELS } from "@shared/actionLabels";
import {
  POS_METHODS as METHODS,
  paymentMethodLabel,
} from "@/lib/paymentMethod";
import { isPosPaymentMethodEnabled, posPaymentRejectionMessage,
} from "@shared/posPaymentPolicy";
import { NextActionChip } from "@/components/nextAction/NextActionChip";
import { invoiceStatusLabel } from "@shared/invoiceStatus";
import { InvoiceHeaderCard } from "@/components/invoice/InvoiceHeaderCard";
import { InvoiceCorrectionHistoryCard } from "@/components/invoice/InvoiceCorrectionHistoryCard";
import {
  invoiceItemColumns,
  invoicePaymentColumns,
  invoiceReturnColumns,
  type InvoiceItemRow,
  type InvoicePaymentRow,
  type InvoiceReturnRow,
} from "@/components/invoice/InvoiceDetailComponents";

const ENABLED_COLLECTION_METHODS = METHODS.filter((method) => isPosPaymentMethodEnabled(method.v),
);

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
  const [externalAttempt, setExternalAttempt] = useState<{
    attemptId: number | null;
    requestId: string;
    deviceId: string;
    fingerprint: string;
    confirmed: boolean;
  } | null>(null);
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
  const [cancelReference, setCancelReference] = useState("");
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
      setExternalAttempt(null);
      setPayReference("");
    },
    onError: (e) => {
      setError(e.message);
      setDone("");
    },
  });

  const initiateExternal = trpc.sales.initiateExternalPayment.useMutation();
  const confirmExternal = trpc.sales.confirmExternalPayment.useMutation();

  const cancel = trpc.sales.cancel.useMutation({
    onSuccess: async (r) => {
      setDone(`أُرسل طلب الإلغاء #${r.requestId} للاعتماد — لم يتغير المخزون أو المال بعد.`);
      setError("");
      setCancelOpen(false);
      setCancelReason("");
      setCancelConfirmText(""); setCancelReference("");
      await Promise.all([
        utils.salesControl.list.invalidate(),
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
    moduleAccessAllowed(
      me.data.role as RoleKey,
      (me.data.permissionsOverride ?? null) as PermissionMap | null,
      "sales",
      "FULL",
      ["manager"],
    );
  const corrections = trpc.sales.correctionHistory.useQuery(
    { invoiceId },
    { enabled: Number.isFinite(invoiceId) && canCorrectInvoice, retry: false },
  );
  const [correctionOpen, setCorrectionOpen] = useState(false);
  const [correctionNotes, setCorrectionNotes] = useState("");
  const [correctionDueDate, setCorrectionDueDate] = useState("");
  const [correctionReason, setCorrectionReason] = useState("");
  const [correctionRequestKey, setCorrectionRequestKey] = useState(() => crypto.randomUUID());
  const [dispatchOpen, setDispatchOpen] = useState(false);
  const [cancelDeliveryOpen, setCancelDeliveryOpen] = useState(false);
  const correctInvoice = trpc.sales.correct.useMutation();
  const requestDueDateChange = trpc.salesControl.requestDueDateChange.useMutation();

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
        {ACTION_LABELS.loading}
      </div>
    );
  if (inv.isError)
    return (
      <ErrorState
        message={`تعذّر تحميل الفاتورة: ${inv.error.message}`}
        onRetry={() => void inv.refetch()}
      />
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
  const normalizedPayAmount = round2(D(payAmount || "0")).toFixed(2);
  const externalNeeded = payMethod !== "CASH" && D(payAmount || "0").gt(0);
  const externalFingerprint = `SALES_COLLECTION|${data.branchId}|${payMethod}|${normalizedPayAmount}|${payReference.trim()}`;
  const externalConfirmed =
    !externalNeeded ||
    (externalAttempt?.confirmed === true &&
      externalAttempt.fingerprint === externalFingerprint);
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
  // الإلغاء صار طلباً صفري الأثر؛ موظف sales=FULL يطلب، ومديرٌ مستقل يعتمد وينفّذ.
  const canCancelInvoice =
    !!me.data?.role &&
    moduleAccessAllowed(
      me.data.role as RoleKey,
      (me.data.permissionsOverride ?? null) as PermissionMap | null,
      "sales",
      "FULL",
      ["cashier", "manager"],
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
  const hasDeliveryLifecycle =
    data.consignmentId != null || data.consignmentStatus != null || data.deliveryPartyId != null;
  // مرآة بصرية للحارس الخادمي: الإرسالية الحديثة لا تصبح آمنة إلا بعد CANCELLED النهائي.
  // طلب المتجر القديم الملغى يُعرض موحّداً كـRETURNED (saleRouter)، وهو الاستثناء الآمن بلا consignmentId.
  const deliveryCancellationResolved =
    data.consignmentId != null
      ? data.consignmentStatus === "CANCELLED"
      : data.sourceType === "ONLINE" && data.consignmentStatus === "RETURNED";
  const deliveryCancellationBlockReason = !hasDeliveryLifecycle || deliveryCancellationResolved
    ? null
    : canCancelDelivery
      ? "ألغِ إسناد التوصيل أولاً، ثم ألغِ الفاتورة. لا يجوز إعادة المخزون والطرد ما زال مسنداً."
      : data.consignmentStatus === "DISPATCHED" || data.consignmentStatus === "PARTIAL"
        ? "لا يمكن إلغاء الفاتورة والطرد أو تحصيل COD ما زال في دورة التوصيل. أعد الطرد وسوِّ العهدة من مركز التوصيل أولاً."
        : "لا يمكن إلغاء الفاتورة بعد تسليم الطرد أو وجود تسوية توصيل. استخدم الإرجاع الموثق أو عالج العهدة من مركز التوصيل.";
  const isCancellable =
    data.status !== "CANCELLED" &&
    data.status !== "RETURNED" &&
    data.sourceType !== "WORKORDER" &&
    deliveryCancellationBlockReason == null;
  /** فاتورة أمر الشغل الحيّة لا تمرّ بإلغاء البيع أو مرتجعه العام؛ مخرجها طلب عكس محكوم. */
  /** مُعرّف أمر الشغل مشتقٌّ من `sourceId` (`WO-{id}` القديم أو النسخة `WO-{id}:R{n}`). */
  const linkedWorkOrderId = (() => {
    const m = /^WO-(\d+)(?::R\d+)?$/.exec(String(data.sourceId ?? ""));
    return m ? Number(m[1]) : null;
  })();
  const canReverseWorkOrderInvoice =
    data.sourceType === "WORKORDER" &&
    data.status !== "CANCELLED" &&
    data.status !== "RETURNED" &&
    data.status !== "SUPERSEDED" &&
    !!me.data?.role &&
    moduleAccessAllowed(
      me.data.role as RoleKey,
      (me.data.permissionsOverride ?? null) as PermissionMap | null,
      "workorders",
      "FULL",
      ["cashier", "manager"],
    );
  const paidAmountForRefund = round2(D(data.paidAmount ?? "0"));
  // مرجع جهاز الدفع إلزاميّ لِـCARD وحدها (تفرضه الخدمة) — ومقصورٌ على حالة وجود استردادٍ فعليّ
  // كي لا يحجب فاتورةً بلا استرداد بسبب طريقةٍ متبقّية من فتحةٍ سابقة للحوار.
  const needsCardReference = paidAmountForRefund.gt(0) && cancelMethod === "CARD";
  const hasDiscount = D(data.discountAmount ?? "0").gt(0);
  const hasTax = D(data.taxAmount ?? "0").gt(0);
  // «تصحيح كامل» (عكس وإعادة إصدار، 0168) — أضيق من «تعديل البيانات»: يُقصَر على فاتورة بيعٍ
  // حيّة بلا مرتجعات ولا توصيلٍ نشط ولا أمر شغل (الخادم يرفض البقية برسالةٍ واضحة؛ هذا فلترٌ
  // بصريّ يمنع رحلةً تنتهي برفض). المُصحَّحة سابقاً (SUPERSEDED) والملغاة مستبعَدتان.
  // ⭐ قرار المالك (١٧/٨/٢٦): رُفع شرط `paidAmount == 0`. كان مرآةً لحظر الخادم، وأثرُه أنّ
  //    **كل فاتورة استقبالٍ عليها عربون لا يظهر لها زرّ تصحيحٍ إطلاقاً** — وهو جوهر الشكوى.
  //    الآن المقبوض يُنقل للمصحّحة كما هو، والفرق الزائد يُردّ نقداً أو يُرصَّد (correct.ts خطوة ⑨).
  const canFullCorrect =
    canRecordPayment &&
    data.status !== "CANCELLED" &&
    data.status !== "SUPERSEDED" &&
    D(data.returnedTotal ?? "0").isZero() &&
    data.sourceType !== "WORKORDER" &&
    !data.consignmentNumber;

  function openCorrection() {
    setCorrectionNotes(data.notes ?? "");
    setCorrectionDueDate(data.dueDate ? String(data.dueDate).slice(0, 10) : "");
    setCorrectionReason("");
    setCorrectionRequestKey(crypto.randomUUID());
    setCorrectionOpen(true);
  }

  async function submitCorrection() {
    const nextNotes = correctionNotes.trim() || null;
    const currentNotes = data.notes ?? null;
    const nextDueDate = correctionDueDate || null;
    const currentDueDate = data.dueDate ? String(data.dueDate).slice(0, 10) : null;
    const notesChanged = nextNotes !== currentNotes;
    const dueDateChanged = nextDueDate !== currentDueDate;
    if (!notesChanged && !dueDateChanged) {
      notify.err("لا يوجد تغيير", "عدّل الملاحظات أو تاريخ الاستحقاق أولاً.");
      return;
    }

    let notesSaved = false;
    try {
      // الملاحظات غير مالية وتُحفظ مباشرة أولاً، كي تلتقط بصمة طلب التاريخ
      // الرأس النهائي ولا يصبح الطلب STALE بسبب هذا التعديل نفسه.
      if (notesChanged) {
        await correctInvoice.mutateAsync({
          invoiceId,
          notes: correctionNotes,
          reason: correctionReason,
        });
        notesSaved = true;
      }
      let dueDateRequestId: number | null = null;
      if (dueDateChanged) {
        const requested = await requestDueDateChange.mutateAsync({
          requestKey: correctionRequestKey,
          invoiceId,
          dueDate: nextDueDate,
          reason: correctionReason,
        });
        dueDateRequestId = Number(requested.id);
      }
      setCorrectionOpen(false);
      setCorrectionReason("");
      setCorrectionRequestKey(crypto.randomUUID());
      if (dueDateRequestId != null) {
        notify.ok(
          notesSaved ? "حُفظت الملاحظات وأُرسل الطلب" : "أُرسل طلب تغيير الاستحقاق",
          `الطلب #${dueDateRequestId} صفري الأثر؛ يتغير التاريخ بعد اعتماد مدير مستقل فقط.`,
        );
      } else {
        notify.ok("حُفظت الملاحظات", "سُجل التعديل غير المالي باسمك.");
      }
      await Promise.all([
        utils.sales.get.invalidate({ invoiceId }),
        utils.sales.list.invalidate(),
        utils.sales.listPage.invalidate(),
        utils.sales.listSummary.invalidate(),
        utils.sales.correctionHistory.invalidate({ invoiceId }),
        utils.salesControl.list.invalidate(),
      ]);
    } catch (error) {
      if (notesSaved) {
        const detail = error instanceof Error ? error.message : "تعذّر إرسال طلب تاريخ الاستحقاق";
        notify.err("حُفظت الملاحظات فقط", `${detail}. أعد إرسال طلب التاريخ؛ لم يتغير تاريخ الاستحقاق.`);
      } else {
        notify.err(error);
      }
    }
  }

  async function reprintThermal() {
    if (printingReceipt) return;
    setPrintingReceipt(true);
    try {
      const result = await printReceipt({
        ...invoiceToReceipt(data),
        digitalDetails: digitalPrint.data?.length ? digitalPrint.data : null,
      });
      if (!result.ok) {
        notify.err("تعذّرت الطباعة", "حجب المتصفح نافذة الطباعة البديلة؛ اسمح بالنوافذ المنبثقة ثم أعد المحاولة",
        );
      } else if (result.via === "server") {
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

  async function confirmInvoiceExternalPayment() {
    const reference = payReference.trim();
    if (!reference) return setError("أدخل مرجع العملية أولاً.");
    if (!D(payAmount || "0").gt(0))
      return setError("أدخل مبلغ الدفعة قبل تأكيد العملية الخارجية.");
    setError("");
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
      setError(
        err instanceof Error ? err.message : "تعذّر تأكيد الدفع الخارجي",
      );
    }
  }

  async function submit() {
    setError("");
    setDone("");
    if (!isPosPaymentMethodEnabled(payMethod)) return setError(posPaymentRejectionMessage(payMethod));
    const amt = D(payAmount || "0");
    if (payMethod !== "CASH" && !payReference.trim()) {
      return setError("مرجع عملية البطاقة/التحويل مطلوب — لا يُسجَّل قبضٌ بلا أثرٍ قابلٍ للمطابقة.",
      );
    }
    if (
      payMethod !== "CASH" &&
      (!externalConfirmed || externalAttempt?.attemptId == null)
    ) {
      return setError("ثبّت تأكيد الدفع غير النقدي قبل تسجيل الدفعة.");
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
      ...(payMethod === "CASH"
        ? {}
        : {
            externalPaymentAttemptId: externalAttempt!.attemptId!,
            externalPaymentDeviceId: externalAttempt!.deviceId,
          }),
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
        ? { partyName: data.courierName, fee: data.courierFee ?? "0", feeCollection: data.courierFeeCollection ?? "COURIER",
            }
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

  function downloadOfficialDocument() {
    downloadOfficialPdf({
      kind: "INVOICE",
      documentId: invoiceId,
      documentNumber: data.invoiceNumber,
      fetcher: (params) => utils.client.documentDelivery.downloadPdf.mutate(params),
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
            تفاصيل الفاتورة{" "}
            <span dir="ltr" className="font-mono text-primary">#{data.invoiceNumber}</span>
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
              <DropdownMenuItem onClick={() => downloadOfficialDocument()}>
                <Download aria-hidden className="size-4" />
                تحميل / حفظ PDF
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
                setCancelMethod((data.paymentMethod as (typeof METHODS)[number]["v"] | null) ?? "CASH");
                setCancelReason("");
                setCancelConfirmText(""); setCancelReference("");
                setError("");
                setCancelOpen(true);
              }}
            >
              <FileWarning aria-hidden className="size-4" />
              إلغاء الفاتورة
            </Button>
          )}
          {/* كل فواتير أمر الشغل، ذات البنود والصفرية، تمرّ من طلب تحكم واحد صفري الأثر.
              لا عكس مباشر ولا تحويل إلى مرتجع بيع عام؛ الاعتماد المستقل هو من ينفّذ العملية. */}
          {canReverseWorkOrderInvoice && linkedWorkOrderId != null && (
              <ReverseDeliveryRequestDialog
                workOrderId={linkedWorkOrderId}
                orderNumber={String(data.sourceId ?? linkedWorkOrderId)}
                title={`فاتورة ${data.invoiceNumber}`}
                buttonLabel="طلب عكس التسليم"
                size="sm"
                onRequested={(message) => {
                  setDone(message);
                  setError("");
                }}
              />
            )}
          </>
        }
      />

      {/* م٢ ق١١ — «الخطوة التالية» على المستند. الحقلُ اختياريّ في العقد فيعرض null بأمان. */}
      <NextActionChip
        nextAction={data.nextAction ?? null}
        terminalReason={data.nextActionReason ?? null}
      />

      {canCancelInvoice && deliveryCancellationBlockReason && (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] px-3 py-2 text-sm text-[var(--sem-warn)]"
        >
          <span className="inline-flex items-center gap-2 font-medium">
            <Truck aria-hidden className="size-4 shrink-0" />
            {deliveryCancellationBlockReason}
          </span>
          <Link
            href={`/delivery?tab=parties&detail=${data.deliveryPartyId ?? ""}`}
            className="font-bold underline underline-offset-2"
          >
            فتح مركز التوصيل
          </Link>
        </div>
      )}

      {/* بطاقة الترويسة: بيانات وصفية + لوحة ملخّص مالي */}
      <InvoiceHeaderCard
        data={data}
        remaining={remaining}
        canOpenStatement={canOpenStatement}
      />

      {(data.returns ?? []).length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">سجل المرتجعات ومنفّذها</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {/* مُضمَّن: العنوان في رأس البطاقة، والسجلّ يُقرأ كاملاً بلا بحثٍ ولا ترقيم. */}
            <DataTable<InvoiceReturnRow>
              embedded
              searchable={false}
              bounded={false}
              pageSize={Infinity}
              columns={invoiceReturnColumns}
              data={data.returns ?? []}
              emptyText="لا مرتجعات على هذه الفاتورة."
            />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">البنود</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {/* بنود المستند: مُضمَّنة وبلا ترقيم — الفاتورة تُقرأ كاملةً.
              صفّ «مجموع البنود» صار `footer` فيقع تحت عمود إجمالي السطر مباشرةً. */}
          <DataTable<InvoiceItemRow>
            embedded
            searchable={false}
            bounded={false}
            pageSize={Infinity}
            columns={invoiceItemColumns(data.subtotal)}
            data={data.items}
            emptyText="لا بنود في هذه الفاتورة."
          />
        </CardContent>
      </Card>

      {/* ش١٢: الكروت الرقمية ومسار عكسها — لا تُعرض إن لم تكن الفاتورة تحوي كروتاً. */}
      <InvoiceDigitalCards invoiceId={invoiceId} />

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">سجل الدفعات</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {/* مُضمَّن: العنوان في رأس البطاقة، وسجلّ الدفعات يُقرأ كاملاً بلا بحثٍ ولا ترقيم. */}
          <DataTable<InvoicePaymentRow>
            embedded
            searchable={false}
            bounded={false}
            pageSize={Infinity}
            columns={invoicePaymentColumns(canOpenVouchers)}
            data={data.payments ?? []}
            emptyText="لا دفعات بعد."
          />
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
              <AppSelect
                value={payMethod}
                onValueChange={(value) => {
                  setPayMethod(value as typeof payMethod);
                  setPayReference("");
                  setExternalAttempt(null);
                }}
              >
                {ENABLED_COLLECTION_METHODS.map((m) => (
                  <option key={m.v} value={m.v}>
                    {m.label}
                  </option>
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
                  onConfirm={confirmInvoiceExternalPayment}
                  inputId="invoice-pay-reference"
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
        <InvoiceCorrectionHistoryCard
          isLoading={corrections.isLoading}
          history={corrections.data}
        />
      )}

      <Dialog open={correctionOpen} onOpenChange={setCorrectionOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>تعديل بيانات الفاتورة</DialogTitle>
            <DialogDescription>
              تُحفظ الملاحظات غير المالية مباشرة. أمّا تاريخ الاستحقاق فيُرسل
              كطلب صفري الأثر ولا يتغير إلا بعد اعتماد مدير مستقل عن الطالب
              ومنشئ الفاتورة. لتغيير البنود أو الأسعار استعمل «تصحيح الفاتورة».
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
              disabled={correctInvoice.isPending || requestDueDateChange.isPending}
            >
              إلغاء
            </Button>
            <Button
              onClick={submitCorrection}
              disabled={
                correctInvoice.isPending || requestDueDateChange.isPending || correctionReason.trim().length < 3
              }
            >
              {/* الطلبان يتعاقبان لا يتزامنان (submitCorrection: حفظ الملاحظات ثمّ إرسال طلب التاريخ)
                  ⇒ لكلّ طورٍ نصُّه الدقيق من القاموس بدل نصٍّ مركّب واحد. */}
              {correctInvoice.isPending
                ? ACTION_LABELS.saving
                : requestDueDateChange.isPending
                  ? ACTION_LABELS.sending
                  : "حفظ الملاحظات / إرسال طلب التاريخ"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {error && <p className="text-sm text-destructive">{error}</p>}
      {done && <p className="text-sm text-[var(--sem-pos)]">{done}</p>}

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
                هذا طلب إلغاء صفري الأثر. بعد اعتماد مراجع مستقل يعكس النظام القيد المحاسبيّ ويعيد كامل البضاعة إلى المخزون
                {paidAmountForRefund.gt(0) && (
                  <>
                    {" "}
                    ويُصدر <strong>سند صرفٍ</strong> باستردادِ {" "}
                    {fmt(paidAmountForRefund.toFixed(2))}</>
                )}.
              </div>
              {data.status !== "PENDING" && (
                <div className="rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] p-2 text-xs text-[var(--sem-warn)]">
                  حالة الفاتورة حالياً:{" "}
                  <strong>{invoiceStatusLabel(data.status)}</strong> — يُلغى ما تبقّى غير مُرتجَع.
                </div>
              )}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            {paidAmountForRefund.gt(0) && (
              <div className="space-y-1">
                <Label htmlFor="cancel-method">جهة الاسترداد (إلزاميّة)</Label>
                <AppSelect
                  id="cancel-method"
                  className="h-9"
                  value={cancelMethod}
                  onValueChange={(value) => setCancelMethod(value as typeof cancelMethod)}
                >
                  {METHODS.map((m) => (
                    <option key={m.v} value={m.v}>{m.label}</option>))}
                </AppSelect>
                <p className="text-xs text-muted-foreground">
                  النقد يخرج من درج الوردية المفتوحة (أو من الخزينة الإدارية إن كنت مديراً بلا وردية).
                </p>
              </div>
            )}
            {needsCardReference && (
              <PaymentDeviceReferenceField id="cancel-card-ref" value={cancelReference} onChange={setCancelReference}
                hint="اختياريّ هنا. إن نفّذت الاسترداد على الجهاز فعلاً أدخِل مرجعه — وإلا اتركه فارغاً؛ المُعتمِد المستقل يدخله أو يؤكّده لحظة الاعتماد، قبل أن يُنفَّذ أيّ أثرٍ فعليّ." />
            )}
            <div className="space-y-1">
              <Label htmlFor="cancel-reason">سبب الإلغاء *</Label>
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
                للتأكيد اكتب رقم الفاتورة:{" "}
                <span dir="ltr" className="font-mono font-semibold">{data.invoiceNumber}</span>
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
            <Button variant="destructive"
              disabled={cancel.isPending || cancelConfirmText.trim() !== data.invoiceNumber || cancelReason.trim().length < 3}
              onClick={() => {
                if (cancelConfirmText.trim() !== data.invoiceNumber) return;
                cancel.mutate({
                  invoiceId, refundPaymentMethod: cancelMethod,
                  reference: needsCardReference && cancelReference.trim() ? cancelReference.trim() : undefined,
                  reason: cancelReason.trim(), clientRequestId: cancelRequestId,
                });
              }}
            >
              {cancel.isPending ? ACTION_LABELS.sending : "إرسال طلب الإلغاء"}
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
