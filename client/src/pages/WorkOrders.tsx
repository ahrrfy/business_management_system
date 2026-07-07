import "./WorkOrders.board.css";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { AlertTriangle, Calendar, CheckCircle2, ChevronRight, FileText, Package, Printer, Receipt, Search, Timer, Wrench, X } from "lucide-react";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { moduleAccessAllowed, type PermissionMap, type RoleKey } from "@shared/permissions";
import { notify } from "@/lib/notify";
import { confirm } from "@/lib/confirm";
import { exportRows } from "@/lib/export";
import { fmtAr, fmtInt } from "@/lib/money";
import { fmtDate, fmtDateTime } from "@/lib/date";
import { printWorkOrder } from "@/lib/printing/printTemplates";
import { printWorkOrderReceipt } from "@/lib/printing/print";
import { RowActions } from "@/components/list";
import { CopyInline } from "@/components/CopyButton";
import { CopyAsMenu } from "@/lib/copy/CopyAsMenu";
import { formatWorkOrderAsWhatsApp } from "@/lib/copy/formatters";
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

// ── المراحل (أعمدة الكانبان) — مطابقة لحالات النظام الحقيقية ──
const STATUSES: { key: Status; label: string; hint: string; hue: number }[] = [
  { key: "RECEIVED", label: "مُستلَم", hint: "بانتظار البدء", hue: 72 },
  { key: "IN_PROGRESS", label: "قيد التنفيذ", hint: "تحت الإنتاج الآن", hue: 250 },
  { key: "READY", label: "جاهز للتسليم", hint: "جاهز — بانتظار العميل", hue: 293 },
  { key: "DELIVERED", label: "مُسلَّم", hint: "اكتمل وصدرت الفاتورة", hue: 155 },
];
const STATUS_LABEL: Record<string, string> = {
  RECEIVED: "مُستلَم", IN_PROGRESS: "قيد التنفيذ", READY: "جاهز للتسليم", DELIVERED: "مُسلَّم", CANCELLED: "ملغى",
};
const STATUS_HUE: Record<string, number> = { RECEIVED: 72, IN_PROGRESS: 250, READY: 293, DELIVERED: 155 };
const STAGE_INDEX: Record<string, number> = { RECEIVED: 0, IN_PROGRESS: 1, READY: 2, DELIVERED: 3 };
const NEXT: Record<string, Status> = { RECEIVED: "IN_PROGRESS", IN_PROGRESS: "READY", READY: "DELIVERED" };
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
  { key: "DELIVERED", label: "مُسلَّم", hint: "اكتمل وصدرت الفاتورة", hue: 155, status: "DELIVERED", match: (o) => o.status === "DELIVERED" },
];

