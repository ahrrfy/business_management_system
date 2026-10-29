import { type WorkOrderStatus, WO_NEXT_STATUS } from "@shared/workOrderStatus";
import { nextKanbanStateInCycle, type WorkOrderKanbanState } from "@shared/workOrderKanban";
import "./WorkOrders.board.css";
import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { AppSelect } from "@/components/ui/AppSelect";
import { Input } from "@/components/ui/input";
import { UnifiedSearchInput } from "@/components/search/UnifiedSearchInput";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { useUrlFilters } from "@/hooks/useUrlFilters";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { AlertTriangle, Calendar, FileText, LayoutGrid, Rows3, SlidersHorizontal, Timer, Truck, Wrench, X, Zap } from "lucide-react";

import { trpc } from "@/lib/trpc";
import { hasModuleAccess, moduleAccessAllowed, type PermissionMap, type RoleKey } from "@shared/permissions";
import { notify } from "@/lib/notify";
import { confirm } from "@/lib/confirm";
import { exportRows } from "@/lib/export";
import { fmtAr, fmtInt, D, positiveDiff, toAccessibleMoney } from "@/lib/money";
import { reservePrintWindow, releaseReservedPrintWindow } from "@/lib/printing/brand";
import { printDoc } from "@/lib/printing/print";
import { printInvoicePaymentReceipt } from "@/lib/printing/cashierLifecycleReceipts";
import { printReadyOrderLabel } from "@/lib/printing/deliveryDocs";
import { printDeliveryDispatchSlipAsync } from "@/lib/printing/printDeliveryDispatchSlip";
import { preopenShippingLabelWindow } from "@/lib/printing/shippingLabel";





import { ShippingLabelSizeSelect } from "@/components/ShippingLabelSizeSelect";





import { WORK_ORDER_CHANNELS, receptionChannelLabel, receptionChannelOptions } from "@shared/receptionChannel";




import { Label } from "@/components/ui/label";

import CustomerPicker from "@/components/CustomerPicker";

import { Contact360Panel } from "@/components/contacts/Contact360Panel";

import { deriveWoDeliveryState, woDeliveryStateLabel } from "@shared/workOrderDeliveryState";
import { WorkOrderRefundApprovals } from "@/components/workOrders/WorkOrderRefundApprovals";
import { WorkOrderControlApprovals } from "@/components/workOrders/WorkOrderControlApprovals";
import { newClientRequestId } from "@/lib/countQueue";
import { canCancelWorkOrder } from "@/lib/workOrderRefundPolicy";
import { EditWorkOrderDialog } from "@/components/workOrders/EditWorkOrderDialog";
import { mayRequestWorkOrderControl } from "@shared/workOrderControlAuthority";
import { canLifecycleOperation } from "@/lib/lifecycleOperationAccess";

import { ErrorState, LoadingState } from "@/components/PageState";

import { type WO, type Detail, type Status, type DeliverTarget, COLUMNS, PRIORITIES, colVars, dueDayDelta, workOrderCardLabel } from "@/components/workOrders/workOrderTypes";
import { WorkOrderKanbanCard } from "@/components/workOrders/WorkOrderKanbanCard";
import { WorkOrderPreviewDrawer } from "@/components/workOrders/WorkOrderPreviewDrawer";
import { WorkOrdersTable } from "@/components/workOrders/WorkOrdersTable";
import { WorkOrderBlockedReasonDialog } from "@/components/workOrders/WorkOrderBlockedReasonDialog";
import { WorkOrderDeliverDialog } from "@/components/workOrders/WorkOrderDeliverDialog";
import { useRealtimeEvent } from "@/lib/realtime";
import { REALTIME_EVENT_TYPES } from "@shared/realtimeEvents";

// الحالات النشطة — مرآة WO_ACTIVE_STATUSES في workOrderRouter (الحالات غير النهائية).
const ACTIVE_STATUSES = ["RECEIVED", "IN_PROGRESS", "READY"] as const;
/** حدّ «مُسلَّم» المعروضة في العمود — الأحدث فقط؛ الإجمالي الحقيقي من workOrders.counts. */
const DELIVERED_LIMIT = 50;

