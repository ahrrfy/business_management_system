import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Check, Package, Store, Truck, type LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/PageState";
import { RowActions, type RowAction } from "@/components/list";
import type { RoleGate } from "@/lib/navVisibility";
import { IntlPhoneInput } from "@/components/form/IntlPhoneInput";
import { MoneyInput } from "@/components/form/MoneyInput";
import { DispatchDialog, type DispatchParty } from "@/components/delivery/DispatchDialog";
import { MarkPickedUpDialog } from "@/components/delivery/MarkPickedUpDialog";
import { ManagerApprovalDialog } from "@/components/reception/ManagerApprovalDialog";
import { printDeliverySlip, printReadyOrderLabel } from "@/lib/printing/deliveryDocs";
import { preopenShippingLabelWindow } from "@/lib/printing/shippingLabel";
import { D, fmt, round2 } from "@/lib/money";
import { notify } from "@/lib/notify";
import { trpc, type RouterInputs, type RouterOutputs } from "@/lib/trpc";
import { deriveWoDeliveryState, woDeliveryStateLabel, WO_DELIVERY_STATE_CLS } from "@shared/workOrderDeliveryState";
import { cn } from "@/lib/utils";

type QueueRow = RouterOutputs["workOrders"]["list"][number];

const STATUS_LABEL: Record<string, string> = {
  RECEIVED: "مُستلَم",
  IN_PROGRESS: "قيد التنفيذ",
  READY: "جاهز",
  DELIVERED: "مُسلَّم",
  CANCELLED: "ملغى",
};
const STATUS_CLS: Record<string, string> = {
  RECEIVED: "bg-muted text-foreground/70",
  IN_PROGRESS: "bg-[var(--sem-info-bg)] text-[var(--sem-info)]",
  READY: "bg-amber-100 text-amber-700",
  DELIVERED: "bg-emerald-100 text-emerald-700",
  CANCELLED: "bg-rose-100 text-rose-700",
};
// مرآة بوّابتي الخادم بالضبط (لا مفتاح وحدة صلاحيات منفصل لـ"delivery" — راجع server/trpc.ts):
//   workOrders.deliver / workOrders.setDeliveryMethod ⇐ workordersCashierProcedure (كاشير/مدير + وحدة workorders=FULL).
//   delivery.dispatch ⇐ cashierProcedure الخام (كاشير/مدير بلا مفتاح وحدة).
const FULFILL_GATE: RoleGate = { roles: ["cashier", "manager"], module: "workorders", level: "FULL" };
const DISPATCH_GATE: RoleGate = { roles: ["cashier", "manager"] };

/**
 * اِستقبال (تكامل التوصيل، ٤/٨): طابور طلبات الاستقبال — الفجوة التي أبلغ عنها المالك («بعد إكمال
 * الطلب كيف نحوّله للتوصيل؟ لا يظهر جدول طلبات ولا إسناد لمندوب»). ثلاثة أقسام (جاهزة/قيد التنفيذ/
 * سُلِّمت اليوم)، وكل صفٍّ يحمل إجراءات ديناميكية بحسب حالته وطريقة تسليمه: استلام مباشر، إسناد
 * لمندوب، أو إعادة تصنيف الطريقة (السيناريو الثالث: زبونٌ غيّر رأيه بين الاستلام والتوصيل).
 */
