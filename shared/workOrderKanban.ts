/**
 * **حالة الكانبان لأمر الشغل** — إشارةٌ **متعامدةٌ** على `workOrders.status`
 * (الموجة ١ من ترقية شاشة أوامر الشغل بنمط Odoo، ٢٠٢٦-٠٨-٣٠).
 *
 * الفرق الحاكم: `status` **حالة آلة** (RECEIVED → IN_PROGRESS → READY → DELIVERED)
 * يُغيّرها الانتقال الرسميّ (claim/start/markReady/deliver) بحرّاسه ومحاسباته.
 * `kanbanState` **إشارةُ الفنّيّ** داخل المرحلة نفسها: «مستعدّ للانتقال»، «معطَّل»،
 * «عاديّ» — بلا تغيير مرحلة ولا أثر ماليّ. زرٌّ في البطاقة لا يمرّ بالحرّاس المالية.
 *
 * لماذا لم تكفِ `status`: أمرٌ في «قيد التنفيذ» ينتظر مادّةً أو موافقة عميل يبدو
 * مطابقاً لأمرٍ يشتغل عليه الفنّيّ فعلاً — والفارق ساعات. الفنّيّ يحتاج إشارةً
 * دون أن يعكسَ الحالة، والمدير يحتاج أن يرى «قيد التنفيذ ٩ منها ٤ معطَّلة»
 * بلمحةٍ لا بفتح كل بطاقة.
 *
 * ⛔ لا تُستعمل هذه الحالة **حاكماً منطقياً** (شرطاً لفاتورة أو خصم مخزون) — إشارةٌ
 * تشغيليّة بحتة. القراراتُ المالية تبقى على `status` وحدها.
 */

/** القيم الثلاث على `mysqlEnum("woKanbanState")` — بترتيبها في `drizzle/schema.ts`. */
export const WO_KANBAN_STATES = ["NORMAL", "READY", "BLOCKED"] as const;

export type WorkOrderKanbanState = (typeof WO_KANBAN_STATES)[number];

const LABELS: Record<WorkOrderKanbanState, string> = {
  NORMAL: "عاديّ",
  READY: "جاهز للانتقال",
  BLOCKED: "معطَّل",
};

const HINTS: Record<WorkOrderKanbanState, string> = {
  NORMAL: "لا إشارة — الحال طبيعيّ",
  READY: "الفنّيّ يشير: جاهزٌ لخطوة المرحلة التالية",
  BLOCKED: "معطَّل بحاجة تدخّل — سبب مطلوب",
};

export function isWorkOrderKanbanState(v: unknown): v is WorkOrderKanbanState {
  return typeof v === "string" && (WO_KANBAN_STATES as readonly string[]).includes(v);
}

export function workOrderKanbanStateLabel(v: string | null | undefined): string {
  if (v == null) return LABELS.NORMAL;
  return isWorkOrderKanbanState(v) ? LABELS[v] : LABELS.NORMAL;
}

export function workOrderKanbanStateHint(v: string | null | undefined): string {
  if (v == null) return HINTS.NORMAL;
  return isWorkOrderKanbanState(v) ? HINTS[v] : HINTS.NORMAL;
}

/**
 * الدورةُ عند نقر النقطة — فنّيٌّ يدور NORMAL → READY → BLOCKED → NORMAL.
 * الانتقال إلى BLOCKED يستدعي حواراً لسبب — يُفرض في `setKanbanState` خادمياً.
 */
export function nextKanbanStateInCycle(v: string | null | undefined): WorkOrderKanbanState {
  const current = isWorkOrderKanbanState(v) ? v : "NORMAL";
  switch (current) {
    case "NORMAL":
      return "READY";
    case "READY":
      return "BLOCKED";
    case "BLOCKED":
      return "NORMAL";
  }
}

/**
 * لون النقطة على البطاقة — توكنز `sem-*` (تتكيّف مع الوضع الداكن). حارس `check:colors`
 * يمنع الألوان الخامّة على `client/src/pages/**` — هذه هي مصدر الحقيقة الوحيد.
 */
export const WO_KANBAN_DOT_CLS: Record<WorkOrderKanbanState, string> = {
  NORMAL: "wob-kanban-dot-normal",
  READY: "wob-kanban-dot-ready",
  BLOCKED: "wob-kanban-dot-blocked",
};

export function workOrderKanbanDotCls(v: string | null | undefined): string {
  return isWorkOrderKanbanState(v) ? WO_KANBAN_DOT_CLS[v] : WO_KANBAN_DOT_CLS.NORMAL;
}

/** الحالات النشطة فقط تحمل إشارةَ فنّيّ ذات معنى — التسليم والإلغاء نهايةٌ. */
export function isKanbanStateApplicable(status: string | null | undefined): boolean {
  return status === "RECEIVED" || status === "IN_PROGRESS" || status === "READY";
}
