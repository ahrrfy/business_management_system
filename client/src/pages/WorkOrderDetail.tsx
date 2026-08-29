import DesignApprovalCard from "@/components/workorder/DesignApprovalCard";
import { PageHeader } from "@/components/PageHeader";
import CancelWorkOrderDialog from "@/components/workorder/CancelWorkOrderDialog";
import DesignFileCard from "@/components/workorder/DesignFileCard";
import { workOrderStatusBadgeCls, workOrderStatusLabel } from "@shared/workOrderStatus";
import { ChannelBadge } from "@/components/ChannelBadge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { MoneyInput } from "@/components/form/MoneyInput";
import { Label } from "@/components/ui/label";
import { BarcodeDisplay } from "@/components/BarcodeDisplay";
import { confirm } from "@/lib/confirm";
import { D, fmtAr, positiveDiff } from "@/lib/money";
import { fmtDateTime } from "@/lib/date";
import { cn } from "@/lib/utils";
import { trpc } from "@/lib/trpc";
import { printWorkOrder } from "@/lib/printing/printTemplates";
import { printWorkOrderReceipt } from "@/lib/printing/print";
import { printShippingLabel } from "@/lib/printing/shippingLabel";
import { notify } from "@/lib/notify";
import { openWhatsApp, buildWorkOrderStatusMessage } from "@/lib/whatsapp";
import { Printer, MessageCircle, Truck } from "lucide-react";
import { CopyInline } from "@/components/CopyButton";
import { WorkOrderMaterialsEditor } from "@/components/workOrders/WorkOrderMaterialsEditor";
import { WorkOrderTimelineCard } from "@/components/workorder/WorkOrderTimelineCard";
import { ReclassifyDeliveryDialog } from "@/components/workorder/ReclassifyDeliveryDialog";
import { ManagerApprovalDialog } from "@/components/reception/ManagerApprovalDialog";
import { workOrderStatusHue } from "@shared/workOrderStatus";
import { CopyAsMenu } from "@/lib/copy/CopyAsMenu";
import { formatWorkOrderAsWhatsApp } from "@/lib/copy/formatters";
import { canSeeCost, moduleAccessAllowed, type PermissionMap, type RoleKey } from "@shared/permissions";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { Link, useParams, useSearch } from "wouter";
import { isPosPaymentMethodEnabled, posPaymentRejectionMessage } from "@shared/posPaymentPolicy";
import { isPartialDispatchRejection } from "@shared/partialDispatch";
import { newClientRequestId } from "@/lib/countQueue";
import { canCancelWorkOrder, cancellationRefundNotice, durableRefundStatusNotice } from "@/lib/workOrderRefundPolicy";


/** إثراء سياق بطاقة الأمر (كان فقيراً — قناة/أولوية/منفّذ غائبة رغم توفّرها من الخادم). */
const PRIORITY_LABEL: Record<string, string> = { LOW: "منخفض", NORMAL: "عادي", URGENT: "عاجل" };

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
      <span dir="ltr" className={cn("tabular-nums", strong ? "text-lg font-bold" : "text-sm")}>{fmtAr(value)}</span>
    </div>
  );
}

