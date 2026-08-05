import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowRight, Check, Package, Store, Truck, type LucideIcon } from "lucide-react";
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
import { ReceptionInvoiceQueue } from "./ReceptionInvoiceQueue";
import { MarkPickedUpDialog } from "@/components/delivery/MarkPickedUpDialog";
import { printDeliverySlip, printReadyOrderLabel } from "@/lib/printing/deliveryDocs";
import { preopenShippingLabelWindow } from "@/lib/printing/shippingLabel";
import { fmt } from "@/lib/money";
import { notify } from "@/lib/notify";
import { trpc, type RouterOutputs } from "@/lib/trpc";
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
export default function ReceptionOrderQueue({ branchId, onClose }: { branchId: number; onClose: () => void }) {
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
    onSuccess: () => {
      notify.ok("حُدِّثت طريقة التسليم");
      setReclassifyTarget(null);
      invalidateAll();
    },
    onError: (e) => notify.err(e),
  });

  if (active.isError) return <ErrorState onRetry={() => active.refetch()} />;

  const rows = active.data ?? [];
  const readyRows = rows.filter((r) => r.status === "READY");
  const inProgressRows = rows.filter((r) => r.status !== "READY");
  const deliveredRows = deliveredToday.data ?? [];

  return (
    <div className="mx-auto max-w-5xl space-y-4 pb-8">
      <div className="mb-1 flex items-center justify-between rounded-xl border bg-card p-3">
        <div>
          <h1 className="font-extrabold">طابور الطلبات والتوصيل</h1>
          <p className="text-xs text-muted-foreground">من الاستلام حتى التسليم — استلام مباشر أو إسناد لمندوب/شركة توصيل.</p>
        </div>
        <Button size="sm" variant="outline" onClick={onClose}>
          <ArrowRight aria-hidden className="size-4 me-1" /> العودة إلى الطلب
        </Button>
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
          {/* ٥/٨ — كل فواتير الوردية: كان الطابور مصدره جدول أوامر الشغل حصراً، فالبيع المباشر
              (منتجات جاهزة/طباعة بلا تخصيص) لا يظهر إطلاقاً ولا سبيل لإسناده للتوصيل بعد إتمامه. */}
          <ReceptionInvoiceQueue branchId={branchId} parties={(parties.data ?? []) as DispatchParty[]} canFulfill={canFulfill} />

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
        onConfirm={async ({ partyId, fee, recipientName, recipientPhone }) => {
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
  const actions: RowAction[] = [];
  if (isReady && r.hasDelivery && onDispatch) {
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
          {r.consignmentNumber && (
            <span className="text-[11px] text-muted-foreground">
              {r.deliveryPartyName ? `⇐ ${r.deliveryPartyName}` : ""} ({r.consignmentStatus === "DISPATCHED" ? "قيد التوصيل" : r.consignmentStatus === "DELIVERED" ? "سُلِّمت" : r.consignmentStatus})
            </span>
          )}
          <span className="font-bold">{r.orderNumber}</span>
        </div>
        <p className="mt-0.5 truncate text-sm">{r.title}</p>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          {r.customerName ?? "عميل نقدي"}
          {r.customerPhone ? ` · ${r.customerPhone}` : ""}
          {r.hasDelivery && r.deliveryAddress ? ` · ${r.deliveryAddress}` : ""}
        </p>
      </div>
      <div className="text-left text-sm font-bold tabular-nums shrink-0" dir="ltr">{fmt(r.salePrice)} د.ع</div>
      <RowActions actions={actions} />
    </li>
  );
}

// ───────────────────────── حوار إعادة التصنيف ─────────────────────────
function ReclassifyDialog({ order, pending, onClose, onConfirm }: {
  order: QueueRow | null;
  pending: boolean;
  onClose: () => void;
  onConfirm: (payload: { hasDelivery: boolean; deliveryAddress?: string | null; deliveryPhone?: string | null; deliveryCost?: string | null }) => void;
}) {
  const [hasDelivery, setHasDelivery] = useState(false);
  const [address, setAddress] = useState("");
  const [phone, setPhone] = useState("");
  const [cost, setCost] = useState("0");

  useEffect(() => {
    if (order) {
      setHasDelivery(!!order.hasDelivery);
      setAddress(order.deliveryAddress ?? "");
      setPhone(order.deliveryPhone ?? order.customerPhone ?? "");
      setCost(order.deliveryCost ?? "0");
    }
  }, [order?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!order) return null;
  const originalHasDelivery = !!order.hasDelivery;
  const originalCost = order.deliveryCost ?? "0";
  // تنبيهٌ للموظف فقط (قرار المالك) — لا تعديل تلقائي لسعر البيع الإجمالي عند إعادة التصنيف.
  const priceMayHaveChanged = hasDelivery !== originalHasDelivery || (hasDelivery && cost !== originalCost);

  const submit = () => {
    if (hasDelivery && !address.trim()) { notify.err("عنوان التوصيل مطلوب عند تفعيل التوصيل"); return; }
    onConfirm({
      hasDelivery,
      deliveryAddress: hasDelivery ? address.trim() : null,
      deliveryPhone: phone.trim() || null,
      deliveryCost: hasDelivery ? (cost || "0") : "0",
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

        <div className="flex gap-2.5">
          <Button variant="outline" className="flex-1" onClick={onClose} disabled={pending}>إلغاء</Button>
          <Button className="flex-1" onClick={submit} disabled={pending}>{pending ? "جارٍ…" : "حفظ"}</Button>
        </div>
      </div>
    </div>
  );
}
