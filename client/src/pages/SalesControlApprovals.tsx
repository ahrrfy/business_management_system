import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "wouter";
import { ArrowLeft, Check, FileWarning, Package, Printer, RefreshCcw, Undo2, X } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { ErrorState, LoadingState } from "@/components/PageState";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { confirm } from "@/lib/confirm";
import { D, fmt, formatQuantity } from "@/lib/money";
import { notify } from "@/lib/notify";
import { releaseReservedPrintWindow, reservePrintWindow } from "@/lib/printing/brand";
import { invoiceToReceipt } from "@/lib/printing/invoiceReceipt";
import { printReceipt } from "@/lib/printing/print";
import { invoiceToShippingLabel } from "@/lib/printing/invoiceShippingLabel";
import { preopenShippingLabelWindow, printShippingLabel } from "@/lib/printing/shippingLabel";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { ACTION_LABELS } from "@shared/actionLabels";
import {
  SALES_CONTROL_STATUS_LABELS,
  SALES_CONTROL_TYPE_LABELS,
  type SalesControlStatus,
  type SalesControlType,
} from "@shared/salesControl";
import { moduleAccessAllowed, type PermissionMap, type RoleKey } from "@shared/permissions";
import { getDeviceCode } from "@/lib/offline/outbox";
import { salesControlFacts, type SalesControlFactsType } from "@shared/salesControlFacts";
import { fmtDate, fmtDateTime } from "@/lib/date";
import { paymentMethodLabel } from "@/lib/paymentMethod";
import {
  buildSalesCorrectionComparison,
  type CorrectionComparisonPayload,
} from "@/lib/salesCorrectionComparison";

const STATUS_BADGE_VARIANTS: Record<
  SalesControlStatus,
  "warning" | "success" | "danger" | "neutral"
> = {
  PENDING: "warning",
  APPROVED: "success",
  REJECTED: "danger",
  STALE: "neutral",
  WITHDRAWN: "neutral",
};

/**
 * ⭐ الاشتقاقُ من `@shared/salesControlFacts` لا نسخةٌ محلّية (تصويب مراجعة Codex على PR #932).
 * كانت هذه الدالّة تُعيد تعريف «مصير البضاعة» محلّياً فتعرضه معكوساً للزبون العابر، ثمّ كاد
 * صندوقُ موافقات أندرويد يُعيد العطب من بابٍ ثانٍ. تعريفٌ واحد يعرضه الطرفان.
 */
const payloadFacts = (type: SalesControlType, value: unknown) =>
  salesControlFacts(type as SalesControlFactsType, value, fmt);

function isReviewerConflict(
  reviewerId: number | null | undefined,
  request: { requestedBy: number; invoiceCreatedBy: number | null },
): boolean {
  return reviewerId != null && (
    Number(request.requestedBy) === Number(reviewerId)
    || Number(request.invoiceCreatedBy ?? -1) === Number(reviewerId)
  );
}

type ControlRequest = RouterOutputs["salesControl"]["list"][number];

