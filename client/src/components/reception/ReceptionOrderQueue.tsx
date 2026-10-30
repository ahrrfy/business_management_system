import { lifecycleActionAllowed } from "@/lib/lifecycleActionPermission";
import { workOrderStatusBadgeCls, workOrderStatusLabel } from "@shared/workOrderStatus";
import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ClipboardCheck, Clock, Package, Store, Truck, type LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState, LoadingState } from "@/components/PageState";
import { RowActions, type RowAction } from "@/components/list";
import { canSeeGate, type RoleGate } from "@/lib/navVisibility";
import { DispatchDialog, type DispatchParty } from "@/components/delivery/DispatchDialog";
import { DeliveryDepartureOverlay, type DeliveryDepartureData } from "@/components/delivery/DeliveryDepartureOverlay";
import { MarkPickedUpDialog } from "@/components/delivery/MarkPickedUpDialog";
import { ManagerApprovalDialog } from "@/components/reception/ManagerApprovalDialog";
import { ReceptionCommandAlert } from "@/components/reception/ReceptionCommandAlert";
import { LiveCelebrationOverlay } from "@/components/commission/LiveCelebrationOverlay";
import { ReclassifyDeliveryDialog } from "@/components/workorder/ReclassifyDeliveryDialog";
import { printDeliverySlip, printReadyOrderLabel } from "@/lib/printing/deliveryDocs";
import { preopenShippingLabelWindow } from "@/lib/printing/shippingLabel";
import { preopenDocumentWindow, printReceipt } from "@/lib/printing/print";
import { invoiceToReceipt } from "@/lib/printing/invoiceReceipt";
import { printDeliveryFeeRefundReceipt, printInvoicePaymentReceipt } from "@/lib/printing/cashierLifecycleReceipts";
import { D, fmt, fmtInt, round2 } from "@/lib/money";
import { notify } from "@/lib/notify";
import { playReadyBeep } from "@/lib/notifyBeep";
import { trpc, type RouterInputs, type RouterOutputs } from "@/lib/trpc";
import { deriveWoDeliveryState, woDeliveryStateLabel, WO_DELIVERY_STATE_CLS } from "@shared/workOrderDeliveryState";
import { isPartialDispatchRejection } from "@shared/partialDispatch";
import { computeStateAgeMinutes, formatAgeShort, slaLevel, slaLevelChipClass } from "@shared/orderSla";
import { cn } from "@/lib/utils";
import { hasModuleAccess, moduleAccessAllowed, type PermissionMap, type RoleKey } from "@shared/permissions";
import { useRealtimeEvent } from "@/lib/realtime";
import {
  REALTIME_EVENT_TYPES,
  type ReceptionQueueUpdatedPayload,
  type WorkOrderStatusChangedPayload,
} from "@shared/realtimeEvents";

type QueueRow = RouterOutputs["workOrders"]["list"][number];
type PickupPayment = NonNullable<RouterInputs["workOrders"]["deliver"]["payment"]>;
type PartialPickup = { row: QueueRow; payment?: PickupPayment; message: string; clientRequestId: string };

interface ShelfAuditSelectionProps {
  selectedIds: Set<number>;
  onToggle: (id: number) => void;
}

const SHELF_AUDIT_CONFIRM_PHRASE = "جرد وتسليم";

type ShelfAuditCandidate = Pick<
  QueueRow,
  "status" | "hasDelivery" | "deposit" | "salePrice" | "consignmentStatus" | "parcelStatus"
> & {
  effectiveSalePrice?: string;
  effectiveDeposit?: string | null;
};

function effectiveRowSalePrice(r: { salePrice: string; effectiveSalePrice?: string }): string {
  return r.effectiveSalePrice ?? r.salePrice;
}

function effectiveRowDeposit(r: { deposit: string | null; effectiveDeposit?: string | null }): string | null {
  return r.effectiveDeposit !== undefined ? r.effectiveDeposit : r.deposit;
}

export function isShelfAuditEligible(r: ShelfAuditCandidate): boolean {
  if (r.status !== "READY" || r.hasDelivery) return false;
  if (deriveWoDeliveryState(r.consignmentStatus, r.parcelStatus) !== "NONE") return false;
  return D(effectiveRowDeposit(r) ?? "0").gte(D(effectiveRowSalePrice(r)));
}

// بوابات التوافق القديمة؛ السياسة المحفوظة تفحص مسار كل عملية مستقلاً:
//   workOrders.deliver / workOrders.setDeliveryMethod ⇐ workordersCashierProcedure (كاشير/مدير + وحدة workorders=FULL).
//   delivery.dispatch ⇐ بوابة الإسناد القديمة؛ قراءة الجهات تبقى متطلباً مستقلاً للحوار.
const FULFILL_GATE: RoleGate = { operations: ["workOrders.deliver"], roles: ["cashier", "manager"], module: "workorders", level: "FULL" };
const RECLASSIFY_GATE: RoleGate = { ...FULFILL_GATE, operations: ["workOrders.setDeliveryMethod"] };
const DISPATCH_GATE: RoleGate = { operations: ["delivery.dispatch"], roles: ["cashier", "manager"] };

// صافرة الجاهزيّة استُخرجت إلى @/lib/notifyBeep — تُستعمل هنا وفي DeliveryHub معاً (Slice A، ٢٩/٨/٢٦).

