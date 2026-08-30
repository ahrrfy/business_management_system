import {
  type WorkOrderStatus,
  WO_NEXT_STATUS,
  WO_STAGE_INDEX,
  workOrderStatusHue,
  workOrderStatusLabel,
  workOrderTimelineLabel,
} from "@shared/workOrderStatus";
import {
  isKanbanStateApplicable,
  isWorkOrderKanbanState,
  nextKanbanStateInCycle,
  workOrderKanbanDotCls,
  workOrderKanbanStateLabel,
  type WorkOrderKanbanState,
} from "@shared/workOrderKanban";
import "./WorkOrders.board.css";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import { AppSelect } from "@/components/ui/AppSelect";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { useUrlFilters } from "@/hooks/useUrlFilters";
import { AlertTriangle, ArrowRight, Calendar, CheckCircle2, ChevronRight, FileText, Home, LayoutGrid, Package, Pencil, Printer, Receipt, Rows3, Search, Timer, Truck, Wrench, X } from "lucide-react";
import type { ColumnDef } from "@tanstack/react-table";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { hasModuleAccess, moduleAccessAllowed, type PermissionMap, type RoleKey } from "@shared/permissions";
import { notify } from "@/lib/notify";
import { confirm } from "@/lib/confirm";
import { exportRows } from "@/lib/export";
import { fmtAr, fmtInt, D, positiveDiff, round2 } from "@/lib/money";
import { MoneyInput } from "@/components/form/MoneyInput";
import { fmtDate, fmtDateTime, toDate } from "@/lib/date";
import { printWorkOrder } from "@/lib/printing/printTemplates";
import { printWorkOrderReceipt } from "@/lib/printing/print";
import { printShippingLabel, type ShippingLabelData } from "@/lib/printing/shippingLabel";
import { ShippingLabelSizeSelect } from "@/components/ShippingLabelSizeSelect";
import { RowActions, type RowAction } from "@/components/list";
import { DataTable } from "@/components/data-table/DataTable";
import { MobileDataCard } from "@/components/ui/MobileDataCard";
import { WhatsAppIcon, WhatsAppShare } from "@/components/WhatsAppShare";
import { ChannelBadge, ChannelMark } from "@/components/ChannelBadge";
import { WORK_ORDER_CHANNELS, receptionChannelLabel, receptionChannelOptions } from "@shared/receptionChannel";
import { CopyInline } from "@/components/CopyButton";
import { CopyAsMenu } from "@/lib/copy/CopyAsMenu";
import { formatWorkOrderAsWhatsApp } from "@/lib/copy/formatters";
import { buildWorkOrderStatusMessage } from "@/lib/whatsapp";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import CustomerPicker from "@/components/CustomerPicker";
import { IntlPhoneInput } from "@/components/form/IntlPhoneInput";
import { Contact360Panel } from "@/components/contacts/Contact360Panel";
import { isPosPaymentMethodEnabled } from "@shared/posPaymentPolicy";
import { deriveWoDeliveryState, woDeliveryStateLabel } from "@shared/workOrderDeliveryState";
import { WorkOrderRefundApprovals } from "@/components/workOrders/WorkOrderRefundApprovals";
import { newClientRequestId } from "@/lib/countQueue";
import { canCancelWorkOrder, cancellationRefundNotice } from "@/lib/workOrderRefundPolicy";
import { ACTION_LABELS } from "@shared/actionLabels";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type WO = RouterOutputs["workOrders"]["list"][number];
type Detail = NonNullable<RouterOutputs["workOrders"]["get"]>;
type Status = "RECEIVED" | "IN_PROGRESS" | "READY" | "DELIVERED";
type DeliverTarget = { id: number; orderNumber: string; title: string; salePrice: string; deposit: string };

function workOrderCardLabel(
  o: Pick<WO, "status" | "consignmentId" | "courierDeliveredAt" | "consignmentStatus" | "parcelStatus">,
): string {
  if (o.status === "DELIVERED" && o.consignmentId) {
    return o.courierDeliveredAt ? "وصل للعميل" : "مُرسل للتوصيل";
  }
  // ١٨/٨: الأمر يبقى READY طوال رحلة المندوب (الإسناد لا يمسّ حالته عمداً) — فكانت البطاقة
  // تقول «جاهز للتسليم» لطردٍ خرج من المكتبة. الحالة المشتقّة تقول أين هو فعلاً.
  const st = deriveWoDeliveryState(o.consignmentStatus, o.parcelStatus);
  if (o.status === "READY" && st !== "NONE") return woDeliveryStateLabel(st)!;
  return workOrderStatusLabel(o.status);
}

// ── المراحل (أعمدة الكانبان) — مطابقة لحالات النظام الحقيقية ──
const STATUSES: { key: Status; label: string; hint: string; hue: number }[] = [
  { key: "RECEIVED", label: "مُستلَم", hint: "بانتظار البدء", hue: 72 },
  { key: "IN_PROGRESS", label: "قيد التنفيذ", hint: "تحت الإنتاج الآن", hue: 250 },
  { key: "READY", label: "جاهز للتسليم", hint: "جاهز — بانتظار العميل", hue: 293 },
  { key: "DELIVERED", label: "مُغلق/مُرسل", hint: "فاتورة أو إرسالية توصيل", hue: 155 },
];
const ADV_LABEL: Record<string, React.ReactNode> = {
  IN_PROGRESS: (<><ChevronRight aria-hidden className="size-4 inline-block align-text-bottom me-1" /> بدء التنفيذ (خصم المواد)</>),
  READY: (<><CheckCircle2 aria-hidden className="size-4 inline-block align-text-bottom me-1" /> وضع علامة: جاهز</>),
  DELIVERED: (<><Package aria-hidden className="size-4 inline-block align-text-bottom me-1" /> تسليم وإصدار فاتورة</>),
};

// أعمدة اللوحة (٥) — «مسحوب» ليست حالة DB بل عرضٌ لـRECEIVED المُسنَد (assignedTo != null).
// لا هجرة: التسلسل الحقيقي يبقى RECEIVED→IN_PROGRESS→READY→DELIVERED؛ السحب يضبط assignedTo فقط.
// السحب/الإسناد ينقل البطاقة بين «طابور وارد» و«مسحوب» (نفس الحالة)؛ والسحب يقدّم الحالة.
type ColKey = "INBOX" | "CLAIMED" | "IN_PROGRESS" | "READY" | "DELIVERED";
const COLUMNS: { key: ColKey; label: string; hint: string; hue: number; status: Status; match: (o: WO) => boolean }[] = [
  { key: "INBOX", label: "طابور وارد", hint: "غير مسحوب — بانتظار فنّي", hue: 72, status: "RECEIVED", match: (o) => o.status === "RECEIVED" && !o.assignedTo },
  { key: "CLAIMED", label: "مسحوب", hint: "مُسنَد لفنّي — لم يبدأ", hue: 235, status: "RECEIVED", match: (o) => o.status === "RECEIVED" && !!o.assignedTo },
  { key: "IN_PROGRESS", label: "قيد التنفيذ", hint: "تحت الإنتاج الآن", hue: 250, status: "IN_PROGRESS", match: (o) => o.status === "IN_PROGRESS" },
  { key: "READY", label: "جاهز للتسليم", hint: "جاهز — بانتظار العميل", hue: 293, status: "READY", match: (o) => o.status === "READY" },
  // «مُسلَّم» تُجلب باستعلام منفصل محدود بالأحدث (DELIVERED_LIMIT) — التاريخ يتراكم بلا سقف،
  // والعدّاد الحقيقي يأتي من workOrders.counts لا من طول القائمة.
  { key: "DELIVERED", label: "مُغلق/مُرسل", hint: "استلام مباشر أو خرج للتوصيل — يُعرض الأحدث", hue: 155, status: "DELIVERED", match: (o) => o.status === "DELIVERED" },
];

const PRIORITIES: Record<string, { label: string; cls: string; rank: number }> = {
  URGENT: { label: "عاجل", cls: "wob-urgent", rank: 3 },
  NORMAL: { label: "عادي", cls: "wob-normal", rank: 2 },
  LOW: { label: "منخفض", cls: "wob-low", rank: 1 },
};
const PAYMENT_METHOD_LABEL: Record<string, string> = {
  CASH: "نقدي",
  CARD: "بطاقة",
  TRANSFER: "تحويل",
  WALLET: "محفظة",
};

function colVars(hue: number): React.CSSProperties {
  return {
    ["--c-solid" as string]: `oklch(0.6 0.17 ${hue})`,
    ["--c-soft" as string]: `oklch(0.6 0.17 ${hue} / 0.13)`,
    ["--c-text" as string]: `oklch(0.45 0.17 ${hue})`,
  } as React.CSSProperties;
}
function avatarHue(name: string): number {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}
function initials(name: string | null | undefined): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "؟") + (parts[1]?.[0] ?? "")).slice(0, 2);
}
/**
 * فرقُ أيّامٍ بين موعد الاستحقاق واليوم — قيمةٌ رقميّة يبني عليها كلٌّ من `dueInfo`
 * (للعرض) والفلاتر السريعة في الموجة ٣ (المتأخّر/يستحقّ اليوم). المصدرُ الحاكم
 * الوحيد لحساب اليوم، كي لا يختلف عرضٌ عن فلتر على نفس البطاقة.
 *
 * ⚠️ حسّاسٌ للنوع: `dueDate` يصل عبر tRPC/superjson كائنَ Date حقيقياً — `String(Date)`
 * ينتج "Sun Aug 30 2026…" لا ISO، فيكسر أيّ مقارنةٍ بـ`slice(0,10)`. `toDate` يتعامل مع
 * Date/نصّ/YYYY-MM-DD محلياً بأمان (Codex أمسك هذا).
 */
function dueDayDelta(dueVal: unknown): number | null {
  const due = toDate(dueVal as string | number | Date | null | undefined);
  if (!due) return null;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dueDay = new Date(due.getFullYear(), due.getMonth(), due.getDate());
  return Math.round((dueDay.getTime() - today.getTime()) / 864e5);
}

function dueInfo(o: { status: string; dueDate: unknown }): { state: "done" | "ok" | "soon" | "late"; text: string } {
  if (o.status === "DELIVERED") return { state: "done", text: "سُلّم" };
  const days = dueDayDelta(o.dueDate);
  if (days == null) return { state: "ok", text: "بلا موعد" };
  if (days < 0) return { state: "late", text: days === -1 ? "متأخر يوم" : `متأخر ${Math.abs(days)} يوم` };
  if (days === 0) return { state: "soon", text: "يستحق اليوم" };
  if (days === 1) return { state: "soon", text: "غداً" };
  return { state: "ok", text: `باقٍ ${days} يوم` };
}
function progressOf(status: string) { const i = Math.max(WO_STAGE_INDEX[status as WorkOrderStatus] ?? 0, 0); return { idx: i, pct: Math.round((i / 3) * 100) }; }
function workOrderContactMessage(o: {
  orderNumber: string;
  title: string;
  status: string;
  customerName: string | null;
  quantity?: number | null;
  dueDate: unknown;
  salePrice?: string | number | null;
  deposit?: string | number | null;
  hasDelivery?: boolean | null;
  deliveryCost?: string | number | null;
  deliveryFeeCollection?: "COURIER" | "COUNTER" | "SHOP" | null;
}) {
  return buildWorkOrderStatusMessage({
    orderNumber: o.orderNumber,
    title: o.title,
    status: o.status,
    customerName: o.customerName,
    quantity: o.quantity,
    dueDate: o.dueDate ? String(o.dueDate) : null,
    amountDue: o.status === "READY" ? D(o.salePrice ?? 0).minus(D(o.deposit ?? 0)).toString() : null,
    // Slice E (٢٩/٨/٢٦): للتوصيل — الرسالة تُصرّح بالأجرة وبالإجماليّ الذي يدفعه العميل للمندوب.
    hasDelivery: o.hasDelivery,
    deliveryFee: o.deliveryCost ?? "0",
    deliveryFeeCollection: o.deliveryFeeCollection ?? "COURIER",
  });
}