export default function WorkOrderDetail() {
  const params = useParams();
  const workOrderId = Number(params.id);
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const wo = trpc.workOrders.get.useQuery({ workOrderId }, { enabled: Number.isFinite(workOrderId) });
  const cancellationRefundStatus = trpc.workOrders.cancellationRefundStatus.useQuery(
    { workOrderId },
    { enabled: Number.isFinite(workOrderId) },
  );
  const qs = useSearch();
  // حجب التكلفة بـcanSeeCost (نفس دالة الخادم/الشاشات الأخرى، لا مقارنة دور خام) — الخادم يُخفي
  // materialsCost/laborCost/unitCost بالفعل (null) لغير المخوَّلين، والواجهة تُخفي الصفوف/الأعمدة
  // كاملةً بدل عرضها فارغة («—») بلا داعٍ.
  const showCost = me.data ? canSeeCost(me.data.role) : true;
  const canCancel = canCancelWorkOrder(me.data?.role, me.data?.permissionsOverride ?? null);
  const role = me.data?.role as RoleKey | undefined;
  const permissions = (me.data?.permissionsOverride ?? null) as PermissionMap | null;
  // مرايا بوابات الخادم نفسها: التنفيذ = كاشير/مدير/فني، والمال/التعديل = كاشير/مدير.
  const canExecuteWorkOrder = !!role && moduleAccessAllowed(role, permissions, "workorders", "FULL", ["cashier", "manager", "print_operator"]);
  const canDeliverWorkOrder = !!role && moduleAccessAllowed(role, permissions, "workorders", "FULL", ["cashier", "manager"]);
  const canEditWorkOrder = canDeliverWorkOrder;
  const canRequestDesignApproval = canExecuteWorkOrder;

  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const [awaitingOwnerRefund, setAwaitingOwnerRefund] = useState(false);
  const [cancelOutcomeUncertain, setCancelOutcomeUncertain] = useState(false);
  // تحرير بنود الأمر (١٧/٨/٢٦) — الفجوة التي اشتكاها المالك: لا مسار لإضافة/حذف منتج.
  const [editingMaterials, setEditingMaterials] = useState(false);
  const [payAmount, setPayAmount] = useState("");
  const [payMethod, setPayMethod] = useState<(typeof METHODS)[number]["v"]>("CASH");
  const [payReference, setPayReference] = useState("");
  const [partialDispatchMessage, setPartialDispatchMessage] = useState("");
  const deliverRequestIdRef = useRef<string | null>(null);
  const cancelRequestIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!isPosPaymentMethodEnabled(payMethod)) {
      setPayMethod("CASH");
      setPayReference("");
    }
  }, [payMethod]);

  // ?print=1 من شاشة «حفظ وطباعة»: نطبع التذكرة الحرارية تلقائياً مرة واحدة بعد تحميل البيانات.
  const autoPrintedRef = useRef(false);
  useEffect(() => {
    if (autoPrintedRef.current) return;
    const wantPrint = new URLSearchParams(qs || "").get("print") === "1";
    if (!wantPrint || !wo.data) return;
    autoPrintedRef.current = true;
    void printWorkOrderReceipt({
      orderNumber: wo.data.orderNumber,
      orderDate: wo.data.createdAt ? String(wo.data.createdAt).slice(0, 10) : undefined,
      dueDate: wo.data.dueDate ? String(wo.data.dueDate).slice(0, 10) : undefined,
      status: wo.data.status,
      customerName: wo.data.customerName ?? undefined,
      customerPhone: wo.data.customerPhone ?? undefined,
      jobTitle: wo.data.title,
      quantity: wo.data.quantity ? `${wo.data.quantity} نسخة` : undefined,
      specs: wo.data.customizationText ?? undefined,
      total: wo.data.salePrice,
      // ش٤: التذكرة تُثبت العربون والمتبقّي (كانت تطبع الإجمالي وحده — أكثر ما يُتنازَع عليه).
      paidUpfront: Number(wo.data.deposit ?? 0) > 0 ? wo.data.deposit : null,
      balanceDue: Number(wo.data.deposit ?? 0) > 0
        ? String(Math.max(0, Number(wo.data.salePrice) - Number(wo.data.deposit ?? 0)))
        : null,
    });
  }, [qs, wo.data]);

  // تعبئة المتبقّي تلقائياً عند الجهوزية = سعر البيع − العربون المقبوض (لا طرح يدويّ، decimal.js
  // عبر positiveDiff — لا Number() على المال، §٥).
  useEffect(() => {
    const d = wo.data;
    if (d && d.status === "READY") {
      const due = positiveDiff(d.salePrice, d.deposit ?? 0);
      setPayAmount(due.gt(0) ? due.toFixed(2) : "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wo.data?.status, wo.data?.salePrice, wo.data?.deposit]);

  const refresh = async () => {
    await Promise.all([
      utils.workOrders.get.invalidate({ workOrderId }),
      utils.workOrders.list.invalidate(),
      utils.workOrders.pendingCancellationRefunds.invalidate(),
      utils.workOrders.cancellationRefundStatus.invalidate({ workOrderId }),
      utils.inventory.movements.invalidate(),
      utils.delivery.readyForDispatch.invalidate(),
      // Codex #853 P2: بعد أيّ mutation دورة حياة (start/markReady/deliver/cancel/reverse) نُبطل
      // كاش الخطّ الزمنيّ صراحةً؛ التطبيق يعطّل refetchOnFocus/Reconnect عالميّاً فيبقى العرض
      // على تاريخٍ ما قبل الحدث حتى إعادة تحميل الصفحة يدوياً — والحدث الجديد كُتب فعلاً.
      utils.workOrders.timeline.invalidate({ workOrderId }),
    ]);
  };

  const start = trpc.workOrders.start.useMutation({
    onSuccess: async () => { setDone("بدأ التنفيذ — تم خصم المواد من المخزون."); setAwaitingOwnerRefund(false); setError(""); await refresh(); },
    onError: (e) => setError(e.message),
  });
  const markReady = trpc.workOrders.markReady.useMutation({
    onSuccess: async () => { setDone("الأمر جاهز للتسليم."); setAwaitingOwnerRefund(false); setError(""); await refresh(); },
    onError: (e) => setError(e.message),
  });
  const deliver = trpc.workOrders.deliver.useMutation({
    onSuccess: async (r) => {
      setDone(`تم التسليم. فاتورة ${r.invoiceNumber} (${r.status}).`);
      setPartialDispatchMessage("");
      deliverRequestIdRef.current = null;
      setAwaitingOwnerRefund(false);
      setError("");
      await refresh();
    },
    onError: (e) => {
      // حارس الطلب الجامع: لا يتحول الرفض إلى طريق مسدود؛ الإقرار الجزئي إجراءٌ منفصل وصريح.
      if (isPartialDispatchRejection(e)) {
        setPartialDispatchMessage(e.message);
        setError("");
        return;
      }
      setError(e.message);
    },
  });
  const [cancelOpen, setCancelOpen] = useState(false);
  /**
   * ٢٠/٨ — الاسترجاع بعد التسليم: كان **بلا زرّ ولا مسار** إطلاقاً؛ الأمرُ المُسلَّم يرفضه
   * الإلغاء، وفاتورتُه يرفضها `sales.cancel` و`sales.correct`، والمرتجعُ يشترط بنداً
   * والفاتورةُ الخدميّة بلا بنود. فكان الردّ العمليّ الوحيد «لا شيء يمكن فعله».
   */
  const [reverseOpen, setReverseOpen] = useState(false);
  const [reverseReason, setReverseReason] = useState("");
  const [reverseReopen, setReverseReopen] = useState(false);
  const reverse = trpc.workOrders.reverseDelivery.useMutation({
    onSuccess: async (r) => {
      setDone(
        r.delegatedToReturn
          ? "سُجِّل الاسترجاع كمرتجعٍ كامل للفاتورة."
          : `عُكِس التسليم — أُرجع ${fmtAr(String(r.refundedTotal ?? "0"))} وسقطت الذمّة.`
            + (r.status === "READY" ? " والطلب عاد للطابور جاهزاً لإعادة التسليم." : ""),
      );
      setReverseOpen(false);
      setError("");
      await refresh();
    },
    onError: (e) => setError(e.message),
  });
  // Slice C (٢٩/٨/٢٦) — الإسناد المتأخّر: زرّ «تغيير طريقة التسليم» يظهر قبل التسليم/الإرسال ⇒
  // موظّف الاستقبال يقلب استلاماً⇄توصيلاً من هذه الشاشة نفسها بلا العودة للطابور (بلاغ المالك:
  // «الإسناد يحتوي على مشكلة، يسند الطلب منذ البداية ولا نعلم هل الشركة أم المندوب»). المكوّن
  // نفسه المُستعمَل في ReceptionOrderQueue (حارس أمانة الأجرة موحَّد بين الشاشتَين).
  const [reclassifyOpen, setReclassifyOpen] = useState(false);
  const setDeliveryMethodMut = trpc.workOrders.setDeliveryMethod.useMutation({
    onSuccess: async (r) => {
      notify.ok(
        "حُدِّثت طريقة التسليم",
        Number(r.refundedFee) > 0 ? `رُدّت أمانة الأجرة ${fmtAr(r.refundedFee)} د.ع نقداً للزبون` : undefined,
      );
      setReclassifyOpen(false);
      await refresh();
    },
    onError: (e) => notify.err(e),
  });
  const cancel = trpc.workOrders.cancel.useMutation({
    onSuccess: async (result) => {
      const notice = cancellationRefundNotice(result.pendingRefundReceiptIds, result.replayed);
      setDone(`${notice.title} — ${notice.description}`);
      setAwaitingOwnerRefund(notice.awaitingOwner);
      setCancelOutcomeUncertain(false);
      setError("");
      cancelRequestIdRef.current = null;
      if (typeof window !== "undefined") window.sessionStorage.removeItem(`work-order-cancel-request:${workOrderId}`);
      await refresh();
    },
    onError: async (mutationError) => {
      const [refundCheck, orderCheck] = await Promise.all([
        cancellationRefundStatus.refetch(),
        wo.refetch(),
      ]);
      const durable = refundCheck.data
        ? durableRefundStatusNotice(refundCheck.data.status, fmtAr(refundCheck.data.amount))
        : null;
      if (durable) {
        setDone(`${durable.title} — ${durable.description}`);
        setAwaitingOwnerRefund(durable.awaitingOwner);
        setCancelOutcomeUncertain(false);
        setError("");
        cancelRequestIdRef.current = null;
        if (typeof window !== "undefined") window.sessionStorage.removeItem(`work-order-cancel-request:${workOrderId}`);
        return;
      }
      if (orderCheck.data?.status === "CANCELLED") {
        setDone("تحققنا من الخادم: الأمر ملغى ولا يوجد رد غير نقدي معلّق.");
        setAwaitingOwnerRefund(false);
        setCancelOutcomeUncertain(false);
        setError("");
        cancelRequestIdRef.current = null;
        if (typeof window !== "undefined") window.sessionStorage.removeItem(`work-order-cancel-request:${workOrderId}`);
        return;
      }
      setCancelOutcomeUncertain(true);
      setError(`${mutationError.message} — لم يثبت الخادم تنفيذ الإلغاء. يمكنك إعادة التحقق والمحاولة الآمنة بالمعرّف نفسه.`);
    },
  });

  if (wo.isLoading) return <div className="p-10 text-center text-muted-foreground">جارٍ التحميل…</div>;
  if (!wo.data) return <div className="p-10 text-center text-muted-foreground">طلب الخدمة غير موجود.</div>;
  const data = wo.data;
  const blockedByDesign = !!data.blockingTask;
  const displayStatus = data.status === "DELIVERED" && data.consignmentId
    ? (data.courierDeliveredAt ? "وصل للعميل" : "مُرسل للتوصيل")
    : workOrderStatusLabel(data.status);

  const fmt = fmtAr;
  // الرصيد المستحق = سعر البيع − العربون المقبوض، عبر decimal.js (لا Number() على المال، §٥) —
  // يُستعمَل في رسالة واتساب/ملصق الشحن/بطاقة الدفعة عند التسليم بدل تكرار Math.max(0, Number(a)-Number(b)).
  const remainingDue = positiveDiff(data.salePrice, data.deposit ?? 0);
  const durableRefundNotice = cancellationRefundStatus.data
    ? durableRefundStatusNotice(cancellationRefundStatus.data.status, fmt(cancellationRefundStatus.data.amount))
    : null;

  return (
    <div className="space-y-4 max-w-4xl">
      <PageHeader
        title="طلب خدمة"
        backHref="/work-orders"
        backLabel="رجوع للقائمة"
        actions={<>
          <CopyAsMenu
            label="نَسخ التَفاصيل"
            plain={formatWorkOrderAsWhatsApp({
              number: data.orderNumber,
              date: data.createdAt,
              customer: data.customerName,
              description: data.customizationText,
              status: workOrderStatusLabel(data.status),
              items: [{ name: data.title, qty: data.quantity, unit: "نُسخة" }],
              total: data.salePrice,
              deliveryDate: data.dueDate,
            })}
            whatsapp={formatWorkOrderAsWhatsApp({
              number: data.orderNumber,
              date: data.createdAt,
              customer: data.customerName,
              description: data.customizationText,
              status: workOrderStatusLabel(data.status),
              items: [{ name: data.title, qty: data.quantity, unit: "نُسخة" }],
              total: data.salePrice,
              deliveryDate: data.dueDate,
            })}
          />
          <Button
            variant="outline"
            size="sm"
            className="gap-1"
            disabled={!data.customerPhone}
            title={data.customerPhone ? "فتح واتساب برسالة تحديث حالة جاهزة للعميل" : "لا رقم هاتف مسجَّل للعميل"}
            onClick={() => openWhatsApp(data.customerPhone, buildWorkOrderStatusMessage({
              orderNumber: data.orderNumber,
              title: data.title,
              status: data.status,
              customerName: data.customerName,
              quantity: data.quantity,
              dueDate: data.dueDate ? String(data.dueDate) : null,
              amountDue: remainingDue.toFixed(2),
            }))}
          >
            <MessageCircle className="h-3.5 w-3.5" />
            تحديث للعميل
          </Button>
          <Button variant="outline" size="sm" onClick={() => printWorkOrder({
            woNumber: data.orderNumber,
            woDate: data.createdAt ? String(data.createdAt).slice(0, 10) : undefined,
            dueDate: data.dueDate ? String(data.dueDate).slice(0, 10) : undefined,
            status: data.status,
            customerName: data.customerName,
            jobType: data.title,
            specs: data.customizationText,
            items: [{
              name: `${data.title} (${data.quantity} نسخة)`,
              unit: 'مهمة',
              quantity: 1,
              unitPrice: data.salePrice,
              total: data.salePrice,
            }],
            subtotal: data.salePrice,
            total: data.salePrice,
          })}>طباعة A4</Button>
          <Button
            variant="outline"
            size="sm"
            className="gap-1"
            onClick={() => printWorkOrderReceipt({
              orderNumber: data.orderNumber,
              orderDate: data.createdAt ? String(data.createdAt).slice(0, 10) : undefined,
              dueDate: data.dueDate ? String(data.dueDate).slice(0, 10) : undefined,
              status: data.status,
              customerName: data.customerName ?? undefined,
              customerPhone: data.customerPhone ?? undefined,
              jobTitle: data.title,
              quantity: data.quantity ? `${data.quantity} نسخة` : undefined,
              specs: data.customizationText ?? undefined,
              total: data.salePrice,
              paidUpfront: Number(data.deposit ?? 0) > 0 ? data.deposit : null,
              balanceDue: Number(data.deposit ?? 0) > 0
                ? String(Math.max(0, Number(data.salePrice) - Number(data.deposit ?? 0)))
                : null,
            })}
          >
            <Printer className="h-3.5 w-3.5" />
            طباعة حرارية
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="gap-1"
            title="ملصق شحن يُلصَق على الطرد (بالقياس المحفوظ — الافتراضي ٨٠×١٢٠مم)"
            onClick={async () => {
              const res = await printShippingLabel({
                orderNumber: data.orderNumber,
                customerName: data.customerName,
                customerPhone: data.customerPhone,
                governorate: null,
                addressText: data.deliveryAddress ?? null,
                total: remainingDue.toFixed(2),
                createdAt: data.createdAt,
                items: [{ productName: data.title, unitName: "", quantity: String(data.quantity) }],
              });
              if (!res.ok) notify.err("افسح مانع النوافذ المنبثقة لطباعة ملصق الشحن");
            }}
          >
            <Truck className="h-3.5 w-3.5" />
            ملصق شحن
          </Button>
        </>}
      />

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center justify-between gap-2">
            <span className="truncate">{data.title}</span>
            <span className="flex shrink-0 items-center gap-1.5">
              {/* التمييز البصريّ «مُعدَّل» (طلب المالك ١٧/٨) — من عمودٍ مخصَّص لتحرير البنود،
                  لا من `updatedAt` (ذاك يتحرّك مع كل كتابة فيصير كلُّ أمرٍ «معدَّلاً»). */}
              {Number(data.materialsEditCount ?? 0) > 0 && (
                <span
                  className="rounded-full bg-[var(--sem-warn-bg)] px-2.5 py-0.5 text-xs font-medium text-[var(--sem-warn)]"
                  title={`عُدِّلت بنوده ${data.materialsEditCount} مرّة${data.materialsEditedByName ? ` — آخرها ${data.materialsEditedByName}` : ""}`}
                >
                  مُعدَّل
                  {Number(data.materialsEditCount) > 1 ? ` ×${data.materialsEditCount}` : ""}
                </span>
              )}
              <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${workOrderStatusBadgeCls(data.status)}`}>
                {displayStatus}
              </span>
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-5 md:grid-cols-3">
            {/* سياق الأمر — كان فقيراً (رقم/عميل/كمية/استحقاق فقط) رغم أنّ الخادم يُعيد القناة
             *  والأولوية والمنفّذ وتاريخ الإنشاء والتوصيل بلا استهلاك في الشاشة. */}
            <div className="md:col-span-2 grid grid-cols-2 gap-x-6 gap-y-4 text-sm content-start">
              <Field label="رقم الأمر"><CopyInline value={data.orderNumber} successMessage="تم نَسخ رَقم الأَمر" /></Field>
              <Field label="العميل">{data.customerName ?? "عميل نقدي"}</Field>
              <Field label="الكمية">{data.quantity}</Field>
              <Field label="الاستحقاق">{data.dueDate ? String(data.dueDate).slice(0, 10) : "—"}</Field>
              <Field label="قناة الاستلام"><ChannelBadge channel={data.receptionChannel} handle={data.channelHandle} /></Field>
              {/* ش٥ (0220): الزبون يرى **طلباً واحداً** — والأمرُ كان لا يعرف إخوته، فيُشحَن
                  نصفُ الطلب صامتاً بينما نصفُه الآخر لم يبدأ. */}
              {data.siblings && data.siblings.total > 1 && (
                <Field label="ضمن الطلب">
                  <span className="inline-flex flex-wrap items-center gap-1.5">
                    <span className="font-mono" dir="ltr">{data.siblings.draftNumber ?? `#${data.siblings.draftId}`}</span>
                    <span
                      className={
                        data.siblings.ready === data.siblings.total
                          ? "rounded-full bg-[var(--sem-pos-bg)] px-2 py-0.5 text-2xs font-extrabold text-[var(--sem-pos)]"
                          : "rounded-full bg-[var(--sem-warn-bg)] px-2 py-0.5 text-2xs font-extrabold text-[var(--sem-warn)]"
                      }
                    >
                      {data.siblings.ready}/{data.siblings.total} جاهزة
                    </span>
                  </span>
                  <div className="mt-1 flex flex-col gap-0.5">
                    {data.siblings.items
                      .filter((it) => Number(it.id) !== Number(data.id))
                      .map((it) => (
                        <a
                          key={it.id}
                          href={`/work-orders/${it.id}`}
                          className="text-2xs text-muted-foreground hover:text-foreground hover:underline"
                        >
                          <span className="font-mono" dir="ltr">{it.orderNumber}</span> — {it.title}
                          <span className="ms-1">({workOrderStatusLabel(it.status)})</span>
                        </a>
                      ))}
                  </div>
                </Field>
              )}
              <Field label="الأولوية">{PRIORITY_LABEL[data.priority ?? "NORMAL"] ?? data.priority}</Field>
              <Field label="المنفّذ المسؤول">{data.assigneeName ?? "غير مُسنَد"}</Field>
              <Field label="تاريخ الإنشاء">{fmtDateTime(data.createdAt)}</Field>
              {data.hasDelivery && <Field label="عنوان التوصيل">{data.deliveryAddress ?? "—"}</Field>}
            </div>

            <div className="rounded-lg border bg-muted/30 p-4 space-y-2.5 text-sm self-start">
              <SummaryRow label="سعر البيع" value={data.salePrice} strong />
              {D(data.deposit ?? 0).gt(0) && (
                <SummaryRow label="العربون المقبوض" value={`−${fmt(data.deposit ?? "0")}`} />
              )}
              {/* Slice D (٢٩/٨/٢٦): إظهار «إجمالي ما سيدفعه العميل» شاملاً التوصيل في بطاقة الأمر —
                  بلاغ المالك: «يجب أن يعلم الزبون بالمبلغ الكلي النهائي شاملاً التوصيل». يظهر عند
                  التوصيل بأجرةٍ موجبة، ويُحسَب بحسب `feeCollection`: COURIER يجمع، COUNTER/SHOP لا. */}
              {data.hasDelivery && D(data.deliveryCost ?? 0).gt(0) && (() => {
                const feeCollection = (data.deliveryFeeCollection ?? "COURIER") as "COURIER" | "COUNTER" | "SHOP";
                const feeLabel = feeCollection === "COURIER" ? "أجرة التوصيل (المندوب يقبضها)"
                  : feeCollection === "COUNTER" ? "أجرة التوصيل (قُبضت أمانةً)"
                  : "أجرة التوصيل (تتحمّلها المكتبة)";
                const remaining = Math.max(0, Number(data.salePrice) - Number(data.deposit ?? 0));
                const customerPays = feeCollection === "COURIER" ? remaining + Number(data.deliveryCost ?? 0) : remaining;
                return (
                  <>
                    <SummaryRow label={feeLabel} value={data.deliveryCost ?? "0"} />
                    <div className="flex justify-between border-t border-[var(--sem-info)] pt-2 text-base font-black text-[var(--sem-info)]">
                      <span>يدفعه العميل</span>
                      <span dir="ltr" className="tabular-nums">{fmt(String(customerPays))} د.ع</span>
                    </div>
                  </>
                );
              })()}
              {showCost && <SummaryRow label="كلفة المواد" value={data.materialsCost} />}
              {showCost && <SummaryRow label="كلفة العمالة" value={data.laborCost} />}
            </div>
          </div>

          {data.customizationText && (
            <div className="rounded-md bg-muted/40 p-3 text-sm">
              <div className="text-xs text-muted-foreground mb-1">التخصيص</div>
              <div className="whitespace-pre-wrap">{data.customizationText}</div>
            </div>
          )}

          {/* ش٢ (١٩/٨): بطاقةُ الموافقة — الحالة مشتقّةٌ من مهمّةٍ حاجزة مفتوحة لا من عَلَم. */}
          <DesignApprovalCard
            workOrderId={Number(data.id)}
            status={String(data.status)}
            blockingTask={(data.blockingTask as never) ?? null}
            canManage={canRequestDesignApproval}
          />

          {/* **ملفّ التصميم** — كان الخادم يُرسل `images` والشاشة تُهملها كلّياً (صفر استعمال
              في ٦٨٣ سطراً)، فيقف الفنّيّ أمام أمرٍ لا يرى تصميمه. النسخةُ العليا أوّلاً،
              والسابقةُ تُعرَض مطويّةً — سجلٌّ بلا حذف. */}
          {data.images && data.images.length > 0 && (
            <DesignFileCard images={data.images as never} workOrderId={Number(data.id)} canEdit={canEditWorkOrder && data.status !== "DELIVERED" && data.status !== "CANCELLED"} />
          )}
        </CardContent>
      </Card>

      {editingMaterials ? (
        <WorkOrderMaterialsEditor
          workOrderId={data.id}
          branchId={Number(data.branchId)}
          orderNumber={data.orderNumber}
          status={data.status}
          initial={data.materials.map((m) => ({
            variantId: Number(m.variantId),
            baseQuantity: Number(m.baseQuantity),
            productName: m.productName + (m.variantName ? ` — ${m.variantName}` : ""),
            sku: m.sku ?? "",
          }))}
          onSaved={async () => { setEditingMaterials(false); await refresh(); }}
          onCancel={() => setEditingMaterials(false)}
        />
      ) : (
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
          <CardTitle className="text-base">المواد</CardTitle>
          {/* التعديل متاحٌ ما لم يُسلَّم الأمر أو يُلغَ — نفس ما يفرضه الخادم، فلا زرٌّ يقود لرفض. */}
          {canEditWorkOrder && data.status !== "DELIVERED" && data.status !== "CANCELLED" && (
            <Button size="sm" variant="outline" onClick={() => setEditingMaterials(true)}>
              تعديل البنود
            </Button>
          )}
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium text-start">المادة</th>
                  <th className="px-3 py-2 font-medium text-start">SKU</th>
                  <th className="px-3 py-2 font-medium text-center">كمية (أساس)</th>
                  {showCost && <th className="px-3 py-2 font-medium text-right">كلفة الوحدة</th>}
                  {showCost && <th className="px-3 py-2 font-medium text-right">كلفة السطر</th>}
                </tr>
              </thead>
              <tbody>
                {data.materials.map((m) => (
                  <tr key={m.id} className="border-t hover:bg-muted/30">
                    <td className="px-3 py-2">{m.productName}{m.variantName ? ` — ${m.variantName}` : ""}</td>
                    <td className="px-3 py-2 font-mono text-xs" dir="ltr">{m.sku}</td>
                    <td className="px-3 py-2 text-center tabular-nums" dir="ltr">{m.baseQuantity}</td>
                    {showCost && <td className="px-3 py-2 text-right tabular-nums" dir="ltr">{fmt(m.unitCost)}</td>}
                    {showCost && <td className="px-3 py-2 text-right tabular-nums" dir="ltr">{fmt(D(m.unitCost).times(m.baseQuantity).toFixed(2))}</td>}
                  </tr>
                ))}
                {data.materials.length === 0 && (
                  <tr><td colSpan={showCost ? 5 : 3} className="p-6 text-center text-muted-foreground">لا مواد مرفقة (أمر طباعة/خدمة صرفة).</td></tr>
                )}
              </tbody>
              {data.materials.length > 0 && showCost && (
                <tfoot>
                  <tr className="border-t-2 bg-muted/40 font-semibold">
                    <td className="px-3 py-2" colSpan={4}>إجمالي كلفة المواد</td>
                    <td className="px-3 py-2 text-right tabular-nums" dir="ltr">
                      {fmt(data.materials.reduce((s, m) => s.plus(D(m.unitCost).times(m.baseQuantity)), D(0)).toFixed(2))}
                    </td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </CardContent>
      </Card>
      )}

      {data.status === "READY" && (
        <Card>
          <CardHeader><CardTitle className="text-base">دفعة عند التسليم (اختياري)</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-md border bg-muted/30 p-3 text-sm space-y-1">
              <div className="flex justify-between"><span className="text-muted-foreground">سعر البيع</span><span dir="ltr" className="tabular-nums">{fmt(data.salePrice)} د.ع</span></div>
              {D(data.deposit ?? 0).gt(0) && <div className="flex justify-between"><span className="text-muted-foreground">العربون المقبوض</span><span dir="ltr" className="tabular-nums text-[var(--sem-pos)]">−{fmt(data.deposit)} د.ع</span></div>}
              <div className="flex justify-between border-t pt-1 font-bold"><span>الرصيد المستحق</span><span dir="ltr" className="tabular-nums">{fmt(remainingDue.toFixed(2))} د.ع</span></div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-end">
              <div className="space-y-1">
                <Label>المبلغ المدفوع الآن (الافتراضي = المستحق)</Label>
                <MoneyInput value={payAmount} onChange={setPayAmount} placeholder="الرصيد المستحق" ariaLabel="مبلغ الدفعة" />
              </div>
              <div className="space-y-1">
                <Label>طريقة الدفع</Label>
                <select className={selectCls} value={payMethod} onChange={(e) => setPayMethod(e.target.value as typeof payMethod)}>
                  {METHODS.map((m) => <option key={m.v} value={m.v} disabled={!isPosPaymentMethodEnabled(m.v)}>{m.label}</option>)}
                </select>
              </div>
              {/* مرآة PaymentReferenceField من POS (client/src/components/pos/PaymentReferenceField.tsx) —
               *  ذاك المكوّن مبنيّ بأنماط CSS خام تخصّ ثيم POS (colors prop)؛ هنا حقل مطابق ببنى Tailwind
               *  القائمة في هذه الشاشة. الخادم يرفض دفعاً غير نقديّ بلا مرجع (deliver.ts superRefine)
               *  فكان الحفظ يفشل بخطأ zod عامّ لا يشرح السبب — الحقل يمنعه مبكراً. */}
              {payMethod !== "CASH" && (
                <div className="space-y-1">
                  <Label htmlFor="pay-ref">مرجع العملية {D(payAmount || "0").gt(0) && <span className="text-destructive">*</span>}</Label>
                  <Input
                    id="pay-ref"
                    dir="ltr"
                    value={payReference}
                    onChange={(e) => setPayReference(e.target.value)}
                    placeholder="رقم إشعار الجهاز/التحويل"
                    className={cn(payReference.trim() === "" && D(payAmount || "0").gt(0) && "border-[var(--sem-warn)]")}
                  />
                  {payReference.trim() === "" && D(payAmount || "0").gt(0) && (
                    <p className="text-[11px] text-[var(--sem-warn)]">مطلوب لمطابقة دفعة {METHODS.find((m) => m.v === payMethod)?.label} مع كشف الحساب.</p>
                  )}
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* باركود + QR تذكرة طلب الخدمة */}
      {data.qrPayload && (
        <Card>
          <CardHeader><CardTitle className="text-base">باركود طلب الخدمة</CardTitle></CardHeader>
          <CardContent className="flex justify-center py-4">
            <BarcodeDisplay
              barcodeSet={{
                barcode128: data.orderNumber,
                qrPayload: data.qrPayload,
                displayLabel: `طلب خدمة: ${data.orderNumber}${data.customerName ? `\nالعميل: ${data.customerName}` : ""}`,
              }}
              size="md"
            />
          </CardContent>
        </Card>
      )}

      {/* الخطّ الزمنيّ للأمر (٢٨/٨/٢٦): كان مضمّناً في WorkOrders.tsx وWorkOrderStation فقط —
          شاشة التفاصيل الأساسيّة بلا تاريخٍ للأمر، فالفنّي/الكاشير يفتحان صفحةً لا تُخبرهم متى
          سُحب/بُدئ/جُهِّز/سُلّم. يقرأ من workOrders.timeline بعد أن صار صادقاً كاملاً في PR #851. */}
      <WorkOrderTimelineCard workOrderId={workOrderId} statusHue={workOrderStatusHue(data.status)} />

      {durableRefundNotice && (
        <div
          role="status"
          className={cn(
            "rounded-md border p-3 text-sm",
            durableRefundNotice.awaitingOwner
              ? "border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] text-[var(--sem-warn)]"
              : "border-[var(--sem-pos)]/30 bg-[var(--sem-pos-bg)] text-[var(--sem-pos)]",
          )}
        >
          <div className="font-bold">{durableRefundNotice.title}</div>
          <div>{durableRefundNotice.description}</div>
        </div>
      )}
      {partialDispatchMessage && (
        <div role="alert" className="rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] p-3 text-sm text-[var(--sem-warn)]">
          <p>{partialDispatchMessage}</p>
          <Button
            type="button"
            size="sm"
            className="mt-2"
            disabled={deliver.isPending}
            onClick={() => deliver.mutate({
              workOrderId,
              clientRequestId: deliverRequestIdRef.current ?? (deliverRequestIdRef.current = newClientRequestId()),
              partialDispatchConfirmed: true,
              ...(payAmount && D(payAmount).gt(0)
                ? { payment: { amount: D(payAmount).toFixed(2), method: payMethod, reference: payMethod !== "CASH" ? payReference.trim() : undefined } }
                : {}),
            })}
          >
            {deliver.isPending ? "جارٍ التنفيذ…" : "أقرّ التسليم الجزئي"}
          </Button>
        </div>
      )}
      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          <p>{error}</p>
          {cancelOutcomeUncertain && canCancel && (
            <Button
              type="button"
              variant="outline"
              className="mt-2"
              disabled={cancel.isPending}
              onClick={() => {
                const key = `work-order-cancel-request:${workOrderId}`;
                const clientRequestId = cancelRequestIdRef.current
                  ?? (typeof window !== "undefined" ? window.sessionStorage.getItem(key) : null);
                if (!clientRequestId) {
                  setError("تعذّر العثور على معرّف المحاولة السابقة؛ حدّث الصفحة للتحقق من حالة الأمر قبل أي إجراء.");
                  return;
                }
                cancelRequestIdRef.current = clientRequestId;
                cancel.mutate({ workOrderId, clientRequestId });
              }}
            >
              {cancel.isPending ? "جارٍ التحقق…" : "إعادة التحقق والمحاولة الآمنة"}
            </Button>
          )}
        </div>
      )}
      {done && !durableRefundNotice && (
        <p
          role="status"
          className={cn(
            "rounded-md border p-3 text-sm",
            awaitingOwnerRefund
              ? "border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] text-[var(--sem-warn)]"
              : "border-[var(--sem-pos)]/30 bg-[var(--sem-pos-bg)] text-[var(--sem-pos)]",
          )}
        >
          {done}
        </p>
      )}

      <div className="flex gap-2 flex-wrap">
        {canExecuteWorkOrder && data.status === "RECEIVED" && (
          <Button
            onClick={async () => {
              if (blockedByDesign) return;
              if (!(await confirm({
                variant: "warning",
                title: "بدء تنفيذ طلب الخدمة",
                description: `سيبدأ تنفيذ أمر «${data.title}» (${data.orderNumber}) وتُخصم المواد من المخزون. هل تريد المتابعة؟`,
                confirmText: "بدء التنفيذ",
              }))) return;
              start.mutate({ workOrderId });
            }}
            disabled={start.isPending || blockedByDesign}
          >
            {start.isPending ? "جارٍ…" : blockedByDesign ? "بانتظار موافقة العميل" : "بدء التنفيذ (خصم المواد)"}
          </Button>
        )}
        {canExecuteWorkOrder && data.status === "IN_PROGRESS" && (
          <Button
            onClick={async () => {
              if (!(await confirm({
                variant: "info",
                title: "وضع علامة جاهز للتسليم",
                description: `سيُعلَّم أمر «${data.title}» (${data.orderNumber}) كجاهز للتسليم. هل تريد المتابعة؟`,
                confirmText: "وضع علامة جاهز",
              }))) return;
              markReady.mutate({ workOrderId });
            }}
            disabled={markReady.isPending}
          >
            {markReady.isPending ? "جارٍ…" : "وضع علامة جاهز"}
          </Button>
        )}
        {canDeliverWorkOrder && data.status === "READY" && data.hasDelivery && !data.consignmentId && (
          <Button asChild>
            <Link href="/delivery"><Truck aria-hidden className="me-1 size-4" /> إسناد للتوصيل</Link>
          </Button>
        )}
        {canDeliverWorkOrder && data.status === "READY" && !data.hasDelivery && (
          <Button
            onClick={async () => {
              const payAmountD = D(payAmount || "0");
              const payNow = payAmountD.gt(0);
              if (!isPosPaymentMethodEnabled(payMethod)) {
                setError(posPaymentRejectionMessage(payMethod));
                return;
              }
              // الخادم يرفض دفعاً غير نقديّ بلا مرجع (deliver.ts superRefine) — نتحقّق مبكراً بدل
              // فشل التسليم بخطأ zod عامّ بعد تأكيد المستخدم.
              if (payNow && payMethod !== "CASH" && !payReference.trim()) {
                setError("مرجع العملية مطلوب لدفعة غير نقدية.");
                return;
              }
              if (!(await confirm({
                variant: "danger",
                title: "تسليم طلب الخدمة وإصدار الفاتورة",
                description: `سيُسلَّم أمر «${data.title}» (${data.orderNumber}) وتُصدر فاتورة بقيمة ${fmt(data.salePrice)}${payNow ? ` مع دفعة ${fmt(payAmountD.toFixed(2))}` : " (آجل بالكامل)"}. لا يمكن التراجع. اكتب «تسليم» للتأكيد.`,
                confirmText: "تسليم وإصدار فاتورة",
                requireText: "تسليم",
              }))) return;
              deliver.mutate({
                workOrderId,
                clientRequestId: deliverRequestIdRef.current ?? (deliverRequestIdRef.current = newClientRequestId()),
                payment: payNow ? { amount: payAmountD.toFixed(2), method: payMethod, reference: payMethod !== "CASH" ? payReference.trim() : undefined } : undefined,
                partialDispatchConfirmed: false,
              });
            }}
            disabled={deliver.isPending}
          >
            {deliver.isPending ? "جارٍ…" : "تسليم وإصدار فاتورة"}
          </Button>
        )}
        {/* Slice C: زرّ «تغيير طريقة التسليم» يظهر لكاشير/مدير قبل التسليم/الإرسال (لا إرسالية حيّة).
            إذا كان الطلب مسنَداً لمندوب فعلياً (consignmentId) يُخفى — التحويل يمرّ من إلغاء الإسناد أوّلاً. */}
        {canDeliverWorkOrder && (data.status === "RECEIVED" || data.status === "IN_PROGRESS" || data.status === "READY") && !data.consignmentId && (
          <Button variant="outline" onClick={() => setReclassifyOpen(true)} disabled={setDeliveryMethodMut.isPending}>
            <Truck aria-hidden className="me-1 size-4" />
            {data.hasDelivery ? "تحويل لاستلامٍ مباشر" : "تحويل إلى توصيل"}
          </Button>
        )}
        {canCancel && (data.status === "RECEIVED" || data.status === "IN_PROGRESS" || data.status === "READY") && (
          <Button
            variant="outline"
            onClick={() => setCancelOpen(true)}
            disabled={cancel.isPending}
          >
            {cancel.isPending ? "جارٍ…" : "إلغاء الأمر"}
          </Button>
        )}
        {canCancel && data.status === "DELIVERED" && data.invoiceId && (
          <Button variant="destructive" onClick={() => setReverseOpen(true)} disabled={reverse.isPending}>
            {reverse.isPending ? "جارٍ…" : "استرجاع الطلب المُسلَّم"}
          </Button>
        )}
        {/* رابط الفاتورة كان يوجّه لقائمة الفواتير العامة بدل الفاتورة المحدَّدة. */}
        {data.status === "DELIVERED" && data.invoiceId && (
          <Link href={`/invoices/${data.invoiceId}`}><Button variant="outline">فتح الفاتورة #{data.invoiceId}</Button></Link>
        )}
      </div>

      {reverseOpen && (
        <div role="dialog" aria-label="استرجاع الطلب المُسلَّم"
             className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4"
             onClick={() => !reverse.isPending && setReverseOpen(false)}>
          <div className="w-full max-w-lg rounded-lg border bg-background p-5 shadow-lg"
               onClick={(e) => e.stopPropagation()}>
            <h2 className="mb-1 text-base font-extrabold">استرجاع الطلب المُسلَّم</h2>
            <p className="mb-3 text-2xs text-muted-foreground">
              «{data.title}» — <span dir="ltr" className="font-mono">{data.orderNumber}</span>
            </p>
            {/* الأرقام تُعرَض **قبل** التأكيد: لا امتصاصَ خفيّ ولا مفاجأةَ بعد النقر (§٥).
                تنبيه: المقبوضُ من **الفاتورة** لا من `deposit`: الدفعُ عند التسليم لا يمرّ بالعربون
                إطلاقاً، فكان الحوار يَعِد بردّ صفرٍ بينما يخرج من الدرج كامل المبلغ. */}
            <div className="mb-3 space-y-1 rounded-md border p-3 text-xs">
              <div className="flex justify-between"><span>صافي الفاتورة</span>
                <span dir="ltr" className="tabular-nums font-bold">
                  {fmtAr(String(data.invoiceTotal ?? data.salePrice ?? "0"))}
                </span></div>
              <div className="flex justify-between"><span>المقبوض فعلاً — سيُردّ بطريقة قبضه</span>
                <span dir="ltr" className="tabular-nums font-bold">
                  {fmtAr(String(data.invoicePaidAmount ?? "0"))}
                </span></div>
              <div className="flex justify-between text-muted-foreground"><span>يسقط من ذمّة العميل</span>
                <span dir="ltr" className="tabular-nums">
                  {fmtAr(
                    String(
                      Math.max(
                        0,
                        Number(data.invoiceTotal ?? data.salePrice ?? 0)
                          - Number(data.invoicePaidAmount ?? 0),
                      ),
                    ),
                  )}
                </span></div>
            </div>
            <label className="mb-1 block text-xs font-bold">سبب الاسترجاع</label>
            <Input value={reverseReason} onChange={(e) => setReverseReason(e.target.value)}
                   placeholder="رفض الزبون العمل المُسلَّم / أعاده المندوب…" maxLength={500} />
            <label className="mt-3 flex items-start gap-2 text-2xs text-muted-foreground">
              <input type="checkbox" className="mt-0.5" checked={reverseReopen}
                     onChange={(e) => setReverseReopen(e.target.checked)} />
              <span>
                <b className="text-foreground">أعِده للطابور</b> جاهزاً لإعادة التسليم مصحَّحاً
                (بدل إغلاقه ملغىً). تُفكّ الفاتورة المرتجعة عنه فيمكن تسليمه ثانيةً.
              </span>
            </label>
            <p className="mt-3 rounded-md bg-muted/50 p-2 text-2xs leading-relaxed text-muted-foreground">
              يُعكَس قيد البيع والتكلفة، وتسقط ذمّةُ العميل غير المسدَّدة، ويُردّ المقبوض.
              ولا تعود الخامة للمخزون — استُهلكت فعلاً، واسترجاعُ الخردة تسويةُ مخزونٍ منفصلة.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setReverseOpen(false)} disabled={reverse.isPending}>تراجع</Button>
              <Button variant="destructive" disabled={reverse.isPending || reverseReason.trim().length < 3}
                onClick={() => reverse.mutate({
                  workOrderId,
                  reason: reverseReason.trim(),
                  reopen: reverseReopen,
                  clientRequestId: newClientRequestId(),
                })}>
                {reverse.isPending ? "جارٍ…" : "أكّد الاسترجاع"}
              </Button>
            </div>
          </div>
        </div>
      )}

      <ReclassifyDeliveryDialog
        order={reclassifyOpen ? {
          id: workOrderId,
          orderNumber: data.orderNumber,
          title: data.title,
          hasDelivery: data.hasDelivery,
          deliveryAddress: data.deliveryAddress,
          deliveryPhone: data.deliveryPhone,
          deliveryCost: data.deliveryCost,
          customerPhone: data.customerPhone,
        } : null}
        pending={setDeliveryMethodMut.isPending}
        onClose={() => setReclassifyOpen(false)}
        onConfirm={(payload) => setDeliveryMethodMut.mutate({ workOrderId, ...payload })}
      />

      <CancelWorkOrderDialog
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        orderNumber={data.orderNumber}
        title={data.title}
        // الخامة تُعرَض فقط بعد البدء — قبله لا استهلاك، فجدولُ الهدر يكذب لو ظهر.
        materials={
          data.status === "IN_PROGRESS" || data.status === "READY"
            ? (data.materials ?? []).map((m) => ({
                id: Number(m.id),
                name: [m.productName, m.variantName].filter(Boolean).join(" — ") || m.sku || `#${m.variantId}`,
                baseQuantity: Number(m.baseQuantity),
                unitCost: m.unitCost ?? null,
              }))
            : []
        }
        pending={cancel.isPending}
        onConfirm={(d) => {
          const key = `work-order-cancel-request:${workOrderId}`;
          cancelRequestIdRef.current ??=
            (typeof window !== "undefined" ? window.sessionStorage.getItem(key) : null)
            ?? newClientRequestId();
          if (typeof window !== "undefined") window.sessionStorage.setItem(key, cancelRequestIdRef.current);
          setCancelOpen(false);
          cancel.mutate({
            workOrderId,
            clientRequestId: cancelRequestIdRef.current,
            reason: d.reason,
            materials: d.materials,
          });
        }}
      />
    </div>
  );
}
