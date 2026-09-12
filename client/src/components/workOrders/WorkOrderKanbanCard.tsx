import { useState } from "react";
import type React from "react";
import { AppSelect } from "@/components/ui/AppSelect";
import { Calendar, ChevronRight, Package, Printer, Timer, Truck } from "lucide-react";
import { fmtAr, fmtInt } from "@/lib/money";
import { RowActions } from "@/components/list";
import { WhatsAppShare } from "@/components/WhatsAppShare";
import { ChannelMark } from "@/components/ChannelBadge";
import { receptionChannelLabel } from "@shared/receptionChannel";
import { CopyInline } from "@/components/CopyButton";
import { workOrderStatusHue } from "@shared/workOrderStatus";
import {
  isKanbanStateApplicable,
  isWorkOrderKanbanState,
  workOrderKanbanDotCls,
  workOrderKanbanStateLabel,
  type WorkOrderKanbanState,
} from "@shared/workOrderKanban";
import { deriveWoDeliveryState, woDeliveryStateLabel } from "@shared/workOrderDeliveryState";
import {
  type WO,
  PRIORITIES,
  progressOf,
  dueInfo,
  avatarHue,
  initials,
  workOrderContactMessage,
  printWoFromCard,
  printWoThermalFromCard,
  printWoShippingLabel,
} from "./workOrderTypes";

export function WorkOrderKanbanCard({ o, onPointerDown, dragging, ghost, inboxAssign, staff, assignPending, onOpenCustomer, onCycleKanban, kanbanBusy }: {
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
          {(() => {
            const st = deriveWoDeliveryState(o.consignmentStatus, o.parcelStatus);
            return st !== "NONE" ? (
              <span className="inline-flex items-center gap-1 rounded bg-[var(--sem-warn-bg)] text-[var(--sem-warn)] px-1.5 py-0.5 text-2xs font-bold shrink-0 ms-auto" title={o.deliveryPartyName ? `مع ${o.deliveryPartyName}` : undefined}>
                <Truck aria-hidden className="size-3" /> {woDeliveryStateLabel(st)}
              </span>
            ) : null;
          })()}
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
          {/* flex-1/min-w-0 يعوّضان تخطيط `.wob-inbox-sel` (الصنف نفسه زال مع الـ<select>).
              الارتفاع يتبع مقياس الراحة الآن: size="sm" = 40px بدل ٣٢px البَعديّة — وهو ما
              يراه الجهاز اللمسيّ أصلاً اليوم (min-height: 44px على pointer: coarse). */}
          <AppSelect
            className="min-w-0 flex-1 text-xs"
            size="sm"
            value={pickedStaff}
            onValueChange={setPickedStaff}
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
          </AppSelect>
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