function CorrectionBeforeAfter({ request, approvalAction }: { request: ControlRequest; approvalAction?: ReactNode }) {
  const payload = request.payload as CorrectionComparisonPayload;
  const original = trpc.sales.get.useQuery({ invoiceId: Number(request.invoiceId) });
  const catalog = trpc.salesControl.correctionCatalog.useQuery({ requestId: Number(request.id) });

  if (original.isLoading || catalog.isLoading) {
    return <div className="rounded-md border p-3 text-xs text-muted-foreground">جارٍ إعداد مقارنة الفاتورة…</div>;
  }
  if (original.isError || catalog.isError || !original.data || !catalog.data) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
        <span>تعذّر تحميل المقارنة كاملة؛ الاعتماد محجوب حتى تنجح إعادة المحاولة.</span>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void Promise.all([original.refetch(), catalog.refetch()])}
        >
          إعادة تحميل المقارنة
        </Button>
      </div>
    );
  }

  const comparison = buildSalesCorrectionComparison(original.data, payload, catalog.data.rows);
  const delta = D(comparison.afterTotal).minus(D(comparison.beforeTotal));
  const tierLabel = (value: string | null | undefined) => ({
    RETAIL: "مفرد",
    WHOLESALE: "جملة",
    GOVERNMENT: "حكومي",
  }[value ?? ""] ?? value ?? "—");
  const beforeCustomer = original.data.customerName
    ? `${original.data.customerName}${original.data.customerId ? ` (#${original.data.customerId})` : ""}`
    : "عميل نقدي";
  const afterCustomer = payload.customerId == null
    ? "عميل نقدي"
    : `${catalog.data.targetCustomerName ?? "عميل"} (#${payload.customerId})`;
  return (
    <div className="space-y-2 rounded-lg border-2 border-primary/20 bg-primary/5 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="font-extrabold text-primary">مقارنة التعديل قبل الاعتماد</div>
        <Badge variant={delta.eq(0) ? "neutral" : delta.gt(0) ? "warning" : "success"}>
          {delta.eq(0) ? "الإجمالي بلا تغيير" : `${delta.gt(0) ? "+" : "−"}${fmt(delta.abs().toFixed(2))} د.ع`}
        </Badge>
      </div>
      <div className="grid items-stretch gap-2 md:grid-cols-[1fr_auto_1fr]">
        <div className="rounded-md border bg-card p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="font-extrabold">كان هكذا</span>
            <span className="font-mono text-xs text-muted-foreground">#{request.invoiceNumber}</span>
          </div>
          <div className="mb-2 text-xs text-muted-foreground">تاريخ الفاتورة: {fmtDateTime(original.data.invoiceDate)}</div>
          <dl className="mb-3 grid gap-x-3 gap-y-1 rounded-md bg-muted/30 p-2 text-xs sm:grid-cols-2">
            <div><dt className="text-muted-foreground">العميل</dt><dd className="font-medium">{beforeCustomer}</dd></div>
            <div><dt className="text-muted-foreground">جهة الاتصال</dt><dd className="font-medium">{original.data.contactName || "—"} · {original.data.contactPhone || "—"}</dd></div>
            <div><dt className="text-muted-foreground">فئة السعر</dt><dd className="font-medium">{tierLabel(original.data.priceTier)}</dd></div>
            <div><dt className="text-muted-foreground">الاستحقاق</dt><dd className="font-medium">{original.data.dueDate ? fmtDate(original.data.dueDate) : "—"}</dd></div>
            <div className="sm:col-span-2"><dt className="text-muted-foreground">الملاحظات</dt><dd className="whitespace-pre-wrap font-medium">{original.data.notes || "—"}</dd></div>
          </dl>
          <div className="space-y-1.5">
            {original.data.items.map((line) => (
              <div key={line.id} className="flex items-start justify-between gap-2 border-b pb-1.5 last:border-0">
                <div>
                  <div className="font-medium">{line.productName}{line.variantName ? ` — ${line.variantName}` : ""}</div>
                  <div className="text-xs text-muted-foreground">{formatQuantity(line.quantity)} {line.unitName ?? "وحدة"} × {fmt(line.unitPrice)}</div>
                </div>
                <div dir="ltr" className="shrink-0 font-bold tabular-nums">{fmt(line.total)}</div>
              </div>
            ))}
          </div>
          <div className="mt-2 border-t pt-2 text-xs">
            <div className="flex justify-between"><span>الإجمالي</span><strong>{fmt(comparison.beforeTotal)} د.ع</strong></div>
            <div className="flex justify-between"><span>خصم الفاتورة</span><strong>{fmt(original.data.discountAmount ?? 0)} د.ع</strong></div>
            <div className="flex justify-between"><span>الضريبة</span><strong>{fmt(original.data.taxAmount ?? 0)} د.ع</strong></div>
            <div className="flex justify-between"><span>التوصيل</span><strong>{original.data.deliveryFree ? `مجاني${D(original.data.deliveryWaivedAmount ?? 0).gt(0) ? ` · متنازل ${fmt(original.data.deliveryWaivedAmount)} د.ع` : ""}` : `${fmt(original.data.deliveryFee ?? 0)} د.ع`}</strong></div>
            <div className="flex justify-between"><span>المدفوع</span><strong>{fmt(comparison.beforePaid)} د.ع</strong></div>
            <div className="flex justify-between"><span>طريقة الدفع</span><strong>{paymentMethodLabel(original.data.paymentMethod)}</strong></div>
          </div>
        </div>

        <div className="hidden items-center md:flex"><ArrowLeft aria-hidden className="size-5 text-primary" /></div>

        <div className="rounded-md border border-primary/30 bg-card p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="font-extrabold text-primary">سيصبح هكذا</span>
            <Badge variant="outline">فاتورة جديدة</Badge>
          </div>
          <div className="mb-2 text-xs text-muted-foreground">رقم وتاريخ جديدان يُنشآن لحظة الاعتماد</div>
          <dl className="mb-3 grid gap-x-3 gap-y-1 rounded-md bg-primary/5 p-2 text-xs sm:grid-cols-2">
            <div><dt className="text-muted-foreground">العميل</dt><dd className="font-medium">{afterCustomer}</dd></div>
            <div><dt className="text-muted-foreground">جهة الاتصال</dt><dd className="font-medium">{payload.contactName || "—"} · {payload.contactPhone || "—"}</dd></div>
            <div><dt className="text-muted-foreground">فئة السعر</dt><dd className="font-medium">{tierLabel(payload.priceTier)}</dd></div>
            <div><dt className="text-muted-foreground">الاستحقاق</dt><dd className="font-medium">{payload.dueDate || "—"}</dd></div>
            <div className="sm:col-span-2"><dt className="text-muted-foreground">الملاحظات</dt><dd className="whitespace-pre-wrap font-medium">{payload.notes || "—"}</dd></div>
          </dl>
          <div className="space-y-1.5">
            {comparison.afterLines.map((line) => (
              <div key={line.productUnitId} className="flex items-start justify-between gap-2 border-b pb-1.5 last:border-0">
                <div>
                  <div className="flex flex-wrap items-center gap-1.5 font-medium">
                    <span>{line.name}</span>
                    {line.change === "added" && <Badge variant="success">مضاف</Badge>}
                    {line.change === "changed" && <Badge variant="warning">معدّل</Badge>}
                    {line.isGift && <Badge variant="neutral">هدية</Badge>}
                  </div>
                  <div className="text-xs text-muted-foreground">{formatQuantity(line.quantity)} {line.unitName} × {fmt(line.unitPrice)}</div>
                </div>
                <div dir="ltr" className="shrink-0 font-bold tabular-nums">{fmt(line.total)}</div>
              </div>
            ))}
            {comparison.removedLines.map((line) => (
              <div key={`removed-${line.productUnitId}`} className="flex items-center justify-between gap-2 text-muted-foreground line-through">
                <span>{line.name}</span>
                <Badge variant="danger">محذوف</Badge>
              </div>
            ))}
          </div>
          <div className="mt-2 space-y-0.5 border-t pt-2 text-xs">
            <div className="flex justify-between"><span>الإجمالي الجديد</span><strong>{fmt(comparison.afterTotal)} د.ع</strong></div>
            <div className="flex justify-between"><span>خصم الفاتورة</span><strong>{fmt(comparison.afterDiscount)} د.ع</strong></div>
            <div className="flex justify-between"><span>الضريبة</span><strong>{fmt(comparison.afterTax)} د.ع</strong></div>
            <div className="flex justify-between"><span>التوصيل</span><strong>{comparison.afterDeliveryFree ? `مجاني${D(comparison.afterDeliveryWaived).gt(0) ? ` · متنازل ${fmt(comparison.afterDeliveryWaived)} د.ع` : ""}` : `${fmt(comparison.afterDelivery)} د.ع`}</strong></div>
            <div className="flex justify-between"><span>المدفوع بعد النقل/التحصيل</span><strong>{fmt(comparison.afterPaid)} د.ع</strong></div>
            <div className="flex justify-between"><span>المتبقي</span><strong>{fmt(comparison.afterDue)} د.ع</strong></div>
            <div className="flex justify-between"><span>طريقة الدفع</span><strong>{paymentMethodLabel(comparison.paymentMethod)}</strong></div>
            {D(comparison.overpay).gt(0) && (
              <div className="flex justify-between text-[var(--sem-warn)]">
                <span>فرق زائد</span>
                <strong>{fmt(comparison.overpay)} د.ع · {comparison.overpayHandling === "CREDIT" ? "رصيد للعميل" : "رد نقدي"}</strong>
              </div>
            )}
          </div>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">عند الاعتماد فقط: يُعكس الأصل، يعود مخزونه، تُنقل إيصالاته كما هي، ثم تُرحّل الفاتورة الجديدة والفرق في معاملة واحدة.</p>
      {approvalAction ? <div className="flex flex-wrap gap-2 border-t pt-3">{approvalAction}</div> : null}
    </div>
  );
}

