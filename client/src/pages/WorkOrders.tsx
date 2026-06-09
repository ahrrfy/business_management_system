import "./WorkOrders.board.css";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { notify } from "@/lib/notify";
import { confirm } from "@/lib/confirm";
import { exportRows } from "@/lib/export";
import { printWorkOrder } from "@/lib/printing/printTemplates";
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
type DeliverTarget = { id: number; orderNumber: string; title: string; salePrice: string };

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
const ADV_LABEL: Record<string, string> = {
  IN_PROGRESS: "▶ بدء التنفيذ (خصم المواد)", READY: "✓ وضع علامة: جاهز", DELIVERED: "📦 تسليم وإصدار فاتورة",
};

const CHANNELS: Record<string, { label: string; icon: string }> = {
  WHATSAPP: { label: "واتساب", icon: "💬" },
  INSTAGRAM: { label: "انستغرام", icon: "📷" },
  TIKTOK: { label: "تيك توك", icon: "🎵" },
  PHONE: { label: "اتصال", icon: "📞" },
  WALK_IN: { label: "زبون مباشر", icon: "🏪" },
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

const fmtN = (n: string | number | null | undefined) =>
  Number(n ?? 0).toLocaleString("en-US", { maximumFractionDigits: 0 });
const fmtDT = (d: string | number | Date) =>
  new Date(d).toLocaleString("en-GB", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: true });

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
    `مرحباً ${customer ?? ""}،\nأمر شغل رقم: ${o.orderNumber}\nالعمل: ${o.title}\nالحالة: ${STATUS_LABEL[o.status] ?? o.status}\nالاستحقاق: ${o.dueDate ? String(o.dueDate).slice(0, 10) : "—"}\nشكراً — المطبعة`
  );
  return `https://wa.me/${String(phone).replace(/[^\d]/g, "")}?text=${msg}`;
}