// ─────────────── البطاقة ───────────────
/** طباعة طلب الخدمة من بيانات البطاقة — نفس قالب printWorkOrder المستعمل في الـDrawer
 *  (صف القائمة بلا customizationText فتُطبع التذكرة بلا حقل التخصيص فقط). */
function printWoFromCard(o: WO) {
  printWorkOrder({
    woNumber: o.orderNumber,
    woDate: o.createdAt ? String(o.createdAt).slice(0, 10) : undefined,
    dueDate: o.dueDate ? String(o.dueDate).slice(0, 10) : undefined,
    status: o.status,
    employeeName: o.createdByName?.trim() || "موظف الخدمة",
    customerName: o.customerName,
    customerPhone: o.customerPhone,
    jobType: o.title,
    items: [{ name: `${o.title} (${o.quantity} نسخة)`, unit: "مهمة", quantity: 1, unitPrice: o.salePrice, total: o.salePrice }],
    subtotal: o.salePrice,
    total: o.salePrice,
  });
}

/** ملصق شحن للطرد (بالقياس المحفوظ — الافتراضي ٨٠×١٢٠مم) — نفس ملصق المتجر/التوصيل، تكامل واحد.
 *  يعمل من بيانات البطاقة (WO) أو الدُرج (Detail) — كلاهما يحمل عنوان التوصيل بعد إضافة الخادم. */
function printWoShippingLabel(o: {
  orderNumber: string;
  customerName: string | null;
  customerPhone: string | null;
  deliveryAddress?: string | null;
  salePrice: string;
  deposit: string | null;
  quantity: number;
  title: string;
  createdAt: Date | string | null;
}) {
  const data: ShippingLabelData = {
    orderNumber: o.orderNumber,
    customerName: o.customerName,
    customerPhone: o.customerPhone,
    governorate: null,
    addressText: o.deliveryAddress ?? null,
    total: String(Math.max(0, Number(o.salePrice) - Number(o.deposit ?? 0))),
    createdAt: o.createdAt,
    items: [{ productName: o.title, unitName: "", quantity: String(o.quantity) }],
  };
  void printShippingLabel(data).then((r) => {
    if (!r.ok) notify.err("افسح مانع النوافذ المنبثقة لطباعة ملصق الشحن");
  });
}

/** طباعة حرارية 80مم لطلب الخدمة من بيانات البطاقة — نفس مسار التذكرة (جسر/WebUSB/متصفّح). */
function printWoThermalFromCard(o: WO) {
  void printWorkOrderReceipt({
    orderNumber: o.orderNumber,
    orderDate: o.createdAt ? String(o.createdAt).slice(0, 10) : undefined,
    dueDate: o.dueDate ? String(o.dueDate).slice(0, 10) : undefined,
    status: o.status,
    employeeName: o.createdByName?.trim() || "موظف الخدمة",
    customerName: o.customerName ?? undefined,
    customerPhone: o.customerPhone ?? undefined,
    jobTitle: o.title,
    quantity: o.quantity ? `${o.quantity} نسخة` : undefined,
    total: o.salePrice,
    paidUpfront: Number(o.deposit ?? 0) > 0 ? o.deposit : null,
    balanceDue: Number(o.deposit ?? 0) > 0
      ? String(Math.max(0, Number(o.salePrice) - Number(o.deposit ?? 0)))
      : null,
  });
}