const CHANNELS: Record<string, { label: string; icon: string }> = {
  WHATSAPP: { label: "واتساب", icon: "💬" },
  INSTAGRAM: { label: "انستغرام", icon: "📷" },
  TIKTOK: { label: "تيك توك", icon: "🎵" },
  PHONE: { label: "اتصال", icon: "📞" },
  WALK_IN: { label: "عميل نقدي", icon: "🏪" },
  OTHER: { label: "أخرى", icon: "✳️" },
};
const PRIORITIES: Record<string, { label: string; cls: string; rank: number }> = {
  URGENT: { label: "عاجل", cls: "wob-urgent", rank: 3 },
  NORMAL: { label: "عادي", cls: "wob-normal", rank: 2 },
  LOW: { label: "منخفض", cls: "wob-low", rank: 1 },
};
const TL_LABEL: Record<string, string> = {
  "workOrder.create": "استُلم الطلب",
  "workOrder.start": "بدأ التنفيذ — خُصمت المواد",
  "workOrder.markReady": "جاهز للتسليم",
  "workOrder.deliver": "سُلّم وصدرت الفاتورة",
  "workOrder.cancel": "أُلغي الأمر",
  "workOrder.assign": "أُعيد الإسناد",
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
function dueInfo(o: { status: string; dueDate: unknown }): { state: "done" | "ok" | "soon" | "late"; text: string } {
  if (o.status === "DELIVERED") return { state: "done", text: "سُلّم" };
  if (!o.dueDate) return { state: "ok", text: "بلا موعد" };
  const due = new Date(String(o.dueDate).slice(0, 10) + "T00:00:00");
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dueDay = new Date(due.getFullYear(), due.getMonth(), due.getDate());
  const days = Math.round((dueDay.getTime() - today.getTime()) / 864e5);
  if (days < 0) return { state: "late", text: days === -1 ? "متأخر يوم" : `متأخر ${Math.abs(days)} يوم` };
  if (days === 0) return { state: "soon", text: "يستحق اليوم" };
  if (days === 1) return { state: "soon", text: "غداً" };
  return { state: "ok", text: `باقٍ ${days} يوم` };
}
function isLate(o: { status: string; dueDate: unknown }) { return dueInfo(o).state === "late"; }
function progressOf(status: string) { const i = STAGE_INDEX[status] ?? 0; return { idx: i, pct: Math.round((i / 3) * 100) }; }
function waUrl(phone: string, customer: string | null, o: { orderNumber: string; title: string; status: string; dueDate: unknown }) {
  const msg = encodeURIComponent(
    `مرحباً ${customer ?? ""}،\nطلب خدمة رقم: ${o.orderNumber}\nالعمل: ${o.title}\nالحالة: ${STATUS_LABEL[o.status] ?? o.status}\nالاستحقاق: ${o.dueDate ? String(o.dueDate).slice(0, 10) : "—"}\nشكراً — المطبعة`
  );
  return `https://wa.me/${String(phone).replace(/[^\d]/g, "")}?text=${msg}`;
}

const WaIcon = ({ size = 13 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
  </svg>
);

// ─────────────── البطاقة ───────────────
/** طباعة طلب الخدمة من بيانات البطاقة — نفس قالب printWorkOrder المستعمل في الـDrawer
 *  (صف القائمة بلا customizationText فتُطبع التذكرة بلا حقل التخصيص فقط). */
function printWoFromCard(o: WO) {
  printWorkOrder({
    woNumber: o.orderNumber,
    woDate: o.createdAt ? String(o.createdAt).slice(0, 10) : undefined,
    dueDate: o.dueDate ? String(o.dueDate).slice(0, 10) : undefined,
    status: o.status,
    customerName: o.customerName,
    customerPhone: o.customerPhone,
    jobType: o.title,
    items: [{ name: `${o.title} (${o.quantity} نسخة)`, unit: "مهمة", quantity: 1, unitPrice: o.salePrice, total: o.salePrice }],
    subtotal: o.salePrice,
    total: o.salePrice,
  });
}

/** طباعة حرارية 80مم لطلب الخدمة من بيانات البطاقة — نفس مسار التذكرة (جسر/WebUSB/متصفّح). */
function printWoThermalFromCard(o: WO) {
  void printWorkOrderReceipt({
    orderNumber: o.orderNumber,
    orderDate: o.createdAt ? String(o.createdAt).slice(0, 10) : undefined,
    dueDate: o.dueDate ? String(o.dueDate).slice(0, 10) : undefined,
    status: o.status,
    customerName: o.customerName ?? undefined,
    customerPhone: o.customerPhone ?? undefined,
    jobTitle: o.title,
    quantity: o.quantity ? `${o.quantity} نسخة` : undefined,
    total: o.salePrice,
  });
}

function Card({ o, onPointerDown, dragging, ghost, inboxAssign, staff, assignPending }: {
  o: WO;
  onPointerDown?: (e: React.PointerEvent) => void;
  dragging?: boolean;
  ghost?: boolean;
  /** عند توفّره: تظهر شريط الإسناد inline في عَمود «طابور وارد» (مَدير فَقط). */
  inboxAssign?: (orderId: number, staffId: number) => void;
  /** بَيانات الفنّيين من `assignableStaff` (name قد يَكون null في DB ⇒ يُعرَض «بلا اسم»). */
  staff?: { id: number; name: string | null; role: string }[];
  assignPending?: boolean;
}) {
  const pr = progressOf(o.status);
  const di = dueInfo(o);
  const ch = CHANNELS[o.receptionChannel ?? "WALK_IN"] ?? CHANNELS.OTHER;
  const pri = PRIORITIES[o.priority ?? "NORMAL"] ?? PRIORITIES.NORMAL;
  const hue = STATUS_HUE[o.status] ?? 255;
  const late = di.state === "late";
  const cls = ["wob-card", late ? "wob-late" : "", dragging ? "wob-dragging" : "", ghost ? "wob-ghost" : ""].filter(Boolean).join(" ");
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
        <span className="wob-ch-chip" title={`القناة: ${ch.label}`}>
          <span aria-hidden>{ch.icon}</span>
          <span className="wob-ch-chip-l">{ch.label}</span>
        </span>
        <span className={`wob-pri ${pri.cls}`}><span className="wob-pri-dot" />{pri.label}</span>
        {!ghost && (
          // إيقاف انتشار pointer/click كي لا يلتقطها محرّك السحب أو فتح الـDrawer
          <span onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
            <RowActions
              mode="menu"
              label={`إجراءات ${o.orderNumber}`}
              actions={[
                { key: "print", label: "طباعة A4", onSelect: () => printWoFromCard(o) },
                { key: "print-thermal", label: "طباعة حرارية (80مم)", onSelect: () => printWoThermalFromCard(o) },
                { key: "open", label: "فتح التفاصيل", href: `/work-orders/${o.id}` },
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
        </div>
      </div>
      <div className="wob-meta">
        <span className="wob-meta-pill"><span className="wob-ml">الكمية </span>{fmtInt(o.quantity)}</span>
        <span className="wob-meta-pill"><span className="wob-ml">السعر </span>{fmtAr(o.salePrice)} <span className="wob-ml">د.ع</span></span>
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
        {o.customerPhone && (
          <a className="wob-wa" href={waUrl(o.customerPhone, o.customerName, o)} target="_blank" rel="noopener noreferrer"
            title={`واتساب: ${o.customerName ?? ""}`} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
            <WaIcon />
          </a>
        )}
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
            <option value="">— اختر فنّياً —</option>
            {staff.map((s) => (
              <option key={s.id} value={s.id}>{s.name ?? "بلا اسم"}{s.role ? ` — ${s.role}` : ""}</option>
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
function Stats({ orders }: { orders: WO[] }) {
  const active = orders.filter((o) => o.status !== "DELIVERED" && o.status !== "CANCELLED").length;
  const late = orders.filter((o) => isLate(o)).length;
  const inProg = orders.filter((o) => o.status === "IN_PROGRESS").length;
  const ready = orders.filter((o) => o.status === "READY").length;
  const delivered = orders.filter((o) => o.status === "DELIVERED").length;
  const cards: { c: string; label: React.ReactNode; val: number; sub: string }[] = [
    { c: "var(--primary)", label: (<><Receipt aria-hidden className="size-4 inline-block align-text-bottom me-1" /> أوامر نشطة</>), val: active, sub: "قيد المعالجة الآن" },
    { c: "oklch(0.577 0.245 27.325)", label: (<><Timer aria-hidden className="size-4 inline-block align-text-bottom me-1" /> متأخرة عن الاستحقاق</>), val: late, sub: "تحتاج تدخّلاً فورياً" },
    { c: "oklch(0.60 0.16 250)", label: (<><Wrench aria-hidden className="size-4 inline-block align-text-bottom me-1" /> قيد التنفيذ</>), val: inProg, sub: "تحت الإنتاج" },
    { c: "oklch(0.58 0.22 293)", label: (<><CheckCircle2 aria-hidden className="size-4 inline-block align-text-bottom me-1" /> جاهز للتسليم</>), val: ready, sub: "بانتظار العميل" },
    { c: "oklch(0.62 0.16 155)", label: (<><Package aria-hidden className="size-4 inline-block align-text-bottom me-1" /> مُسلَّم</>), val: delivered, sub: "اكتمل وصدرت الفاتورة" },
  ];
  return (
    <div className="wob-stats">
      {cards.map((s, i) => (
        <div className="wob-stat" key={i} style={{ ["--stat-c" as string]: s.c } as React.CSSProperties}>
          <div className="wob-stat-label">{s.label}</div>
          <div className="wob-stat-val">{fmtInt(s.val)}</div>
          <div className="wob-stat-sub">{s.sub}</div>
        </div>
      ))}
    </div>
  );
}

// ─────────────── حوار التسليم (مالي — تأكيد صريح) ───────────────
const dlgInput = "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
function DeliverDialog({ order, onClose, onConfirm, pending }: { order: DeliverTarget | null; onClose: () => void; onConfirm: (payment?: { amount: string; method: "CASH" | "CARD" | "CHECK" | "TRANSFER" | "WALLET" }) => void; pending: boolean }) {
  const [amount, setAmount] = useState("");
  const [methodV, setMethodV] = useState<"CASH" | "CARD" | "CHECK" | "TRANSFER" | "WALLET">("CASH");
  useEffect(() => {
    if (order) {
      // تعبئة المتبقّي تلقائياً = سعر البيع − العربون المقبوض (لا طرح يدويّ من الموظّف).
      const dueInit = Math.max(0, Number(order.salePrice) - Number(order.deposit ?? 0));
      setAmount(dueInit > 0 ? String(dueInit) : "");
      setMethodV("CASH");
    }
  }, [order?.id]); // eslint-disable-line
  if (!order) return null;
  const amt = Number(amount);
  const dep = Number(order.deposit ?? 0);
  const due = Math.max(0, Number(order.salePrice) - dep);
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
            {dep > 0 && <div className="flex justify-between"><span className="text-muted-foreground">العربون المقبوض</span><span dir="ltr" className="tabular-nums text-emerald-600">−{fmtAr(dep)} د.ع</span></div>}
            <div className="flex justify-between border-t pt-1 font-bold"><span>الرصيد المستحق</span><span dir="ltr" className="tabular-nums">{fmtAr(due)} د.ع</span></div>
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium">المبلغ المدفوع الآن (الافتراضي = الرصيد المستحق؛ أقل = آجل)</label>
            <input dir="ltr" inputMode="decimal" className={dlgInput} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={`0 – ${fmtAr(due)}`} />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium">طريقة الدفع</label>
            <select className={dlgInput} value={methodV} onChange={(e) => setMethodV(e.target.value as typeof methodV)}>
              <option value="CASH">نقدي</option>
              <option value="CARD">بطاقة</option>
              <option value="TRANSFER">تحويل</option>
              <option value="WALLET">محفظة</option>
            </select>
          </div>
        </div>
        <DialogFooter>
          <button className="wob-btn wob-btn-ghost" onClick={onClose} disabled={pending}>إلغاء</button>
          <button className="wob-btn wob-btn-primary" disabled={pending}
            onClick={() => onConfirm(amt > 0 ? { amount: String(amt), method: methodV } : undefined)}>
            {pending ? "جارٍ…" : "تسليم وإصدار الفاتورة"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─────────────── لوحة التفاصيل (Drawer) ───────────────
function Drawer({
  id, onClose, isManager, canDeliver, onAdvance, onCancel, onDeliver, onAssign, busy,
}: {
  id: number; onClose: () => void; isManager: boolean; canDeliver: boolean;
  onAdvance: (id: number, to: Status) => void; onCancel: (d: Detail) => void;
  onDeliver: (d: Detail) => void; onAssign: (id: number, staffId: number | null) => void; busy: boolean;
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
  const ch = d ? (CHANNELS[d.receptionChannel ?? "WALK_IN"] ?? CHANNELS.OTHER) : null;
  const pri = d ? (PRIORITIES[d.priority ?? "NORMAL"] ?? PRIORITIES.NORMAL) : null;
  const next = d ? NEXT[d.status] : undefined;
  const hue = d ? (STATUS_HUE[d.status] ?? 255) : 255;
  const cur = d ? (STAGE_INDEX[d.status] ?? 0) : 0;

  // أحداث الخط الزمني: من سجلّ التدقيق إن توفّر، وإلا اشتقاق صادق من الطوابع.
  const tlRows = timeline.data ?? [];
  const tlItems = tlRows.length
    ? tlRows.map((r) => ({ ev: TL_LABEL[r.action] ?? r.action, at: r.createdAt, by: r.userName as string | null }))
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
                <span className="wob-meta-pill" style={{ background: `oklch(0.6 0.17 ${hue} / 0.13)`, color: `oklch(0.45 0.17 ${hue})`, display: "inline-flex", alignItems: "center", gap: 6 }}><span className="inline-block size-2 rounded-full" style={{ background: `oklch(0.45 0.17 ${hue})` }} />{STATUS_LABEL[d.status]}</span>
                {pri && <span className={`wob-pri ${pri.cls}`}><span className="wob-pri-dot" />{pri.label}</span>}
                {di && <span className={`wob-due wob-${di.state}`} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>{di.state === "late" ? <Timer aria-hidden className="size-3.5" /> : <Calendar aria-hidden className="size-3.5" />} {di.text}</span>}
              </div>
            </div>

            <div className="wob-dr-body">
              <div>
                <div className="wob-kv">
                  <div><div className="wob-k">العميل</div><div className="wob-v">{d.customerName ?? "عميل نقدي"}</div></div>
                  <div><div className="wob-k">قناة الاستلام</div><div className="wob-v">{ch?.icon} {ch?.label}{d.channelHandle ? ` · ${d.channelHandle}` : ""}</div></div>
                  <div><div className="wob-k">الكمية</div><div className="wob-v">{fmtInt(d.quantity)}</div></div>
                  <div><div className="wob-k">سعر البيع</div><div className="wob-v" style={{ direction: "ltr", textAlign: "right" }}>{fmtAr(d.salePrice)} د.ع</div></div>
                  {Number(d.deposit ?? 0) > 0 && <div><div className="wob-k">العربون</div><div className="wob-v" style={{ direction: "ltr", textAlign: "right" }}>{fmtAr(d.deposit)} د.ع</div></div>}
                  <div><div className="wob-k">الاستحقاق</div><div className="wob-v">{fmtDate(d.dueDate)}</div></div>
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
                  status: STATUS_LABEL[d.status] ?? d.status,
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
                  status: STATUS_LABEL[d.status] ?? d.status,
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
                customerName: d.customerName,
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
                  customerName: d.customerName ?? undefined,
                  customerPhone: d.customerPhone ?? undefined,
                  jobTitle: d.title,
                  quantity: d.quantity ? `${d.quantity} نسخة` : undefined,
                  specs: d.customizationText ?? undefined,
                  total: d.salePrice,
                })}
              ><Receipt aria-hidden className="size-4 inline-block align-text-bottom me-1" /> حراري 80مم</button>
              {d.customerPhone && (
                <a className="wob-wa-lg" href={waUrl(d.customerPhone, d.customerName, d)} target="_blank" rel="noopener noreferrer"><WaIcon size={18} /> راسل العميل</a>
              )}
              {next ? (next !== "DELIVERED" || canDeliver) && (
                <button className="wob-btn wob-btn-primary" style={{ flex: 1 }} disabled={busy}
                  onClick={() => (next === "DELIVERED" ? onDeliver(d) : onAdvance(d.id, next))}>{ADV_LABEL[next]}</button>
              ) : (
                <button className="wob-btn wob-btn-ghost" disabled style={{ flex: 1, opacity: 0.6 }}><CheckCircle2 aria-hidden className="size-4 inline-block align-text-bottom me-1" /> اكتمل الأمر</button>
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

// ─────────────── الصفحة ───────────────
export default function WorkOrders() {
  const listInput = { limit: 200 };
  const rows = trpc.workOrders.list.useQuery(listInput);
  const me = trpc.auth.me.useQuery();
  const utils = trpc.useUtils();
  const isManager = me.data?.role === "admin" || me.data?.role === "manager";
  // مرآة بوّابة الخادم: deliver = workordersCashierProcedure(["cashier","manager"], "workorders", "FULL") —
  // فنّي المطبعة (workordersExecProcedure) يقدّم المراحل لكن التسليم/الفوترة مال ونقد (كاشير/مدير أو منح صريح).
  // بنفس دالة الخادم moduleAccessAllowed (لا قائمة أدوار حرفية) ⇒ لا تباعُد.
  const canDeliver = !!me.data?.role &&
    moduleAccessAllowed(me.data.role as RoleKey, (me.data.permissionsOverride ?? null) as PermissionMap | null, "workorders", "FULL", ["cashier", "manager"]);
  // قائمة الموظَّفين القابِلين للإسناد — مَرفوعة لصَفحة WorkOrders كَي تُستعمَل
  // في الإسناد inline على بطاقات «طابور وارد» (بَدل فَتح الـDrawer لِكل أَمر).
  // مَفعَّلة لِلمَدير فَقط لِتَوافق صَلاحية `assignableStaff` على الخادم.
  const assignableStaff = trpc.workOrders.assignableStaff.useQuery(undefined, { enabled: isManager });

  const [q, setQ] = useState("");
  const [fPri, setFPri] = useState("");
  const [fCh, setFCh] = useState("");
  const [sel, setSel] = useState<number | null>(null);
  const [deliverOrder, setDeliverOrder] = useState<DeliverTarget | null>(null);
  const [drag, setDrag] = useState<{ order: WO; x: number; y: number; overCol: string | null } | null>(null);

  const colRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const dragRef = useRef<{ order: WO; startX: number; startY: number; ox: number; oy: number; moved: boolean } | null>(null);

  const invalidateAll = () => Promise.all([
    utils.workOrders.list.invalidate(),
    utils.workOrders.get.invalidate(),
    utils.workOrders.timeline.invalidate(),
    utils.inventory.movements.invalidate(),
  ]);
  const optimisticMove = (id: number, to: Status) =>
    utils.workOrders.list.setData(listInput, (old) => old?.map((o) => (o.id === id ? { ...o, status: to } : o)));

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
    onSuccess: () => { notify.ok("أُلغي الأمر", "أُعيدت المواد للمخزون إن وُجدت."); setSel(null); invalidateAll(); },
    onError: (e) => { notify.err(e); invalidateAll(); },
  });
  const assign = trpc.workOrders.assign.useMutation({
    onSuccess: () => { notify.ok("تم تحديث الإسناد"); invalidateAll(); },
    onError: (e) => { notify.err(e); invalidateAll(); },
  });
  const busy = start.isPending || markReady.isPending || deliver.isPending || cancel.isPending || assign.isPending;

  const all = rows.data ?? [];
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return all.filter((o) => {
      if (fPri && o.priority !== fPri) return false;
      if (fCh && o.receptionChannel !== fCh) return false;
      if (needle) {
        const hay = [o.orderNumber, o.title, o.customerName ?? ""].join(" ").toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [all, q, fPri, fCh]);

  const byCol = useMemo(() => {
    const m: Record<string, WO[]> = {};
    COLUMNS.forEach((c) => (m[c.key] = []));
    filtered.forEach((o) => {
      const col = COLUMNS.find((c) => c.match(o));
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
  }, [filtered]);

  // ── الانتقال بين المراحل (الخطوة التالية فقط — التسليم خلف تأكيد مالي) ──
  async function attemptMove(order: WO, to: Status) {
    if (NEXT[order.status] !== to) {
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

  async function onCancelOrder(d: Detail) {
    if (!(await confirm({ variant: "danger", title: "إلغاء طلب الخدمة", description: `إلغاء «${d.title}» (${d.orderNumber})؟ تُعكَس المواد المخصومة للمخزون.`, confirmText: "إلغاء الطلب", cancelText: "تراجع" }))) return;
    cancel.mutate({ workOrderId: d.id });
  }

  const anyFilter = q || fPri || fCh;
  const boardEmpty = filtered.length === 0;

  return (
    <div className="wob">
      <div className="wob-topbar">
        <div>
          <div className="wob-title">طلبات خدمة العملاء</div>
          <div className="wob-sub">من الاستلام إلى التسليم — اسحب البطاقة بين المراحل. فاتورة تلقائية عند التسليم.</div>
        </div>
        <div className="wob-head-actions">
          <button className="wob-btn wob-btn-ghost" disabled={filtered.length === 0}
            onClick={() => exportRows(filtered, {
              filename: "طلبات-خدمة-العملاء",
              columns: [
                { key: "orderNumber", header: "رقم الأمر" },
                { key: "title", header: "العنوان" },
                { key: "customerName", header: "العميل", map: (r) => r.customerName ?? "" },
                { key: "quantity", header: "الكمية", map: (r) => Number(r.quantity ?? 0) },
                { key: "salePrice", header: "السعر", map: (r) => Number(r.salePrice ?? 0) },
                { key: "dueDate", header: "الاستحقاق", map: (r) => (r.dueDate ? String(r.dueDate).slice(0, 10) : "") },
                { key: "priority", header: "الأولوية", map: (r) => PRIORITIES[r.priority ?? "NORMAL"]?.label ?? "" },
                { key: "receptionChannel", header: "القناة", map: (r) => CHANNELS[r.receptionChannel ?? "WALK_IN"]?.label ?? "" },
                { key: "assigneeName", header: "المسؤول", map: (r) => r.assigneeName ?? "" },
                { key: "status", header: "الحالة", map: (r) => STATUS_LABEL[r.status] ?? r.status },
              ],
            })}><FileText aria-hidden className="size-4 inline-block align-text-bottom me-1" /> تصدير Excel</button>
          <Link href="/work-orders/new" className="wob-btn wob-btn-primary">＋ طلب خدمة جديد</Link>
        </div>
      </div>

      <Stats orders={all} />

      <div className="wob-toolbar">
        <div className="wob-search">
          <span className="wob-si"><Search aria-hidden className="size-4" /></span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="بحث (رقم / عنوان / عميل)" />
        </div>
        <select className="wob-sel" value={fPri} onChange={(e) => setFPri(e.target.value)}>
          <option value="">كل الأولويات</option>
          {Object.entries(PRIORITIES).map(([k, p]) => <option key={k} value={k}>{p.label}</option>)}
        </select>
        <select className="wob-sel" value={fCh} onChange={(e) => setFCh(e.target.value)}>
          <option value="">كل القنوات</option>
          {Object.entries(CHANNELS).map(([k, c]) => <option key={k} value={k}>{c.icon} {c.label}</option>)}
        </select>
        {anyFilter && <button className="wob-chip-clear" onClick={() => { setQ(""); setFPri(""); setFCh(""); }}>مسح الفلاتر <X aria-hidden className="size-3.5 inline-block align-text-bottom" /></button>}
      </div>

      <div className="wob-board-wrap">
        {rows.isLoading ? (
          <div className="wob-empty-board">جارٍ التحميل…</div>
        ) : boardEmpty ? (
          <div className="wob-empty-board">{anyFilter ? "لا طلبات مطابقة للبحث/الفلاتر الحالية." : "لا طلبات خدمة بعد. ابدأ بـ«طلب خدمة جديد»."}</div>
        ) : (
          <div className="wob-board">
            {COLUMNS.map((s) => {
              const list = byCol[s.key] ?? [];
              const isOver = drag && drag.overCol === s.key && NEXT[drag.order.status] === s.status;
              return (
                <div className="wob-col" style={colVars(s.hue)} key={s.key}>
                  <div className="wob-col-head">
                    <span className="wob-col-pip" />
                    <div className="wob-col-head-txt">
                      <div className="wob-col-title">{s.label}</div>
                      <div className="wob-col-hint">{s.hint}</div>
                    </div>
                    <span className="wob-col-count">{list.length}</span>
                  </div>
                  <div className={`wob-col-body ${isOver ? "wob-drop-on" : ""}`} ref={(el) => { colRefs.current[s.key] = el; }}>
                    {list.map((o) => (
                      <Card
                        key={o.id}
                        o={o}
                        dragging={!!drag && drag.order.id === o.id}
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

      {drag && (
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
          onAssign={async (id, staffId) => {
            if (!(await confirm({ variant: "info", title: "تغيير إسناد الأمر", description: staffId ? "إسناد هذا الأمر إلى الموظف المحدّد. متابعة؟" : "إلغاء إسناد هذا الأمر (سيصبح غير مُسنَد). متابعة؟", confirmText: "تأكيد الإسناد", cancelText: "تراجع" }))) return;
            assign.mutate({ workOrderId: id, assignedTo: staffId });
          }}
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
    </div>
  );
}