// ─────────────── الصفحة ───────────────
export default function WorkOrders() {
  const [, navigate] = useLocation();
  const me = trpc.auth.me.useQuery();
  const utils = trpc.useUtils();
  // مرآة workordersManagerProcedure حرفياً: roles=[manager] + workorders/FULL، مع admin
  // والمنح الصريح حسب moduleAccessAllowed. لا مقارنة أدوار خام قد تحجب دوراً مخصّصاً أو
  // تُظهر زرّاً سيرفضه الخادم بسبب override مُقيِّد.
  const canCancel = canCancelWorkOrder(me.data?.role, me.data?.permissionsOverride ?? null);
  const isManager = canLifecycleOperation(me.data, "workOrders.update", canCancel);
  const canAssign = canLifecycleOperation(me.data, "workOrders.assign", canCancel);
  const canReadStaff = canLifecycleOperation(me.data, "workOrders.assignableStaff", canCancel);
  const isOwner = me.data?.isOwner === true;
  const canCrossBranches = me.data?.role === "admin";
  // مرآة workordersManagerProcedure حرفياً، بما فيها المنح الصريح لدور مخصّص.
  const legacyReviewControls = !!me.data?.role && moduleAccessAllowed(
    me.data.role as RoleKey,
    (me.data.permissionsOverride ?? null) as PermissionMap | null,
    "workorders",
    "FULL",
    ["manager"],
  );
  const canReviewWorkOrderControls = canLifecycleOperation(me.data, "workOrders.pendingControlRequests", legacyReviewControls);
  // المشرف (أدمن/مالك/مدير) نطاقُه كلُّ الفرع بحكم `scopedOwnerId=null` — فالرقاقة بلا أثرٍ له.
  const isSupervisor = me.data?.role === "admin" || me.data?.role === "manager" || !!me.data?.isOwner;
  // مرآة بوّابة الخادم: deliver = workordersCashierProcedure(["cashier","manager"], "workorders", "FULL") —
  // فنّي المطبعة (workordersExecProcedure) يقدّم المراحل لكن التسليم/الفوترة مال ونقد (كاشير/مدير أو منح صريح).
  // بنفس دالة الخادم moduleAccessAllowed (لا قائمة أدوار حرفية) ⇒ لا تباعُد.
  const legacyDeliver = !!me.data?.role &&
    moduleAccessAllowed(me.data.role as RoleKey, (me.data.permissionsOverride ?? null) as PermissionMap | null, "workorders", "FULL", ["cashier", "manager"]);
  const canDeliver = canLifecycleOperation(me.data, "workOrders.deliver", legacyDeliver);
  const canAutoClear = canLifecycleOperation(me.data, "workOrders.autoClearReady", legacyDeliver);
  const canRequestControl = canLifecycleOperation(me.data, "workOrders.requestControl", legacyDeliver) || isManager;
  /**
   * **طلبُ الإلغاء لفنّي المطبعة** (قرار المالك ١/٩/٢٦): مصدرُه القاموس المشترك نفسه الذي
   * يُنفّذه الخادم، لا قائمةُ أدوارٍ ثانية. التعديلُ التجاريّ يبقى على `canRequestControl`.
   */
  const canRequestCancel = canLifecycleOperation(me.data, "workOrders.requestControl", mayRequestWorkOrderControl("CANCEL", me.data?.role, (me.data?.permissionsOverride ?? null) as PermissionMap | null)) || canLifecycleOperation(me.data, "workOrders.cancel", false);
  // مرآة workordersExecProcedure الخادميّة: workorders/FULL + roles=[cashier|manager|print_operator].
  // إشارة الكانبان (setKanbanState) تحته ⇒ لا نُظهر زرّاً سيفشل بـFORBIDDEN لمستخدم READ (Codex #6).
  const legacyExec = !!me.data?.role &&
    moduleAccessAllowed(me.data.role as RoleKey, (me.data.permissionsOverride ?? null) as PermissionMap | null, "workorders", "FULL", ["cashier", "manager", "print_operator"]);
  const canSetKanban = canLifecycleOperation(me.data, "workOrders.setKanbanState", legacyExec);
  const canClaim = canLifecycleOperation(me.data, "workOrders.claim", legacyExec);
  const canRelease = canLifecycleOperation(me.data, "workOrders.release", legacyExec);
  const canStart = canLifecycleOperation(me.data, "workOrders.start", legacyExec);
  const canMarkReady = canLifecycleOperation(me.data, "workOrders.markReady", legacyExec);
  const canReadOrders = canLifecycleOperation(me.data, "workOrders.list", true);
  const canReadCounts = canLifecycleOperation(me.data, "workOrders.counts", true);
  const canReadCustomerContext = !!me.data?.role &&
    hasModuleAccess(me.data.role, (me.data.permissionsOverride ?? null) as PermissionMap | null, "crm", "READ");
  // قائمة الموظَّفين القابِلين للإسناد — مَرفوعة لصَفحة WorkOrders كَي تُستعمَل
  // في الإسناد inline على بطاقات «طابور وارد» (بَدل فَتح الـDrawer لِكل أَمر).
  // مَفعَّلة لِلمَدير فَقط لِتَوافق صَلاحية `assignableStaff` على الخادم.
  const assignableStaff = trpc.workOrders.assignableStaff.useQuery(undefined, { enabled: canReadStaff });
  // عبور الفروع للأدمن فقط؛ مدير الفرع مقيَّد بفرعه في الواجهة والخادم.
  const branchesQ = trpc.branches.list.useQuery(undefined, { enabled: canCrossBranches });

  // الفلاتر في querystring — تنجو من فتح التفاصيل والرجوع وتُشارَك رابطاً.
  // pri/ch/branch/tech بقيمة "all" (لا "") لأن AppSelect يعامل "" كـplaceholder غير قابل لإعادة الاختيار.
  const defaultDensity = useMemo(() => {
    if (typeof window === "undefined") return "normal";
    const saved = window.localStorage.getItem("wo-density");
    return saved === "compact" || saved === "detailed" || saved === "normal" ? saved : "normal";
  }, []);
  const [f, setF, resetF] = useUrlFilters({ customerId: "", q: "", pri: "all", ch: "all", branch: "all", from: "", to: "", tech: "all", scope: "branch", stale: "", gb: "stage", late: "", unassigned: "", dueToday: "", blocked: "", d: defaultDensity, deliv: "" });
  useEffect(() => {
    if (f.d === "compact" || f.d === "normal" || f.d === "detailed") {
      window.localStorage.setItem("wo-density", f.d);
    }
  }, [f.d]);
  const dq = useDebouncedValue(f.q, 250);
  const [sel, setSel] = useState<number | null>(null);
  const [editTarget, setEditTarget] = useState<number | null>(null);
  // طلب المالك (٩/٨): الكانبان يخدم الفنّيين/الإنتاج؛ يلزم عرضٌ جدوليّ للمراجعة المالية/الإدارية
  // (فرز/فلترة كـ«المبيعات») بلا حاجة لفتح شاشة الاستقبال. يُتذكَّر الاختيار على هذا الجهاز.
  const [view, setView] = useState<"board" | "list">(() => {
    if (typeof window === "undefined") return "board";
    return window.localStorage.getItem("wo-view") === "list" ? "list" : "board";
  });
  useEffect(() => {
    window.localStorage.setItem("wo-view", view);
  }, [view]);
  const [customerContextId, setCustomerContextId] = useState<number | null>(null);
  const [deliverOrder, setDeliverOrder] = useState<DeliverTarget | null>(null);
  const [drag, setDrag] = useState<{ order: WO; x: number; y: number; overCol: string | null } | null>(null);

  const colRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const dragRef = useRef<{ order: WO; startX: number; startY: number; ox: number; oy: number; moved: boolean } | null>(null);
  const deliverSnapRef = useRef<WO | DeliverTarget | null>(null);
  const autoClearSnapRef = useRef<{ single?: WO; candidates: WO[]; labelWin: Window | null } | null>(null);

  // فلاتر خادمية مشتركة بين القائمتين والعدّادات والتصدير — بناء واحد فلا تنحرف الأرقام عن الجدول.
  const customerFilterId = Number(f.customerId);
  const serverFilters = {
    customerId: Number.isSafeInteger(customerFilterId) && customerFilterId > 0 ? customerFilterId : undefined,
    q: dq.trim() || undefined,
    from: f.from || undefined,
    to: f.to || undefined,
    assignedTo: f.tech !== "all" ? Number(f.tech) : undefined,
    branchId: canCrossBranches && f.branch !== "all" ? Number(f.branch) : undefined,
    // قرار المالك (١٩/٨): الشاشات التشغيلية تعرض **أوامر الفرع كلّها** افتراضياً. موظّفةٌ لا ترى
    // طلبات زميلتها كانت تعجز عن الردّ على زبونٍ سأل عن طلبٍ استقبلته الوردية السابقة.
    // الخادم يشترط `workorders:FULL` ويُبقي عزل الفرع حاكماً؛ ورقاقة «طلباتي» تعيد التضييق.
    branchQueue: f.scope !== "mine",
    // ش٦: «لم يحضر أصحابها» — جاهزٌ منذ ٧ أيّامٍ فأكثر. لحظةُ الجاهزية مشتقّة خادمياً
    // (`workStartedAt + workSeconds`) فلا عمودَ جديد ولا كاتبَ ينجرف.
    awaitingPickupDays: f.stale === "1" ? 7 : undefined,
  };
  // العلة الجوهرية سابقاً: list({limit:200}) واحدة desc(id) — «مُسلَّم» المتراكمة بلا سقف كانت تملأ
  // النافذة فيسقط عملٌ نشط من اللوحة بصمت. الحل (نمط WorkOrderStation المُصلَح): استعلامان منفصلان —
  // النشطة كاملةً (مجموعة صغيرة بطبيعتها) و«مُسلَّم» محدودة بالأحدث.
  const activeInput = { statuses: [...ACTIVE_STATUSES], limit: 500, ...serverFilters };
  const deliveredInput = { statuses: ["DELIVERED" as const], limit: DELIVERED_LIMIT, ...serverFilters };
  const activeQ = trpc.workOrders.list.useQuery(activeInput, { enabled: canReadOrders });
  const deliveredQ = trpc.workOrders.list.useQuery(deliveredInput, { enabled: canReadOrders });
  const countsQ = trpc.workOrders.counts.useQuery(serverFilters, { enabled: canReadCounts });
  const serverCounts = countsQ.data;

  const invalidateAll = () => Promise.all([
    utils.workOrders.list.invalidate(),
    utils.workOrders.counts.invalidate(),
    utils.workOrders.get.invalidate(),
    utils.workOrders.timeline.invalidate(),
    utils.workOrders.pendingCancellationRefunds.invalidate(),
    utils.workOrders.cancellationRefundStatus.invalidate(),
    utils.inventory.movements.invalidate(),
    utils.delivery.readyForDispatch.invalidate(),
  ]);

  useRealtimeEvent(
    [
      REALTIME_EVENT_TYPES.WORK_ORDER_CREATED,
      REALTIME_EVENT_TYPES.WORK_ORDER_STATUS_CHANGED,
      REALTIME_EVENT_TYPES.WORK_ORDER_CLAIMED,
    ],
    () => {
      void invalidateAll();
    },
  );
  // التفاؤل على استعلام النشطة فقط — الانتقال إلى «مُسلَّم» يمرّ بحوار التسليم ثم invalidateAll.
  const optimisticMove = (id: number, to: Status) =>
    utils.workOrders.list.setData(activeInput, (old) => old?.map((o) => (o.id === id ? { ...o, status: to } : o)));

  const claim = trpc.workOrders.claim.useMutation({
    onSuccess: () => { notify.ok("سُحب الأمر إلى قائمتك"); invalidateAll(); },
    onError: (e) => { notify.err(e); invalidateAll(); },
  });
  const release = trpc.workOrders.release.useMutation({
    onSuccess: () => { notify.ok("أُعيد الأمر إلى الطابور المشترك"); invalidateAll(); },
    onError: (e) => { notify.err(e); invalidateAll(); },
  });
  const start = trpc.workOrders.start.useMutation({
    onSuccess: () => { notify.warn("بدأ التنفيذ", "خُصمت المواد من المخزون تلقائياً."); invalidateAll(); },
    onError: (e) => { notify.err(e); invalidateAll(); },
  });
  const markReady = trpc.workOrders.markReady.useMutation({
    onSuccess: () => { notify.ok("جاهز للتسليم", "الأمر جاهز — أبلغ العميل."); invalidateAll(); },
    onError: (e) => { notify.err(e); invalidateAll(); },
  });
  const deliver = trpc.workOrders.deliver.useMutation({
    onSuccess: (r, vars) => {
      const snap = deliverSnapRef.current ?? all.find((o) => o.id === vars.workOrderId) ?? deliverOrder;
      deliverSnapRef.current = null;
      const saleTotal = snap?.salePrice ?? "0";
      const paidBefore = D(snap?.deposit ?? 0);
      const paidNow = vars.payment?.amount ? D(vars.payment.amount) : D(0);
      const remAfter = D(saleTotal).minus(paidBefore).minus(paidNow);
      notify.ok("تم التسليم", `صدرت فاتورة ${r.invoiceNumber} تلقائياً.`);
      void printInvoicePaymentReceipt({
        invoiceNumber: r.invoiceNumber,
        customerName: snap && "customerName" in snap ? snap.customerName : null,
        customerPhone: snap && "customerPhone" in snap ? snap.customerPhone : null,
        invoiceTotal: saleTotal,
        paidBefore: paidBefore.toFixed(2),
        amountPaid: paidNow.toFixed(2),
        remainingAfter: (remAfter.gt(0) ? remAfter : D(0)).toFixed(2),
        paymentMethod: paidNow.gt(0) ? (vars.payment?.method ?? "CASH") : null,
        reference: vars.payment?.reference ?? null,
        cashierName: me.data?.name ?? null,
      }).catch(() => {}).finally(() => releaseReservedPrintWindow());
      setDeliverOrder(null);
      invalidateAll();
    },
    onError: (e) => { deliverSnapRef.current = null; releaseReservedPrintWindow(); notify.err(e); invalidateAll(); },
  });
  const assign = trpc.workOrders.assign.useMutation({
    onSuccess: () => { notify.ok("تم تحديث الإسناد"); invalidateAll(); },
    onError: (e) => { notify.err(e); invalidateAll(); },
  });
  // الموجة ١ (٣٠/٨/٢٦) — إشارةُ الفنّيّ داخل المرحلة (NORMAL/READY/BLOCKED).
  const [blockTarget, setBlockTarget] = useState<{ id: number; orderNumber: string; title: string } | null>(null);
  const setKanban = trpc.workOrders.setKanbanState.useMutation({
    onSuccess: () => { setBlockTarget(null); invalidateAll(); },
    onError: (e) => { notify.err(e); },
  });
  /**
   * دورةُ نقر النقطة: NORMAL → READY → BLOCKED (بحوار سبب) → NORMAL.
   * BLOCKED بلا سببٍ يعني علامةً خاويةً لا تُساعد المدير — الخادم يرفضها والواجهة تسأل.
   */
  const onCycleKanbanState = (orderId: number, current: WorkOrderKanbanState) => {
    const next = nextKanbanStateInCycle(current);
    if (next === "BLOCKED") {
      const row = all.find((o) => o.id === orderId);
      setBlockTarget({
        id: orderId,
        orderNumber: row?.orderNumber ?? String(orderId),
        title: row?.title ?? "",
      });
      return;
    }
    setKanban.mutate({ workOrderId: orderId, kanbanState: next });
  };
  const activeBranchId = canCrossBranches && f.branch !== "all" ? Number(f.branch) : undefined;

  const autoClearReady = trpc.workOrders.autoClearReady.useMutation({
    onSuccess: async (res, vars) => {
      const snap = autoClearSnapRef.current;
      autoClearSnapRef.current = null;
      const closeLabel = () => { try { snap?.labelWin?.close(); } catch { /* noop */ } };
      if (res.clearedCount > 0) {
        if (!vars?.workOrderId) {
          notify.ok(
            "تم التصريف التلقائي",
            `تم تصريف ${fmtInt(res.clearedCount)} طلب (${fmtInt(res.dispatchedCount)} إرسال للتوصيل، ${fmtInt(res.deliveredCount)} تسليم مباشر).`,
          );
        }
        const target = snap?.single ?? (res.clearedCount === 1 && snap?.candidates.length === 1 ? snap.candidates[0] : undefined);
        if (target && res.dispatchedCount === 1 && res.deliveredCount === 0) {
          const freshRows = await utils.workOrders.list.fetch({ statuses: [...ACTIVE_STATUSES, "DELIVERED"], limit: 100, ...serverFilters }).catch(() => [] as WO[]);
          const updated = freshRows.find((o) => o.id === target.id) ?? target;
          const cod = positiveDiff(updated.salePrice, updated.deposit ?? 0).toFixed(2);
          const cnNum = (updated as { consignmentNumber?: string | null }).consignmentNumber ?? updated.orderNumber;
          const printable = {
            orderNumber: updated.orderNumber,
            title: updated.title,
            quantity: Number(updated.quantity ?? 1),
            salePrice: updated.salePrice,
            deposit: updated.deposit ?? null,
            customerName: updated.customerName ?? null,
            customerPhone: updated.customerPhone ?? null,
            deliveryAddress: updated.deliveryAddress ?? null,
            deliveryCost: updated.deliveryCost ?? null,
            deliveryFeeCollection: (updated as { deliveryFeeCollection?: "COURIER" | "COUNTER" | "SHOP" | null }).deliveryFeeCollection ?? null,
          };
          if (snap?.labelWin) {
            void printReadyOrderLabel(printable, {
              partyName: updated.deliveryPartyName ?? null,
              trackingNumber: cnNum,
              cod,
              into: snap.labelWin,
            }).catch(() => closeLabel());
          }
          void printDeliveryDispatchSlipAsync({
            sourceType: "WORK_ORDER",
            workOrderId: updated.id,
            consignmentNumber: cnNum,
            orderNumber: updated.orderNumber,
            orderKind: "workOrder",
            partyName: updated.deliveryPartyName ?? "مندوب التوصيل",
            recipientName: updated.customerName ?? "",
            recipientPhone: updated.customerPhone ?? "",
            deliveryAddress: updated.deliveryAddress ?? "",
            salePrice: updated.salePrice,
            deposit: updated.deposit ?? null,
            codAmount: cod,
            deliveryFee: String(updated.deliveryCost ?? "0"),
            feeCollection: (updated as { deliveryFeeCollection?: "COURIER" | "COUNTER" | "SHOP" | null }).deliveryFeeCollection ?? "COURIER",
            title: updated.title,
          }).catch(() => {}).finally(() => releaseReservedPrintWindow());
        } else if (target && res.deliveredCount === 1 && res.dispatchedCount === 0) {
          closeLabel();
          const det = await utils.workOrders.get.fetch({ workOrderId: target.id }).catch(() => null);
          const invNum = (det as { invoiceNumber?: string | null } | null)?.invoiceNumber ?? (det?.invoiceId ? `INV-${det.invoiceId}` : target.orderNumber);
          void printInvoicePaymentReceipt({
            invoiceNumber: invNum,
            customerName: target.customerName ?? null,
            customerPhone: target.customerPhone ?? null,
            invoiceTotal: target.salePrice,
            paidBefore: D(target.deposit ?? 0).toFixed(2),
            amountPaid: "0.00",
            remainingAfter: "0.00",
            paymentMethod: null,
            cashierName: me.data?.name ?? null,
          }).catch(() => {}).finally(() => releaseReservedPrintWindow());
        } else {
          closeLabel();
          void printDoc({
            kind: "receipt",
            includeBrandHeader: true,
            title: "بيان التصريف التلقائي للطلبات الجاهزة",
            subtitle: `إجمالي المصرف: ${res.clearedCount} طلب`,
            meta: [
              me.data?.name ? `الموظف: ${me.data.name}` : "",
              `مرسل للتوصيل: ${res.dispatchedCount}`,
              `تسليم مباشر (مدفوع مسبقاً): ${res.deliveredCount}`,
            ].filter(Boolean),
            totals: [
              { label: "إرسالات التوصيل", value: String(res.dispatchedCount) },
              { label: "التسليم المباشر", value: String(res.deliveredCount) },
              { label: "إجمالي الطلبات المصرفة", value: String(res.clearedCount) },
            ],
            footer: "تم التصريف التلقائي للطلبات الجاهزة المؤهلة.",
          }).catch(() => {}).finally(() => releaseReservedPrintWindow());
        }
      } else {
        closeLabel();
        releaseReservedPrintWindow();
        if (!vars?.workOrderId) {
          notify.warn(
            "لا توجد طلبات مؤهلة للتصريف",
            "التصريف التلقائي للتوصيل يتطلب مندوباً فردياً نشطاً؛ شركة التوصيل تُسنَد من شاشة التوصيل بعد مسح البوليصة. والاستلام المباشر يتطلب دفع كامل المبلغ مقدماً.",
          );
        }
      }
      invalidateAll();
    },
    onError: (e) => {
      try { autoClearSnapRef.current?.labelWin?.close(); } catch { /* noop */ }
      autoClearSnapRef.current = null;
      releaseReservedPrintWindow();
      notify.err(e);
      invalidateAll();
    },
  });

  const onQuickDispatch = (order: WO) => {
    const labelWin = order.hasDelivery ? preopenShippingLabelWindow() : null;
    reservePrintWindow();
    autoClearSnapRef.current = { single: order, candidates: [order], labelWin };
    autoClearReady.mutate(
      { workOrderId: order.id, branchId: order.branchId },
      {
        onSuccess: (res) => {
          if (res.dispatchedCount > 0) {
            notify.ok("تم الإرسال للتوصيل", `تم إسناد الطلب ${order.orderNumber} لمندوب التوصيل.`);
          } else {
            notify.warn("تعذّر الإرسال للتوصيل", "تأكد من وجود مندوب فردي نشط للفرع، أو أرسله لشركة من شاشة التوصيل بعد مسح البوليصة.");
          }
        },
      },
    );
  };

  const onQuickDeliver = (order: WO) => {
    deliverSnapRef.current = order;
    reservePrintWindow();
    deliver.mutate({
      workOrderId: order.id,
      clientRequestId: newClientRequestId(),
    });
  };

  const busy = claim.isPending || release.isPending || start.isPending || markReady.isPending || deliver.isPending || assign.isPending || autoClearReady.isPending;

  const operation = useMemo(() => ({
    getOperation: (order: WO) => ({
      actor: {
        name: order.createdByName,
        source: order.createdByName ? ("user" as const) : ("legacy" as const),
      },
      action: { code: "workOrder.create", label: "إنشاء طلب خدمة" },
      subject: { type: "workOrder", label: "طلب", id: order.orderNumber },
      at: order.createdAt,
    }),
    label: "تتبّع الإنشاء",
  }), []);

  const all = useMemo(() => [...(activeQ.data ?? []), ...(deliveredQ.data ?? [])], [activeQ.data, deliveredQ.data]);
  // الأولوية/القناة ترشيح عميلي (لا يدعمهما الخادم)؛ q تُطبَّق فورياً هنا أيضاً فوق الترشيح الخادمي
  // المُبطَّأ (debounce) — استجابة لحظية بلا وميض نتائج قديمة.
  /**
   * predicate الفلترة العميليّة — منفصلٌ عن `filtered` عمداً كي **يُعاد استعماله في التصدير**
   * (Codex #5): «تصدير Excel» كان يطبّق فلاتر الخادم فقط ⇒ يصدّر أوامر لا تظهر في اللوحة.
   */
  const clientFilterPredicate = useMemo(() => {
    const needle = f.q.trim().toLowerCase();
    return (o: WO) => {
      if (f.pri !== "all" && o.priority !== f.pri) return false;
      if (f.ch !== "all" && o.receptionChannel !== f.ch) return false;
      // الفلاتر السريعة تطبِّق على النشطة فقط — تسليمٌ فائتُ الموعد ليس «متأخّراً» (خرج من الدورة).
      // اليومُ يُحسَب بأيّامٍ محلّية (`dueDayDelta`) لاتساقه مع `dueInfo` على البطاقة نفسها —
      // كلاهما مصدرُه الحاكم واحد، لا فرقَ بين ما يعرضه الشاشة وما يفلتره الزرّ (Codex #3).
      if (f.late === "1") {
        if (o.status === "DELIVERED" || o.status === "CANCELLED") return false;
        const d = dueDayDelta(o.dueDate);
        if (d == null || d >= 0) return false;
      }
      if (f.unassigned === "1") {
        // Codex #2 (الجولة ٣): الاسم يقول «طابور مشترك — أوامرُ لم تُسنَد لفنّيّ بعد»،
        // فإدراج أوامر مُسلَّمة/ملغاة غير مُسنَدة يخالف الاسم ويلوّث التصدير. مطابقة
        // نمط late/dueToday/blocked: النهائيات مستبعدةٌ قبل فحص الشرط.
        if (o.status === "DELIVERED" || o.status === "CANCELLED") return false;
        if (o.assignedTo != null) return false;
      }
      if (f.dueToday === "1") {
        if (o.status === "DELIVERED" || o.status === "CANCELLED") return false;
        const d = dueDayDelta(o.dueDate);
        if (d !== 0) return false;
      }
      if (f.blocked === "1") {
        // Codex #5 (الجولة ٢): مسارُ التسليم/الإلغاء لا يمسح `kanbanState` — أمرٌ وُسم
        // BLOCKED ثمّ سُلّم يبقى محتفظاً بالقيمة، فيعيده فلترُ «معطَّل» من نافذة deliveredQ
        // بينما `isKanbanStateApplicable` يعدّ DELIVERED نهاية ويُخفي نقطته على البطاقة.
        // الحلّ الاتّساقيّ: نستبعد النهائيات هنا كما يفعل `late` و`dueToday`.
        if (o.status === "DELIVERED" || o.status === "CANCELLED") return false;
        const ks = (o as unknown as { kanbanState?: string | null }).kanbanState;
        if (ks !== "BLOCKED") return false;
      }
      if (f.deliv === "1") {
        if (o.status === "DELIVERED" || o.status === "CANCELLED") return false;
        const st = deriveWoDeliveryState(o.consignmentStatus, o.parcelStatus);
        if (!o.hasDelivery && st === "NONE") return false;
      }
      if (needle) {
        const hay = [o.orderNumber, o.title, o.customerName ?? ""].join(" ").toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    };
  }, [f.q, f.pri, f.ch, f.late, f.unassigned, f.dueToday, f.blocked, f.deliv]);

  const filtered = useMemo(() => all.filter(clientFilterPredicate), [all, clientFilterPredicate]);

  /** تصدير كامل عبر cursor (الشكل مصفوفة صرفة): صفحات 200 حتى صفحة ناقصة، بسقف أمان. */
  async function fetchAllForExport(): Promise<WO[]> {
    const out: WO[] = [];
    let cursor: number | undefined;
    for (let i = 0; i < 200; i++) {
      const pageRows = await utils.workOrders.list.fetch({ limit: 200, cursor, ...serverFilters });
      out.push(...pageRows);
      if (pageRows.length < 200) break;
      cursor = Number(pageRows[pageRows.length - 1].id);
    }
    // نطبّق **نفس** predicate الفلترة العميليّة على النتائج — التصدير يطابق ما تعرضه
    // اللوحة حرفياً بما فيه الفلاتر السريعة الأربعة (Codex #5). قبله: أولوية/قناة/بحث
    // وحدها كانت تُطبَّق، فالضغط على «تصدير» بعد تفعيل «معطَّل» يصدّر أوامر لا تظهر.
    return out.filter(clientFilterPredicate);
  }

  // ─── الموجة ٢ (٣٠/٨/٢٦) — Group By متبدّل بنمط Odoo ──────────────────────────
  // «حسب المرحلة» يبقى الافتراضَ (سلوكٌ ثابت + D&D يعمل). الأخرى تُشتقّ من البيانات
  // ذاتها وتُعطّل D&D — تغييرُ الفنّيّ يحتاج mutation `assign`، الأولويّة تحتاج `update`،
  // والقناة لا تتغيّر بعد الإنشاء ⇒ فتح كلٍّ منها في موجةٍ لاحقة يبقى أنقى من إدخالها هنا مبعثرةً.
  type GroupBy = "stage" | "technician" | "channel" | "priority";
  const groupBy = (["stage", "technician", "channel", "priority"] as const).includes(f.gb as GroupBy)
    ? (f.gb as GroupBy)
    : "stage";
  const dndEnabled = groupBy === "stage";

  type DynCol = { key: string; label: string; hint: string; hue: number; status: Status; match: (o: WO) => boolean };
  const dynColumns: DynCol[] = useMemo(() => {
    if (groupBy === "stage") return COLUMNS.slice();
    if (groupBy === "technician") {
      // «غير مُسنَد» عمودٌ حاكمٌ أوّلاً (طابور مشترك)، ثمّ فنّيّون مرتَّبون بالاسم.
      const byTech = new Map<number | null, string>();
      byTech.set(null, "غير مُسنَد");
      filtered.forEach((o) => {
        const id = o.assignedTo ?? null;
        if (id != null && !byTech.has(id)) byTech.set(id, o.assigneeName ?? `فنّيّ #${id}`);
      });
      const cols: DynCol[] = [];
      // ⚠️ status/hint هنا **قيمة عرضٍ** لا حاكمٌ منطقيّ — D&D معطَّل في هذا الوضع.
      cols.push({ key: "tech:none", label: "غير مُسنَد", hint: "الطابور المشترك — بلا فنّيّ", hue: 72, status: "RECEIVED" as Status, match: (o) => o.assignedTo == null });
      Array.from(byTech.entries()).forEach(([id, name]) => {
        if (id == null) return;
        cols.push({ key: `tech:${id}`, label: name, hint: `أوامرُ الفنّيّ`, hue: (Number(id) * 47) % 360, status: "IN_PROGRESS" as Status, match: (o) => Number(o.assignedTo) === Number(id) });
      });
      return cols;
    }
    if (groupBy === "channel") {
      const cols: DynCol[] = [];
      const CHANNEL_HUES: Record<string, number> = { WALK_IN: 155, WHATSAPP: 155, INSTAGRAM: 293, TIKTOK: 320, PHONE: 250, OTHER: 210 };
      for (const ch of WORK_ORDER_CHANNELS) {
        cols.push({
          key: `ch:${ch}`,
          label: receptionChannelLabel(ch),
          hint: `قناةُ استلام`,
          hue: CHANNEL_HUES[ch] ?? 210,
          status: "IN_PROGRESS" as Status,
          match: (o) => o.receptionChannel === ch,
        });
      }
      return cols;
    }
    // priority
    return [
      { key: "pri:URGENT", label: "عاجل", hint: "أولويّة عليا — تنفيذٌ فوريّ", hue: 27, status: "IN_PROGRESS" as Status, match: (o) => (o.priority ?? "NORMAL") === "URGENT" },
      { key: "pri:NORMAL", label: "عادي", hint: "أولويّة اعتياديّة", hue: 235, status: "IN_PROGRESS" as Status, match: (o) => (o.priority ?? "NORMAL") === "NORMAL" },
      { key: "pri:LOW", label: "منخفض", hint: "لا يستعجل", hue: 155, status: "IN_PROGRESS" as Status, match: (o) => (o.priority ?? "NORMAL") === "LOW" },
    ];
  }, [groupBy, filtered]);

  const byCol = useMemo(() => {
    const m: Record<string, WO[]> = {};
    dynColumns.forEach((c) => (m[c.key] = []));
    filtered.forEach((o) => {
      const col = dynColumns.find((c) => c.match(o));
      if (col) m[col.key].push(o);
    });
    Object.values(m).forEach((arr) =>
      arr.sort((a, b) => {
        const pr = (PRIORITIES[b.priority ?? "NORMAL"]?.rank ?? 2) - (PRIORITIES[a.priority ?? "NORMAL"]?.rank ?? 2);
        if (pr) return pr;
        const da = a.dueDate ? new Date(String(a.dueDate)).getTime() : Infinity;
        const db = b.dueDate ? new Date(String(b.dueDate)).getTime() : Infinity;
        return da - db;
      })
    );
    return m;
  }, [filtered, dynColumns]);

  const anyClientFilter =
    f.pri !== "all" ||
    f.ch !== "all" ||
    f.dueToday === "1" ||
    f.unassigned === "1" ||
    f.blocked === "1" ||
    f.late === "1" ||
    f.deliv === "1" ||
    (f.q?.trim() ?? "") !== "";

  // ── حساب إحصائيات الأعمدة (القيمة الإجمالية، المتأخر، المعطل) ذرّياً من بطاقات العمود الفعلية ──
  // يحلّ جذرياً علّة تكرار مبالغ الحالة الواحدة (RECEIVED) بين «طابور وارد» و«مسحوب»،
  // ويصمد أمام كافة الفلاتر العميلية والتجميع المتبدل (حسب الفني/القناة/الأولوية).
  const colStatsMap = useMemo(() => {
    const map: Record<string, { totalValue: string; late: number; blocked: number }> = {};
    dynColumns.forEach((c) => {
      const colItems = byCol[c.key] ?? [];
      let total = D(0);
      let late = 0;
      let blocked = 0;
      for (const o of colItems) {
        total = total.plus(D(o.salePrice || 0));
        if (o.status !== "DELIVERED" && o.status !== "CANCELLED") {
          const delta = dueDayDelta(o.dueDate);
          if (delta != null && delta < 0) late++;
        }
        const ks = (o as unknown as { kanbanState?: string | null }).kanbanState;
        if (ks === "BLOCKED" && o.status !== "DELIVERED" && o.status !== "CANCELLED") {
          blocked++;
        }
      }
      map[c.key] = { totalValue: total.toString(), late, blocked };
    });
    return map;
  }, [dynColumns, byCol]);

  // ── الانتقال بين المراحل (الخطوة التالية فقط — التسليم خلف تأكيد مالي) ──
  async function attemptMove(order: WO, to: Status) {
    if (WO_NEXT_STATUS[order.status as WorkOrderStatus] !== to) {
      notify.warn("انتقال غير مسموح", "اتبع التسلسل: مُستلَم ← قيد التنفيذ ← جاهز ← مُسلَّم.");
      return;
    }
    if (to === "IN_PROGRESS") {
      if (!canStart) return;
      if (!(await confirm({ variant: "warning", title: "بدء تنفيذ طلب الخدمة", description: `بدء تنفيذ «${order.title}» (${order.orderNumber}) يخصم المواد المطلوبة من المخزون تلقائياً. متابعة؟`, confirmText: "بدء التنفيذ", cancelText: "تراجع" }))) return;
      optimisticMove(order.id, "IN_PROGRESS"); start.mutate({ workOrderId: order.id });
    }
    else if (to === "READY") {
      if (!canMarkReady) return;
      if (!(await confirm({ variant: "info", title: "وضع علامة: جاهز للتسليم", description: `وضع «${order.title}» (${order.orderNumber}) في حالة «جاهز للتسليم». متابعة؟`, confirmText: "جاهز للتسليم", cancelText: "تراجع" }))) return;
      optimisticMove(order.id, "READY"); markReady.mutate({ workOrderId: order.id });
    }
    else if (to === "DELIVERED") {
      // مرآة الخادم: deliver محصور بالكاشير/المدير (أو منح workorders=FULL صريح) — لا نفتح حوار تسليم سيفشل بـ403.
      if (!canDeliver) { notify.warn("التسليم من صلاحية الكاشير/المدير", "تقديم الأمر إلى «مُسلَّم» يُصدر فاتورة نهائية — يتولّاه الكاشير أو المدير."); return; }
      if (order.hasDelivery) {
        // ١٨/٨ (بلاغ المالك): كانت الرسالة واحدةً لكل الحالات والتنقّل يقذف إلى شاشةٍ **لا أثر
        // للطلب فيها** (الطرد المُسنَد كان خارج كل تبويباتها). الآن: رسالةٌ بحالته الحقيقية،
        // والتنقّل إلى التبويب الذي يعرضه فعلاً.
        const st = deriveWoDeliveryState(order.consignmentStatus, order.parcelStatus);
        if (st === "NONE") {
          notify.warn("هذا طلب توصيل", "أنشئ الإرسالية واختر الجهة من «جاهز للإرسال» في إدارة التوصيل.");
          navigate("/delivery");
        } else {
          notify.warn(
            `الطلب ${woDeliveryStateLabel(st)}`,
            `${order.deliveryPartyName ? `مع ${order.deliveryPartyName}. ` : ""}يُغلَق بإثبات التسليم من تبويب «قيد التوصيل».`,
          );
          navigate("/delivery?tab=transit");
        }
        return;
      }
      setDeliverOrder({ id: order.id, orderNumber: order.orderNumber, title: order.title, salePrice: order.salePrice, deposit: order.deposit ?? "0" });
    }
  }

  function hitCol(x: number, y: number): string | null {
    for (const [k, el] of Object.entries(colRefs.current)) {
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return k;
    }
    return null;
  }

  const canReleaseOrder = (o: Pick<WO, "status" | "assignedTo">) =>
    canRelease && o.status === "RECEIVED" && o.assignedTo != null && Number(o.assignedTo) === Number(me.data?.id);

  function onCardPointerDown(e: React.PointerEvent, order: WO) {
    if (e.button !== 0) return;
    const canDragOrder = order.status === "RECEIVED"
      ? (canStart || (order.assignedTo == null ? canClaim : canReleaseOrder(order)))
      : canLifecycleOperation(me.data, order.status === "IN_PROGRESS" ? "workOrders.markReady" : "workOrders.deliver", true);
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    dragRef.current = { order, startX: e.clientX, startY: e.clientY, ox: e.clientX - rect.left, oy: e.clientY - rect.top, moved: false };
    const move = (ev: PointerEvent) => {
      const dr = dragRef.current; if (!dr) return;
      if (!dr.moved && Math.hypot(ev.clientX - dr.startX, ev.clientY - dr.startY) < 6) return;
      // Codex #6 (الجولة ٢): وسمُ `moved=true` **قبل** فحص `dndEnabled` كان يعطّل النقر
      // على البطاقات في تجميعاتٍ غير stage — حركةٌ لمسٍ طفيفة (>6px) تنتج pointerup
      // بحالة `moved=true` فلا يُفتح Drawer، ولا نقلٍ يحدث لأنّ مفاتيح `tech:*` ليست في
      // COLUMNS ⇒ نقرةٌ ضائعة. الحلّ: نتخطّى في تجميعاتٍ غير stage قبل الوسم.
      if (!dndEnabled || !canDragOrder) return;
      dr.moved = true;
      document.body.style.userSelect = "none";
      setDrag({ order: dr.order, x: ev.clientX - dr.ox, y: ev.clientY - dr.oy, overCol: hitCol(ev.clientX, ev.clientY) });
    };
    // Codex #4 (الجولة ٣): تنظيفٌ مشترك — يزيل كلّ المستمعين ويعيد `userSelect` و`drag` و
    // `dragRef` إلى قيمها الحياديّة. يُستدعى من pointerup **وpointercancel** معاً:
    // المتصفّح يُطلق cancel (لا up) عند التمرير اللمسيّ العموديّ فوق البطاقة، وبدون
    // مستمعٍ له كانت `dragRef` تبقى مأهولةً فيلتقط أوّل pointerup لاحقٍ في أيّ مكان
    // من الشاشة بطاقةً «قديمة» ويفتح Drawer الخاطئ.
    const cleanup = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      document.body.style.userSelect = "";
      setDrag(null);
    };
    const cancel = () => { dragRef.current = null; cleanup(); };
    const up = (ev: PointerEvent) => {
      const dr = dragRef.current; dragRef.current = null;
      cleanup();
      if (!dr) return;
      if (!dr.moved) { setSel(dr.order.id); return; }
      const overKey = hitCol(ev.clientX, ev.clientY);
      if (dr.order.status === "RECEIVED" && dr.order.assignedTo == null && overKey === "CLAIMED" && canClaim) {
        claim.mutate({ workOrderId: dr.order.id });
        return;
      }
      if (overKey === "INBOX" && canReleaseOrder(dr.order)) {
        release.mutate({ workOrderId: dr.order.id });
        return;
      }
      const col = COLUMNS.find((c) => c.key === overKey);
      if (col && col.status !== dr.order.status) attemptMove(dr.order, col.status);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
  }

  function onCancelOrder(d: Pick<Detail, "id" | "title" | "orderNumber">) {
    // الإلغاء يحتاج سبباً ومصير كل خامة ووردية ردّ النقد، وقد يتحول إلى طلب اعتماد.
    // لذلك لا ننفّذ اختصاراً ناقصاً من اللوحة؛ نفتح مسار التفاصيل الجامع بهذه البيانات.
    navigate(`/work-orders/${d.id}?cancel=1`);
  }

  const anyFilter = f.customerId || f.q || f.pri !== "all" || f.ch !== "all" || f.branch !== "all" || f.from || f.to || f.tech !== "all" || f.stale === "1" || (f.scope || "branch") !== "branch" || f.late === "1" || f.unassigned === "1" || f.dueToday === "1" || f.blocked === "1" || f.deliv === "1";
  const secondaryFilterCount =
    (f.pri !== "all" ? 1 : 0) +
    (f.ch !== "all" ? 1 : 0) +
    (f.branch !== "all" ? 1 : 0) +
    (f.tech !== "all" ? 1 : 0) +
    (f.from ? 1 : 0) +
    (f.to ? 1 : 0) +
    (f.gb && f.gb !== "stage" ? 1 : 0);
  const boardEmpty = filtered.length === 0;
  const boardLoading = activeQ.isLoading || deliveredQ.isLoading;
  const boardError = activeQ.isError || deliveredQ.isError || (canReadCounts && countsQ.isError);

  return (
    <div className={`wob ${view === "board" ? "wob--board" : "wob--list"}`}>
      <WorkOrderRefundApprovals isOwner={isOwner} />
      <WorkOrderControlApprovals
        canReview={canReviewWorkOrderControls}
        currentUserId={me.data?.id}
      />

      <div className="wob-toolbar">
        {/* رقاقة النطاق (قرار المالك ١٩/٨) — «كل طلبات الفرع» هو الافتراضيّ، و«طلباتي» تضييقٌ
            اختياريّ. لا تُعرَض للمشرفين: نطاقُهم كلُّ الفرع أصلاً فتكون الرقاقة بلا أثر. */}
        {!isSupervisor && (
          <div className="wob-scope" role="group" aria-label="نطاق العرض">
            {([
              { v: "branch", label: "كل طلبات الفرع" },
              { v: "mine", label: "طلباتي" },
            ] as const).map((o) => (
              <button
                key={o.v}
                type="button"
                aria-pressed={(f.scope || "branch") === o.v}
                onClick={() => setF({ scope: o.v })}
                className={`wob-scope-btn${(f.scope || "branch") === o.v ? " is-on" : ""}`}
              >
                {o.label}
              </button>
            ))}
          </div>
        )}
        {/* ش٦: رقاقةُ «لم يحضر أصحابها» بجوار النطاق — طابورٌ ثالثٌ لا يقوله أيّ عمود:
            الأمرُ جاهزٌ (فليس متأخّراً في التنفيذ) ولا أحد يستلمه. */}
        <button
          type="button"
          aria-pressed={f.stale === "1"}
          onClick={() => setF({ stale: f.stale === "1" ? "" : "1" })}
          className={`wob-scope-btn${f.stale === "1" ? " is-on" : ""}`}
          title="طلبات جاهزة منذ أكثر من ٧ أيّام ولم يستلمها أصحابها"
        >
          لم يحضر أصحابها
        </button>
        {/* الموجة ٣ (٣٠/٨/٢٦) — فلاتر معلَّبة (نمط Odoo): بديلٌ عن حقولٍ متفرّقة يفهمها
            الموظّف بأسمائها لا بالفلترة اليدويّة. كلٌّ منها URL-toggle قابلة للنسخ.
            الشارة السابقة «متأخّر» صارت فلتراً تفاعليّاً: تعرض العدّاد وتحصر عند النقر. */}
        {(() => {
          const clientFilterActive =
            f.pri !== "all" || f.ch !== "all" ||
            f.late === "1" || f.dueToday === "1" || f.unassigned === "1" || f.blocked === "1";
          const lateBadge = clientFilterActive
            ? filtered.filter((o) => {
                if (o.status === "DELIVERED" || o.status === "CANCELLED") return false;
                const d = dueDayDelta(o.dueDate);
                return d != null && d < 0;
              }).length
            : (serverCounts?.late ?? 0);
          return (
            <button
              type="button"
              aria-pressed={f.late === "1"}
              onClick={() => setF({ late: f.late === "1" ? "" : "1" })}
              className={`wob-qf${f.late === "1" ? " wob-qf-on wob-qf-late" : ""}`}
              title="أوامرُ فات موعد استحقاقها"
            >
              <Timer aria-hidden className="size-3.5" />
              متأخّر
              {lateBadge > 0 && <span className="wob-qf-badge">{fmtInt(lateBadge)}</span>}
            </button>
          );
        })()}
        <button type="button" aria-pressed={f.dueToday === "1"} onClick={() => setF({ dueToday: f.dueToday === "1" ? "" : "1" })} className={`wob-qf${f.dueToday === "1" ? " wob-qf-on wob-qf-today" : ""}`} title="أوامرُ تستحقّ التسليم اليوم">
          <Calendar aria-hidden className="size-3.5" /> يستحقّ اليوم
        </button>
        <button type="button" aria-pressed={f.unassigned === "1"} onClick={() => setF({ unassigned: f.unassigned === "1" ? "" : "1" })} className={`wob-qf${f.unassigned === "1" ? " wob-qf-on wob-qf-unassigned" : ""}`} title="طابورٌ مشترك — أوامرُ لم تُسنَد لفنّيّ بعد">
          <Wrench aria-hidden className="size-3.5" /> بلا فنّيّ
        </button>
        <button type="button" aria-pressed={f.blocked === "1"} onClick={() => setF({ blocked: f.blocked === "1" ? "" : "1" })} className={`wob-qf${f.blocked === "1" ? " wob-qf-on wob-qf-blocked" : ""}`} title="أوامرٌ أشار الفنّيّ إلى تعطّلها — سببها في تلميح البطاقة">
          <AlertTriangle aria-hidden className="size-3.5" /> معطَّل
        </button>
        <button type="button" aria-pressed={f.deliv === "1"} onClick={() => setF({ deliv: f.deliv === "1" ? "" : "1" })} className={`wob-qf${f.deliv === "1" ? " wob-qf-on wob-qf-deliv" : ""}`} title="أوامرُ مسندة للتوصيل أو قيد التوصيل">
          <Truck aria-hidden className="size-3.5" /> قيد التوصيل
        </button>
        <UnifiedSearchInput barcode={false} debounceMs={0} value={f.q} onChange={(q) => setF({ q })} placeholder="بحث (رقم / عنوان / عميل)..." className="flex-1 min-w-[180px] max-w-[300px]" />

        {view === "board" && (
          <>
            <AppSelect
              value={f.gb}
              onValueChange={(v) => setF({ gb: v })}
              className="hidden xl:inline-flex h-[30px] text-xs w-[150px]"
              aria-label="تجميع البطاقات"
            >
              <option value="stage">حسب المرحلة (افتراضيّ)</option>
              <option value="technician">حسب الفنّيّ</option>
              <option value="channel">حسب القناة</option>
              <option value="priority">حسب الأولويّة</option>
            </AppSelect>
            <AppSelect
              value={f.d}
              onValueChange={(v) => setF({ d: v })}
              className="hidden lg:inline-flex h-[30px] text-xs w-[112px]"
              aria-label="كثافة العرض"
            >
              <option value="compact">كثافة: مضغوط</option>
              <option value="normal">كثافة: عاديّ</option>
              <option value="detailed">كثافة: مفصَّل</option>
            </AppSelect>
          </>
        )}

        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              className={`wob-qf${secondaryFilterCount > 0 ? " wob-qf-on" : ""}`}
              title="فلاتر متقدمة وتخصيص العرض"
            >
              <SlidersHorizontal aria-hidden className="size-3.5" />
              فلاتر متقدمة
              {secondaryFilterCount > 0 && <span className="wob-qf-badge">{fmtInt(secondaryFilterCount)}</span>}
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-80 p-3 space-y-2.5 text-start" dir="rtl">
            <div className="flex items-center justify-between border-b pb-1.5">
              <span className="text-xs font-extrabold">الفلاتر وتخصيص اللوحة</span>
              {anyFilter && (
                <button type="button" className="text-2xs font-bold text-destructive hover:underline" onClick={resetF}>
                  إعادة ضبط
                </button>
              )}
            </div>
            <div className="grid grid-cols-2 gap-2">
              {view === "board" && (
                <div className="space-y-1">
                  <Label className="text-2xs text-muted-foreground">تجميع البطاقات</Label>
                  <AppSelect
                    value={f.gb}
                    onValueChange={(v) => setF({ gb: v })}
                    className="w-full"
                    aria-label="تجميع البطاقات"
                  >
                    <option value="stage">حسب المرحلة (افتراضيّ)</option>
                    <option value="technician">حسب الفنّيّ</option>
                    <option value="channel">حسب القناة</option>
                    <option value="priority">حسب الأولويّة</option>
                  </AppSelect>
                </div>
              )}
              {view === "board" && (
                <div className="space-y-1">
                  <Label className="text-2xs text-muted-foreground">كثافة العرض</Label>
                  <AppSelect
                    value={f.d}
                    onValueChange={(v) => setF({ d: v })}
                    className="w-full"
                    aria-label="كثافة العرض"
                  >
                    <option value="compact">مضغوط</option>
                    <option value="normal">عاديّ</option>
                    <option value="detailed">مفصَّل</option>
                  </AppSelect>
                </div>
              )}
              {canCrossBranches && (
                <div className="space-y-1 col-span-2">
                  <Label className="text-2xs text-muted-foreground">الفرع</Label>
                  <AppSelect
                    value={f.branch}
                    onValueChange={(v) => setF({ branch: v })}
                    className="w-full"
                    aria-label="فلتر الفرع"
                  >
                    <option value="all">كل الفروع</option>
                    {(branchesQ.data ?? []).map((b) => (
                      <option key={Number(b.id)} value={String(Number(b.id))}>{b.name}</option>
                    ))}
                  </AppSelect>
                </div>
              )}
              <div className="space-y-1">
                <Label className="text-2xs text-muted-foreground">الأولوية</Label>
                <AppSelect value={f.pri} onValueChange={(v) => setF({ pri: v })} className="w-full" aria-label="فلتر الأولوية">
                  <option value="all">كل الأولويات</option>
                  {Object.entries(PRIORITIES).map(([k, p]: [string, { label: string }]) => <option key={k} value={k}>{p.label}</option>)}
                </AppSelect>
              </div>
              <div className="space-y-1">
                <Label className="text-2xs text-muted-foreground">القناة</Label>
                <AppSelect value={f.ch} onValueChange={(v) => setF({ ch: v })} className="w-full" aria-label="فلتر القناة">
                  <option value="all">كل القنوات</option>
                  {receptionChannelOptions(WORK_ORDER_CHANNELS).map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                </AppSelect>
              </div>
              {canReadStaff && (assignableStaff.data?.length ?? 0) > 0 && (
                <div className="space-y-1 col-span-2">
                  <Label className="text-2xs text-muted-foreground">الفنّي المسؤول</Label>
                  <AppSelect value={f.tech} onValueChange={(v) => setF({ tech: v })} className="w-full" aria-label="فلتر الفنّي">
                    <option value="all">كل الفنّيين</option>
                    {(assignableStaff.data ?? []).map((s) => (
                      <option key={s.id} value={String(s.id)}>{s.name ?? "بلا اسم"}</option>
                    ))}
                  </AppSelect>
                </div>
              )}
              <div className="space-y-1">
                <Label className="text-2xs text-muted-foreground">من تاريخ الاستلام</Label>
                <Input
                  type="date"
                  className="wob-sel wob-date w-full"
                  value={f.from}
                  onChange={(e) => setF({ from: e.target.value })}
                  aria-label="من تاريخ"
                  title="من تاريخ الاستلام"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-2xs text-muted-foreground">إلى تاريخ الاستلام</Label>
                <Input
                  type="date"
                  className="wob-sel wob-date w-full"
                  value={f.to}
                  onChange={(e) => setF({ to: e.target.value })}
                  aria-label="إلى تاريخ"
                  title="إلى تاريخ الاستلام"
                />
              </div>
            </div>
            <div className="border-t pt-2 flex items-center justify-between">
              <span className="text-2xs text-muted-foreground">مقاس ملصق الشحن</span>
              <ShippingLabelSizeSelect />
            </div>
          </PopoverContent>
        </Popover>

        {serverFilters.customerId && <button type="button" className="wob-chip" onClick={() => setF({ customerId: "" })}>عميل #{serverFilters.customerId} <X aria-hidden className="size-3 inline-block" /></button>}
        {anyFilter && <button className="wob-chip-clear" onClick={resetF}>مسح الفلاتر <X aria-hidden className="size-3.5 inline-block align-text-bottom" /></button>}

        <div className="ms-auto flex items-center gap-1.5">
          <div role="group" aria-label="طريقة العرض" className="wob-view-toggle">
            <button
              type="button"
              aria-pressed={view === "board"}
              onClick={() => setView("board")}
              title="لوحة الإنتاج (كانبان)"
            ><LayoutGrid aria-hidden className="size-3.5" /> لوحة</button>
            <button
              type="button"
              aria-pressed={view === "list"}
              onClick={() => setView("list")}
              title="قائمة جدولية — للمراجعة والتحكّم"
            ><Rows3 aria-hidden className="size-3.5" /> قائمة</button>
          </div>
          <button
            className="wob-btn wob-btn-ghost"
            disabled={boardLoading}
            title="تصدير إلى Excel"
            onClick={() => exportRows<WO>(fetchAllForExport, {
              filename: "طلبات-خدمة-العملاء",
              columns: [
                { key: "orderNumber", header: "رقم الأمر" },
                { key: "title", header: "العنوان" },
                { key: "customerName", header: "العميل", map: (r) => r.customerName ?? "" },
                { key: "quantity", header: "الكمية", map: (r) => Number(r.quantity ?? 0) },
                { key: "salePrice", header: "السعر", map: (r) => Number(r.salePrice ?? 0) },
                { key: "dueDate", header: "الاستحقاق", map: (r) => (r.dueDate ? String(r.dueDate).slice(0, 10) : "") },
                { key: "priority", header: "الأولوية", map: (r) => PRIORITIES[r.priority ?? "NORMAL"]?.label ?? "" },
                { key: "receptionChannel", header: "القناة", map: (r) => receptionChannelLabel(r.receptionChannel) },
                { key: "assigneeName", header: "المسؤول", map: (r) => r.assigneeName ?? "" },
                { key: "status", header: "الحالة", map: (r) => workOrderCardLabel(r) },
              ],
            })}
          ><FileText aria-hidden className="size-3.5 inline-block align-text-bottom me-1" /> تصدير</button>
        </div>
      </div>

      {boardLoading ? (
        <LoadingState message="جارٍ تحميل أوامر الشغل…" />
      ) : boardError ? (
        <ErrorState
          message="تعذّر تحميل جزء من أوامر الشغل أو عدّاداتها؛ لم يُفترض أن الطابور فارغ أو أن القيم صفر."
          onRetry={() => {
            void activeQ.refetch();
            void deliveredQ.refetch();
            if (canReadCounts) void countsQ.refetch();
          }}
        />
      ) : view === "list" ? (
        <WorkOrdersTable
          operation={operation}
          rows={filtered}
          isManager={isManager}
          canRequestControl={canRequestControl}
          canRequestCancel={canRequestCancel}
          canDeliver={canDeliver}
          onOpen={setSel}
          onEdit={setEditTarget}
          onAdvance={attemptMove}
          onCancel={onCancelOrder}
          onClaim={canClaim ? (id) => claim.mutate({ workOrderId: id }) : undefined}
          onRelease={canRelease ? (id) => release.mutate({ workOrderId: id }) : undefined}
        />
      ) : (
      <div className="wob-board-wrap">
        {boardEmpty ? (
          <div className="wob-empty-board">{anyFilter ? "لا طلبات مطابقة للبحث/الفلاتر الحالية." : "لا أوامر شغل بعد. تُنشأ الطلبات من شاشة الاستقبال الموحدة."}</div>
        ) : (
          <div className={`wob-board wob-d-${f.d === "compact" ? "compact" : f.d === "detailed" ? "detailed" : "normal"}`}>
            {dynColumns.map((s) => {
              const list = byCol[s.key] ?? [];
              // D&D يعمل فقط في «حسب المرحلة» (`groupBy=stage`): الأخرى تحتاج mutations
              // مختلفة (assign/update) لم يُبنَ لها بعد جسر D&D — يبقى العرض قراءةً فقط.
              const isOver = dndEnabled && !!drag && drag.overCol === s.key && (
                WO_NEXT_STATUS[drag.order.status as WorkOrderStatus] === s.status ||
                (drag.order.status === "RECEIVED" && drag.order.assignedTo == null && s.key === "CLAIMED" && canClaim) ||
                (s.key === "INBOX" && canReleaseOrder(drag.order))
              );
              // إحصائيات رأس العمود مشتقة حتمياً من بطاقات العمود نفسه (Single Source of Truth)
              // لتطابق العين الأرقام 100% وتفصل «طابور وارد» عن «مسحوب»، وتصمد أمام الفلاتر والتجميع.
              const colStats = colStatsMap[s.key] ?? { totalValue: "0", late: 0, blocked: 0 };
              const showValue = Number(colStats.totalValue) > 0;
              return (
                <div className="wob-col" style={colVars(s.hue)} key={s.key}>
                  <div className="wob-col-head">
                    <span className="wob-col-pip" />
                    <div className="wob-col-head-txt">
                      <div className="wob-col-title">{s.label}</div>
                      <div className="wob-col-hint">{s.hint}</div>
                      {showValue && (
                        <div className="wob-col-kpis">
                          <span
                            className="wob-col-kpi wob-col-kpi-value"
                            title="مجموع قيمة العمل الجاري في هذا العمود"
                            role="text"
                            aria-label={`مجموع قيمة العمل الجاري: ${toAccessibleMoney(colStats.totalValue)}`}
                          >
                            <bdi dir="ltr" aria-hidden="true">
                              {fmtAr(colStats.totalValue)}
                            </bdi>
                            <span aria-hidden="true" className="wob-curr">د.ع</span>
                          </span>
                          {colStats.late > 0 && s.status !== "DELIVERED" && (
                            <span
                              className="wob-col-kpi wob-col-kpi-late"
                              title="أوامرُ فات موعد استحقاقها"
                              role="text"
                              aria-label={`${colStats.late} طلبات متأخرة`}
                            >
                              <Timer aria-hidden className="size-3" /> <bdi dir="ltr">{fmtInt(colStats.late)}</bdi> متأخّر
                            </span>
                          )}
                          {colStats.blocked > 0 && s.status !== "DELIVERED" && (
                            <span
                              className="wob-col-kpi wob-col-kpi-blocked"
                              title="أوامرٌ أشار الفنّيّ إلى تعطّلها"
                              role="text"
                              aria-label={`${colStats.blocked} طلبات معطلة`}
                            >
                              <AlertTriangle aria-hidden className="size-3" /> <bdi dir="ltr">{fmtInt(colStats.blocked)}</bdi> معطَّل
                            </span>
                          )}
                        </div>
                      )}
                      {s.key === "READY" && canAutoClear && list.length > 0 && (
                        <div className="mt-1.5">
                          <button
                            type="button"
                            onClick={() => {
                              const labelWin = list.length === 1 && list[0]?.hasDelivery ? preopenShippingLabelWindow() : null;
                              reservePrintWindow();
                              autoClearSnapRef.current = { single: list.length === 1 ? list[0] : undefined, candidates: list, labelWin };
                              autoClearReady.mutate({ branchId: activeBranchId });
                            }}
                            disabled={autoClearReady.isPending}
                            className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-bold rounded-md bg-[var(--sem-pos)] text-background hover:bg-[var(--sem-pos-hover)] active:scale-95 transition-all shadow-xs cursor-pointer disabled:opacity-50"
                            title="تصريف تلقائي للمدفوع ومندوب التوصيل الفردي؛ الشركة تتطلب مسح البوليصة من شاشة التوصيل"
                          >
                            <Zap aria-hidden className="size-3" />
                            <span>تصريف تلقائي ({fmtInt(list.length)})</span>
                          </button>
                        </div>
                      )}
                    </div>
                    {/* عمود «مُسلَّم» يعرض نافذة الأحدث فقط — العدّاد من الخادم يحمل الإجمالي الحقيقي.
                        Codex #3 (الجولة ٣): يُستعمل عدّاد الخادم فقط حين لا فلترَ عميليّ (بما فيه
                        الفلاتر السريعة). عند تفعيل late/dueToday/blocked تصير قائمة المُسلَّم
                        فارغة (النهائيات مستبعدة في الـpredicate) لكنّ العدّاد كان يعرض «مُسلَّم 120»
                        فوق عمود بلا بطاقات ⇒ تناقض. الآن يستعمل نفس `anyClientFilter`. */}
                    <span className="wob-col-count">
                      {s.key === "DELIVERED" && serverCounts != null && !anyClientFilter
                        ? fmtInt(serverCounts.delivered)
                        : list.length}
                    </span>
                  </div>
                  <div className={`wob-col-body ${isOver ? "wob-drop-on" : ""}`} ref={(el) => { colRefs.current[s.key] = el; }}>
                    {list.map((o) => (
                      <WorkOrderKanbanCard
                        key={o.id}
                        o={o}
                        dragging={!!drag && drag.order.id === o.id}
                        // النقر يفتح Drawer دائماً؛ السحب يعمل في «حسب المرحلة» فقط (`dndEnabled` داخل onCardPointerDown).
                        onPointerDown={(e) => onCardPointerDown(e, o)}
                        // إسناد inline لعَمود INBOX فَقط (مَدير + بَيانات الفنّيين جاهزة) per README §5.2.
                        inboxAssign={
                          s.key === "INBOX" && canAssign && (assignableStaff.data?.length ?? 0) > 0
                            ? (orderId, staffId) => {
                                // بلا تأكيد — العَملية رَخيصة وعَكسية (يُمكن إعادة الإسناد بَعدها).
                                assign.mutate({ workOrderId: orderId, assignedTo: staffId });
                              }
                            : undefined
                        }
                        staff={s.key === "INBOX" && canAssign ? assignableStaff.data : undefined}
                        assignPending={assign.isPending}
                        onClaim={canClaim ? (orderId) => claim.mutate({ workOrderId: orderId }) : undefined}
                        onRelease={canReleaseOrder(o) ? (orderId) => release.mutate({ workOrderId: orderId }) : undefined}
                        claimPending={claim.isPending || release.isPending}
                        onAdvance={
                          (o.status === "RECEIVED" && canStart) ||
                          (o.status === "IN_PROGRESS" && canMarkReady) ||
                          (o.status === "READY" && canDeliver)
                            ? attemptMove
                            : undefined
                        }
                        advancePending={start.isPending || markReady.isPending || deliver.isPending}
                        onOpenCustomer={canReadCustomerContext ? setCustomerContextId : undefined}
                        // Codex #6: النقطة تفاعليّة لمن يستطيع الكتابة فقط؛ لغيرهم تُعرض قراءةً
                        // (عرضاً غير-NORMAL فقط — بلا زرّ يفشل بـFORBIDDEN).
                        onCycleKanban={canSetKanban ? ((orderId, current) => onCycleKanbanState(orderId, current)) : undefined}
                        kanbanBusy={setKanban.isPending}
                        onQuickDispatch={canAutoClear ? onQuickDispatch : undefined}
                        onQuickDeliver={canDeliver ? onQuickDeliver : undefined}
                        quickActionPending={autoClearReady.isPending || deliver.isPending}
                      />
                    ))}
                    {list.length === 0 && <div className="wob-col-empty">— لا أوامر —</div>}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      )}

      {drag && view === "board" && (
        <div style={{ position: "fixed", left: drag.x, top: drag.y, zIndex: 9999, pointerEvents: "none" }}>
          <WorkOrderKanbanCard o={drag.order} ghost />
        </div>
      )}

      {sel != null && (
        <WorkOrderPreviewDrawer
          id={sel}
          onClose={() => setSel(null)}
          isManager={isManager}
          canRequestControl={canRequestControl}
          canRequestCancel={canRequestCancel}
          canDeliver={canDeliver}
          busy={busy}
          onClaim={canClaim ? (id) => claim.mutate({ workOrderId: id }) : undefined}
          onRelease={canRelease ? (id) => release.mutate({ workOrderId: id }) : undefined}
          onAdvance={async (id, to) => {
            if (!canLifecycleOperation(me.data, to === "IN_PROGRESS" ? "workOrders.start" : to === "READY" ? "workOrders.markReady" : "workOrders.deliver", true)) return;
            if (to === "IN_PROGRESS") {
              if (!(await confirm({ variant: "warning", title: "بدء تنفيذ طلب الخدمة", description: "بدء التنفيذ يخصم المواد المطلوبة من المخزون تلقائياً. متابعة؟", confirmText: "بدء التنفيذ", cancelText: "تراجع" }))) return;
              optimisticMove(id, "IN_PROGRESS"); start.mutate({ workOrderId: id });
            }
            else if (to === "READY") {
              if (!(await confirm({ variant: "info", title: "وضع علامة: جاهز للتسليم", description: "وضع الأمر في حالة «جاهز للتسليم» وإبلاغ العميل. متابعة؟", confirmText: "جاهز للتسليم", cancelText: "تراجع" }))) return;
              optimisticMove(id, "READY"); markReady.mutate({ workOrderId: id });
            }
          }}
          onDeliver={(d) => setDeliverOrder({ id: d.id, orderNumber: d.orderNumber, title: d.title, salePrice: d.salePrice, deposit: d.deposit ?? "0" })}
          onCancel={onCancelOrder}
          onEdit={(id) => setEditTarget(id)}
          onAssign={async (id, staffId) => {
            if (!(await confirm({ variant: "info", title: "تغيير إسناد الأمر", description: staffId ? "إسناد هذا الأمر إلى الموظف المحدّد. متابعة؟" : "إلغاء إسناد هذا الأمر (سيصبح غير مُسنَد). متابعة؟", confirmText: "تأكيد الإسناد", cancelText: "تراجع" }))) return;
            assign.mutate({ workOrderId: id, assignedTo: staffId });
          }}
          onOpenCustomer={canReadCustomerContext ? setCustomerContextId : undefined}
        />
      )}

      <WorkOrderDeliverDialog
        order={deliverOrder}
        pending={deliver.isPending}
        onClose={() => setDeliverOrder(null)}
        onConfirm={async (payment, extra) => {
          if (!deliverOrder) return;
          if (!(await confirm({ variant: "danger", title: "تسليم الأمر وإصدار الفاتورة", description: `تسليم «${deliverOrder.title}» (${deliverOrder.orderNumber}) يُصدر فاتورة نهائية بمبلغ ${fmtAr(deliverOrder.salePrice)} د.ع ويحدّث المخزون والذمم — لا رجعة فيه. اكتب «تسليم» للتأكيد.`, confirmText: "تسليم وإصدار الفاتورة", cancelText: "تراجع", requireText: "تسليم" }))) return;
          deliverSnapRef.current = all.find((o) => o.id === deliverOrder.id) ?? deliverOrder;
          reservePrintWindow();
          deliver.mutate({
            workOrderId: deliverOrder.id,
            payment,
            addToCustomerDebt: extra?.addToCustomerDebt,
            managerApproval: extra?.managerApproval,
          });
        }}
      />
      <EditWorkOrderDialog
        workOrderId={editTarget}
        onClose={() => setEditTarget(null)}
        onSaved={() => { setEditTarget(null); invalidateAll(); }}
      />
      <WorkOrderBlockedReasonDialog
        target={blockTarget}
        pending={setKanban.isPending}
        onClose={() => setBlockTarget(null)}
        onConfirm={(reason) => {
          if (!blockTarget) return;
          setKanban.mutate({ workOrderId: blockTarget.id, kanbanState: "BLOCKED", blockedReason: reason });
        }}
      />
      {canReadCustomerContext && customerContextId != null && (
        <Contact360Panel
          kind="customer"
          id={customerContextId}
          onClose={() => setCustomerContextId(null)}
          onOpenContact={(kind, id) => { if (kind === "customer") setCustomerContextId(id); }}
        />
      )}
    </div>
  );
}