export default function SalesControlApprovals() {
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const canReview = !!me.data?.role && moduleAccessAllowed(
    me.data.role as RoleKey,
    (me.data.permissionsOverride ?? null) as PermissionMap | null,
    "sales",
    "FULL",
    ["manager"],
  );
  const pending = trpc.salesControl.list.useQuery(
    canReview ? { status: "PENDING" } : { mine: true },
  );
  const [comparisonFor, setComparisonFor] = useState<number | null>(null);
  useEffect(() => {
    if (comparisonFor != null || !pending.data) return;
    const first = pending.data.find((request) => request.status === "PENDING"
      && (request.requestType === "SALES_REISSUE" || request.requestType === "SALES_EXCHANGE"));
    if (first) setComparisonFor(Number(first.id));
  }, [comparisonFor, pending.data]);
  /**
   * ⭐ درجُ الاسترداد لحظة الاعتماد (تدقيق ١/٩/٢٦ — «حارسٌ بلا حقلٍ في الواجهة = ميزةٌ مقفلة»).
   *
   * الدرج المختار وقت **الطلب** يُجمَّد في الحمولة المُبصَمة؛ فإن أُقفلت الوردية قبل الاعتماد
   * سقط التنفيذ حتماً بـ«الوردية المحدَّدة غير مفتوحة» ولا حقلَ هنا لتبديلها — فكلّ مرتجعٍ
   * نقديّ يُطلَب آخر الدوام كان يولد ميتاً. الخادم يقبل `cashRouting` الآن؛ هذا هو الحقل.
   */
  const [routingFor, setRoutingFor] = useState<number | null>(null);
  const [routingShiftId, setRoutingShiftId] = useState<string>("");
  /**
   * ⭐ مرجع استرداد البطاقة لحظة الاعتماد لا لحظة الطلب (مراجعة Codex على PR #988) — نظير
   * `routingShiftId` تماماً. الطالب قد يترك المرجع فارغاً (لم ينفّذ الاسترداد بعد)؛ المُعتمِد
   * يدخله هنا بعد تنفيذه الفعليّ على الجهاز، أو يعتمد ما أدخله الطالب إن كان قد نفّذه هو.
   */
  const [routingReference, setRoutingReference] = useState<string>("");
  const [paymentClaimFor, setPaymentClaimFor] = useState<number | null>(null);
  const [recoveredClaimFor, setRecoveredClaimFor] = useState<number | null>(null);
  const [routingDeviceId, setRoutingDeviceId] = useState<string>("");
  const [rejecting, setRejecting] = useState<number | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [printingInvoiceId, setPrintingInvoiceId] = useState<number | null>(null);
  const [printingLabelInvoiceId, setPrintingLabelInvoiceId] = useState<number | null>(null);
  const [lastApprovedInvoice, setLastApprovedInvoice] = useState<NonNullable<RouterOutputs["sales"]["get"]> | null>(null);
  const [lastApprovedPrintStatus, setLastApprovedPrintStatus] = useState<"printing" | "printed" | "browser" | "failed">("printing");
  const approvalPrintReservation = useRef<number | null>(null);
  const claimCorrectionPayment = trpc.salesControl.claimCorrectionPayment.useMutation();
  const releaseCorrectionPaymentClaim = trpc.salesControl.releaseCorrectionPaymentClaim.useMutation();

  async function refresh() {
    await pending.refetch();
  }

  async function printCorrectedInvoice(
    invoiceId: number,
    windowReserved = false,
    knownInvoice?: NonNullable<RouterOutputs["sales"]["get"]>,
  ): Promise<"printed" | "browser" | "failed"> {
    if (printingInvoiceId != null) return "failed";
    setPrintingInvoiceId(invoiceId);
    try {
      const invoice = knownInvoice ?? await utils.sales.get.fetch({ invoiceId });
      if (!invoice) {
        if (windowReserved) releaseReservedPrintWindow();
        notify.warn("تم التصحيح لكن تعذّر جلب الفاتورة البديلة للطباعة");
        return "failed";
      }
      // اعتماد التصحيح ليس بيعاً نقدياً جديداً على محطة المدير؛ لا تفتح درجاً لمجرد طباعة البديلة.
      const printed = await printReceipt(invoiceToReceipt(invoice), { openDrawer: false });
      if (!printed.ok) {
        notify.warn(
          "تم التصحيح وحُفظت الفاتورة البديلة",
          "حجب المتصفح نافذة الطباعة؛ اسمح بالنوافذ المنبثقة ثم اضغط «طباعة البديلة».",
        );
        return "failed";
      } else if (printed.via === "browser") {
        notify.warn("تم التصحيح", `فُتحت نافذة طباعة الفاتورة البديلة ${invoice.invoiceNumber}.`);
        return "browser";
      } else {
        if (windowReserved) releaseReservedPrintWindow();
        notify.ok("تم التصحيح والطباعة", `الفاتورة البديلة ${invoice.invoiceNumber}`);
        return "printed";
      }
    } catch (cause) {
      if (windowReserved) releaseReservedPrintWindow();
      notify.err(cause instanceof Error ? cause.message : "حُفظ التصحيح وتعذّرت الطباعة");
      return "failed";
    } finally {
      setPrintingInvoiceId(null);
    }
  }

  function requestCorrectedInvoicePrint(invoiceId: number) {
    if (!reservePrintWindow()) {
      notify.warn("تعذّر فتح نافذة الطباعة", "تحقّق من مانع النوافذ المنبثقة ثم أعد المحاولة.");
      return;
    }
    void printCorrectedInvoice(invoiceId, true);
  }

  function requestShippingLabelPrint(invoiceId: number) {
    if (printingLabelInvoiceId != null) return;
    const labelWindow = preopenShippingLabelWindow();
    if (!labelWindow) {
      notify.warn("تعذّر فتح ليبل الشحن", "اسمح بالنوافذ المنبثقة ثم أعد المحاولة.");
      return;
    }
    setPrintingLabelInvoiceId(invoiceId);
    void (async () => {
      try {
        const invoice = await utils.sales.get.fetch({ invoiceId });
        if (!invoice) throw new Error("تعذّر جلب الفاتورة البديلة");
        const printed = await printShippingLabel(invoiceToShippingLabel(invoice), { into: labelWindow });
        if (!printed.ok) notify.warn("تعذّرت طباعة ليبل الشحن", "أعد المحاولة بعد السماح بالنوافذ المنبثقة.");
      } catch (cause) {
        try { labelWindow.close(); } catch { /* النافذة مغلقة سلفاً */ }
        notify.err(cause);
      } finally {
        setPrintingLabelInvoiceId(null);
      }
    })();
  }

  const approve = trpc.salesControl.approve.useMutation({
    onSuccess: async (result) => {
      setMessage(result.replayed ? "الطلب منفّذ سلفاً؛ استُعيدت الفاتورة البديلة." : "اعتمد الطلب ونُفِّذ أثره ذرّياً.");
      setError("");
      setPaymentClaimFor(null);
      setRecoveredClaimFor(null);
      setRoutingDeviceId("");
      const invalidation = Promise.all([
        utils.salesControl.list.invalidate(),
        utils.sales.list.invalidate(),
        utils.returns.list.invalidate(),
        utils.reception.invoiceQueue.invalidate(),
      ]);
      const correctedInvoiceId = result.request.resultInvoiceId == null
        ? null
        : Number(result.request.resultInvoiceId);
      if (
        correctedInvoiceId != null
        && (result.request.requestType === "SALES_REISSUE" || result.request.requestType === "SALES_EXCHANGE")
      ) {
        const windowReserved = approvalPrintReservation.current === Number(result.request.id);
        approvalPrintReservation.current = null;
        let replacement: NonNullable<RouterOutputs["sales"]["get"]> | null = null;
        try {
          replacement = await utils.sales.get.fetch({ invoiceId: correctedInvoiceId });
          if (replacement) {
            setLastApprovedInvoice(replacement);
            setLastApprovedPrintStatus("printing");
          }
        } catch {
          // الاعتماد التزم فعلاً؛ فشل قراءة ما بعد الالتزام لا يُحوّل النجاح إلى خطأ mutation.
          notify.warn(
            "اعتمد التعديل وحُفظت الفاتورة البديلة",
            "تعذّر تحميل بيانات الطباعة الآن؛ استخدم إعادة الطباعة بعد تحديث الشاشة.",
          );
        }
        const printStatus = await printCorrectedInvoice(
          correctedInvoiceId,
          windowReserved,
          replacement ?? undefined,
        );
        if (replacement) setLastApprovedPrintStatus(printStatus);
      } else if (approvalPrintReservation.current != null) {
        approvalPrintReservation.current = null;
        releaseReservedPrintWindow();
      }
      try {
        await invalidation;
      } catch {
        notify.warn("تم الاعتماد", "تعذّر تحديث القوائم تلقائياً؛ حدّث الشاشة لرؤية الحالة الجديدة.");
      }
    },
    onError: async (cause, variables) => {
      if (approvalPrintReservation.current != null) {
        approvalPrintReservation.current = null;
        releaseReservedPrintWindow();
      }
      setError(cause.message);
      setMessage("");
      try {
        const refreshed = await pending.refetch();
        const remainsPending = refreshed.data?.some((row) => Number(row.id) === Number(variables.requestId));
        if (!remainsPending) {
          setPaymentClaimFor(null);
          setRecoveredClaimFor(null);
          setRoutingDeviceId("");
        }
      } catch { /* رسالة الخادم الأصلية تكفي، والحجز يبقى آمناً لإعادة المحاولة. */ }
    },
  });
  const reject = trpc.salesControl.reject.useMutation({
    onSuccess: async () => {
      setRejecting(null);
      setRejectReason("");
      setMessage("رُفض الطلب وحُفظ السبب بلا أي أثر مالي أو مخزني.");
      setError("");
      await utils.salesControl.list.invalidate();
    },
    onError: (cause) => { setError(cause.message); setMessage(""); },
  });

  /**
   * سحبُ الطالب لطلبه — المخرج الوحيد حين لا يوجد مراجعٌ مستقلّ في الفرع (هجرة 0326).
   * صفريُّ الأثر: يُحرّر `activeInvoiceId` فتعود الفاتورة قابلةً لطلبٍ جديد.
   */
  const withdraw = trpc.salesControl.withdraw.useMutation({
    onSuccess: async () => {
      setMessage("سُحب الطلب — تحرّرت الفاتورة ويمكن إرسال طلبٍ جديد. لم يتغيّر المال ولا المخزون.");
      setError("");
      await utils.salesControl.list.invalidate();
    },
    onError: (cause) => { setError(cause.message); setMessage(""); },
  });

  async function withdrawOne(requestId: number, invoiceNumber: string) {
    if (!(await confirm({
      variant: "warning",
      title: `سحب الطلب #${requestId}`,
      description: `تسحب طلبك على الفاتورة ${invoiceNumber}. لا يتغيّر المال ولا المخزون — يُغلَق الطلب فقط وتعود الفاتورة قابلةً لطلبٍ جديد.`,
      confirmText: "سحب الطلب",
    }))) return;
    withdraw.mutate({ requestId, reason: "سحبه الطالب" });
  }

  async function approveOne(requestId: number, invoiceNumber: string, type: SalesControlType) {
    const editingThis = routingFor === requestId;
    const shiftId = editingThis && routingShiftId ? Number(routingShiftId) : null;
    const request = pending.data?.find((row) => Number(row.id) === requestId);
    const correctionPayment = type === "SALES_REISSUE" || type === "SALES_EXCHANGE"
      ? (request?.payload as CorrectionComparisonPayload | undefined)?.additionalPayment
      : null;
    const needsExternalCorrectionPayment = correctionPayment != null
      && correctionPayment.method !== "CASH";
    /**
     * ⭐ ثلاثُ حالاتٍ للمرجع لا حالتان (مراجعة Codex P1 على PR #997): `undefined` (لم يلمسه
     * المُعتمِد لهذا الطلب بعينه) ⇒ لا override، يبقى مرجع الطلب كما أُرسل. `null` (لمسه ثمّ
     * مسحه عمداً — لا يطابق قسيمة الجهاز) ⇒ override إلى null فيُرفض الاعتماد حتماً لـCARD،
     * لا رجوعٌ صامتٌ لمرجع الطالب. نصٌّ ⇒ override إلى القيمة الجديدة. الخلطُ بين «لم يُلمَس»
     * و«مُسِح» كان يُسقِط المسح العمديّ فيُنفَّذ الاعتماد بمرجعٍ رفضه المُعتمِد بنفسه.
     */
    const referenceOverride: string | null | undefined = editingThis
      ? (routingReference.trim() ? routingReference.trim() : null)
      : undefined;
    if (needsExternalCorrectionPayment && !referenceOverride) {
      notify.warn(
        "مرجع جهاز الدفع مطلوب",
        `نفّذ ${fmt(correctionPayment.amount)} د.ع بطريقة ${paymentMethodLabel(correctionPayment.method)}، ثم أدخل مرجع القسيمة واعتمد.`,
      );
      return;
    }
    if (needsExternalCorrectionPayment && paymentClaimFor !== requestId) {
      notify.warn("احجز عملية الدفع أولاً", "اضغط حقل المرجع وانتظر ظهور أن الطلب محجوز لك قبل تنفيذ العملية على الجهاز.");
      return;
    }
    const deviceId = needsExternalCorrectionPayment ? routingDeviceId : undefined;
    const cashRouting = shiftId != null || referenceOverride !== undefined || deviceId != null
      ? {
          ...(shiftId != null ? { shiftId } : {}),
          ...(referenceOverride !== undefined ? { reference: referenceOverride } : {}),
          ...(deviceId != null ? { deviceId } : {}),
        }
      : null;
    if (!(await confirm({
      variant: "danger",
      title: `اعتماد ${SALES_CONTROL_TYPE_LABELS[type]}`,
      description: `سيُنفَّذ الأثر الآن على الفاتورة ${invoiceNumber} داخل معاملة واحدة.${
        shiftId ? ` النقد يخرج من الدرج #${shiftId}.` : ""
      }${referenceOverride ? ` مرجع جهاز الدفع: ${referenceOverride}.` : ""}${
        referenceOverride === null ? " مسحتَ المرجع المعروض — سيُرفض الاعتماد إن كانت الطريقة بطاقة." : ""
      } لا يمكن للطالب أو منشئ الفاتورة اعتمادها.`,
      confirmText: "اعتماد وتنفيذ",
      ...(type === "SALES_REISSUE" || type === "SALES_EXCHANGE" ? {} : { requireText: invoiceNumber }),
    }))) return;
    if (type === "SALES_REISSUE" || type === "SALES_EXCHANGE") {
      if (reservePrintWindow()) {
        approvalPrintReservation.current = requestId;
      } else {
        approvalPrintReservation.current = null;
        notify.warn(
          "سيُنفَّذ الاعتماد دون طباعة تلقائية",
          "حجب المتصفح نافذة الطباعة؛ ستتمكن من إعادة طباعتها من بطاقة النجاح.",
        );
      }
    }
    approve.mutate(cashRouting ? { requestId, cashRouting } : { requestId });
  }

  /** يبدأ تحرير توجيه طلبٍ بعينه — يمسح توجيه أيّ طلبٍ آخر كان قيد التحرير (درجاً أو مرجعاً)
   *  كي لا يُرسَل مرجع/درج طلبٍ سابقٍ خطأً مع اعتماد طلبٍ مختلف (مراجعة Codex P2 على PR #997). */
  function beginRouting(requestId: number) {
    if (routingFor === requestId) return;
    setRoutingFor(requestId);
    setRoutingShiftId("");
    setRoutingReference("");
  }

  async function beginCorrectionPaymentClaim(requestId: number) {
    if (paymentClaimFor === requestId || claimCorrectionPayment.isPending) return;
    if (paymentClaimFor != null && paymentClaimFor !== requestId) {
      setComparisonFor(paymentClaimFor);
      notify.warn(
        "أكمل العملية المحجوزة أولاً",
        `عدتُ إلى الطلب #${paymentClaimFor}. حرّر حجزه قبل الدفع، أو أكمله بالمرجع نفسه إن نُفذت العملية على الجهاز.`,
      );
      return;
    }
    beginRouting(requestId);
    let deviceId: string;
    try {
      deviceId = await getDeviceCode();
    } catch {
      notify.warn("تعذّر تثبيت هوية الجهاز", "لم تُنفّذ أي عملية؛ حدّث شاشة الاعتماد ثم أعد المحاولة.");
      return;
    }
    try {
      const result = await claimCorrectionPayment.mutateAsync({ requestId });
      if (result.stale) {
        setError("تغيّرت الفاتورة قبل بدء الدفع؛ أُغلق الطلب بلا قبض. أنشئ طلب تعديل جديداً.");
        await utils.salesControl.list.invalidate();
        return;
      }
      if (result.blockedByRequestId) {
        const blockedId = Number(result.blockedByRequestId);
        setPaymentClaimFor(blockedId);
        setRecoveredClaimFor(blockedId);
        setComparisonFor(blockedId);
        beginRouting(blockedId);
        setRoutingDeviceId(deviceId);
        notify.warn(
          "لديك عملية دفع محجوزة",
          `عدتُ إلى الطلب #${blockedId}. حرّر الحجز قبل الدفع، أو أكمله بمرجع القسيمة نفسها.`,
        );
        return;
      }
      setPaymentClaimFor(requestId);
      setRoutingDeviceId(deviceId);
      setError("");
      if (result.replayed) {
        setRecoveredClaimFor(requestId);
        notify.warn(
          "استُعيد حجز دفع سابق",
          "لا تمرّر المبلغ مرة ثانية. تحقّق من سجل جهاز الدفع: إن نُفّذت العملية فأدخل مرجع القسيمة القائمة واعتمد؛ وإن لم تُنفّذ فحرّر الحجز ثم احجز من جديد.",
        );
      } else {
        setRecoveredClaimFor(null);
        notify.ok("حُجز الطلب لك", "يمكن الآن تنفيذ المبلغ على جهاز الدفع ثم إدخال مرجع القسيمة.");
      }
    } catch (cause) {
      setPaymentClaimFor(null);
      setRecoveredClaimFor(null);
      setRoutingDeviceId("");
      setError(cause instanceof Error ? cause.message : "تعذّر حجز عملية دفع فرق التعديل");
    }
  }

  async function releaseCorrectionClaim(requestId: number) {
    if (!(await confirm({
      variant: "danger",
      title: `تحرير حجز الدفع للطلب #${requestId}`,
      description: "حرّر الحجز فقط بعد التحقق من جهاز الدفع أن العملية لم تُنفّذ. إن نُفّذ الدفع فلا تحرّر الحجز؛ أدخل مرجع القسيمة واعتمد الطلب.",
      confirmText: "تأكيد عدم الدفع وتحرير الحجز",
      requireText: "لم يتم الدفع",
      requireTextLabel: "اكتب «لم يتم الدفع» بعد التحقق من الجهاز",
    }))) return;
    releaseCorrectionPaymentClaim.mutate({ requestId, confirmation: "NO_EXTERNAL_PAYMENT_EXECUTED" }, {
      onSuccess: () => {
        setPaymentClaimFor(null);
        setRecoveredClaimFor(null);
        setRoutingDeviceId("");
        setRoutingReference("");
        notify.ok("حُرّر حجز الدفع", "لم يُسجّل قبض ويمكن لمراجع آخر متابعة الطلب.");
      },
      onError: (cause) => setError(cause.message),
    });
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title={canReview ? "اعتمادات عمليات البيع" : "طلباتي على فواتير البيع"}
        description={canReview
          ? "طلبات الإرجاع والإلغاء وإعادة الإصدار والاستبدال — الطلب صفري الأثر حتى اعتماد مراجع مستقل."
          : "تابع حالة طلباتك؛ لا يتغير المال أو المخزون قبل اعتماد مدير مستقل."}
        icon={<FileWarning className="size-5" />}
        backHref="/invoices?tab=controls"
        backLabel="المبيعات"
        actions={(
          <Button variant="outline" onClick={refresh} disabled={pending.isFetching}>
            <RefreshCcw aria-hidden className="me-1 size-4" />
            {pending.isFetching ? ACTION_LABELS.refreshing : ACTION_LABELS.refresh}
          </Button>
        )}
      />

      {error && <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">{error}</div>}
      {message && <div className="rounded-md border border-[var(--sem-pos)]/40 bg-[var(--sem-pos-bg)] p-3 text-sm text-[var(--sem-pos)]">{message}</div>}
      {lastApprovedInvoice && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-[var(--sem-pos)]/40 bg-[var(--sem-pos-bg)] p-3 text-sm">
          <div>
            <div className="font-extrabold text-[var(--sem-pos)]">تم إنشاء الفاتورة المعدلة #{lastApprovedInvoice.invoiceNumber}</div>
            <div className="text-xs text-muted-foreground">
              {fmtDateTime(lastApprovedInvoice.invoiceDate)} · {
                lastApprovedPrintStatus === "printing"
                  ? "جاري تجهيز الطباعة الحرارية…"
                  : lastApprovedPrintStatus === "printed"
                    ? "طُبعت حرارياً تلقائياً."
                    : lastApprovedPrintStatus === "browser"
                      ? "فُتحت نافذة الطباعة الحرارية."
                      : "تعذّرت الطباعة التلقائية؛ الفاتورة محفوظة ويمكن إعادة طباعتها."
              } ويمكن إخراج ليبل الشحن من هنا.
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link href={`/invoices/${lastApprovedInvoice.id}`} className="inline-flex h-9 items-center rounded-md border bg-background px-3 text-xs font-bold text-primary hover:bg-muted">فتح الفاتورة</Link>
            <Button size="sm" variant="outline" onClick={() => requestCorrectedInvoicePrint(Number(lastApprovedInvoice.id))} disabled={printingInvoiceId != null}>
              <Printer aria-hidden className="me-1 size-4" /> إعادة طباعة حرارية
            </Button>
            <Button size="sm" variant="outline" onClick={() => requestShippingLabelPrint(Number(lastApprovedInvoice.id))} disabled={printingLabelInvoiceId != null}>
              <Package aria-hidden className="me-1 size-4" /> ليبل الشحن
            </Button>
          </div>
        </div>
      )}

      {pending.isLoading ? <LoadingState message={ACTION_LABELS.loading} /> : null}
      {pending.isError ? <ErrorState onRetry={() => void pending.refetch()} /> : null}
      {!pending.isLoading && !pending.isError && !(pending.data?.length ?? 0) ? (
        <Card>
          <CardContent className="p-10 text-center text-sm text-muted-foreground">
            {canReview ? "لا توجد طلبات بيع معلّقة." : "لم تُرسل أي طلبات على فواتير البيع بعد."}
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-3 xl:grid-cols-2">
        {pending.data?.map((request) => {
          const isPendingCorrection = request.status === "PENDING"
            && (request.requestType === "SALES_REISSUE" || request.requestType === "SALES_EXCHANGE");
          const reviewerConflict = isReviewerConflict(me.data?.id, request);
          const correctionPayload = request.payload as CorrectionComparisonPayload;
          const correctionNeedsCashRouting = isPendingCorrection && (
            correctionPayload.additionalPayment?.method === "CASH"
            || correctionPayload.overpayHandling === "CASH_REFUND"
          );
          const correctionNeedsExternalRouting = isPendingCorrection
            && correctionPayload.additionalPayment != null
            && correctionPayload.additionalPayment.method !== "CASH";
          return (
          <Card key={request.id} className={isPendingCorrection ? "xl:col-span-2" : undefined}>
            <CardHeader className="pb-2">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <CardTitle className="text-base">
                    {SALES_CONTROL_TYPE_LABELS[request.requestType as SalesControlType]}
                  </CardTitle>
                  <div className="mt-1 text-xs text-muted-foreground">
                    طلب #{request.id} · الطالب {request.requestedByName} · {fmtDateTime(request.createdAt)}
                  </div>
                </div>
                <Badge variant={STATUS_BADGE_VARIANTS[request.status as SalesControlStatus]}>
                  {SALES_CONTROL_STATUS_LABELS[request.status as SalesControlStatus]}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="grid grid-cols-2 gap-2 rounded-md border bg-muted/25 p-3">
                <div><div className="text-xs text-muted-foreground">الفاتورة</div><Link href={`/invoices/${request.invoiceId}`} className="font-mono font-bold text-primary hover:underline">{request.invoiceNumber}</Link></div>
                <div><div className="text-xs text-muted-foreground">الإجمالي</div><div dir="ltr" className="font-bold tabular-nums">{fmt(request.invoiceTotal)}</div></div>
                <div><div className="text-xs text-muted-foreground">منشئ الفاتورة</div><div>{request.invoiceCreatedByName ?? "غير معروف"}</div></div>
                <div><div className="text-xs text-muted-foreground">بصمة الحمولة</div><div dir="ltr" className="font-mono text-xs">{request.payloadHash.slice(0, 12)}</div></div>
              </div>
              <div><div className="text-xs text-muted-foreground">السبب</div><div className="font-medium">{request.reason}</div></div>
              {isPendingCorrection ? (
                comparisonFor === Number(request.id) ? (
                  <CorrectionBeforeAfter
                    request={request}
                    approvalAction={canReview ? (
                      <div className="flex w-full flex-wrap items-end gap-3">
                        {correctionNeedsCashRouting && !reviewerConflict ? (
                          <div className="min-w-56 flex-1 space-y-1">
                            <Label htmlFor={`correction-routing-${request.id}`} className="text-xs">
                              درج تنفيذ فرق التعديل
                            </Label>
                            <Input
                              id={`correction-routing-${request.id}`}
                              dir="ltr"
                              inputMode="numeric"
                              className="h-10 tabular-nums"
                              placeholder="رقم الوردية المفتوحة"
                              value={routingFor === Number(request.id) ? routingShiftId : ""}
                              onChange={(event) => {
                                beginRouting(Number(request.id));
                                setRoutingShiftId(event.target.value.replace(/[^\d]/g, ""));
                              }}
                            />
                            <p className="text-[11px] text-muted-foreground">اتركه فارغاً فقط إذا كان في الفرع درج مفتوح واحد.</p>
                          </div>
                        ) : null}
                        {correctionNeedsExternalRouting && !reviewerConflict ? (
                          <div className="min-w-64 flex-[2] space-y-1">
                            <Label htmlFor={`correction-ref-${request.id}`} className="text-xs">
                              {recoveredClaimFor === Number(request.id)
                                ? "حجز مستعاد: لا تمرّر المبلغ ثانيةً؛ تحقق من الجهاز وأدخل مرجع القسيمة القائمة"
                                : paymentClaimFor === Number(request.id)
                                ? `نفّذ ${fmt(correctionPayload.additionalPayment!.amount)} د.ع على جهاز الدفع ثم أدخل مرجع القسيمة`
                                : "اضغط حقل المرجع أولاً لحجز الطلب قبل تنفيذ أي دفع"}
                            </Label>
                            <Input
                              id={`correction-ref-${request.id}`}
                              dir="ltr"
                              className="h-10"
                              placeholder={recoveredClaimFor === Number(request.id)
                                ? "مرجع القسيمة الموجودة — لا تُعد الدفع"
                                : paymentClaimFor === Number(request.id) ? "رقم العملية / كود الموافقة" : "اضغط هنا لحجز العملية"}
                              readOnly={paymentClaimFor !== Number(request.id)}
                              value={routingFor === Number(request.id) ? routingReference : ""}
                              onFocus={() => void beginCorrectionPaymentClaim(Number(request.id))}
                              onChange={(event) => {
                                beginRouting(Number(request.id));
                                setRoutingReference(event.target.value);
                              }}
                            />
                            <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                              <span>{recoveredClaimFor === Number(request.id)
                                ? "تحقق من سجل الجهاز أولاً: أدخل المرجع القائم، أو حرّر الحجز بإقرار فقط إن لم يحدث قبض."
                                : paymentClaimFor === Number(request.id) ? "محجوز لك؛ الدليل يبقى آمناً لإعادة المحاولة إن تعذر الترحيل." : "لا تمرّر البطاقة قبل نجاح الحجز."}</span>
                              {paymentClaimFor === Number(request.id) && !routingReference.trim() ? (
                                <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-[11px]" onClick={() => releaseCorrectionClaim(Number(request.id))} disabled={releaseCorrectionPaymentClaim.isPending}>تحرير الحجز</Button>
                              ) : null}
                            </div>
                          </div>
                        ) : null}
                        <Button
                          className="h-11 min-w-56 text-base font-extrabold"
                          onClick={() => approveOne(Number(request.id), request.invoiceNumber, request.requestType as SalesControlType)}
                          disabled={approve.isPending || reject.isPending || reviewerConflict
                            || (correctionNeedsExternalRouting
                              && (paymentClaimFor !== Number(request.id) || !routingReference.trim()))}
                        >
                          <Check aria-hidden className="me-1 size-5" />
                          اعتماد وتنفيذ بعد المراجعة
                        </Button>
                      </div>
                    ) : undefined}
                  />
                ) : (
                  <Button
                    variant="outline"
                    className="w-full"
                    onClick={() => setComparisonFor(Number(request.id))}
                  >
                    عرض ومراجعة: كان هكذا / سيصبح هكذا
                  </Button>
                )
              ) : (
                <div className="grid grid-cols-2 gap-2 rounded-md border border-dashed p-3">
                  {payloadFacts(request.requestType as SalesControlType, request.payload).map((fact) => (
                    <div key={fact.label}>
                      <div className="text-xs text-muted-foreground">{fact.label}</div>
                      <div className="font-medium">{fact.value}</div>
                    </div>
                  ))}
                </div>
              )}
              {canReview && reviewerConflict && (
                <div className="rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] p-2 text-xs text-[var(--sem-warn)]">
                  لا يمكنك مراجعة هذا الطلب لأنك الطالب أو منشئ الفاتورة. يجب أن يحسمه مدير مستقل.
                </div>
              )}
              {canReview && request.requestType === "SALES_RETURN" && !reviewerConflict && (
                <div className="space-y-1 rounded-md border border-dashed p-3">
                  <Label htmlFor={`routing-${request.id}`} className="text-xs">
                    درج خروج النقد (اختياريّ — اتركه فارغاً لاستعمال الدرج المسجَّل في الطلب)
                  </Label>
                  <Input
                    id={`routing-${request.id}`}
                    dir="ltr"
                    inputMode="numeric"
                    className="h-8 w-32 tabular-nums"
                    placeholder="رقم الوردية"
                    value={routingFor === Number(request.id) ? routingShiftId : ""}
                    onChange={(event) => {
                      beginRouting(Number(request.id));
                      setRoutingShiftId(event.target.value.replace(/[^\d]/g, ""));
                    }}
                  />
                  <p className="text-[11px] text-muted-foreground">
                    إن أُقفلت وردية الطلب فسيسقط التنفيذ — حدّد هنا وردية مفتوحة الآن. المبلغ والطريقة لا يتغيّران.
                  </p>
                </div>
              )}
              {canReview && request.requestType === "SALES_CANCEL"
                && (request.payload as { refundPaymentMethod?: string } | null)?.refundPaymentMethod === "CARD"
                && !reviewerConflict && (
                <div className="space-y-1 rounded-md border border-dashed p-3">
                  <Label htmlFor={`cancel-ref-${request.id}`} className="text-xs">
                    مرجع استرداد البطاقة — نفّذه على الجهاز ثمّ أدخِله هنا قبل الاعتماد
                  </Label>
                  <Input
                    id={`cancel-ref-${request.id}`}
                    dir="ltr"
                    className="h-8 w-56"
                    placeholder="رقم العملية / كود الموافقة"
                    value={routingFor === Number(request.id)
                      ? routingReference
                      : String((request.payload as { reference?: string } | null)?.reference ?? "")}
                    onChange={(event) => {
                      beginRouting(Number(request.id));
                      setRoutingReference(event.target.value);
                    }}
                  />
                  <p className="text-[11px] text-muted-foreground">
                    المرجع الذي تعتمده هنا هو ما يُنفَّذ فعلياً — قارنه بإيصال الجهاز قبل الاعتماد. تركه فارغاً
                    يرفض الاعتماد فوراً (لا أثر) إن كانت الطريقة بطاقة.
                    {" "}إن ظهر خطأ «تغيّرت الفاتورة» بعد تنفيذك الاسترداد فعلاً على الجهاز، لا تُعِد المحاولة —
                    أبلغ الإدارة فوراً للتسوية اليدوية (المبلغ خرج من حسابنا البنكيّ بلا أثرٍ في النظام).
                  </p>
                </div>
              )}
              {request.status === "PENDING" && me.data?.id != null
                && Number(request.requestedBy) === Number(me.data.id) && (
                <div className="flex flex-wrap items-center gap-2 rounded-md border border-dashed p-2">
                  <span className="text-xs text-muted-foreground">
                    هذا طلبك — لا تراجعه بنفسك. إن تعذّر إيجاد مراجعٍ مستقل، اسحبه لتتحرّر الفاتورة.
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={withdraw.isPending}
                    onClick={() => withdrawOne(Number(request.id), request.invoiceNumber)}
                  >
                    <Undo2 aria-hidden className="me-1 size-4" />
                    سحب الطلب
                  </Button>
                </div>
              )}
              {request.status === "APPROVED"
                && request.resultInvoiceId != null
                && (request.requestType === "SALES_REISSUE" || request.requestType === "SALES_EXCHANGE") && (
                <div className="flex flex-wrap items-center gap-2 rounded-md border border-[var(--sem-pos)]/40 bg-[var(--sem-pos-bg)] p-2">
                  <span className="text-xs text-muted-foreground">
                    أصبحت #{request.resultInvoiceNumber ?? request.resultInvoiceId} · {request.resultInvoiceDate ? fmtDateTime(request.resultInvoiceDate) : ""}
                    {` · عدّلها ${request.requestedByName}`}
                    {request.reviewedByName ? ` · اعتمدها ${request.reviewedByName}` : ""}
                    {request.reviewedAt ? ` · ${fmtDateTime(request.reviewedAt)}` : ""}
                  </span>
                  <Link
                    href={`/invoices/${request.resultInvoiceId}`}
                    className="text-xs font-bold text-[var(--sem-pos)] hover:underline"
                  >
                    فتح الفاتورة البديلة
                  </Link>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={printingInvoiceId != null}
                    onClick={() => requestCorrectedInvoicePrint(Number(request.resultInvoiceId))}
                  >
                    <Printer aria-hidden className="me-1 size-4" />
                    {printingInvoiceId === Number(request.resultInvoiceId) ? "جارٍ الطباعة…" : "طباعة البديلة"}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={printingLabelInvoiceId != null}
                    onClick={() => requestShippingLabelPrint(Number(request.resultInvoiceId))}
                  >
                    <Package aria-hidden className="me-1 size-4" />
                    {printingLabelInvoiceId === Number(request.resultInvoiceId) ? "جارٍ تجهيز الليبل…" : "ليبل الشحن"}
                  </Button>
                </div>
              )}
              {canReview && <div className="flex flex-wrap gap-2">
                {!isPendingCorrection && <Button
                  onClick={() => approveOne(Number(request.id), request.invoiceNumber, request.requestType as SalesControlType)}
                  disabled={approve.isPending || reject.isPending || reviewerConflict}
                >
                  <Check aria-hidden className="me-1 size-4" />
                  اعتماد وتنفيذ
                </Button>}
                <Button
                  variant="destructive"
                  onClick={() => { setRejecting(Number(request.id)); setRejectReason(""); }}
                  disabled={approve.isPending || reject.isPending || reviewerConflict}
                >
                  <X aria-hidden className="me-1 size-4" />
                  رفض
                </Button>
              </div>}
            </CardContent>
          </Card>
          );
        })}
      </div>

      <Dialog open={rejecting != null} onOpenChange={(open) => { if (!open) setRejecting(null); }}>
        <DialogContent dir="rtl">
          <DialogHeader>
            <DialogTitle>رفض طلب البيع</DialogTitle>
            <DialogDescription>يُحفظ السبب للطالب ويُغلق الطلب بلا أثر مالي أو مخزني.</DialogDescription>
          </DialogHeader>
          <div className="space-y-1">
            <Label htmlFor="sales-control-reject-reason">سبب الرفض *</Label>
            <Input
              id="sales-control-reject-reason"
              value={rejectReason}
              onChange={(event) => setRejectReason(event.target.value)}
              maxLength={500}
              placeholder="مثال: الكميات أو مسار الاسترداد غير صحيح"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejecting(null)}>رجوع</Button>
            <Button
              variant="destructive"
              disabled={rejectReason.trim().length < 3 || reject.isPending}
              onClick={() => rejecting != null && reject.mutate({ requestId: rejecting, reason: rejectReason.trim() })}
            >
              {reject.isPending ? ACTION_LABELS.sending : ACTION_LABELS.reject}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