const WaIcon = ({ size = 13 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
  </svg>
);

// ─────────────── البطاقة ───────────────
function Card({ o, onPointerDown, dragging, ghost }: { o: WO; onPointerDown?: (e: React.PointerEvent) => void; dragging?: boolean; ghost?: boolean }) {
  const pr = progressOf(o.status);
  const di = dueInfo(o);
  const ch = CHANNELS[o.receptionChannel ?? "WALK_IN"] ?? CHANNELS.OTHER;
  const pri = PRIORITIES[o.priority ?? "NORMAL"] ?? PRIORITIES.NORMAL;
  const hue = STATUS_HUE[o.status] ?? 255;
  const late = di.state === "late";
  const cls = ["wob-card", late ? "wob-late" : "", dragging ? "wob-dragging" : "", ghost ? "wob-ghost" : ""].filter(Boolean).join(" ");
  return (
    <div className={cls} style={{ ["--accent" as string]: `oklch(0.6 0.17 ${hue})` } as React.CSSProperties} onPointerDown={onPointerDown}>
      <div className="wob-card-top">
        <span className="wob-num">{o.orderNumber}</span>
        <span className={`wob-pri ${pri.cls}`}><span className="wob-pri-dot" />{pri.label}</span>
      </div>
      <div className="wob-card-body">
        <div className="wob-thumb" style={{ background: `oklch(0.6 0.15 ${hue})` }}>
          {o.thumbnailUrl ? <img src={o.thumbnailUrl} alt="" /> : <span className="wob-thumb-abbr" style={{ fontSize: 22 }}>🖨</span>}
        </div>
        <div className="wob-info">
          <div className="wob-card-title">{o.title}</div>
          <div className="wob-cust"><span className="wob-ch" title={ch.label}>{ch.icon}</span>{o.customerName ?? "عميل عابر"}</div>
        </div>
      </div>
      <div className="wob-meta">
        <span className="wob-meta-pill"><span className="wob-ml">الكمية </span>{fmtN(o.quantity)}</span>
        <span className="wob-meta-pill"><span className="wob-ml">السعر </span>{fmtN(o.salePrice)} <span className="wob-ml">د.ع</span></span>
        <span className={`wob-due wob-${di.state}`} style={{ marginInlineStart: "auto" }}>{late ? "⏱" : "📅"} {di.text}</span>
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
  const cards = [
    { c: "var(--primary)", label: "🧾 أوامر نشطة", val: active, sub: "قيد المعالجة الآن" },
    { c: "oklch(0.577 0.245 27.325)", label: "⏱ متأخرة عن الاستحقاق", val: late, sub: "تحتاج تدخّلاً فورياً" },
    { c: "oklch(0.60 0.16 250)", label: "🛠 قيد التنفيذ", val: inProg, sub: "تحت الإنتاج" },
    { c: "oklch(0.58 0.22 293)", label: "✅ جاهز للتسليم", val: ready, sub: "بانتظار العميل" },
    { c: "oklch(0.62 0.16 155)", label: "📦 مُسلَّم", val: delivered, sub: "اكتمل وصدرت الفاتورة" },
  ];
  return (
    <div className="wob-stats">
      {cards.map((s, i) => (
        <div className="wob-stat" key={i} style={{ ["--stat-c" as string]: s.c } as React.CSSProperties}>
          <div className="wob-stat-label">{s.label}</div>
          <div className="wob-stat-val">{s.val.toLocaleString("en-US")}</div>
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
  useEffect(() => { if (order) { setAmount(""); setMethodV("CASH"); } }, [order?.id]); // eslint-disable-line
  if (!order) return null;
  const amt = Number(amount);
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>تسليم وإصدار فاتورة</DialogTitle>
          <DialogDescription>
            الأمر «{order.title}» ({order.orderNumber}) — سعر البيع {fmtN(order.salePrice)} د.ع.
            سيُصدر فاتورة فوراً ويُحدَّث المخزون والذمم. هذا إجراء لا رجعة فيه.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 py-1">
          <div className="space-y-1">
            <label className="text-sm font-medium">المبلغ المدفوع الآن (اختياري — الباقي يُسجَّل آجلاً)</label>
            <input dir="ltr" inputMode="decimal" className={dlgInput} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={`0 – ${fmtN(order.salePrice)}`} />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium">طريقة الدفع</label>
            <select className={dlgInput} value={methodV} onChange={(e) => setMethodV(e.target.value as typeof methodV)}>
              <option value="CASH">نقد</option>
              <option value="CARD">بطاقة</option>
              <option value="TRANSFER">تحويل</option>
              <option value="CHECK">صك</option>
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
  id, onClose, isManager, onAdvance, onCancel, onDeliver, onAssign, busy,
}: {
  id: number; onClose: () => void; isManager: boolean;
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
      <div className="wob-drawer" role="dialog" aria-modal="true" aria-label="تفاصيل أمر الشغل">
        <button className="wob-dr-close" onClick={onClose} aria-label="إغلاق">✕</button>
        {!d ? (
          <div className="wob-dr-body"><div style={{ color: "var(--muted-fg)", textAlign: "center", padding: 40 }}>{detail.isLoading ? "جارٍ التحميل…" : "تعذّر العثور على الأمر."}</div></div>
        ) : (
          <>
            <div className="wob-dr-head">
              <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                <div className="wob-thumb" style={{ width: 48, height: 48, background: `oklch(0.6 0.15 ${hue})` }}>
                  {d.images?.[0]?.url ? <img src={d.images[0].url} alt="" /> : <span className="wob-thumb-abbr" style={{ fontSize: 20 }}>🖨</span>}
                </div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 11, color: "var(--muted-fg)", fontFamily: "ui-monospace, monospace", direction: "ltr", textAlign: "right" }}>{d.orderNumber}</div>
                  <div style={{ fontSize: 18, fontWeight: 800, lineHeight: 1.3 }}>{d.title}</div>
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap", alignItems: "center" }}>
                <span className="wob-meta-pill" style={{ background: `oklch(0.6 0.17 ${hue} / 0.13)`, color: `oklch(0.45 0.17 ${hue})` }}>● {STATUS_LABEL[d.status]}</span>
                {pri && <span className={`wob-pri ${pri.cls}`}><span className="wob-pri-dot" />{pri.label}</span>}
                {di && <span className={`wob-due wob-${di.state}`}>{di.state === "late" ? "⏱" : "📅"} {di.text}</span>}
              </div>
            </div>

            <div className="wob-dr-body">
              <div>
                <div className="wob-kv">
                  <div><div className="wob-k">العميل</div><div className="wob-v">{d.customerName ?? "عميل عابر"}</div></div>
                  <div><div className="wob-k">قناة الاستلام</div><div className="wob-v">{ch?.icon} {ch?.label}{d.channelHandle ? ` · ${d.channelHandle}` : ""}</div></div>
                  <div><div className="wob-k">الكمية</div><div className="wob-v">{fmtN(d.quantity)}</div></div>
                  <div><div className="wob-k">سعر البيع</div><div className="wob-v" style={{ direction: "ltr", textAlign: "right" }}>{fmtN(d.salePrice)} د.ع</div></div>
                  {Number(d.deposit ?? 0) > 0 && <div><div className="wob-k">العربون</div><div className="wob-v" style={{ direction: "ltr", textAlign: "right" }}>{fmtN(d.deposit)} د.ع</div></div>}
                  <div><div className="wob-k">الاستحقاق</div><div className="wob-v">{d.dueDate ? String(d.dueDate).slice(0, 10) : "—"}</div></div>
                  {d.materialsCost != null && <div><div className="wob-k">كلفة المواد</div><div className="wob-v" style={{ direction: "ltr", textAlign: "right" }}>{fmtN(d.materialsCost)} د.ع</div></div>}
                  {d.laborCost != null && <div><div className="wob-k">كلفة العمالة</div><div className="wob-v" style={{ direction: "ltr", textAlign: "right" }}>{fmtN(d.laborCost)} د.ع</div></div>}
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
                    <div className={`wob-stage-box ${i < cur ? "wob-on" : ""} ${i === cur ? "wob-cur" : ""}`}>{i < cur ? "✓" : i + 1}</div>
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
                      <div className="wob-tl-meta" style={{ direction: "ltr", textAlign: "right" }}>{fmtDT(e.at)}{e.by ? ` — ${e.by}` : ""}</div>
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
              })}>🖨️ طباعة</button>
              {d.customerPhone && (
                <a className="wob-wa-lg" href={waUrl(d.customerPhone, d.customerName, d)} target="_blank" rel="noopener noreferrer"><WaIcon size={18} /> راسل العميل</a>
              )}
              {next ? (
                <button className="wob-btn wob-btn-primary" style={{ flex: 1 }} disabled={busy}
                  onClick={() => (next === "DELIVERED" ? onDeliver(d) : onAdvance(d.id, next))}>{ADV_LABEL[next]}</button>
              ) : (
                <button className="wob-btn wob-btn-ghost" disabled style={{ flex: 1, opacity: 0.6 }}>✓ اكتمل الأمر</button>
              )}
              {isManager && d.status !== "DELIVERED" && d.status !== "CANCELLED" && (
                <button className="wob-btn wob-btn-danger" disabled={busy} onClick={() => onCancel(d)}>إلغاء الأمر</button>
              )}
              {d.status === "DELIVERED" && d.invoiceId && (
                <Link href="/invoices" className="wob-btn wob-btn-ghost">الفاتورة #{d.invoiceId}</Link>
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
    STATUSES.forEach((s) => (m[s.key] = []));
    filtered.forEach((o) => { if (m[o.status]) m[o.status].push(o); });
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
  function attemptMove(order: WO, to: Status) {
    if (NEXT[order.status] !== to) {
      notify.warn("انتقال غير مسموح", "اتبع التسلسل: مُستلَم ← قيد التنفيذ ← جاهز ← مُسلَّم.");
      return;
    }
    if (to === "IN_PROGRESS") { optimisticMove(order.id, "IN_PROGRESS"); start.mutate({ workOrderId: order.id }); }
    else if (to === "READY") { optimisticMove(order.id, "READY"); markReady.mutate({ workOrderId: order.id }); }
    else if (to === "DELIVERED") { setDeliverOrder({ id: order.id, orderNumber: order.orderNumber, title: order.title, salePrice: order.salePrice }); }
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
      const over = hitCol(ev.clientX, ev.clientY);
      setDrag(null);
      if (over && over !== dr.order.status) attemptMove(dr.order, over as Status);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  async function onCancelOrder(d: Detail) {
    if (!(await confirm({ variant: "danger", title: "إلغاء أمر الشغل", description: `إلغاء «${d.title}» (${d.orderNumber})؟ تُعكَس المواد المخصومة للمخزون.`, confirmText: "إلغاء الأمر", cancelText: "تراجع" }))) return;
    cancel.mutate({ workOrderId: d.id });
  }

  const anyFilter = q || fPri || fCh;
  const boardEmpty = filtered.length === 0;

  return (
    <div className="wob">
      <div className="wob-topbar">
        <div>
          <div className="wob-title">أوامر الشغل / المطبعة</div>
          <div className="wob-sub">من الاستلام إلى التسليم — اسحب البطاقة بين المراحل. فاتورة تلقائية عند التسليم.</div>
        </div>
        <div className="wob-head-actions">
          <button className="wob-btn wob-btn-ghost" disabled={filtered.length === 0}
            onClick={() => exportRows(filtered, {
              filename: "أوامر-الشغل",
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
            })}>📄 تصدير Excel</button>
          <Link href="/work-orders/new" className="wob-btn wob-btn-primary">＋ أمر شغل جديد</Link>
        </div>
      </div>

      <Stats orders={all} />

      <div className="wob-toolbar">
        <div className="wob-search">
          <span className="wob-si">🔍</span>
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
        {anyFilter && <button className="wob-chip-clear" onClick={() => { setQ(""); setFPri(""); setFCh(""); }}>مسح الفلاتر ✕</button>}
      </div>

      <div className="wob-board-wrap">
        {rows.isLoading ? (
          <div className="wob-empty-board">جارٍ التحميل…</div>
        ) : boardEmpty ? (
          <div className="wob-empty-board">{anyFilter ? "لا أوامر مطابقة للبحث/الفلاتر الحالية." : "لا أوامر شغل بعد. ابدأ بـ«أمر شغل جديد»."}</div>
        ) : (
          <div className="wob-board">
            {STATUSES.map((s) => {
              const list = byCol[s.key] ?? [];
              const isOver = drag && drag.overCol === s.key && drag.order.status !== s.key && NEXT[drag.order.status] === s.key;
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
                      <Card key={o.id} o={o} dragging={!!drag && drag.order.id === o.id} onPointerDown={(e) => onCardPointerDown(e, o)} />
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
          busy={busy}
          onAdvance={(id, to) => {
            if (to === "IN_PROGRESS") { optimisticMove(id, "IN_PROGRESS"); start.mutate({ workOrderId: id }); }
            else if (to === "READY") { optimisticMove(id, "READY"); markReady.mutate({ workOrderId: id }); }
          }}
          onDeliver={(d) => setDeliverOrder({ id: d.id, orderNumber: d.orderNumber, title: d.title, salePrice: d.salePrice })}
          onCancel={onCancelOrder}
          onAssign={(id, staffId) => assign.mutate({ workOrderId: id, assignedTo: staffId })}
        />
      )}

      <DeliverDialog
        order={deliverOrder}
        pending={deliver.isPending}
        onClose={() => setDeliverOrder(null)}
        onConfirm={(payment) => deliverOrder && deliver.mutate({ workOrderId: deliverOrder.id, payment })}
      />
    </div>
  );
}