function Card({ o, onPointerDown, dragging, ghost, inboxAssign, staff, assignPending, onOpenCustomer, onCycleKanban, kanbanBusy }: {
  o: WO;
  onPointerDown?: (e: React.PointerEvent) => void;
  dragging?: boolean;
  ghost?: boolean;
  /** عند توفّره: تظهر شريط الإسناد inline في عَمود «طابور وارد» (مَدير فَقط). */
  inboxAssign?: (orderId: number, staffId: number) => void;
  /** بَيانات الفنّيين من `assignableStaff` (name قد يَكون null في DB ⇒ يُعرَض «بلا اسم»). */
  staff?: { id: number; name: string | null; role: string; openLoad?: number; overdueLoad?: number; onShift?: boolean }[];
  assignPending?: boolean;
  onOpenCustomer?: (customerId: number) => void;
  /** الموجة ١ — نقر نقطة الكانبان يدور إشارةَ الفنّيّ (NORMAL→READY→BLOCKED→NORMAL). */
  onCycleKanban?: (orderId: number, current: WorkOrderKanbanState) => void;
  kanbanBusy?: boolean;
}) {
  const pr = progressOf(o.status);
  const di = dueInfo(o);
  const chLabel = receptionChannelLabel(o.receptionChannel);
  const pri = PRIORITIES[o.priority ?? "NORMAL"] ?? PRIORITIES.NORMAL;
  const hue = workOrderStatusHue(o.status);
  const late = di.state === "late";
  // إشارةُ الفنّيّ (الموجة ١) — تُعرض في الحالات النشطة فقط (المُسلَّم/الملغى نهايةٌ لا حاجةَ لإشارة).
  const kanbanRaw = (o as unknown as { kanbanState?: string | null }).kanbanState;
  const blockedReason = (o as unknown as { blockedReason?: string | null }).blockedReason ?? null;
  const kanban: WorkOrderKanbanState = isWorkOrderKanbanState(kanbanRaw) ? kanbanRaw : "NORMAL";
  const showKanbanDot = isKanbanStateApplicable(o.status);
  const cls = [
    "wob-card",
    late ? "wob-late" : "",
    dragging ? "wob-dragging" : "",
    ghost ? "wob-ghost" : "",
    showKanbanDot && kanban === "BLOCKED" ? "wob-kanban-blocked" : "",
    showKanbanDot && kanban === "READY" ? "wob-kanban-ready" : "",
  ].filter(Boolean).join(" ");
  // حالة محلّية لاختيار الفنّي في شريط الإسناد — لكل بطاقة على حِدة.
  const [pickedStaff, setPickedStaff] = useState<string>("");
  return (
    <div className={cls} style={{ ["--accent" as string]: `oklch(0.6 0.17 ${hue})` } as React.CSSProperties} onPointerDown={onPointerDown}>
      <div className="wob-card-top">
        {ghost ? (
          <span className="wob-num">{o.orderNumber}</span>
        ) : (
          // إيقاف انتشار pointer/click كي لا يلتقطها محرّك السحب أو فتح الـDrawer
          <span
            className="wob-num"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          >
            <CopyInline value={o.orderNumber} successMessage="تم نَسخ رَقم الأَمر" />
          </span>
        )}
        {/* شارة قَناة المَصدر — مَوضوعة في رأس البطاقة per README §5.2 (لإبراز جانب المبيعات). */}
        <span className="wob-ch-chip" title={`القناة: ${chLabel}`}>
          <ChannelMark channel={o.receptionChannel} />
          <span className="wob-ch-chip-l">{chLabel}</span>
        </span>
        {/* الموجة ١ — إشارةُ الفنّيّ داخل المرحلة: نقرةٌ تدور NORMAL→READY→BLOCKED→NORMAL.
            الحالاتُ النهائية (DELIVERED/CANCELLED) تُخفي النقطة — لا معنى لإشارةٍ بعد الخروج من الدورة. */}
        {showKanbanDot && !ghost && onCycleKanban && (
          <button
            type="button"
            className={`wob-kanban-dot ${workOrderKanbanDotCls(kanban)}`}
            title={
              kanban === "BLOCKED" && blockedReason
                ? `معطَّل — ${blockedReason} (اضغط لتغيير الإشارة)`
                : `إشارةُ الفنّيّ: ${workOrderKanbanStateLabel(kanban)} — اضغط لتغييرها`
            }
            aria-label={`إشارةُ الفنّيّ الحاليّة: ${workOrderKanbanStateLabel(kanban)}`}
            disabled={kanbanBusy}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); onCycleKanban(o.id, kanban); }}
          />
        )}
        {/* في وضع الشبح (السحب) أو حين لا يُمكن التبديل: نعرض النقطةَ عرضاً لا زرّاً. */}
        {showKanbanDot && (ghost || !onCycleKanban) && kanban !== "NORMAL" && (
          <span
            className={`wob-kanban-dot ${workOrderKanbanDotCls(kanban)}`}
            title={workOrderKanbanStateLabel(kanban)}
            aria-hidden
          />
        )}
        <span className={`wob-pri ${pri.cls}`}><span className="wob-pri-dot" />{pri.label}</span>
        {!ghost && (
          // إيقاف انتشار pointer/click كي لا يلتقطها محرّك السحب أو فتح الـDrawer
          <span onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
            <RowActions
              mode="menu"
              label={`إجراءات ${o.orderNumber}`}
              contact={{
                phone: o.customerPhone,
                alternativePhones: [o.deliveryPhone],
                label: `واتساب ${o.customerName ?? "العميل"}`,
                message: workOrderContactMessage(o),
                gate: { module: "workorders", level: "READ" },
              }}
              actions={[
                ...(o.customerId && onOpenCustomer ? [{
                  key: "customer-360",
                  kind: "view" as const,
                  label: "بطاقة العميل ٣٦٠° وكل طلباته",
                  onSelect: () => onOpenCustomer(Number(o.customerId)),
                  gate: { module: "crm" as const, level: "READ" as const },
                }] : []),
                { key: "print", kind: "print", label: "طباعة A4", onSelect: () => printWoFromCard(o), gate: { module: "workorders", level: "READ" } },
                { key: "print-thermal", kind: "print", label: "طباعة حرارية (80مم)", onSelect: () => printWoThermalFromCard(o), gate: { module: "workorders", level: "READ" } },
                { key: "print-label", kind: "print", label: "ملصق شحن", onSelect: () => printWoShippingLabel(o), gate: { module: "workorders", level: "READ" } },
                { key: "open", kind: "view", label: "فتح التفاصيل", href: `/work-orders/${o.id}`, gate: { module: "workorders", level: "READ" } },
              ]}
            />
          </span>
        )}
      </div>
      <div className="wob-card-body">
        <div className="wob-thumb" style={{ background: `oklch(0.6 0.15 ${hue})` }}>
          {o.thumbnailUrl ? <img src={o.thumbnailUrl} alt="" /> : <span className="wob-thumb-abbr"><Printer aria-hidden size={22} /></span>}
        </div>
        <div className="wob-info">
          <div className="wob-card-title">{o.title}</div>
          <div className="wob-cust">{o.customerName ?? "عميل نقدي"}</div>
          {o.customerPhone && <div className="wob-cust-phone" dir="ltr">{o.customerPhone}</div>}
        </div>
      </div>
      {o.customizationText && <div className="wob-card-specs">{o.customizationText}</div>}
      {o.hasDelivery && (
        <div className="wob-card-delivery">
          <Package aria-hidden className="size-3.5 shrink-0" />
          <span className="truncate">{o.deliveryAddress ?? "توصيل للعميل"}</span>
        </div>
      )}
      <div className="wob-meta">
        <span className="wob-meta-pill"><span className="wob-ml">الكمية </span>{fmtInt(o.quantity)}</span>
        <span className="wob-meta-pill"><span className="wob-ml">السعر </span>{fmtAr(o.salePrice)} <span className="wob-ml">د.ع</span></span>
        {/* ٨/٨ — شارة التوصيل: يظهر التوصيل في التنفيذ (كان «غير موجود بالتنفيذ»). الأجرة تمريرٌ
            لا إيراد ⇒ تُعرَض للعِلم فقط. العنوان في التلميح. */}
        {o.hasDelivery && (
          <span
            className="wob-deliv"
            title={o.deliveryAddress ? `توصيل إلى: ${o.deliveryAddress}` : "توصيل"}
          >
            <Truck aria-hidden className="size-3.5" />
            {Number(o.deliveryCost ?? 0) > 0
              ? <>توصيل <span dir="ltr">{fmtAr(o.deliveryCost)}</span></>
              : "توصيل"}
          </span>
        )}
        <span className={`wob-due wob-${di.state}`} style={{ marginInlineStart: "auto", display: "inline-flex", alignItems: "center", gap: 4 }}>{late ? <Timer aria-hidden className="size-3.5" /> : <Calendar aria-hidden className="size-3.5" />} {di.text}</span>
      </div>
      <div className="wob-prog">
        <div className="wob-prog-bar"><div className="wob-prog-fill" style={{ width: pr.pct + "%", background: `oklch(0.6 0.17 ${hue})` }} /></div>
        <div className="wob-prog-row"><span>المرحلة {pr.idx + 1}/4</span><span>{pr.pct}%</span></div>
      </div>
      <div className="wob-foot">
        <div className="wob-who">
          {o.assigneeName ? (
            <div className="wob-avatar" title={o.assigneeName} style={{ background: `oklch(0.6 0.17 ${avatarHue(o.assigneeName)})` }}>{initials(o.assigneeName)}</div>
          ) : (
            <div className="wob-avatar wob-unassigned" title="غير مُسنَد">؟</div>
          )}
          <span className="wob-who-name">{o.assigneeName ?? "غير مُسنَد"}</span>
        </div>
        <span onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
          <WhatsAppShare
            phone={o.customerPhone}
            alternativePhones={[o.deliveryPhone]}
            message={workOrderContactMessage(o)}
            label="مراسلة"
            size="sm"
            appearance="solid"
            className="wob-wa"
          />
        </span>
      </div>
      {/* شَريط إسناد inline لعَمود «طابور وارد» فَقط — مَدير فَقط، per README §5.2. */}
      {inboxAssign && staff && !ghost && (
        <div className="wob-inbox-assign" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
          <select
            className="wob-sel wob-inbox-sel"
            value={pickedStaff}
            onChange={(e) => setPickedStaff(e.target.value)}
            disabled={assignPending}
            aria-label={`إسناد ${o.orderNumber} لفنّي`}
          >
            {/* ش٣: القائمة الفارغة تُفسَّر صراحةً بدل منتقٍ صامتٍ لا يقول لماذا. */}
            <option value="">{staff.length === 0 ? "— لا فنّيّ مؤهَّل في هذا الفرع —" : "— اختر فنّياً —"}</option>
            {staff.map((s) => (
              // ش٣ — **إسنادٌ مستنير**: الحملُ والتأخّرُ والمداومة في السطر نفسه، فيقع القرار
              // على حقيقةٍ لا على اسم. والترتيب خادميّ بالأقلّ حملاً ⇒ الصوابُ أوّلُ خيار.
              <option key={s.id} value={s.id}>
                {s.name ?? "بلا اسم"}
                {typeof s.openLoad === "number" ? ` · ${s.openLoad} مفتوحة` : ""}
                {s.overdueLoad ? ` · ${s.overdueLoad} متأخّرة` : ""}
                {s.onShift === false ? " · خارج الوردية" : s.onShift ? " · على رأس العمل" : ""}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="wob-btn wob-btn-primary wob-inbox-btn"
            disabled={assignPending || !pickedStaff}
            onClick={() => {
              const n = Number(pickedStaff);
              if (!Number.isFinite(n) || n <= 0) return;
              inboxAssign(o.id, n);
              setPickedStaff("");
            }}
            title="إسناد الأمر للفنّي المُختار"
          >
            <ChevronRight aria-hidden className="size-3.5" /> إسناد
          </button>
        </div>
      )}
    </div>
  );
}

// ─────────────── الإحصاءات ───────────────
// من عدّ الخادم (workOrders.counts) لا من صفوف الشاشة: القائمة تجلب النشطة كاملةً لكن «مُسلَّم»
// محدودة بالأحدث، فالعدّ من الصفوف كان سيَعرض نافذة العرض لا الحقيقة.

// ─────────────── حوار سبب التعطيل (الموجة ١ — إشارةُ الفنّيّ) ───────────────
/**
 * حوارٌ صغير لالتقاط سببِ التعطيل حين ينقل الفنّيّ إشارةَ الكانبان إلى BLOCKED.
 * لا مخزون ولا مال — الخادم يحفظ الإشارةَ + السبب في `workOrders.blockedReason`
 * وحدَثاً في `workOrderEvents`. يُغلَق تلقائياً عند نجاح الحفظ (onSuccess).
 */
function BlockedReasonDialog({
  target,
  onClose,
  onConfirm,
  pending,
}: {
  target: { id: number; orderNumber: string; title: string } | null;
  onClose: () => void;
  onConfirm: (reason: string) => void;
  pending: boolean;
}) {
  const [reason, setReason] = useState("");
  useEffect(() => { if (target) setReason(""); }, [target?.id]); // eslint-disable-line
  if (!target) return null;
  const trimmed = reason.trim();
  const tooLong = trimmed.length > 255;
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>تعطيل الأمر — سبب مطلوب</DialogTitle>
          <DialogDescription>
            الأمر «{target.title}» ({target.orderNumber}) — اكتب سبب التعطّل موجزاً.
            سيظهر في تلميح البطاقة وفي سجلّ أحداث الأمر.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2 py-1">
          <Label htmlFor="wob-blocked-reason">سبب التعطّل</Label>
          <Textarea
            id="wob-blocked-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="مثال: بانتظار موافقة العميل على التصميم، أو نفاد لون خامّ، أو عطل الطابعة…"
            rows={3}
            maxLength={255}
            autoFocus
          />
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>{trimmed.length}/255</span>
            {tooLong && <span className="text-[var(--sem-neg)]">أقصاه ٢٥٥ حرفاً</span>}
          </div>
        </div>
        <DialogFooter>
          <button type="button" className="wob-btn" onClick={onClose} disabled={pending}>تراجع</button>
          <button
            type="button"
            className="wob-btn wob-btn-primary"
            disabled={pending || !trimmed || tooLong}
            onClick={() => onConfirm(trimmed)}
          >
            {pending ? ACTION_LABELS.saving : "وسْم كمعطَّل"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─────────────── حوار التسليم (مالي — تأكيد صريح) ───────────────
const dlgInput = "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
function DeliverDialog({ order, onClose, onConfirm, pending }: { order: DeliverTarget | null; onClose: () => void; onConfirm: (payment?: { amount: string; method: "CASH" | "CARD" | "CHECK" | "TRANSFER" | "WALLET"; reference?: string }) => void; pending: boolean }) {
  const [amount, setAmount] = useState("");
  const [methodV, setMethodV] = useState<"CASH" | "CARD" | "CHECK" | "TRANSFER" | "WALLET">("CASH");
  const [reference, setReference] = useState("");
  useEffect(() => {
    if (order) {
      // تعبئة المتبقّي تلقائياً = سعر البيع − العربون المقبوض (لا طرح يدويّ من الموظّف).
      const dueInit = positiveDiff(order.salePrice, order.deposit ?? 0);
      setAmount(dueInit.gt(0) ? dueInit.toFixed(2) : "");
      setMethodV("CASH");
      setReference("");
    }
  }, [order?.id]); // eslint-disable-line
  if (!order) return null;
  const amtD = D(amount);
  const hasDep = D(order.deposit ?? 0).gt(0);
  const due = positiveDiff(order.salePrice, order.deposit ?? 0);
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>تسليم وإصدار فاتورة</DialogTitle>
          <DialogDescription>
            الأمر «{order.title}» ({order.orderNumber}) — سعر البيع {fmtAr(order.salePrice)} د.ع.
            سيُصدر فاتورة فوراً ويُحدَّث المخزون والذمم. هذا إجراء لا رجعة فيه.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 py-1">
          <div className="space-y-1 rounded-md border bg-muted/30 p-3 text-sm">
            <div className="flex justify-between"><span className="text-muted-foreground">سعر البيع</span><span dir="ltr" className="tabular-nums">{fmtAr(order.salePrice)} د.ع</span></div>
            {hasDep && <div className="flex justify-between"><span className="text-muted-foreground">العربون المقبوض</span><span dir="ltr" className="tabular-nums text-[var(--sem-pos)]">−{fmtAr(order.deposit)} د.ع</span></div>}
            <div className="flex justify-between border-t pt-1 font-bold"><span>الرصيد المستحق</span><span dir="ltr" className="tabular-nums">{fmtAr(due.toFixed(2))} د.ع</span></div>
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium">المبلغ المدفوع الآن (الافتراضي = الرصيد المستحق؛ أقل = آجل)</label>
            <MoneyInput value={amount} onChange={setAmount} className={dlgInput} placeholder={`0 – ${fmtAr(due.toFixed(2))}`} />
          </div>
          {methodV !== "CASH" && (
            <div className="space-y-1">
              <label className="text-sm font-medium">مرجع العملية <span className="text-destructive">*</span></label>
              <input className={dlgInput} value={reference} onChange={(e) => setReference(e.target.value)} placeholder="رقم موافقة البطاقة أو رقم التحويل" />
              <p className="text-xs text-muted-foreground">لا تُحفظ دفعة إلكترونية بلا مرجع قابل للمطابقة.</p>
            </div>
          )}
          <div className="space-y-1">
            <label className="text-sm font-medium">طريقة الدفع</label>
            <select className={dlgInput} value={methodV} onChange={(e) => setMethodV(e.target.value as typeof methodV)}>
              <option value="CASH">نقدي</option>
              <option value="CARD" disabled={!isPosPaymentMethodEnabled("CARD")}>بطاقة</option>
              <option value="TRANSFER" disabled={!isPosPaymentMethodEnabled("TRANSFER")}>تحويل</option>
              <option value="WALLET" disabled={!isPosPaymentMethodEnabled("WALLET")}>محفظة</option>
            </select>
          </div>
        </div>
        <DialogFooter>
          <button className="wob-btn wob-btn-ghost" onClick={onClose} disabled={pending}>إلغاء</button>
          <button className="wob-btn wob-btn-primary" disabled={pending || !isPosPaymentMethodEnabled(methodV) || (amtD.gt(0) && methodV !== "CASH" && !reference.trim())}
            onClick={() => {
              if (!isPosPaymentMethodEnabled(methodV)) return;
              onConfirm(amtD.gt(0)
                ? { amount: round2(amtD).toFixed(2), method: methodV, reference: methodV === "CASH" ? undefined : reference.trim() }
                : undefined);
            }}>
            {pending ? "جارٍ…" : "تسليم وإصدار الفاتورة"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─────────────── تعديل تفاصيل الطلب (مديرٌ فأعلى — يقفل بعد DELIVERED/CANCELLED) ───────────────
type EditForm = {
  title: string;
  customizationText: string;
  salePrice: string;
  dueDate: string;
  priority: "LOW" | "NORMAL" | "URGENT";
  customerId: number | null;
  contactName: string;
  contactPhone: string;
  receptionChannel: "WALK_IN" | "WHATSAPP" | "INSTAGRAM" | "TIKTOK" | "PHONE" | "OTHER";
  channelHandle: string;
};

function EditWorkOrderDialog({ workOrderId, onClose, onSaved }: { workOrderId: number | null; onClose: () => void; onSaved: () => void }) {
  const detail = trpc.workOrders.get.useQuery({ workOrderId: workOrderId ?? 0 }, { enabled: workOrderId != null });
  const [form, setForm] = useState<EditForm | null>(null);

  // يعبّئ النموذج من بيانات الخادم عند فتح طلبٍ جديد — لا يُعيد الكتابة فوق تعديلات المستخدم
  // الجارية إن أُعيد جلب نفس الطلب (invalidate) أثناء الفتح.
  useEffect(() => {
    const d = detail.data;
    setForm(
      d
        ? {
            title: d.title,
            customizationText: d.customizationText ?? "",
            salePrice: d.salePrice,
            dueDate: d.dueDate ? String(d.dueDate).slice(0, 10) : "",
            priority: (d.priority as EditForm["priority"]) ?? "NORMAL",
            customerId: d.customerId ?? null,
            contactName: d.contactName ?? "",
            contactPhone: d.contactPhone ?? "",
            receptionChannel: d.receptionChannel ?? "WALK_IN",
            channelHandle: d.channelHandle ?? "",
          }
        : null,
    );
  }, [detail.data?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const update = trpc.workOrders.update.useMutation({
    onSuccess: () => { notify.ok("حُفظ التعديل"); onSaved(); },
    onError: (e) => notify.err(e),
  });

  if (workOrderId == null) return null;
  const d = detail.data;
  const locked = !!d && (d.status === "DELIVERED" || d.status === "CANCELLED");
  const deposit = D(d?.deposit ?? 0);

  function submit() {
    if (!form) return;
    const title = form.title.trim();
    if (!title) { notify.err("عنوان الطلب مطلوب"); return; }
    const priceD = D(form.salePrice);
    if (priceD.lte(0)) { notify.err("السعر يجب أن يكون أكبر من صفر"); return; }
    if (priceD.lt(deposit)) { notify.err(`السعر أقلّ من العربون المقبوض سلفاً (${fmtAr(deposit.toFixed(2))} د.ع)`); return; }
    update.mutate({
      workOrderId: workOrderId!,
      title,
      customizationText: form.customizationText.trim() || null,
      salePrice: round2(priceD).toFixed(2),
      dueDate: form.dueDate || null,
      priority: form.priority,
      customerId: form.customerId,
      contactName: form.contactName.trim() || null,
      contactPhone: form.contactPhone.trim() || null,
      receptionChannel: form.receptionChannel,
      channelHandle: form.channelHandle.trim() || null,
    });
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>تعديل طلب الخدمة{d ? ` — ${d.orderNumber}` : ""}</DialogTitle>
          <DialogDescription>
            {locked
              ? "هذا الطلب مُسلَّم أو مُلغى — لا يمكن تعديله بعد الآن."
              : "يسري التعديل فوراً. الكمية والمواد المستهلَكة لا تُعدَّلان من هنا."}
          </DialogDescription>
        </DialogHeader>
        {!d || !form ? (
          <div className="py-8 text-center text-sm text-muted-foreground">{detail.isLoading ? "جارٍ التحميل…" : "تعذّر العثور على الطلب."}</div>
        ) : locked ? (
          <DialogFooter><button className="wob-btn wob-btn-ghost" onClick={onClose}>إغلاق</button></DialogFooter>
        ) : (
          <>
            <div className="grid gap-3 py-1 max-h-[65vh] overflow-y-auto pe-1">
              <div className="space-y-1">
                <Label>عنوان الطلب</Label>
                <input className={dlgInput} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
              </div>
              <div className="space-y-1">
                <Label>التخصيص/الملاحظات</Label>
                <Textarea value={form.customizationText} onChange={(e) => setForm({ ...form, customizationText: e.target.value })} rows={3} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label>سعر البيع</Label>
                  <MoneyInput value={form.salePrice} onChange={(v) => setForm({ ...form, salePrice: v })} className={dlgInput} />
                  {deposit.gt(0) && <p className="text-xs text-muted-foreground">لا يقلّ عن العربون المقبوض: {fmtAr(deposit.toFixed(2))} د.ع</p>}
                </div>
                <div className="space-y-1">
                  <Label>موعد الاستحقاق</Label>
                  <input type="date" className={dlgInput} value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label>الأولوية</Label>
                  <select className={dlgInput} value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value as EditForm["priority"] })}>
                    {Object.entries(PRIORITIES).map(([k, p]) => <option key={k} value={k}>{p.label}</option>)}
                  </select>
                </div>
                <div className="space-y-1">
                  <Label>قناة الاستلام</Label>
                  <select className={dlgInput} value={form.receptionChannel} onChange={(e) => setForm({ ...form, receptionChannel: e.target.value as EditForm["receptionChannel"] })}>
                    {receptionChannelOptions(WORK_ORDER_CHANNELS).map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                  </select>
                </div>
              </div>
              {form.receptionChannel !== "WALK_IN" && (
                <div className="space-y-1">
                  <Label>معرّف القناة (رقم/حساب)</Label>
                  <input className={dlgInput} value={form.channelHandle} onChange={(e) => setForm({ ...form, channelHandle: e.target.value })} />
                </div>
              )}
              <CustomerPicker customerId={form.customerId} onCustomerChange={(id) => setForm({ ...form, customerId: id })} />
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label>اسم مرجعي (زبون عابر بلا سجلّ)</Label>
                  <input className={dlgInput} value={form.contactName} onChange={(e) => setForm({ ...form, contactName: e.target.value })} />
                </div>
                <div className="space-y-1">
                  <Label>هاتف مرجعي</Label>
                  <IntlPhoneInput value={form.contactPhone} onChange={(v) => setForm({ ...form, contactPhone: v })} />
                </div>
              </div>
            </div>
            <DialogFooter>
              <button className="wob-btn wob-btn-ghost" onClick={onClose} disabled={update.isPending}>إلغاء</button>
              <button className="wob-btn wob-btn-primary" disabled={update.isPending} onClick={submit}>
                {update.isPending ? "جارٍ الحفظ…" : "حفظ التعديل"}
              </button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ─────────────── لوحة التفاصيل (Drawer) ───────────────
function Drawer({
  id, onClose, isManager, canDeliver, onAdvance, onCancel, onDeliver, onAssign, onEdit, onOpenCustomer, busy,
}: {
  id: number; onClose: () => void; isManager: boolean; canDeliver: boolean;
  onAdvance: (id: number, to: Status) => void; onCancel: (d: Detail) => void;
  onDeliver: (d: Detail) => void; onAssign: (id: number, staffId: number | null) => void;
  onEdit: (id: number) => void; busy: boolean;
  onOpenCustomer?: (customerId: number) => void;
}) {
  const detail = trpc.workOrders.get.useQuery({ workOrderId: id });
  const timeline = trpc.workOrders.timeline.useQuery({ workOrderId: id });
  const staff = trpc.workOrders.assignableStaff.useQuery(undefined, { enabled: isManager });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const d = detail.data ?? null;
  const di = d ? dueInfo(d) : null;
  const pri = d ? (PRIORITIES[d.priority ?? "NORMAL"] ?? PRIORITIES.NORMAL) : null;
  const next = d ? WO_NEXT_STATUS[d.status as WorkOrderStatus] : undefined;
  const hue = workOrderStatusHue(d?.status);
  const cur = d ? Math.max(WO_STAGE_INDEX[d.status as WorkOrderStatus] ?? 0, 0) : 0;

  // أحداث الخط الزمني: من سجلّ التدقيق إن توفّر، وإلا اشتقاق صادق من الطوابع.
  const tlRows = timeline.data ?? [];
  const tlItems = tlRows.length
    ? tlRows.map((r) => ({ ev: workOrderTimelineLabel(r.action), at: r.createdAt, by: r.userName as string | null }))
    : d ? [
        { ev: "استُلم الطلب", at: d.createdAt, by: null as string | null },
        ...(d.deliveredAt ? [{ ev: "سُلّم وصدرت الفاتورة", at: d.deliveredAt, by: null as string | null }] : []),
      ] : [];

  return (
    <>
      <div className="wob-scrim" onClick={onClose} />
      <div className="wob-drawer" role="dialog" aria-modal="true" aria-label="تفاصيل طلب الخدمة">
        <button className="wob-dr-close" onClick={onClose} aria-label="إغلاق"><X aria-hidden className="size-4" /></button>
        {!d ? (
          <div className="wob-dr-body"><div style={{ color: "var(--muted-fg)", textAlign: "center", padding: 40 }}>{detail.isLoading ? "جارٍ التحميل…" : "تعذّر العثور على الأمر."}</div></div>
        ) : (
          <>
            <div className="wob-dr-head">
              <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                <div className="wob-thumb" style={{ width: 48, height: 48, background: `oklch(0.6 0.15 ${hue})` }}>
                  {d.images?.[0]?.url ? <img src={d.images[0].url} alt="" /> : <span className="wob-thumb-abbr"><Printer aria-hidden size={20} /></span>}
                </div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 11, color: "var(--muted-fg)" }}>
                    <CopyInline value={d.orderNumber} successMessage="تم نَسخ رَقم الأَمر" />
                  </div>
                  <div style={{ fontSize: 18, fontWeight: 800, lineHeight: 1.3 }}>{d.title}</div>
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap", alignItems: "center" }}>
                <span className="wob-meta-pill" style={{ background: `oklch(0.6 0.17 ${hue} / 0.13)`, color: `oklch(0.45 0.17 ${hue})`, display: "inline-flex", alignItems: "center", gap: 6 }}><span className="inline-block size-2 rounded-full" style={{ background: `oklch(0.45 0.17 ${hue})` }} />{workOrderCardLabel(d)}</span>
                {pri && <span className={`wob-pri ${pri.cls}`}><span className="wob-pri-dot" />{pri.label}</span>}
                {di && <span className={`wob-due wob-${di.state}`} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>{di.state === "late" ? <Timer aria-hidden className="size-3.5" /> : <Calendar aria-hidden className="size-3.5" />} {di.text}</span>}
              </div>
            </div>

            <div className="wob-dr-body">
              <div>
                <div className="wob-kv">
                  <div>
                    <div className="wob-k">العميل</div>
                    <div className="wob-v">
                      {d.customerId && onOpenCustomer ? (
                        <button type="button" className="text-primary hover:underline" onClick={() => onOpenCustomer(Number(d.customerId))}>
                          {d.customerName ?? `عميل #${d.customerId}`} · بطاقة ٣٦٠°
                        </button>
                      ) : "عميل نقدي"}
                    </div>
                  </div>
                  {d.customerPhone && <div><div className="wob-k">هاتف العميل</div><div className="wob-v" dir="ltr">{d.customerPhone}</div></div>}
                  <div><div className="wob-k">قناة الاستلام</div><div className="wob-v inline-flex items-center gap-1"><ChannelBadge channel={d.receptionChannel} handle={d.channelHandle} /></div></div>
                  <div><div className="wob-k">الكمية</div><div className="wob-v">{fmtInt(d.quantity)}</div></div>
                  <div><div className="wob-k">سعر البيع</div><div className="wob-v" style={{ direction: "ltr", textAlign: "right" }}>{fmtAr(d.salePrice)} د.ع</div></div>
                  {Number(d.deposit ?? 0) > 0 && <div><div className="wob-k">العربون</div><div className="wob-v" style={{ direction: "ltr", textAlign: "right" }}>{fmtAr(d.deposit)} د.ع</div></div>}
                  {Number(d.deposit ?? 0) > 0 && <div><div className="wob-k">طريقة دفع العربون</div><div className="wob-v">{PAYMENT_METHOD_LABEL[d.paymentMethod ?? ""] ?? d.paymentMethod ?? "—"}</div></div>}
                  {d.paymentReference && <div><div className="wob-k">مرجع الدفع</div><div className="wob-v" dir="ltr">{d.paymentReference}</div></div>}
                  <div><div className="wob-k">الاستحقاق</div><div className="wob-v">{fmtDate(d.dueDate)}</div></div>
                  <div><div className="wob-k">أنشأ الطلب</div><div className="wob-v">{d.createdByName ?? "—"}</div></div>
                  <div><div className="wob-k">وقت الاستلام</div><div className="wob-v">{fmtDateTime(d.createdAt)}</div></div>
                  {d.hasDelivery && <div><div className="wob-k">هاتف التوصيل</div><div className="wob-v" dir="ltr">{d.deliveryPhone ?? d.customerPhone ?? "—"}</div></div>}
                  {d.hasDelivery && <div style={{ gridColumn: "1 / -1" }}><div className="wob-k">عنوان التوصيل</div><div className="wob-v">{d.deliveryAddress ?? "—"}</div></div>}
                  {d.materialsCost != null && <div><div className="wob-k">كلفة المواد</div><div className="wob-v" style={{ direction: "ltr", textAlign: "right" }}>{fmtAr(d.materialsCost)} د.ع</div></div>}
                  {d.laborCost != null && <div><div className="wob-k">كلفة العمالة</div><div className="wob-v" style={{ direction: "ltr", textAlign: "right" }}>{fmtAr(d.laborCost)} د.ع</div></div>}
                  <div style={{ gridColumn: "1 / -1" }}>
                    <div className="wob-k">الموظف المسؤول</div>
                    {isManager ? (
                      <select className="wob-sel" style={{ width: "100%", marginTop: 4, height: 34 }} value={d.assignedTo ?? ""}
                        onChange={(e) => onAssign(d.id, e.target.value ? Number(e.target.value) : null)} disabled={busy}>
                        <option value="">— غير مُسنَد —</option>
                        {(staff.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name} — {s.role}</option>)}
                      </select>
                    ) : (
                      <div className="wob-v">{d.assigneeName ?? "غير مُسنَد"}</div>
                    )}
                  </div>
                </div>
                {d.customizationText && (
                  <div className="wob-note"><span style={{ fontWeight: 700 }}>التخصيص/الملاحظات: </span>{d.customizationText}</div>
                )}
                {d.paymentReceiptUrl && (
                  <a href={d.paymentReceiptUrl} target="_blank" rel="noreferrer" className="mt-3 block rounded-xl border bg-card p-2 hover:border-primary">
                    <div className="mb-2 text-xs font-bold text-muted-foreground">صورة إيصال العربون — اضغط للتكبير</div>
                    <img src={d.paymentReceiptUrl} alt="إيصال دفع العربون" className="max-h-44 w-full rounded-lg object-contain" />
                  </a>
                )}
              </div>

              <div>
                <div className="wob-dr-sec-t">مراحل الإنتاج — {cur + 1}/4 ({progressOf(d.status).pct}%)</div>
                <div className="wob-prog-bar" style={{ marginBottom: 12 }}><div className="wob-prog-fill" style={{ width: progressOf(d.status).pct + "%", background: `oklch(0.6 0.17 ${hue})` }} /></div>
                {STATUSES.map((s, i) => (
                  <div key={s.key} className={`wob-stage-row ${i < cur ? "wob-on" : ""}`}>
                    <div className={`wob-stage-box ${i < cur ? "wob-on" : ""} ${i === cur ? "wob-cur" : ""}`}>{i < cur ? <CheckCircle2 aria-hidden className="size-4" /> : i + 1}</div>
                    <span className="wob-stage-label">{s.label}</span>
                  </div>
                ))}
              </div>

              <div>
                <div className="wob-dr-sec-t">الخط الزمني للأمر</div>
                <div className="wob-timeline">
                  {[...tlItems].reverse().map((e, i) => (
                    <div className="wob-tl-item" key={i}>
                      <div className="wob-tl-dot" style={{ background: i === 0 ? `oklch(0.6 0.17 ${hue})` : "var(--border-strong)" }} />
                      <div className="wob-tl-ev">{e.ev}</div>
                      <div className="wob-tl-meta" style={{ direction: "ltr", textAlign: "right" }}>{fmtDateTime(e.at)}{e.by ? ` — ${e.by}` : ""}</div>
                    </div>
                  ))}
                  {tlItems.length === 0 && <div style={{ color: "var(--muted-fg)", fontSize: 12.5 }}>لا أحداث مسجّلة بعد.</div>}
                </div>
              </div>

              {d.qrPayload && (
                <div>
                  <div className="wob-dr-sec-t">باركود التذكرة</div>
                  <div style={{ fontFamily: "ui-monospace, monospace", fontSize: 12, direction: "ltr", textAlign: "right", color: "var(--muted-fg)" }}>{d.orderNumber}</div>
                </div>
              )}
            </div>

            <div className="wob-dr-foot">
              <CopyAsMenu
                label="نَسخ تَفاصيل الأَمر"
                plain={formatWorkOrderAsWhatsApp({
                  number: d.orderNumber,
                  date: d.createdAt,
                  customer: d.customerName,
                  description: d.customizationText,
                  status: workOrderStatusLabel(d.status),
                  items: [{ name: d.title, qty: d.quantity, unit: "نُسخة" }],
                  deposit: d.deposit,
                  total: d.salePrice,
                  deliveryDate: d.dueDate,
                })}
                whatsapp={formatWorkOrderAsWhatsApp({
                  number: d.orderNumber,
                  date: d.createdAt,
                  customer: d.customerName,
                  description: d.customizationText,
                  status: workOrderStatusLabel(d.status),
                  items: [{ name: d.title, qty: d.quantity, unit: "نُسخة" }],
                  deposit: d.deposit,
                  total: d.salePrice,
                  deliveryDate: d.dueDate,
                })}
              />
              <button className="wob-btn wob-btn-ghost" onClick={() => printWorkOrder({
                woNumber: d.orderNumber,
                woDate: d.createdAt ? String(d.createdAt).slice(0, 10) : undefined,
                dueDate: d.dueDate ? String(d.dueDate).slice(0, 10) : undefined,
                status: d.status,
                employeeName: d.createdByName?.trim() || "موظف الخدمة",
                customerName: d.customerName,
                customerPhone: d.customerPhone,
                jobType: d.title,
                specs: d.customizationText,
                items: [{ name: `${d.title} (${d.quantity} نسخة)`, unit: "مهمة", quantity: 1, unitPrice: d.salePrice, total: d.salePrice }],
                subtotal: d.salePrice,
                total: d.salePrice,
              })}><Printer aria-hidden className="size-4 inline-block align-text-bottom me-1" /> طباعة A4</button>
              <button
                className="wob-btn wob-btn-ghost"
                title="إيصال طلب خدمة حراري 80مم — جسر الخادم/WebUSB/متصفّح"
                onClick={() => void printWorkOrderReceipt({
                  orderNumber: d.orderNumber,
                  orderDate: d.createdAt ? String(d.createdAt).slice(0, 10) : undefined,
                  dueDate: d.dueDate ? String(d.dueDate).slice(0, 10) : undefined,
                  status: d.status,
                  employeeName: d.createdByName?.trim() || "موظف الخدمة",
                  customerName: d.customerName ?? undefined,
                  customerPhone: d.customerPhone ?? undefined,
                  jobTitle: d.title,
                  quantity: d.quantity ? `${d.quantity} نسخة` : undefined,
                  specs: d.customizationText ?? undefined,
                  total: d.salePrice,
                })}
              ><Receipt aria-hidden className="size-4 inline-block align-text-bottom me-1" /> حراري 80مم</button>
              <button
                className="wob-btn wob-btn-ghost"
                title="ملصق شحن يُلصَق على الطرد (بالقياس المحفوظ — الافتراضي ٨٠×١٢٠مم)"
                onClick={() => printWoShippingLabel(d)}
              ><Package aria-hidden className="size-4 inline-block align-text-bottom me-1" /> ملصق شحن</button>
              <WhatsAppShare
                phone={d.customerPhone}
                alternativePhones={[d.deliveryPhone]}
                message={workOrderContactMessage(d)}
                label="راسل العميل"
                appearance="solid"
                className="wob-wa-lg"
              />
              {next === "DELIVERED" && d.hasDelivery && canDeliver ? (
                <Link href="/delivery" className="wob-btn wob-btn-primary" style={{ flex: 1 }}>
                  <Truck aria-hidden className="size-4 inline-block align-text-bottom me-1" /> إسناد للتوصيل
                </Link>
              ) : next ? (next !== "DELIVERED" || canDeliver) && (
                <button className="wob-btn wob-btn-primary" style={{ flex: 1 }} disabled={busy}
                  onClick={() => (next === "DELIVERED" ? onDeliver(d) : onAdvance(d.id, next))}>{ADV_LABEL[next]}</button>
              ) : (
                <button className="wob-btn wob-btn-ghost" disabled style={{ flex: 1, opacity: 0.6 }}><CheckCircle2 aria-hidden className="size-4 inline-block align-text-bottom me-1" /> اكتمل الأمر</button>
              )}
              {isManager && d.status !== "DELIVERED" && d.status !== "CANCELLED" && (
                <button className="wob-btn wob-btn-ghost" disabled={busy} onClick={() => onEdit(d.id)}>
                  <Pencil aria-hidden className="size-4 inline-block align-text-bottom me-1" /> تعديل
                </button>
              )}
              {isManager && d.status !== "DELIVERED" && d.status !== "CANCELLED" && (
                <button className="wob-btn wob-btn-danger" disabled={busy} onClick={() => onCancel(d)}>إلغاء الأمر</button>
              )}
              {d.status === "DELIVERED" && d.invoiceId && (
                // رابط مباشر لتفاصيل الفاتورة الصادرة عن التسليم (كان يهبط على القائمة العامة)
                <Link href={`/invoices/${d.invoiceId}`} className="wob-btn wob-btn-ghost">الفاتورة #{d.invoiceId}</Link>
              )}
            </div>
          </>
        )}
      </div>
    </>
  );
}

// ─────────────── عرض القائمة (جدولٌ حقيقي — بديل الكانبان لمراجعةٍ مالية/إدارية) ───────────────
// طلب المالك (٩/٨): الكانبان يخدم الإنتاج/الفنّيين؛ يلزم عرضٌ يشبه شاشة «المبيعات» — جدولٌ يمكن
// فرزه وفلترته، بأزرار تحكّمٍ وتعديل، دون حاجةٍ لفتح شاشة الاستقبال (التي تتطلّب وردية مفتوحة).
function OrdersTable({
  rows, isManager, canDeliver, onOpen, onEdit, onAdvance, onCancel,
}: {
  rows: WO[];
  isManager: boolean;
  canDeliver: boolean;
  onOpen: (id: number) => void;
  onEdit: (id: number) => void;
  onAdvance: (order: WO, to: Status) => void;
  onCancel: (order: Pick<WO, "id" | "title" | "orderNumber">) => void;
}) {
  const columns = useMemo<ColumnDef<WO, unknown>[]>(() => [
    {
      // نمط Invoices.tsx/Card: الرقم للنسخ، لا للتنقّل — «فتح التفاصيل» في قائمة الإجراءات.
      accessorKey: "orderNumber",
      header: "رقم الأمر",
      cell: ({ row }) => <CopyInline value={row.original.orderNumber} successMessage="تم نَسخ رَقم الأَمر" />,
    },
    {
      accessorKey: "createdAt",
      header: "التاريخ",
      cell: ({ row }) => fmtDate(row.original.createdAt),
    },
    {
      id: "title",
      header: "العنوان",
      cell: ({ row }) => {
        const o = row.original;
        const pri = PRIORITIES[o.priority ?? "NORMAL"] ?? PRIORITIES.NORMAL;
        return (
          <div className="max-w-56">
            <div className="truncate font-medium">{o.title}</div>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              {fmtInt(o.quantity)} ×
              <span className={`wob-pri ${pri.cls}`} style={{ padding: "0 4px" }}><span className="wob-pri-dot" />{pri.label}</span>
            </div>
          </div>
        );
      },
    },
    {
      id: "customer",
      header: "العميل",
      cell: ({ row }) => row.original.customerName ?? "عميل نقدي",
    },
    {
      accessorKey: "status",
      header: "الحالة",
      cell: ({ row }) => {
        const o = row.original;
        const hue = workOrderStatusHue(o.status);
        return (
          <span
            className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold"
            style={{ background: `oklch(0.6 0.17 ${hue} / 0.13)`, color: `oklch(0.45 0.17 ${hue})` }}
          >
            {workOrderCardLabel(o)}
          </span>
        );
      },
    },
    {
      accessorKey: "salePrice",
      header: "الإجمالي",
      cell: ({ row }) => <span dir="ltr" className="tabular-nums">{fmtAr(row.original.salePrice)}</span>,
    },
    {
      accessorKey: "deposit",
      header: "العربون",
      cell: ({ row }) => {
        const dep = D(row.original.deposit ?? 0);
        return dep.gt(0) ? <span dir="ltr" className="tabular-nums">{fmtAr(dep.toFixed(2))}</span> : <span className="text-muted-foreground">—</span>;
      },
    },
    {
      id: "remaining",
      header: "المتبقي",
      cell: ({ row }) => {
        const o = row.original;
        if (o.status === "DELIVERED" || o.status === "CANCELLED") return <span className="text-muted-foreground">—</span>;
        const due = positiveDiff(o.salePrice, o.deposit ?? 0);
        return (
          <span dir="ltr" className={`tabular-nums font-medium ${due.gt(0) ? "text-stock-low" : "text-money-positive"}`}>
            {fmtAr(due.toFixed(2))}
          </span>
        );
      },
    },
    {
      id: "due",
      header: "الاستحقاق",
      cell: ({ row }) => {
        const di = dueInfo(row.original);
        return <span className={`wob-due wob-${di.state} whitespace-nowrap`}>{di.text}</span>;
      },
    },
    {
      id: "channel",
      header: "القناة",
      cell: ({ row }) => {
        return <ChannelBadge channel={row.original.receptionChannel} />;
      },
    },
    {
      id: "assignee",
      header: "فني التنفيذ",
      cell: ({ row }) => row.original.assigneeName ?? <span className="text-muted-foreground">غير مُسنَد</span>,
    },
    {
      id: "delivery",
      header: "التوصيل",
      cell: ({ row }) => {
        const o = row.original;
        if (!o.hasDelivery) return <span className="text-muted-foreground">استلام مباشر</span>;
        if (!o.consignmentId) {
          return <span className={o.status === "READY" ? "font-bold text-stock-low" : "text-muted-foreground"}>
            {o.status === "READY" ? "بانتظار الإسناد" : "لم يُرسل"}
          </span>;
        }
        return (
          <span className="whitespace-nowrap">
            {(o as WO & { courierDeliveredAt?: Date | null }).courierDeliveredAt ? "وصل للعميل" : "مع جهة التوصيل"}
            {o.deliveryPartyName ? ` — ${o.deliveryPartyName}` : ""}
          </span>
        );
      },
    },
    {
      id: "actions",
      header: "إجراءات",
      enableSorting: false,
      cell: ({ row }) => {
        const o = row.original;
        const isFinal = o.status === "DELIVERED" || o.status === "CANCELLED";
        const next = WO_NEXT_STATUS[o.status as WorkOrderStatus];
        const actions: RowAction[] = [
          { key: "open", kind: "view", label: "فتح التفاصيل", onSelect: () => onOpen(o.id) },
          { key: "edit", kind: "edit", label: "تعديل", icon: Pencil, hidden: isFinal, onSelect: () => onEdit(o.id), gate: { managerOnly: true } },
          { key: "print", kind: "print", label: "طباعة A4", onSelect: () => printWoFromCard(o) },
          { key: "print-thermal", kind: "print", label: "طباعة حرارية (80مم)", onSelect: () => printWoThermalFromCard(o) },
          { key: "print-label", kind: "print", label: "ملصق شحن", onSelect: () => printWoShippingLabel(o) },
        ];
        if (next === "DELIVERED" && o.hasDelivery && canDeliver) {
          actions.push({ key: "dispatch", kind: "approve", label: "إسناد للتوصيل", icon: Truck, href: "/delivery" });
        } else if (next && (next !== "DELIVERED" || canDeliver)) {
          actions.push({ key: "advance", kind: next === "DELIVERED" ? "pay" : "approve", label: ADV_LABEL[next], onSelect: () => onAdvance(o, next) });
        }
        if (isManager && !isFinal) {
          actions.push({ key: "cancel", kind: "cancel", label: "إلغاء الأمر", variant: "destructive", onSelect: () => onCancel(o) });
        }
        return (
          <RowActions
            mode="menu"
            label={`إجراءات ${o.orderNumber}`}
            contact={{
              phone: o.customerPhone,
              alternativePhones: [o.deliveryPhone],
              label: `واتساب ${o.customerName ?? "العميل"}`,
              message: workOrderContactMessage(o),
              gate: { module: "workorders", level: "READ" },
            }}
            actions={actions}
          />
        );
      },
    },
  ], [isManager, canDeliver, onOpen, onEdit, onAdvance, onCancel]);

  return (
    <DataTable
      columns={columns}
      data={rows}
      searchable={false}
      emptyText="لا طلبات مطابقة للبحث/الفلاتر الحالية."
      viewKey="work-orders-list"
      getRowId={(r) => String(r.id)}
      pageSize={50}
      mobileCardRenderer={(o) => {
        const pri = PRIORITIES[o.priority ?? "NORMAL"] ?? PRIORITIES.NORMAL;
        const due = positiveDiff(o.salePrice, o.deposit ?? 0);
        const next = WO_NEXT_STATUS[o.status as WorkOrderStatus];
        return (
          <MobileDataCard
            key={o.id}
            title={o.title}
            subtitle={`${o.orderNumber} · ${o.customerName ?? "عميل نقدي"}`}
            badge={{
              label: workOrderCardLabel(o),
              variant: o.status === "DELIVERED" ? "success" : o.status === "READY" ? "default" : o.status === "IN_PROGRESS" ? "warning" : "secondary",
            }}
            amount={{
              value: fmtAr(o.salePrice),
              label: due.gt(0) && o.status !== "DELIVERED" && o.status !== "CANCELLED" ? `المتبقي: ${fmtAr(due.toFixed(2))}` : undefined,
              positive: o.status === "DELIVERED",
            }}
            metadata={[
              { label: "الكمية", value: `${fmtInt(o.quantity)} نسخة` },
              { label: "الأولوية", value: pri.label },
              { label: "الاستحقاق", value: fmtDate(o.dueDate), icon: Calendar },
              { label: "الفني", value: o.assigneeName ?? "غير مُسنَد" },
            ]}
            onClick={() => onOpen(o.id)}
            primaryAction={
              next && (next !== "DELIVERED" || canDeliver)
                ? {
                    label: next === "IN_PROGRESS" ? "بدء التنفيذ" : next === "READY" ? "جاهز" : "تسليم",
                    icon: next === "READY" ? CheckCircle2 : next === "DELIVERED" ? Package : ChevronRight,
                    onClick: () => onAdvance(o, next),
                  }
                : undefined
            }
          />
        );
      }}
    />
  );
}

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
  const isManager = canCancel;
  const isOwner = me.data?.isOwner === true;
  const canCrossBranches = me.data?.role === "admin";
  // المشرف (أدمن/مالك/مدير) نطاقُه كلُّ الفرع بحكم `scopedOwnerId=null` — فالرقاقة بلا أثرٍ له.
  const isSupervisor = me.data?.role === "admin" || me.data?.role === "manager" || !!me.data?.isOwner;
  // مرآة بوّابة الخادم: deliver = workordersCashierProcedure(["cashier","manager"], "workorders", "FULL") —
  // فنّي المطبعة (workordersExecProcedure) يقدّم المراحل لكن التسليم/الفوترة مال ونقد (كاشير/مدير أو منح صريح).
  // بنفس دالة الخادم moduleAccessAllowed (لا قائمة أدوار حرفية) ⇒ لا تباعُد.
  const canDeliver = !!me.data?.role &&
    moduleAccessAllowed(me.data.role as RoleKey, (me.data.permissionsOverride ?? null) as PermissionMap | null, "workorders", "FULL", ["cashier", "manager"]);
  // مرآة workordersExecProcedure الخادميّة: workorders/FULL + roles=[cashier|manager|print_operator].
  // إشارة الكانبان (setKanbanState) تحته ⇒ لا نُظهر زرّاً سيفشل بـFORBIDDEN لمستخدم READ (Codex #6).
  const canSetKanban = !!me.data?.role &&
    moduleAccessAllowed(me.data.role as RoleKey, (me.data.permissionsOverride ?? null) as PermissionMap | null, "workorders", "FULL", ["cashier", "manager", "print_operator"]);
  const canReadCustomerContext = !!me.data?.role &&
    hasModuleAccess(me.data.role, (me.data.permissionsOverride ?? null) as PermissionMap | null, "crm", "READ");
  // قائمة الموظَّفين القابِلين للإسناد — مَرفوعة لصَفحة WorkOrders كَي تُستعمَل
  // في الإسناد inline على بطاقات «طابور وارد» (بَدل فَتح الـDrawer لِكل أَمر).
  // مَفعَّلة لِلمَدير فَقط لِتَوافق صَلاحية `assignableStaff` على الخادم.
  const assignableStaff = trpc.workOrders.assignableStaff.useQuery(undefined, { enabled: isManager });
  // عبور الفروع للأدمن فقط؛ مدير الفرع مقيَّد بفرعه في الواجهة والخادم.
  const branchesQ = trpc.branches.list.useQuery(undefined, { enabled: canCrossBranches });

  // الفلاتر في querystring — تنجو من فتح التفاصيل والرجوع وتُشارَك رابطاً.
  // pri/ch/branch/tech بقيمة "all" (لا "") لأن AppSelect يعامل "" كـplaceholder غير قابل لإعادة الاختيار.
  const [f, setF, resetF] = useUrlFilters({ q: "", pri: "all", ch: "all", branch: "all", from: "", to: "", tech: "all", scope: "branch", stale: "", gb: "stage", late: "", unassigned: "", dueToday: "", blocked: "", d: "normal" });
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
  const [cancelNotice, setCancelNotice] = useState<{ title: string; description: string; awaitingOwner: boolean } | null>(null);
  const [cancelRetryWorkOrderId, setCancelRetryWorkOrderId] = useState<number | null>(null);
  const [drag, setDrag] = useState<{ order: WO; x: number; y: number; overCol: string | null } | null>(null);

  const colRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const dragRef = useRef<{ order: WO; startX: number; startY: number; ox: number; oy: number; moved: boolean } | null>(null);
  const cancelRequestIdsRef = useRef(new Map<number, string>());

  // فلاتر خادمية مشتركة بين القائمتين والعدّادات والتصدير — بناء واحد فلا تنحرف الأرقام عن الجدول.
  const serverFilters = {
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
  const activeQ = trpc.workOrders.list.useQuery(activeInput, { enabled: me.data != null });
  const deliveredQ = trpc.workOrders.list.useQuery(deliveredInput, { enabled: me.data != null });
  const countsQ = trpc.workOrders.counts.useQuery(serverFilters, { enabled: me.data != null });
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
  // التفاؤل على استعلام النشطة فقط — الانتقال إلى «مُسلَّم» يمرّ بحوار التسليم ثم invalidateAll.
  const optimisticMove = (id: number, to: Status) =>
    utils.workOrders.list.setData(activeInput, (old) => old?.map((o) => (o.id === id ? { ...o, status: to } : o)));

  const start = trpc.workOrders.start.useMutation({
    onSuccess: () => { notify.warn("بدأ التنفيذ", "خُصمت المواد من المخزون تلقائياً."); invalidateAll(); },
    onError: (e) => { notify.err(e); invalidateAll(); },
  });
  const markReady = trpc.workOrders.markReady.useMutation({
    onSuccess: () => { notify.ok("جاهز للتسليم", "الأمر جاهز — أبلغ العميل."); invalidateAll(); },
    onError: (e) => { notify.err(e); invalidateAll(); },
  });
  const deliver = trpc.workOrders.deliver.useMutation({
    onSuccess: (r) => { notify.ok("تم التسليم", `صدرت فاتورة ${r.invoiceNumber} تلقائياً.`); setDeliverOrder(null); invalidateAll(); },
    onError: (e) => { notify.err(e); invalidateAll(); },
  });
  const cancel = trpc.workOrders.cancel.useMutation({
    onSuccess: (result, variables) => {
      const notice = cancellationRefundNotice(result.pendingRefundReceiptIds, result.replayed);
      setCancelNotice(notice);
      if (notice.awaitingOwner) notify.warn(notice.title, notice.description);
      else notify.ok(notice.title, notice.description);
      cancelRequestIdsRef.current.delete(variables.workOrderId);
      setCancelRetryWorkOrderId(null);
      setSel(null);
      invalidateAll();
    },
    onError: (error, variables) => {
      notify.err(error, "لم نتأكد من نتيجة الإلغاء؛ يمكنك إعادة المحاولة بالمعرّف نفسه دون تكرار الأثر.");
      setCancelRetryWorkOrderId(variables.workOrderId);
      setCancelNotice({
        title: "تعذّر التحقق من نتيجة الإلغاء",
        description: "لم تُنشأ محاولة جديدة تلقائياً. أعد التحقق والمحاولة الآمنة بالمعرّف نفسه؛ إن كان الإلغاء نُفّذ فسيعيد الخادم النتيجة بلا تكرار.",
        awaitingOwner: true,
      });
    },
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
  const busy = start.isPending || markReady.isPending || deliver.isPending || cancel.isPending || assign.isPending;

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
      if (f.unassigned === "1" && o.assignedTo != null) return false;
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
      if (needle) {
        const hay = [o.orderNumber, o.title, o.customerName ?? ""].join(" ").toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    };
  }, [f.q, f.pri, f.ch, f.late, f.unassigned, f.dueToday, f.blocked]);

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

  // ── الانتقال بين المراحل (الخطوة التالية فقط — التسليم خلف تأكيد مالي) ──
  async function attemptMove(order: WO, to: Status) {
    if (WO_NEXT_STATUS[order.status as WorkOrderStatus] !== to) {
      notify.warn("انتقال غير مسموح", "اتبع التسلسل: مُستلَم ← قيد التنفيذ ← جاهز ← مُسلَّم.");
      return;
    }
    if (to === "IN_PROGRESS") {
      if (!(await confirm({ variant: "warning", title: "بدء تنفيذ طلب الخدمة", description: `بدء تنفيذ «${order.title}» (${order.orderNumber}) يخصم المواد المطلوبة من المخزون تلقائياً. متابعة؟`, confirmText: "بدء التنفيذ", cancelText: "تراجع" }))) return;
      optimisticMove(order.id, "IN_PROGRESS"); start.mutate({ workOrderId: order.id });
    }
    else if (to === "READY") {
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

  function onCardPointerDown(e: React.PointerEvent, order: WO) {
    if (e.button !== 0) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    dragRef.current = { order, startX: e.clientX, startY: e.clientY, ox: e.clientX - rect.left, oy: e.clientY - rect.top, moved: false };
    const move = (ev: PointerEvent) => {
      const dr = dragRef.current; if (!dr) return;
      if (!dr.moved && Math.hypot(ev.clientX - dr.startX, ev.clientY - dr.startY) < 6) return;
      // Codex #6 (الجولة ٢): وسمُ `moved=true` **قبل** فحص `dndEnabled` كان يعطّل النقر
      // على البطاقات في تجميعاتٍ غير stage — حركةٌ لمسٍ طفيفة (>6px) تنتج pointerup
      // بحالة `moved=true` فلا يُفتح Drawer، ولا نقلٍ يحدث لأنّ مفاتيح `tech:*` ليست في
      // COLUMNS ⇒ نقرةٌ ضائعة. الحلّ: نتخطّى في تجميعاتٍ غير stage قبل الوسم.
      if (!dndEnabled) return;
      dr.moved = true;
      document.body.style.userSelect = "none";
      setDrag({ order: dr.order, x: ev.clientX - dr.ox, y: ev.clientY - dr.oy, overCol: hitCol(ev.clientX, ev.clientY) });
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.userSelect = "";
      const dr = dragRef.current; dragRef.current = null;
      if (!dr) return;
      if (!dr.moved) { setSel(dr.order.id); setDrag(null); return; }
      const overKey = hitCol(ev.clientX, ev.clientY);
      setDrag(null);
      // overKey هو مفتاح العمود الافتراضي؛ نحوّله لحالة DB المستهدفة (مسحوب↔وارد = نفس الحالة ⇒ لا نقل).
      const col = COLUMNS.find((c) => c.key === overKey);
      if (col && col.status !== dr.order.status) attemptMove(dr.order, col.status);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  async function onCancelOrder(d: Pick<Detail, "id" | "title" | "orderNumber">) {
    if (!(await confirm({ variant: "danger", title: "إلغاء طلب الخدمة", description: `إلغاء «${d.title}» (${d.orderNumber})؟ تُعكَس المواد المخصومة للمخزون.`, confirmText: "إلغاء الطلب", cancelText: "تراجع" }))) return;
    const clientRequestId = cancelRequestIdsRef.current.get(d.id) ?? newClientRequestId();
    cancelRequestIdsRef.current.set(d.id, clientRequestId);
    cancel.mutate({ workOrderId: d.id, clientRequestId });
  }

  const anyFilter = f.q || f.pri !== "all" || f.ch !== "all" || f.branch !== "all" || f.from || f.to || f.tech !== "all" || f.stale === "1" || (f.scope || "branch") !== "branch" || f.late === "1" || f.unassigned === "1" || f.dueToday === "1" || f.blocked === "1";
  const boardEmpty = filtered.length === 0;
  const boardLoading = activeQ.isLoading || deliveredQ.isLoading;

  return (
    <div className="wob">
      <div className="wob-topbar">
        <div>
          {/* ١٩/٨ (طلب المالك): مخرجا الشاشة — محطّة العمل والرئيسيّة. اللوحة تُفتَح من بطاقة
              «لوحة الإنتاج» في الرئيسيّة ومن رأس المحطّة، وكانت بلا طريقِ عودةٍ إلى أيٍّ منهما. */}
          <div className="mb-1 flex items-center gap-3">
            <a href="/pos?mode=RECEPTION" className="inline-flex items-center gap-1 text-2xs font-bold text-muted-foreground hover:text-foreground hover:underline">
              <ArrowRight aria-hidden className="size-3.5" /> محطة خدمة العملاء
            </a>
            <span aria-hidden className="text-muted-foreground/40">·</span>
            <a href="/" className="inline-flex items-center gap-1 text-2xs font-bold text-muted-foreground hover:text-foreground hover:underline">
              <Home aria-hidden className="size-3.5" /> الرئيسية
            </a>
          </div>
          <div className="wob-title">أوامر الشغل</div>
          <div className="wob-sub">من الاستلام إلى التسليم — اسحب البطاقة بين المراحل. فاتورة تلقائية عند التسليم.</div>
        </div>
        <div className="wob-head-actions">
          <div role="group" aria-label="طريقة العرض" className="wob-view-toggle">
            <button
              type="button"
              aria-pressed={view === "board"}
              onClick={() => setView("board")}
              title="لوحة الإنتاج (كانبان)"
            ><LayoutGrid aria-hidden className="size-4" /> لوحة</button>
            <button
              type="button"
              aria-pressed={view === "list"}
              onClick={() => setView("list")}
              title="قائمة جدولية — للمراجعة والتحكّم"
            ><Rows3 aria-hidden className="size-4" /> قائمة</button>
          </div>
          <ShippingLabelSizeSelect />
          <button className="wob-btn wob-btn-ghost" disabled={boardLoading}
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
            })}><FileText aria-hidden className="size-4 inline-block align-text-bottom me-1" /> تصدير Excel</button>
          <Link href="/pos?mode=RECEPTION" className="wob-btn wob-btn-primary">شاشة الاستقبال الموحدة</Link>
        </div>
      </div>

      <WorkOrderRefundApprovals isOwner={isOwner} currentUserId={me.data?.id} />

      {cancelNotice && (
        <div
          role="status"
          className={cancelNotice.awaitingOwner
            ? "rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] p-3 text-sm text-[var(--sem-warn)]"
            : "rounded-md border border-[var(--sem-pos)]/30 bg-[var(--sem-pos-bg)] p-3 text-sm text-[var(--sem-pos)]"}
        >
          <div className="font-bold">{cancelNotice.title}</div>
          <div>{cancelNotice.description}</div>
          {cancelRetryWorkOrderId != null && canCancel && (
            <button
              type="button"
              className="mt-2 rounded-md border border-current px-3 py-1.5 text-xs font-bold disabled:opacity-50"
              disabled={cancel.isPending}
              onClick={() => {
                const clientRequestId = cancelRequestIdsRef.current.get(cancelRetryWorkOrderId);
                if (!clientRequestId) {
                  notify.err("تعذّر العثور على معرّف المحاولة السابقة؛ افتح أمر الشغل للتحقق من حالته.");
                  return;
                }
                cancel.mutate({ workOrderId: cancelRetryWorkOrderId, clientRequestId });
              }}
            >
              {cancel.isPending ? "جارٍ التحقق…" : "إعادة التحقق والمحاولة الآمنة"}
            </button>
          )}
        </div>
      )}

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
          // Codex #4 (الجولة ١) + #3 (الجولة ٢): عدّاد الخادم `serverCounts.late` لا يقبل
          // أيّ فلترٍ عميليّ، فحين يُفعَّل أحدها تكذب الشارة («10 متأخّر» وعلى الشاشة بطاقتان).
          // نُعيد الحساب من `filtered` نفسه (نفس مصدر البطاقات). `late` نفسه لا يُدرَج —
          // لا يغيّر معنى «كم متأخّر»؛ لكن `dueToday/unassigned/blocked` تُغيّر مجموعة العرض
          // ⇒ إغفالُها كان يُنتج شارةً موجبة فوق لوحةٍ فارغة (late × dueToday متنافيان).
          const clientFilterActive =
            f.pri !== "all" || f.ch !== "all" ||
            f.dueToday === "1" || f.unassigned === "1" || f.blocked === "1";
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
        <button
          type="button"
          aria-pressed={f.dueToday === "1"}
          onClick={() => setF({ dueToday: f.dueToday === "1" ? "" : "1" })}
          className={`wob-qf${f.dueToday === "1" ? " wob-qf-on wob-qf-today" : ""}`}
          title="أوامرُ تستحقّ التسليم اليوم"
        >
          <Calendar aria-hidden className="size-3.5" />
          يستحقّ اليوم
        </button>
        <button
          type="button"
          aria-pressed={f.unassigned === "1"}
          onClick={() => setF({ unassigned: f.unassigned === "1" ? "" : "1" })}
          className={`wob-qf${f.unassigned === "1" ? " wob-qf-on wob-qf-unassigned" : ""}`}
          title="طابورٌ مشترك — أوامرُ لم تُسنَد لفنّيّ بعد"
        >
          <Wrench aria-hidden className="size-3.5" />
          بلا فنّيّ
        </button>
        <button
          type="button"
          aria-pressed={f.blocked === "1"}
          onClick={() => setF({ blocked: f.blocked === "1" ? "" : "1" })}
          className={`wob-qf${f.blocked === "1" ? " wob-qf-on wob-qf-blocked" : ""}`}
          title="أوامرٌ أشار الفنّيّ إلى تعطّلها — سببها في تلميح البطاقة"
        >
          <AlertTriangle aria-hidden className="size-3.5" />
          معطَّل
        </button>
        <div className="wob-search">
          <span className="wob-si"><Search aria-hidden className="size-4" /></span>
          <input value={f.q} onChange={(e) => setF({ q: e.target.value })} placeholder="بحث (رقم / عنوان / عميل)" />
        </div>
        {/* الموجة ٢ — Group By (نمط Odoo): يبدّل تجميع الأعمدة بلا تغيير الفلاتر.
            «حسب المرحلة» هو الافتراضُ ويُفعِّل السحب والإفلات. البقيّة للقراءة الآن. */}
        {view === "board" && (
          <AppSelect
            value={f.gb}
            onValueChange={(v) => setF({ gb: v })}
            className="w-auto min-w-36"
            aria-label="تجميع البطاقات"
          >
            <option value="stage">حسب المرحلة (افتراضيّ)</option>
            <option value="technician">حسب الفنّيّ</option>
            <option value="channel">حسب القناة</option>
            <option value="priority">حسب الأولويّة</option>
          </AppSelect>
        )}
        {/* الموجة ٤ (٣٠/٨/٢٦) — كثافة العرض (نمط Odoo): الكاشير يفضّل «مضغوطاً» ليرى ٤٠
            بطاقة بدل ٦؛ المدير يفضّل «مفصّلاً». يُحفَظ في URL — الفنّيّ يفتح الرابط
            بكثافته المعتادة بلا إعادة ضبط. */}
        {view === "board" && (
          <AppSelect
            value={f.d}
            onValueChange={(v) => setF({ d: v })}
            className="w-auto min-w-32"
            aria-label="كثافة العرض"
          >
            <option value="compact">مضغوط</option>
            <option value="normal">عاديّ</option>
            <option value="detailed">مفصَّل</option>
          </AppSelect>
        )}
        {canCrossBranches && (
          <AppSelect
            value={f.branch}
            onValueChange={(v) => setF({ branch: v })}
            className="w-auto min-w-36"
            aria-label="فلتر الفرع"
          >
            <option value="all">كل الفروع</option>
            {(branchesQ.data ?? []).map((b) => (
              <option key={Number(b.id)} value={String(Number(b.id))}>{b.name}</option>
            ))}
          </AppSelect>
        )}
        <AppSelect value={f.pri} onValueChange={(v) => setF({ pri: v })} className="w-auto min-w-32" aria-label="فلتر الأولوية">
          <option value="all">كل الأولويات</option>
          {Object.entries(PRIORITIES).map(([k, p]) => <option key={k} value={k}>{p.label}</option>)}
        </AppSelect>
        <AppSelect value={f.ch} onValueChange={(v) => setF({ ch: v })} className="w-auto min-w-32" aria-label="فلتر القناة">
          <option value="all">كل القنوات</option>
          {receptionChannelOptions(WORK_ORDER_CHANNELS).map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
        </AppSelect>
        {isManager && (assignableStaff.data?.length ?? 0) > 0 && (
          <AppSelect value={f.tech} onValueChange={(v) => setF({ tech: v })} className="w-auto min-w-32" aria-label="فلتر الفنّي">
            <option value="all">كل الفنّيين</option>
            {(assignableStaff.data ?? []).map((s) => (
              <option key={s.id} value={String(s.id)}>{s.name ?? "بلا اسم"}</option>
            ))}
          </AppSelect>
        )}
        {/* نطاق تاريخ الاستلام (createdAt) — شامل لليوم بحدود UTC خادمياً. */}
        <div className="wob-date-range" aria-label="نطاق تاريخ الاستلام">
          <span>من</span>
          <input
            type="date"
            className="wob-sel wob-date"
            value={f.from}
            onChange={(e) => setF({ from: e.target.value })}
            aria-label="من تاريخ"
            title="من تاريخ الاستلام"
          />
          <span>إلى</span>
          <input
            type="date"
            className="wob-sel wob-date"
            value={f.to}
            onChange={(e) => setF({ to: e.target.value })}
            aria-label="إلى تاريخ"
            title="إلى تاريخ الاستلام"
          />
        </div>
        {anyFilter && <button className="wob-chip-clear" onClick={resetF}>مسح الفلاتر <X aria-hidden className="size-3.5 inline-block align-text-bottom" /></button>}
      </div>

      {view === "list" ? (
        <OrdersTable
          rows={filtered}
          isManager={isManager}
          canDeliver={canDeliver}
          onOpen={setSel}
          onEdit={setEditTarget}
          onAdvance={attemptMove}
          onCancel={onCancelOrder}
        />
      ) : (
      <div className="wob-board-wrap">
        {boardLoading ? (
          <div className="wob-empty-board">جارٍ التحميل…</div>
        ) : boardEmpty ? (
          <div className="wob-empty-board">{anyFilter ? "لا طلبات مطابقة للبحث/الفلاتر الحالية." : "لا أوامر شغل بعد. تُنشأ الطلبات من شاشة الاستقبال الموحدة."}</div>
        ) : (
          <div className={`wob-board wob-d-${f.d === "compact" ? "compact" : f.d === "detailed" ? "detailed" : "normal"}`}>
            {dynColumns.map((s) => {
              const list = byCol[s.key] ?? [];
              // D&D يعمل فقط في «حسب المرحلة» (`groupBy=stage`): الأخرى تحتاج mutations
              // مختلفة (assign/update) لم يُبنَ لها بعد جسر D&D — يبقى العرض قراءةً فقط.
              const isOver = dndEnabled && drag && drag.overCol === s.key && WO_NEXT_STATUS[drag.order.status as WorkOrderStatus] === s.status;
              // الموجة ١ — KPIs الرأس: العدّاد كما كان، ونضيف مجموع القيمة و«معطَّل» و«متأخّر».
              // ⚠️ KPIs مقياسها الحالة الحاكمة `s.status` (وليس ColKey): «طابور وارد»/«مسحوب»
              // كلاهما RECEIVED فتظهر لهما نفس أرقام الحالة — قرارٌ مقصود: KPIs مالٍ/تأخّرٍ
              // تُحدَّد على الحالة الحقيقية، والانقسام العرضي بحسب الإسناد.
              // في التجميع غير stage: KPIs الخادم لا تُطابق ⇒ نُخفيها (تُشتقّ لاحقاً بمجموعِ list).
              // Codex #4 (الجولة ٢): وأيضاً حين يُفعَّل أيّ فلترٍ عميليّ (pri/ch/dueToday/
              // unassigned/blocked) — رأس العمود كان يعرض قيماً على كامل الحالة فوق بطاقاتٍ
              // مرشَّحة سريعاً (تقاطعٌ أصغر) ⇒ الرقم يخالف ما تراه العين.
              const anyClientFilter =
                f.pri !== "all" || f.ch !== "all" ||
                f.dueToday === "1" || f.unassigned === "1" || f.blocked === "1" || f.late === "1";
              const colStats = groupBy === "stage" && !anyClientFilter ? serverCounts?.stats?.[s.status] : null;
              const showValue = colStats != null;
              return (
                <div className="wob-col" style={colVars(s.hue)} key={s.key}>
                  <div className="wob-col-head">
                    <span className="wob-col-pip" />
                    <div className="wob-col-head-txt">
                      <div className="wob-col-title">{s.label}</div>
                      <div className="wob-col-hint">{s.hint}</div>
                      {showValue && Number(colStats.totalValue) > 0 && (
                        <div className="wob-col-kpis">
                          <span className="wob-col-kpi wob-col-kpi-value" title="مجموع قيمة العمل الجاري في هذا العمود">
                            {fmtAr(colStats.totalValue)} <span className="wob-ml">د.ع</span>
                          </span>
                          {colStats.late > 0 && s.status !== "DELIVERED" && (
                            <span className="wob-col-kpi wob-col-kpi-late" title="أوامرُ فات موعد استحقاقها">
                              <Timer aria-hidden className="size-3" /> {fmtInt(colStats.late)} متأخّر
                            </span>
                          )}
                          {colStats.blocked > 0 && s.status !== "DELIVERED" && (
                            <span className="wob-col-kpi wob-col-kpi-blocked" title="أوامرٌ أشار الفنّيّ إلى تعطّلها">
                              <AlertTriangle aria-hidden className="size-3" /> {fmtInt(colStats.blocked)} معطَّل
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                    {/* عمود «مُسلَّم» يعرض نافذة الأحدث فقط — العدّاد من الخادم يحمل الإجمالي الحقيقي.
                        يُستعمل فقط حين لا ترشيح عميلي (أولوية/قناة) وإلا خالف العدّادُ المحتوى المعروض. */}
                    <span className="wob-col-count">
                      {s.key === "DELIVERED" && serverCounts != null && f.pri === "all" && f.ch === "all"
                        ? fmtInt(serverCounts.delivered)
                        : list.length}
                    </span>
                  </div>
                  <div className={`wob-col-body ${isOver ? "wob-drop-on" : ""}`} ref={(el) => { colRefs.current[s.key] = el; }}>
                    {list.map((o) => (
                      <Card
                        key={o.id}
                        o={o}
                        dragging={!!drag && drag.order.id === o.id}
                        // النقر يفتح Drawer دائماً؛ السحب يعمل في «حسب المرحلة» فقط (`dndEnabled` داخل onCardPointerDown).
                        onPointerDown={(e) => onCardPointerDown(e, o)}
                        // إسناد inline لعَمود INBOX فَقط (مَدير + بَيانات الفنّيين جاهزة) per README §5.2.
                        inboxAssign={
                          s.key === "INBOX" && isManager && (assignableStaff.data?.length ?? 0) > 0
                            ? (orderId, staffId) => {
                                // بلا تأكيد — العَملية رَخيصة وعَكسية (يُمكن إعادة الإسناد بَعدها).
                                assign.mutate({ workOrderId: orderId, assignedTo: staffId });
                              }
                            : undefined
                        }
                        staff={s.key === "INBOX" && isManager ? assignableStaff.data : undefined}
                        assignPending={assign.isPending}
                        onOpenCustomer={canReadCustomerContext ? setCustomerContextId : undefined}
                        // Codex #6: النقطة تفاعليّة لمن يستطيع الكتابة فقط؛ لغيرهم تُعرض قراءةً
                        // (عرضاً غير-NORMAL فقط — بلا زرّ يفشل بـFORBIDDEN).
                        onCycleKanban={canSetKanban ? ((orderId, current) => onCycleKanbanState(orderId, current)) : undefined}
                        kanbanBusy={setKanban.isPending}
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
          <Card o={drag.order} ghost />
        </div>
      )}

      {sel != null && (
        <Drawer
          id={sel}
          onClose={() => setSel(null)}
          isManager={isManager}
          canDeliver={canDeliver}
          busy={busy}
          onAdvance={async (id, to) => {
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

      <DeliverDialog
        order={deliverOrder}
        pending={deliver.isPending}
        onClose={() => setDeliverOrder(null)}
        onConfirm={async (payment) => {
          if (!deliverOrder) return;
          if (!(await confirm({ variant: "danger", title: "تسليم الأمر وإصدار الفاتورة", description: `تسليم «${deliverOrder.title}» (${deliverOrder.orderNumber}) يُصدر فاتورة نهائية بمبلغ ${fmtAr(deliverOrder.salePrice)} د.ع ويحدّث المخزون والذمم — لا رجعة فيه. اكتب «تسليم» للتأكيد.`, confirmText: "تسليم وإصدار الفاتورة", cancelText: "تراجع", requireText: "تسليم" }))) return;
          deliver.mutate({ workOrderId: deliverOrder.id, payment });
        }}
      />
      <EditWorkOrderDialog
        workOrderId={editTarget}
        onClose={() => setEditTarget(null)}
        onSaved={() => { setEditTarget(null); invalidateAll(); }}
      />
      <BlockedReasonDialog
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