/**
 * اِستقبال (تكامل التوصيل، ٤/٨): طابور طلبات الاستقبال — ثلاثة أقسام (جاهزة/قيد التنفيذ/سُلِّمت اليوم)،
 * وكل صفٍّ يحمل إجراءات ديناميكية بحسب حالته وطريقة تسليمه: استلام مباشر، إسناد لمندوب، أو إعادة تصنيف الطريقة.
 */
export default function ReceptionOrderQueue({
  branchId,
  initialShelfAuditMode = false,
}: {
  branchId: number;
  initialShelfAuditMode?: boolean;
}) {
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const role = me.data?.role as RoleKey | undefined;
  const permissions = (me.data?.permissionsOverride ?? null) as PermissionMap | null;
  const legacyCanFulfill = !!role && moduleAccessAllowed(
    role,
    permissions,
    "workorders",
    "FULL",
    ["cashier", "manager"],
  );
  // نحفظ سلوك الحساب القديم. في السياسة المحفوظة لا يفتح تسليم الطلب صلاحية الإسناد.
  const legacyCanDispatch = legacyCanFulfill
    && canSeeGate(DISPATCH_GATE, role, permissions)
    && hasModuleAccess(role ?? "", permissions, "store", "READ");
  const canFulfill = lifecycleActionAllowed(me.data, "workOrders.deliver", legacyCanFulfill);
  const canReclassify = lifecycleActionAllowed(me.data, "workOrders.setDeliveryMethod", legacyCanFulfill);
  const canDispatch = lifecycleActionAllowed(me.data, "delivery.dispatch", legacyCanDispatch);
  const canReadParties = lifecycleActionAllowed(me.data, "delivery.listParties", legacyCanDispatch);
  const isShelfAuditManager =
    (role === "admin" || role === "manager") &&
    me.data?.operationPolicy?.grants?.["operation.workOrders.autoClearReady"] !== false;
  const todayStr = useMemo(() => new Date().toISOString().slice(0, 10), []);

  // تم استبدال الـpolling ببث الأحداث اللحظية عبر SSE (الموجة 2).
  const active = trpc.workOrders.list.useQuery(
    { branchId, branchQueue: true, statuses: ["RECEIVED", "IN_PROGRESS", "READY"], limit: 200 },
    { refetchOnWindowFocus: true },
  );
  // مُتَسلَّم اليوم بصرف النظر عن تاريخ إنشاء الأمر (قد يكون أمس) — deliveredFrom/deliveredTo
  // يفلتران على workOrders.deliveredAt، لا from/to (تاريخ الإنشاء، يُخفي أوامر أُنشئت أمس وسُلِّمت اليوم).
  const deliveredToday = trpc.workOrders.list.useQuery(
    { branchId, branchQueue: true, statuses: ["DELIVERED"], deliveredFrom: todayStr, deliveredTo: todayStr, limit: 100 },
    { refetchOnWindowFocus: true },
  );
  const parties = trpc.delivery.listParties.useQuery({ activeOnly: true }, { enabled: canDispatch && canReadParties });

  const [shelfAuditMode, setShelfAuditMode] = useState<boolean>(initialShelfAuditMode);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [shelfAuditDialogOpen, setShelfAuditDialogOpen] = useState(false);
  const [confirmationPhrase, setConfirmationPhrase] = useState("");

  useRealtimeEvent<ReceptionQueueUpdatedPayload>(
    REALTIME_EVENT_TYPES.RECEPTION_QUEUE_UPDATED,
    (ev) => {
      void active.refetch();
      if (ev.payload.status === "DELIVERED") {
        void deliveredToday.refetch();
      }
      if (ev.payload.readyForPickup || ev.payload.status === "READY") {
        playReadyBeep();
        notify.info(
          `طلب جاهز للتسليم: ${ev.payload.orderNumber ?? `#${ev.payload.orderId}`}`,
          ev.payload.customerName ? `العميل: ${ev.payload.customerName}` : undefined,
        );
      }
    },
  );

  useRealtimeEvent<WorkOrderStatusChangedPayload>(
    REALTIME_EVENT_TYPES.WORK_ORDER_STATUS_CHANGED,
    (ev) => {
      void active.refetch();
      if (ev.payload.newStatus === "DELIVERED") {
        void deliveredToday.refetch();
      }
      if (ev.payload.newStatus === "READY") {
        playReadyBeep();
        notify.info(
          `طلب جاهز للتسليم: ${ev.payload.orderNumber ?? `#${ev.payload.workOrderId}`}`,
        );
      }
    },
  );

  useRealtimeEvent(REALTIME_EVENT_TYPES.WORK_ORDER_CREATED, () => {
    void active.refetch();
  });

  // كشف READY الجدد بين استعلامَين متتاليَين — يُشعِر الموظّف بجاهزيّة أمر شغل خرج من المطبعة للتوّ.
  const knownReadyRef = useRef<Set<number>>(new Set());
  const firstLoadRef = useRef<boolean>(true);
  useEffect(() => {
    const rows = active.data;
    if (!rows) return;
    const currentReady = new Set<number>();
    for (const r of rows) {
      if (r.status === "READY") currentReady.add(Number(r.id));
    }
    if (firstLoadRef.current) {
      knownReadyRef.current = currentReady;
      firstLoadRef.current = false;
      return;
    }
    const freshIds: number[] = [];
    Array.from(currentReady).forEach((id) => {
      if (!knownReadyRef.current.has(id)) freshIds.push(id);
    });
    knownReadyRef.current = currentReady;
    if (freshIds.length > 0) {
      const freshRows = rows.filter((r) => freshIds.includes(Number(r.id)));
      const first = freshRows[0]!;
      const suffix = freshRows.length > 1 ? ` (و${freshRows.length - 1} طلب/طلبات أخرى)` : "";
      notify.info(
        `طلب جاهز للتسليم: ${first.orderNumber}${suffix}`,
        first.customerName ? `العميل: ${first.customerName}` : undefined,
      );
      playReadyBeep();
    }
  }, [active.data]);

  const [dispatchTarget, setDispatchTarget] = useState<QueueRow | null>(null);
  const [pickupTarget, setPickupTarget] = useState<QueueRow | null>(null);
  const pickupKeyRef = useRef<string | null>(null);
  function ensurePickupKey(): string {
    if (!pickupKeyRef.current) {
      pickupKeyRef.current =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `pickup-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }
    return pickupKeyRef.current;
  }
  const [partialPickup, setPartialPickup] = useState<PartialPickup | null>(null);
  const [reclassifyTarget, setReclassifyTarget] = useState<QueueRow | null>(null);
  const [reclassifyMgrAsk, setReclassifyMgrAsk] = useState<RouterInputs["workOrders"]["setDeliveryMethod"] | null>(null);
  const [departureData, setDepartureData] = useState<DeliveryDepartureData | null>(null);

  const invalidateAll = () => {
    void utils.workOrders?.list?.invalidate?.();
    void utils.workOrders?.counts?.invalidate?.();
  };

  const shelfAuditM = trpc.workOrders.autoClearReady.useMutation({
    onSuccess: (res) => {
      notify.ok(
        "تمت تصفية جرد الرفّ",
        `سُلِّم ووُثِّق ${fmtInt(res.deliveredCount)} من أصل ${fmtInt(res.evaluatedCount)} طلب بعد المراجعة الفردية.`,
      );
      setShelfAuditDialogOpen(false);
      setShelfAuditMode(false);
      setSelectedIds([]);
      setConfirmationPhrase("");
      void active.refetch();
      void deliveredToday.refetch();
      invalidateAll();
    },
    onError: (err) => {
      notify.err(err, "تعذّر إتمام تصفية جرد الرفّ");
    },
  });

  const dispatch = trpc.delivery.dispatch.useMutation({
    onSuccess: (r) => {
      notify.ok("أُرسل عبر المندوب", `إرسالية ${r.consignmentNumber} — COD ${fmt(r.codAmount)} د.ع`);
      setDispatchTarget(null);
      invalidateAll();
    },
    onError: (e) => notify.err(e),
  });
  const pickupPrintRef = useRef<{ win: Window | null; row: QueueRow; payment?: PickupPayment } | null>(null);
  const reclassifyPrintRef = useRef<{ win: Window | null; row: QueueRow } | null>(null);

  const deliver = trpc.workOrders.deliver.useMutation({
    onSuccess: (r) => {
      const snap = pickupPrintRef.current;
      pickupPrintRef.current = null;
      notify.ok("تم التسليم", `فاتورة ${r.invoiceNumber}`);
      if (snap) {
        void (async () => {
          const invId = Number((r as { invoiceId?: number } | null)?.invoiceId ?? 0);
          const fetchInv = (utils as { sales?: { get?: { fetch?: (arg: { invoiceId: number }) => Promise<unknown> } } }).sales?.get?.fetch;
          if (invId > 0 && fetchInv) {
            try {
              const inv = await fetchInv({ invoiceId: invId });
              if (inv) {
                await printReceipt(invoiceToReceipt(inv as never), snap.win ? { into: snap.win } : undefined);
                return;
              }
            } catch { /* fallback below */ }
          }
          const paidNow = snap.payment?.amount ?? "0.00";
          const rowSalePrice = effectiveRowSalePrice(snap.row);
          const rowDeposit = effectiveRowDeposit(snap.row) ?? "0";
          const remAfter = round2(D(rowSalePrice).minus(D(rowDeposit)).minus(D(paidNow)));
          await printInvoicePaymentReceipt(
            {
              invoiceNumber: r.invoiceNumber,
              customerName: snap.row.customerName,
              customerPhone: snap.row.customerPhone,
              invoiceTotal: rowSalePrice,
              paidBefore: rowDeposit,
              amountPaid: paidNow,
              remainingAfter: (remAfter.gt(0) ? remAfter : D(0)).toFixed(2),
              paymentMethod: snap.payment?.method ?? "CASH",
              reference: snap.payment?.reference ?? null,
              cashierName: me.data?.name ?? null,
            },
            snap.win ? { into: snap.win } : undefined,
          );
        })();
      }
      pickupKeyRef.current = null;
      setPickupTarget(null);
      setPartialPickup(null);
      invalidateAll();
    },
    onError: (e, vars) => {
      try { pickupPrintRef.current?.win?.close(); } catch { /* noop */ }
      pickupPrintRef.current = null;
      if (isPartialDispatchRejection(e) && pickupTarget) {
        setPartialPickup({ row: pickupTarget, payment: vars.payment, message: e.message, clientRequestId: vars.clientRequestId ?? ensurePickupKey() });
        return;
      }
      notify.err(e);
    },
  });
  const setDeliveryMethod = trpc.workOrders.setDeliveryMethod.useMutation({
    onSuccess: (r) => {
      const snap = reclassifyPrintRef.current;
      reclassifyPrintRef.current = null;
      notify.ok("حُدِّثت طريقة التسليم", Number(r.refundedFee) > 0 ? `رُدّت أمانة الأجرة ${fmt(r.refundedFee)} د.ع نقداً للزبون` : undefined);
      if (snap) {
        if (Number(r.refundedFee) > 0) {
          void printDeliveryFeeRefundReceipt(
            {
              sourceRef: snap.row.orderNumber,
              customerName: snap.row.customerName,
              customerPhone: snap.row.customerPhone,
              amount: String(r.refundedFee),
              paymentMethod: "CASH",
              cashierName: me.data?.name ?? null,
              reason: "تحويل طريقة التسليم إلى استلام مباشر من الفرع",
            },
            snap.win ? { into: snap.win } : undefined,
          );
        } else {
          try { snap.win?.close(); } catch { /* noop */ }
        }
      }
      setReclassifyTarget(null);
      setReclassifyMgrAsk(null);
      invalidateAll();
    },
    onError: (e, vars) => {
      try { reclassifyPrintRef.current?.win?.close(); } catch { /* noop */ }
      reclassifyPrintRef.current = null;
      // ردّ أمانةٍ نقديّة عبر ورديةٍ أخرى/بعد الإغلاق يلزمه مدير: نطلب اعتماده ونعيد المحاولة
      // بدل رسالة خطأ عابرة (نميّزه عن FORBIDDEN عزل الفرع بوسم الرسالة «اعتماد مدير»).
      const code = (e as { data?: { code?: string } }).data?.code;
      if (code === "FORBIDDEN" && /اعتماد مدير/.test(e.message)) {
        setReclassifyMgrAsk(vars);
        return;
      }
      notify.err(e);
    },
  });

  const rows = active.data ?? [];
  const readyRows = useMemo(() => rows.filter((r) => r.status === "READY"), [rows]);
  const inProgressRows = useMemo(() => rows.filter((r) => r.status !== "READY"), [rows]);
  const deliveredRows = deliveredToday.data ?? [];

  const eligibleShelfRows = useMemo(() => readyRows.filter(isShelfAuditEligible), [readyRows]);
  const eligibleIdSet = useMemo(() => new Set(eligibleShelfRows.map((r) => Number(r.id))), [eligibleShelfRows]);
  const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const selectedShelfRows = useMemo(
    () => eligibleShelfRows.filter((r) => selectedIdSet.has(Number(r.id))),
    [eligibleShelfRows, selectedIdSet],
  );

  useEffect(() => {
    setSelectedIds((prev) => {
      const next = prev.filter((id) => eligibleIdSet.has(id));
      return next.length === prev.length ? prev : next;
    });
    if (shelfAuditMode && !active.isLoading && eligibleShelfRows.length === 0) {
      setShelfAuditMode(false);
      setShelfAuditDialogOpen(false);
      setConfirmationPhrase("");
    }
  }, [eligibleIdSet, eligibleShelfRows.length, shelfAuditMode, active.isLoading]);

  const toggleShelfAuditId = (id: number) => {
    if (!eligibleIdSet.has(id)) return;
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  if (me.isLoading) return <LoadingState message="جارٍ التحقق من صلاحيات طابور الطلبات…" />;
  if (me.isError) {
    return <ErrorState message="تعذّر التحقق من صلاحيات طابور الطلبات." onRetry={() => { void me.refetch(); }} />;
  }
  if (active.isError) {
    return (
      <ErrorState
        message="تعذّر تحميل الطلبات النشطة. لا يمكن افتراض أن الطابور فارغ."
        onRetry={() => { void active.refetch(); }}
      />
    );
  }

  const shelfAuditActive = isShelfAuditManager && shelfAuditMode && eligibleShelfRows.length > 0;
  const phraseExactMatch = confirmationPhrase === SHELF_AUDIT_CONFIRM_PHRASE;

  return (
    <div className="mx-auto max-w-5xl space-y-4 pb-8">
      <LiveCelebrationOverlay branchId={branchId} />
      <ReceptionCommandAlert branchId={branchId} />

      <div className="mb-1 flex flex-col gap-3 rounded-xl border bg-card p-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="font-extrabold">طابور الطلبات والتوصيل</h1>
          <p className="text-xs text-muted-foreground">من الاستلام حتى التسليم — استلام مباشر أو إسناد لمندوب/شركة توصيل.</p>
        </div>
        {isShelfAuditManager && eligibleShelfRows.length > 0 && (
          <Button
            type="button"
            variant={shelfAuditActive ? "default" : "outline"}
            size="sm"
            aria-pressed={shelfAuditActive}
            onClick={() => {
              setShelfAuditMode((prev) => {
                const next = !prev;
                if (!next) {
                  setSelectedIds([]);
                  setShelfAuditDialogOpen(false);
                  setConfirmationPhrase("");
                }
                return next;
              });
            }}
            className="gap-2 text-xs font-bold shrink-0"
          >
            <ClipboardCheck aria-hidden className="size-3.5" />
            <span>جرد الرفّ ({fmtInt(eligibleShelfRows.length)})</span>
          </Button>
        )}
      </div>

      {shelfAuditActive && (
        <div className="flex flex-col gap-2 rounded-xl border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] p-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-0.5">
            <div className="text-xs font-extrabold text-[var(--sem-warn)]">
              وضع جرد الرفّ — المحدّد: {fmtInt(selectedIds.length)} من {fmtInt(eligibleShelfRows.length)} طلب مؤهل
            </div>
            <p className="text-[11px] text-muted-foreground">
              تحديد فردي يدوي بعد مراجعة الرفّ — لا يوجد تحديد للكل
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button
              type="button"
              size="sm"
              disabled={selectedIds.length === 0 || shelfAuditM.isPending}
              onClick={() => {
                setConfirmationPhrase("");
                setShelfAuditDialogOpen(true);
              }}
              className="text-xs font-bold"
            >
              تصفية المحدّد كجرد رفّ ({fmtInt(selectedIds.length)})
            </Button>
          </div>
        </div>
      )}

      {canDispatch && parties.isLoading && (
        <LoadingState message="جارٍ تحميل جهات التوصيل…" className="rounded-xl border p-4" />
      )}
      {canDispatch && parties.isError && (
        <ErrorState
          message="تعذّر تحميل جهات التوصيل؛ أُوقف الإسناد للمندوب حتى نجاح التحميل."
          onRetry={() => { void parties.refetch(); }}
          className="rounded-xl border p-4"
        />
      )}

      {active.isLoading ? (
        <LoadingState message="جارٍ تحميل الطلبات النشطة…" className="p-8" />
      ) : (
        <>
          <QueueSection
            title="جاهزة للتسليم/الإرسال"
            icon={Truck}
            rows={readyRows}
            emptyLabel="لا طلبات جاهزة حالياً."
            canFulfill={canFulfill}
            canReclassify={canReclassify}
            canDispatch={canDispatch}
            partiesReady={canReadParties && parties.isSuccess}
            onDispatch={setDispatchTarget}
            onPickup={setPickupTarget}
            onReclassify={setReclassifyTarget}
            shelfAudit={
              shelfAuditActive
                ? { selectedIds: selectedIdSet, onToggle: toggleShelfAuditId }
                : undefined
            }
          />
          <QueueSection
            title="قيد الاستلام/التنفيذ"
            icon={Package}
            rows={inProgressRows}
            emptyLabel="لا طلبات قيد التنفيذ حالياً."
            canFulfill={canFulfill}
            canReclassify={canReclassify}
            onReclassify={setReclassifyTarget}
          />
          <QueueSection
            title="سُلِّمت اليوم"
            icon={Check}
            rows={deliveredRows}
            emptyLabel="لا طلبات مُسلَّمة اليوم بعد."
            canFulfill={false}
            loading={deliveredToday.isLoading}
            error={deliveredToday.isError}
            onRetry={() => { void deliveredToday.refetch(); }}
          />
        </>
      )}

      <Dialog
        open={shelfAuditDialogOpen}
        onOpenChange={(open) => {
          if (!open && !shelfAuditM.isPending) {
            setShelfAuditDialogOpen(false);
            setConfirmationPhrase("");
          }
        }}
      >
        <DialogContent className="sm:max-w-lg" dir="rtl">
          <DialogHeader>
            <DialogTitle>تأكيد تصفية جرد الرفّ ({fmtInt(selectedShelfRows.length)} طلب)</DialogTitle>
            <DialogDescription>
              راجع الطلبات المختارة أدناه بعد التحقق الفعلي من عدم وجودها على رفّ الاستقبال. هذه العملية توثّق سجل تدقيق باسمك وتُغلق الطلبات المختارة المدفوعة مسبقاً.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-1">
            <ul className="max-h-48 divide-y overflow-y-auto rounded-lg border bg-muted/30 text-xs">
              {selectedShelfRows.map((ord) => (
                <li key={ord.id} className="flex items-center justify-between gap-2 px-3 py-2">
                  <div className="min-w-0">
                    <span className="font-extrabold" dir="ltr">#{ord.orderNumber}</span>
                    <span className="mx-1.5 text-muted-foreground">—</span>
                    <span className="font-semibold">{ord.title}</span>
                    <div className="text-[11px] text-muted-foreground">
                      {ord.customerName ?? "عميل نقدي"}
                    </div>
                  </div>
                  <span className="shrink-0 font-bold tabular-nums" dir="ltr">
                    {fmt(effectiveRowSalePrice(ord))} د.ع
                  </span>
                </li>
              ))}
            </ul>
            <div className="space-y-1.5">
              <Label htmlFor="shelf-audit-phrase" className="text-xs font-bold">
                اكتب عبارة التأكيد <span className="text-destructive">«{SHELF_AUDIT_CONFIRM_PHRASE}»</span> حرفياً للمتابعة:
              </Label>
              <Input
                id="shelf-audit-phrase"
                value={confirmationPhrase}
                onChange={(e) => setConfirmationPhrase(e.target.value)}
                placeholder={SHELF_AUDIT_CONFIRM_PHRASE}
                autoComplete="off"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={shelfAuditM.isPending}
              onClick={() => {
                setShelfAuditDialogOpen(false);
                setConfirmationPhrase("");
              }}
            >
              تراجع
            </Button>
            <Button
              type="button"
              disabled={!phraseExactMatch || selectedShelfRows.length === 0 || shelfAuditM.isPending}
              onClick={() => {
                if (!phraseExactMatch || selectedShelfRows.length === 0) return;
                shelfAuditM.mutate({
                  workOrderIds: selectedShelfRows.map((r) => Number(r.id)),
                  confirmationPhrase,
                  branchId,
                });
              }}
            >
              {shelfAuditM.isPending ? "جارٍ التصفية…" : "تأكيد جرد وتسليم"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <DispatchDialog
        order={dispatchTarget}
        parties={(parties.data ?? []) as DispatchParty[]}
        pending={dispatch.isPending}
        onClose={() => setDispatchTarget(null)}
        onConfirm={async ({ partyId, fee, recipientName, recipientPhone, deliveryAddress, notes, assignedUserId, externalTrackingRef, collectCreditOnDelivery }) => {
          if (!canDispatch || !canReadParties) return;
          const ord = dispatchTarget!;
          const party = (parties.data ?? []).find((p) => p.id === partyId);
          const labelWin = preopenShippingLabelWindow();
          const slipWin = preopenDocumentWindow();
          try {
            const r = await dispatch.mutateAsync({
              workOrderId: ord.id,
              partyId,
              deliveryFee: fee,
              recipientName: recipientName || undefined,
              recipientPhone: recipientPhone || undefined,
              deliveryAddress: deliveryAddress || ord.deliveryAddress || undefined,
              notes: notes || undefined,
              clientRequestId: crypto.randomUUID(),
              assignedUserId,
              externalTrackingRef,
              collectCreditOnDelivery,
            });
            void printReadyOrderLabel(ord, { partyName: party?.name ?? null, trackingNumber: r.consignmentNumber, cod: r.codAmount, externalTrackingRef, into: labelWin });
            if (slipWin) printDeliverySlip(ord, party, { ...r, externalTrackingRef }, { into: slipWin });
            else printDeliverySlip(ord, party, { ...r, externalTrackingRef });
            setDepartureData({
              consignmentNumber: r.consignmentNumber,
              orderNumber: ord.orderNumber,
              title: ord.title,
              customerName: recipientName || ord.customerName,
              customerPhone: recipientPhone || ord.deliveryPhone || ord.customerPhone,
              deliveryAddress: deliveryAddress || ord.deliveryAddress,
              courierName: party?.name ?? "المندوب",
              courierPhone: party?.phone,
              codAmount: r.codAmount,
              deliveryFee: fee,
              feeCollection: ord.deliveryFeeCollection ?? "COURIER",
            });
          } catch {
            labelWin?.close();
            slipWin?.close();
          }
        }}
      />

      <DeliveryDepartureOverlay
        open={!!departureData}
        onClose={() => setDepartureData(null)}
        data={departureData}
      />

      <MarkPickedUpDialog
        order={pickupTarget ? { ...pickupTarget, salePrice: effectiveRowSalePrice(pickupTarget), deposit: effectiveRowDeposit(pickupTarget) } : null}
        pending={deliver.isPending}
        onClose={() => {
          pickupKeyRef.current = null;
          setPickupTarget(null);
        }}
        onConfirm={(payment, extra) => {
          if (!canFulfill) return;
          const ord = pickupTarget!;
          pickupPrintRef.current = { win: preopenDocumentWindow(), row: ord, payment };
          deliver.mutate({
            workOrderId: ord.id,
            payment,
            addToCustomerDebt: extra?.addToCustomerDebt,
            managerApproval: extra?.managerApproval,
            clientRequestId: ensurePickupKey(),
            partialDispatchConfirmed: false,
          });
        }}
      />
      <PartialPickupConfirmDialog
        state={partialPickup}
        pending={deliver.isPending}
        onClose={() => { setPartialPickup(null); setPickupTarget(null); }}
        onConfirm={() => {
          if (!partialPickup || !canFulfill) return;
          pickupPrintRef.current = { win: preopenDocumentWindow(), row: partialPickup.row, payment: partialPickup.payment };
          deliver.mutate({
            workOrderId: partialPickup.row.id,
            payment: partialPickup.payment,
            clientRequestId: partialPickup.clientRequestId,
            partialDispatchConfirmed: true,
          });
        }}
      />

      <ReclassifyDeliveryDialog
        order={reclassifyTarget}
        pending={setDeliveryMethod.isPending}
        onClose={() => setReclassifyTarget(null)}
        onConfirm={(payload) => {
          if (!canReclassify) return;
          const ord = reclassifyTarget!;
          if (!payload.hasDelivery) {
            reclassifyPrintRef.current = { win: preopenDocumentWindow(), row: ord };
          }
          setDeliveryMethod.mutate({ workOrderId: ord.id, ...payload });
        }}
      />

      {reclassifyMgrAsk && (
        <ManagerApprovalDialog
          title="اعتماد مدير — ردّ أمانة أجرة التوصيل"
          description="ردّ أمانة الأجرة النقديّة عبر ورديةٍ أخرى أو بعد إغلاق وردية القبض يحتاج مديراً (تُفحص بياناته على الخادم وتُسجَّل باسمه)."
          onCancel={() => setReclassifyMgrAsk(null)}
          onApprove={(approval) => {
            if (!canReclassify) return;
            const vars = reclassifyMgrAsk;
            if (!vars.hasDelivery) {
              const targetRow = rows.find((x) => Number(x.id) === Number(vars.workOrderId));
              if (targetRow) reclassifyPrintRef.current = { win: preopenDocumentWindow(), row: targetRow };
            }
            setReclassifyMgrAsk(null);
            setDeliveryMethod.mutate({ ...vars, managerApproval: approval });
          }}
        />
      )}
    </div>
  );
}

// ───────────────────────── قسم القائمة ─────────────────────────
function QueueSection({ title, icon: Icon, rows, emptyLabel, canFulfill, canReclassify = false, canDispatch = false, partiesReady = true, loading = false, error = false, onRetry, onDispatch, onPickup, onReclassify, shelfAudit }: {
  title: string;
  icon: LucideIcon;
  rows: QueueRow[];
  emptyLabel: string;
  canFulfill: boolean;
  canReclassify?: boolean;
  canDispatch?: boolean;
  partiesReady?: boolean;
  loading?: boolean;
  error?: boolean;
  onRetry?: () => void;
  onDispatch?: (r: QueueRow) => void;
  onPickup?: (r: QueueRow) => void;
  onReclassify?: (r: QueueRow) => void;
  shelfAudit?: ShelfAuditSelectionProps;
}) {
  const groups = groupQueueRows(rows);
  return (
    <section className="rounded-xl border bg-card">
      <div className="flex items-center gap-2 border-b px-3 py-1.5">
        <Icon aria-hidden className="size-3.5 text-muted-foreground" />
        <h2 className="text-xs font-bold">{title}</h2>
        <Badge variant="secondary" className="ms-1">{loading || error ? "—" : rows.length}</Badge>
      </div>
      {loading ? (
        <LoadingState message={`جارٍ تحميل ${title}…`} className="p-4" />
      ) : error ? (
        <ErrorState message={`تعذّر تحميل ${title}. لا يمكن افتراض عدم وجود طلبات.`} onRetry={onRetry} className="p-4" />
      ) : rows.length === 0 ? (
        <EmptyState icon={Icon} title="لا شيء هنا" description={emptyLabel} />
      ) : (
        <ul className="divide-y">
          {groups.map((group) => group.draftId == null ? (
            <QueueRowItem key={group.rows[0]!.id} row={group.rows[0]!} canFulfill={canFulfill} canReclassify={canReclassify} canDispatch={canDispatch} partiesReady={partiesReady} onDispatch={onDispatch} onPickup={onPickup} onReclassify={onReclassify} shelfAudit={shelfAudit} />
          ) : (
            <li key={`draft-${group.draftId}`}>
              <div className="flex flex-wrap items-center gap-2 bg-muted/30 px-3 py-1.5 text-xs">
                <span className="font-bold">طلب {group.draftNumber ?? `#${group.draftId}`}</span>
                <span className={cn("rounded px-1.5 py-0.5 font-bold", group.readyCount === group.totalCount ? "bg-[var(--sem-pos-bg)] text-[var(--sem-pos)]" : "bg-[var(--sem-warn-bg)] text-[var(--sem-warn)]")}>
                  {group.readyCount}/{group.totalCount} جاهزة
                </span>
                {group.readyCount < group.totalCount && <span className="text-muted-foreground">لا يُسلَّم الجزء الجاهز إلا بإقرار صريح</span>}
              </div>
              <ul className="divide-y">
                {group.rows.map((r: QueueRow) => <QueueRowItem key={r.id} row={r} canFulfill={canFulfill} canReclassify={canReclassify} canDispatch={canDispatch} partiesReady={partiesReady} onDispatch={onDispatch} onPickup={onPickup} onReclassify={onReclassify} shelfAudit={shelfAudit} />)}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function groupQueueRows(rows: QueueRow[]) {
  const groups = new Map<string, { draftId: number | null; draftNumber: string | null; totalCount: number; readyCount: number; rows: QueueRow[] }>();
  for (const row of rows) {
    const draftId = row.draftId == null ? null : Number(row.draftId);
    const key = draftId == null ? `single-${row.id}` : `draft-${draftId}`;
    const group = groups.get(key) ?? {
      draftId,
      draftNumber: row.draftNumber ?? null,
      totalCount: draftId == null ? 1 : Math.max(1, Number(row.draftTotalCount ?? 1)),
      readyCount: draftId == null ? (row.status === "READY" || row.status === "DELIVERED" ? 1 : 0) : Number(row.draftReadyCount ?? 0),
      rows: [],
    };
    group.rows.push(row);
    groups.set(key, group);
  }
  return Array.from(groups.values());
}

function QueueRowItem({ row: r, canFulfill, canReclassify, canDispatch, partiesReady, onDispatch, onPickup, onReclassify, shelfAudit }: {
  row: QueueRow;
  canFulfill: boolean;
  canReclassify: boolean;
  canDispatch: boolean;
  partiesReady: boolean;
  onDispatch?: (r: QueueRow) => void;
  onPickup?: (r: QueueRow) => void;
  onReclassify?: (r: QueueRow) => void;
  shelfAudit?: ShelfAuditSelectionProps;
}) {
  const isReady = r.status === "READY";
  const isFinal = r.status === "DELIVERED" || r.status === "CANCELLED";
  const ageMin = computeStateAgeMinutes(r as never);
  const ageLevel = slaLevel(r.status, ageMin);
  const deliveryState = deriveWoDeliveryState(r.consignmentStatus, r.parcelStatus);
  const hasLiveConsignment = deliveryState !== "NONE";
  const canCheckForShelfAudit = !!shelfAudit && isShelfAuditEligible(r);
  const actions: RowAction[] = [];
  if (isReady && r.hasDelivery && !hasLiveConsignment && onDispatch) {
    actions.push({
      key: "dispatch",
      kind: "approve",
      label: "إسناد لمندوب",
      icon: Truck,
      hidden: !canDispatch,
      disabled: !partiesReady,
      disabledReason: "يلزم تفويض عرض جهات التوصيل واكتمال تحميلها قبل الإسناد",
      onSelect: () => onDispatch(r),
      gate: DISPATCH_GATE,
    });
  }
  if (isReady && !r.hasDelivery && onPickup) {
    actions.push({ key: "pickup", kind: "approve", label: "تسليم مباشر", icon: Store, hidden: !canFulfill, onSelect: () => onPickup(r), gate: FULFILL_GATE });
  }
  if (!isFinal && onReclassify) {
    actions.push({ key: "reclassify", kind: "edit", label: "تغيير الطريقة", hidden: !canReclassify, onSelect: () => onReclassify(r), gate: RECLASSIFY_GATE });
  }
  actions.push({ key: "open", kind: "view", label: "فتح", onSelect: () => window.open(`/work-orders/${r.id}`, "_blank", "noopener") });

  return (
    <li className="flex flex-wrap items-center gap-2.5 px-3 py-2">
      {canCheckForShelfAudit && (
        <input
          type="checkbox"
          className="size-4 shrink-0 cursor-pointer accent-primary"
          checked={shelfAudit.selectedIds.has(Number(r.id))}
          onChange={() => shelfAudit.onToggle(Number(r.id))}
          aria-label={`تحديد الطلب ${r.orderNumber} (${r.title}) ضمن جرد الرفّ`}
        />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className={cn("rounded px-1.5 py-0.5 text-[11px] font-bold", workOrderStatusBadgeCls(r.status))}>{workOrderStatusLabel(r.status)}</span>
          {ageLevel !== "UNKNOWN" && ageMin != null && (
            <span
              className={cn("inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-bold", slaLevelChipClass(ageLevel))}
              title={ageLevel === "BREACHED" ? "تجاوز عتبة الـSLA — يحتاج تحرّكاً فورياً" : ageLevel === "WARNING" ? "اقترب من عتبة الـSLA" : "ضمن الوقت المتوقّع"}
            >
              <Clock aria-hidden className="size-3" />
              {formatAgeShort(ageMin)}
            </span>
          )}
          {r.hasDelivery ? (
            <span className="inline-flex items-center gap-1 rounded bg-[var(--sem-info-bg)] px-1.5 py-0.5 text-[11px] font-bold text-[var(--sem-info)]">
              <Truck aria-hidden className="size-3" /> توصيل
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[11px] font-bold text-muted-foreground">
              <Store aria-hidden className="size-3" /> استلام مباشر
            </span>
          )}
          {hasLiveConsignment ? (
            <a
              href="/delivery?tab=transit"
              className={cn("rounded border px-1.5 py-0.5 text-[11px] font-extrabold", WO_DELIVERY_STATE_CLS[deliveryState])}
              title="افتح تبويب «قيد التوصيل» لمتابعة الطرد"
            >
              {woDeliveryStateLabel(deliveryState)}{r.deliveryPartyName ? ` · ${r.deliveryPartyName}` : ""}
            </a>
          ) : r.consignmentNumber ? (
            <span className="text-[11px] text-muted-foreground">
              {r.deliveryPartyName ? `${r.deliveryPartyName} — ` : ""}
              {r.consignmentStatus === "DELIVERED" ? "سُلِّمت" : r.consignmentStatus === "RETURNED" ? "أُرجعت" : "أُلغي الإسناد"}
            </span>
          ) : null}
          <span className="font-bold text-xs">{r.orderNumber}</span>
        </div>
        <p className="mt-0.5 truncate text-xs font-medium">{r.title}</p>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          {r.customerName ?? "عميل نقدي"}
          {r.customerPhone ? ` · ${r.customerPhone}` : ""}
          {r.hasDelivery && r.deliveryAddress ? ` · ${r.deliveryAddress}` : ""}
        </p>
      </div>
      <div className="text-left shrink-0 text-xs" dir="ltr">
        <div className="text-sm font-bold tabular-nums">{fmt(effectiveRowSalePrice(r))} د.ع</div>
        {D(effectiveRowDeposit(r) ?? "0").gt(0) && (() => {
          const rem = round2(D(effectiveRowSalePrice(r)).minus(D(effectiveRowDeposit(r) ?? "0")));
          return (
            <div className="mt-0.5 space-y-0.5 text-[10px] font-semibold">
              <div className="text-money-positive">عربون: {fmt(effectiveRowDeposit(r) ?? "0")}</div>
              <div className="text-[var(--sem-warn)]">
                متبقّي: {fmt((rem.gt(0) ? rem : D(0)).toFixed(2))}
              </div>
            </div>
          );
        })()}
      </div>
      <RowActions actions={actions} />
    </li>
  );
}

function PartialPickupConfirmDialog({ state, pending, onClose, onConfirm }: { state: PartialPickup | null; pending: boolean; onClose: () => void; onConfirm: () => void }) {
  if (!state) return null;
  return (
    <div className="fixed inset-0 z-[110] grid place-items-center bg-black/70 p-4" dir="rtl" role="dialog" aria-modal="true" aria-label="إقرار التسليم الجزئي">
      <div className="w-full max-w-lg rounded-2xl bg-card p-6 shadow-2xl">
        <h3 className="mb-2 text-lg font-extrabold">تأكيد تسليم جزء من الطلب</h3>
        <p className="rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] p-3 text-sm text-[var(--sem-warn)]">{state.message}</p>
        <p className="mt-3 text-xs text-muted-foreground">سيُسجّل هذا الإقرار باسم المستخدم الحالي، ويبقى باقي الطلب في الطابور حتى يجهز.</p>
        <div className="mt-5 flex gap-2">
          <Button variant="outline" className="flex-1" disabled={pending} onClick={onClose}>تراجع</Button>
          <Button variant="destructive" className="flex-1" disabled={pending} onClick={onConfirm}>{pending ? "جارٍ…" : "أقرّ التسليم الجزئي"}</Button>
        </div>
      </div>
    </div>
  );
}