export default function ReceptionOrderQueue({ branchId }: { branchId: number }) {
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const role = me.data?.role ?? "";
  const canFulfill = role === "admin" || role === "cashier" || role === "manager";
  const todayStr = useMemo(() => new Date().toISOString().slice(0, 10), []);

  const active = trpc.workOrders.list.useQuery({ branchId, statuses: ["RECEIVED", "IN_PROGRESS", "READY"], limit: 200 });
  // مُتَسلَّم اليوم بصرف النظر عن تاريخ إنشاء الأمر (قد يكون أمس) — deliveredFrom/deliveredTo
  // يفلتران على workOrders.deliveredAt، لا from/to (تاريخ الإنشاء، يُخفي أوامر أُنشئت أمس وسُلِّمت اليوم).
  const deliveredToday = trpc.workOrders.list.useQuery({ branchId, statuses: ["DELIVERED"], deliveredFrom: todayStr, deliveredTo: todayStr, limit: 100 });
  const parties = trpc.delivery.listParties.useQuery({ activeOnly: true }, { enabled: canFulfill });

  const [dispatchTarget, setDispatchTarget] = useState<QueueRow | null>(null);
  const [pickupTarget, setPickupTarget] = useState<QueueRow | null>(null);
  const [reclassifyTarget, setReclassifyTarget] = useState<QueueRow | null>(null);
  // ردّ أمانة أجرة توصيلٍ عبر ورديةٍ غير وردية القبض ⇒ الخادم يرفض (FORBIDDEN «اعتماد مدير»):
  // نلتقط بيانات المحاولة ونطلب اعتماد مدير ثم نعيدها معه (نمط DraftPaymentsDialog حرفياً).
  const [reclassifyMgrAsk, setReclassifyMgrAsk] = useState<RouterInputs["workOrders"]["setDeliveryMethod"] | null>(null);

  const invalidateAll = () => {
    void utils.workOrders.list.invalidate();
    void utils.workOrders.counts.invalidate();
  };

  const dispatch = trpc.delivery.dispatch.useMutation({
    onSuccess: (r) => {
      notify.ok("أُرسل عبر المندوب", `إرسالية ${r.consignmentNumber} — COD ${fmt(r.codAmount)} د.ع`);
      setDispatchTarget(null);
      invalidateAll();
    },
    onError: (e) => notify.err(e),
  });
  const deliver = trpc.workOrders.deliver.useMutation({
    onSuccess: (r) => {
      notify.ok("تم التسليم", `فاتورة ${r.invoiceNumber}`);
      setPickupTarget(null);
      invalidateAll();
    },
    onError: (e) => notify.err(e),
  });
  const setDeliveryMethod = trpc.workOrders.setDeliveryMethod.useMutation({
    onSuccess: (r) => {
      notify.ok("حُدِّثت طريقة التسليم", Number(r.refundedFee) > 0 ? `رُدّت أمانة الأجرة ${fmt(r.refundedFee)} د.ع نقداً للزبون` : undefined);
      setReclassifyTarget(null);
      setReclassifyMgrAsk(null);
      invalidateAll();
    },
    onError: (e, vars) => {
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

  if (active.isError) return <ErrorState onRetry={() => active.refetch()} />;

  const rows = active.data ?? [];
  const readyRows = rows.filter((r) => r.status === "READY");
  const inProgressRows = rows.filter((r) => r.status !== "READY");
  const deliveredRows = deliveredToday.data ?? [];

  return (
    <div className="mx-auto max-w-5xl space-y-4 pb-8">
      <div className="mb-1 rounded-xl border bg-card p-3">
        <h1 className="font-extrabold">طابور الطلبات والتوصيل</h1>
        <p className="text-xs text-muted-foreground">من الاستلام حتى التسليم — استلام مباشر أو إسناد لمندوب/شركة توصيل.</p>
      </div>

      {active.isLoading ? (
        <div className="p-8 text-center text-muted-foreground">جارٍ التحميل…</div>
      ) : (
        <>
          <QueueSection
            title="جاهزة للتسليم/الإرسال"
            icon={Truck}
            rows={readyRows}
            emptyLabel="لا طلبات جاهزة حالياً."
            canFulfill={canFulfill}
            onDispatch={setDispatchTarget}
            onPickup={setPickupTarget}
            onReclassify={setReclassifyTarget}
          />
          <QueueSection
            title="قيد الاستلام/التنفيذ"
            icon={Package}
            rows={inProgressRows}
            emptyLabel="لا طلبات قيد التنفيذ حالياً."
            canFulfill={canFulfill}
            onReclassify={setReclassifyTarget}
          />
          {/* ش١ (٥/٨): طابور الفواتير صار **ورشةً مستقلّة** بتبويبها الخاص في المحطة (فلاتر
              وترقيم وتسديد وإعادة طباعة) — لم يعد مضمَّناً هنا؛ هذا التبويب للطلبات (أوامر الشغل). */}
          <QueueSection
            title="سُلِّمت اليوم"
            icon={Check}
            rows={deliveredRows}
            emptyLabel="لا طلبات مُسلَّمة اليوم بعد."
            canFulfill={false}
          />
        </>
      )}

      <DispatchDialog
        order={dispatchTarget}
        parties={(parties.data ?? []) as DispatchParty[]}
        pending={dispatch.isPending}
        onClose={() => setDispatchTarget(null)}
        onConfirm={async ({ partyId, fee, recipientName, recipientPhone, assignedUserId }) => {
          const ord = dispatchTarget!;
          const party = (parties.data ?? []).find((p) => p.id === partyId);
          // نافذة الملصق تُفتح متزامنةً مع نقرة التأكيد (قبل await الإرسال) — نمط DeliveryHub بالضبط.
          const labelWin = preopenShippingLabelWindow();
          try {
            const r = await dispatch.mutateAsync({
              workOrderId: ord.id,
              partyId,
              deliveryFee: fee,
              recipientName: recipientName || undefined,
              recipientPhone: recipientPhone || undefined,
              deliveryAddress: ord.deliveryAddress ?? undefined,
              clientRequestId: crypto.randomUUID(),
              assignedUserId,
            });
            void printReadyOrderLabel(ord, { partyName: party?.name ?? null, trackingNumber: r.consignmentNumber, cod: r.codAmount, into: labelWin });
            printDeliverySlip(ord, party, r);
          } catch {
            labelWin?.close();
          }
        }}
      />

      <MarkPickedUpDialog
        order={pickupTarget}
        pending={deliver.isPending}
        onClose={() => setPickupTarget(null)}
        onConfirm={(payment) => {
          const ord = pickupTarget!;
          deliver.mutate({ workOrderId: ord.id, payment, clientRequestId: crypto.randomUUID() });
        }}
      />

      <ReclassifyDialog
        order={reclassifyTarget}
        pending={setDeliveryMethod.isPending}
        onClose={() => setReclassifyTarget(null)}
        onConfirm={(payload) => {
          const ord = reclassifyTarget!;
          setDeliveryMethod.mutate({ workOrderId: ord.id, ...payload });
        }}
      />

      {reclassifyMgrAsk && (
        <ManagerApprovalDialog
          title="اعتماد مدير — ردّ أمانة أجرة التوصيل"
          description="ردّ أمانة الأجرة النقديّة عبر ورديةٍ أخرى أو بعد إغلاق وردية القبض يحتاج مديراً (تُفحص بياناته على الخادم وتُسجَّل باسمه)."
          onCancel={() => setReclassifyMgrAsk(null)}
          onApprove={(email, password) => {
            const vars = reclassifyMgrAsk;
            setReclassifyMgrAsk(null);
            setDeliveryMethod.mutate({ ...vars, managerApproval: { email, password } });
          }}
        />
      )}
    </div>
  );
}

// ───────────────────────── قسم القائمة ─────────────────────────
function QueueSection({ title, icon: Icon, rows, emptyLabel, canFulfill, onDispatch, onPickup, onReclassify }: {
  title: string;
  icon: LucideIcon;
  rows: QueueRow[];
  emptyLabel: string;
  canFulfill: boolean;
  onDispatch?: (r: QueueRow) => void;
  onPickup?: (r: QueueRow) => void;
  onReclassify?: (r: QueueRow) => void;
}) {
  return (
    <section className="rounded-xl border bg-card">
      <div className="flex items-center gap-2 border-b px-4 py-2.5">
        <Icon aria-hidden className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-bold">{title}</h2>
        <Badge variant="secondary" className="ms-1">{rows.length}</Badge>
      </div>
      {rows.length === 0 ? (
        <EmptyState icon={Icon} title="لا شيء هنا" description={emptyLabel} />
      ) : (
        <ul className="divide-y">
          {rows.map((r) => (
            <QueueRowItem key={r.id} row={r} canFulfill={canFulfill} onDispatch={onDispatch} onPickup={onPickup} onReclassify={onReclassify} />
          ))}
        </ul>
      )}
    </section>
  );
}

function QueueRowItem({ row: r, canFulfill, onDispatch, onPickup, onReclassify }: {
  row: QueueRow;
  canFulfill: boolean;
  onDispatch?: (r: QueueRow) => void;
  onPickup?: (r: QueueRow) => void;
  onReclassify?: (r: QueueRow) => void;
}) {
  const isReady = r.status === "READY";
  const isFinal = r.status === "DELIVERED" || r.status === "CANCELLED";
  // ١٨/٨: حالة التوصيل المشتقّة — مصدرها المشترك، فلا تُعاد تسميتها هنا.
  const deliveryState = deriveWoDeliveryState(r.consignmentStatus, r.parcelStatus);
  const hasLiveConsignment = deliveryState !== "NONE";
  const actions: RowAction[] = [];
  // زرّ الإسناد كان يظهر لأيّ READY+توصيل **بلا فحص إرسالية قائمة** ⇒ النقر على طلبٍ مُسنَد
  // أصلاً يصطدم بقيدٍ فريد برسالةٍ غامضة. الآن تحلّ محلّه شارةُ حالته (أدناه).
  if (isReady && r.hasDelivery && !hasLiveConsignment && onDispatch) {
    actions.push({ key: "dispatch", kind: "approve", label: "إسناد لمندوب", icon: Truck, hidden: !canFulfill, onSelect: () => onDispatch(r), gate: DISPATCH_GATE });
  }
  if (isReady && !r.hasDelivery && onPickup) {
    actions.push({ key: "pickup", kind: "approve", label: "تسليم مباشر", icon: Store, hidden: !canFulfill, onSelect: () => onPickup(r), gate: FULFILL_GATE });
  }
  if (!isFinal && onReclassify) {
    actions.push({ key: "reclassify", kind: "edit", label: "تغيير الطريقة", hidden: !canFulfill, onSelect: () => onReclassify(r), gate: FULFILL_GATE });
  }
  actions.push({ key: "open", kind: "view", label: "فتح", onSelect: () => window.open(`/work-orders/${r.id}`, "_blank", "noopener") });

  return (
    <li className="flex flex-wrap items-center gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className={cn("rounded px-1.5 py-0.5 text-[11px] font-bold", STATUS_CLS[r.status] ?? "bg-muted")}>{STATUS_LABEL[r.status] ?? r.status}</span>
          {r.hasDelivery ? (
            <span className="inline-flex items-center gap-1 rounded bg-[var(--sem-info-bg)] px-1.5 py-0.5 text-[11px] font-bold text-[var(--sem-info)]">
              <Truck aria-hidden className="size-3" /> توصيل
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[11px] font-bold text-muted-foreground">
              <Store aria-hidden className="size-3" /> استلام مباشر
            </span>
          )}
          {/* حالة الطرد صراحةً بدل «قيد التوصيل» العامّة: «مُسنَد لم يخرج» ≠ «بالطريق» ≠ «تعذّر». */}
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
          <span className="font-bold">{r.orderNumber}</span>
        </div>
        <p className="mt-0.5 truncate text-sm">{r.title}</p>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          {r.customerName ?? "عميل نقدي"}
          {r.customerPhone ? ` · ${r.customerPhone}` : ""}
          {r.hasDelivery && r.deliveryAddress ? ` · ${r.deliveryAddress}` : ""}
        </p>
      </div>
      {/* إصلاح (٧/٨، طلب مالك): العربون المقبوض عند إنشاء الطلب كان يُجلَب في الاستعلام
          (workOrders.deposit) ولا يُعرَض — الموظّف يفتح تفاصيل الطلب ليعرف كم دُفع/تبقّى.
          الحقل ثابتٌ منذ الإنشاء (لا مسارَ تعديلٍ لاحقٍ عليه في الكود — التحقّق قبل العرض)،
          فعرضه هنا مباشرةً آمنٌ ودقيق. */}
      <div className="text-left shrink-0 text-xs" dir="ltr">
        <div className="text-sm font-bold tabular-nums">{fmt(r.salePrice)} د.ع</div>
        {D(r.deposit ?? "0").gt(0) && (
          <div className="mt-0.5 space-y-0.5 text-[10px] font-semibold">
            <div className="text-money-positive">عربون: {fmt(r.deposit ?? "0")}</div>
            <div className="text-[var(--sem-warn)]">
              متبقّي: {fmt(round2(D(r.salePrice).minus(D(r.deposit ?? "0"))).toFixed(2))}
            </div>
          </div>
        )}
      </div>
      <RowActions actions={actions} />
    </li>
  );
}

// ───────────────────────── حوار إعادة التصنيف ─────────────────────────
function ReclassifyDialog({ order, pending, onClose, onConfirm }: {
  order: QueueRow | null;
  pending: boolean;
  onClose: () => void;
  onConfirm: (payload: { hasDelivery: boolean; deliveryAddress?: string | null; deliveryPhone?: string | null; deliveryCost?: string | null; confirmFeeRefund?: boolean; refundShiftId?: number | null }) => void;
}) {
  const [hasDelivery, setHasDelivery] = useState(false);
  const [address, setAddress] = useState("");
  const [phone, setPhone] = useState("");
  const [cost, setCost] = useState("0");
  const [confirmRefund, setConfirmRefund] = useState(false);
  const [refundShiftId, setRefundShiftId] = useState<number | null>(null);

  // أمانة أجرة التوصيل (COUNTER) المحتجزة نقداً — تُقرأ لإظهار الردّ وطلب تأكيد صرفه للزبون قبل
  // التحوّل لاستلامٍ مباشر (لا حركة نقدٍ صامتة — مراجعة Codex على PR #531).
  const feeHeldQ = trpc.workOrders.deliveryFeeHeld.useQuery(
    { workOrderId: order?.id ?? 0 },
    { enabled: !!order, staleTime: 0 },
  );
  const heldNet = Number(feeHeldQ.data?.net ?? "0");
  const branchId = feeHeldQ.data?.branchId ?? null;

  useEffect(() => {
    if (order) {
      setHasDelivery(!!order.hasDelivery);
      setAddress(order.deliveryAddress ?? "");
      setPhone(order.deliveryPhone ?? order.customerPhone ?? "");
      setCost(order.deliveryCost ?? "0");
      setConfirmRefund(false);
      setRefundShiftId(null);
    }
  }, [order?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // التحوّل من توصيل ⇒ استلام مباشر مع أمانةٍ محتجزة يستلزم ردّها نقداً للزبون (تأكيدٌ إلزاميّ).
  const mustRefundFee = !hasDelivery && heldNet > 0;
  const openShiftsQ = trpc.treasury.getOpenShifts.useQuery(
    { branchId: branchId ?? 0 },
    { enabled: mustRefundFee && branchId != null },
  );
  const drawerShifts = openShiftsQ.data ?? [];
  const needShiftPick = mustRefundFee && drawerShifts.length > 1;

  if (!order) return null;
  const originalHasDelivery = !!order.hasDelivery;
  const originalCost = order.deliveryCost ?? "0";
  // تنبيهٌ للموظف فقط (قرار المالك) — لا تعديل تلقائي لسعر البيع الإجمالي عند إعادة التصنيف.
  const priceMayHaveChanged = hasDelivery !== originalHasDelivery || (hasDelivery && cost !== originalCost);

  const submit = () => {
    if (hasDelivery && !address.trim()) { notify.err("عنوان التوصيل مطلوب عند تفعيل التوصيل"); return; }
    if (mustRefundFee && !confirmRefund) { notify.err("أكّد تسليم أمانة الأجرة للزبون أولاً"); return; }
    if (needShiftPick && refundShiftId == null) { notify.err("اختر درج الردّ النقديّ"); return; }
    onConfirm({
      hasDelivery,
      deliveryAddress: hasDelivery ? address.trim() : null,
      deliveryPhone: phone.trim() || null,
      deliveryCost: hasDelivery ? (cost || "0") : "0",
      confirmFeeRefund: mustRefundFee ? true : undefined,
      refundShiftId: mustRefundFee ? (refundShiftId ?? undefined) : undefined,
    });
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4" dir="rtl" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl bg-card p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="mb-1 text-lg font-extrabold">تغيير طريقة التسليم</h3>
        <p className="mb-4 text-xs text-muted-foreground">{order.orderNumber} — {order.title}</p>

        <div className="mb-4 grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => setHasDelivery(false)}
            className={cn(
              "flex items-center justify-center gap-1.5 rounded-lg border-2 py-2.5 text-sm font-bold transition-colors",
              !hasDelivery ? "border-primary bg-primary/10 text-primary" : "border-transparent bg-muted text-muted-foreground hover:bg-muted/70",
            )}
          >
            <Store aria-hidden className="size-4" /> استلام مباشر
          </button>
          <button
            type="button"
            onClick={() => setHasDelivery(true)}
            className={cn(
              "flex items-center justify-center gap-1.5 rounded-lg border-2 py-2.5 text-sm font-bold transition-colors",
              hasDelivery ? "border-primary bg-primary/10 text-primary" : "border-transparent bg-muted text-muted-foreground hover:bg-muted/70",
            )}
          >
            <Truck aria-hidden className="size-4" /> توصيل
          </button>
        </div>

        {hasDelivery && (
          <div className="mb-3 space-y-3">
            <div className="space-y-1">
              <Label htmlFor="reclassify-address">عنوان التوصيل</Label>
              <Input id="reclassify-address" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="العنوان التفصيلي" />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label>هاتف المستلم</Label>
                <IntlPhoneInput value={phone} onChange={setPhone} ariaLabel="هاتف المستلم" />
              </div>
              <div className="space-y-1">
                <Label>أجرة التوصيل التقديرية</Label>
                <MoneyInput value={cost} onChange={setCost} ariaLabel="أجرة التوصيل" />
              </div>
            </div>
          </div>
        )}

        {priceMayHaveChanged && (
          <p className="mb-4 flex items-start gap-1.5 rounded-md border border-amber-300 bg-amber-50 p-2.5 text-xs text-amber-800">
            <AlertTriangle aria-hidden className="mt-0.5 size-3.5 shrink-0" />
            <span>هذا التغيير لا يُعدِّل سعر بيع الأمر تلقائياً — راجع السعر مع العميل إن استلزم فرق التوصيل تعديلاً.</span>
          </p>
        )}

        {/* أمانة أجرة توصيل COUNTER مقبوضة نقداً: التحوّل لاستلامٍ مباشر يردّها للزبون — نُظهر المبلغ
            ونطلب تأكيد صرفه صراحةً قبل الحفظ (لا حركة نقدٍ صامتة تُحدث عجز درجٍ عند الإقفال). */}
        {mustRefundFee && (
          <div className="mb-4 space-y-2.5 rounded-lg border border-amber-300 bg-amber-50 p-3">
            <p className="flex items-start gap-1.5 text-xs text-amber-800">
              <AlertTriangle aria-hidden className="mt-0.5 size-3.5 shrink-0" />
              <span>على هذا الطلب أمانة أجرة توصيل <b className="tabular-nums" dir="ltr">{fmt(heldNet)}</b> د.ع مقبوضة نقداً — بالحفظ تُردّ نقداً من الدرج. <b>سلّمها للزبون.</b></span>
            </p>
            {needShiftPick && (
              <div className="space-y-1">
                <Label className="text-[11px] text-amber-900">أكثر من درجٍ مفتوح — من أيّ درجٍ يخرج النقد؟</Label>
                <select
                  aria-label="درج ردّ الأمانة النقدي"
                  className="h-9 w-full rounded-md border bg-card px-2 text-xs font-bold"
                  value={refundShiftId != null ? String(refundShiftId) : ""}
                  onChange={(e) => setRefundShiftId(e.target.value ? Number(e.target.value) : null)}
                >
                  <option value="">اختر الدرج…</option>
                  {drawerShifts.map((sh) => (
                    <option key={sh.shiftId} value={String(sh.shiftId)}>{sh.userName} — وردية #{sh.shiftId}</option>
                  ))}
                </select>
              </div>
            )}
            <label className="flex items-center gap-2 text-xs font-bold text-amber-900">
              <input type="checkbox" checked={confirmRefund} onChange={(e) => setConfirmRefund(e.target.checked)} className="size-4 accent-amber-600" aria-label="تأكيد تسليم أمانة الأجرة للزبون" />
              سلّمتُ مبلغ الأمانة للزبون نقداً
            </label>
          </div>
        )}

        <div className="flex gap-2.5">
          <Button variant="outline" className="flex-1" onClick={onClose} disabled={pending}>إلغاء</Button>
          <Button className="flex-1" onClick={submit} disabled={pending || (mustRefundFee && !confirmRefund)}>{pending ? "جارٍ…" : "حفظ"}</Button>
        </div>
      </div>
    </div>
  );
}
