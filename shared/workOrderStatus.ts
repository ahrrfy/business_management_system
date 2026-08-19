/**
 * **حالة أمر الشغل** — قاموسٌ واحدٌ حاكم (١٩/٨، ش٠ من المرحلة ٢).
 *
 * كانت سبعةَ قواميس محلّية على نفس عمود `workOrders.status`، وانجرافُها ليس تجميلياً:
 *   · `READY` = «جاهز للتسليم» في خمس شاشات و«جاهز» في طابور الاستقبال — اسمان لحالةٍ واحدة.
 *   · `WIPReport.tsx` يعرّف **حالتين فقط** ⇒ أيّ حالةٍ أخرى تظهر للموظّف بمفتاحها الإنجليزيّ.
 *   · وخطُّ الأمر الزمنيّ يغطّي **ستّة** أفعالٍ من أحد عشر مُسجَّلاً فعلاً ⇒ يقرأ الموظّف
 *     «workOrder.claim» و«workOrder.setMaterials» خامّتين في سجلٍّ يُفترض أن يفهمه.
 *
 * وهذه الشريحة تمكينيّة: كل حالةٍ **مشتقّة** تبنيها الشرائح التالية (انتظارُ موافقةٍ، تنفيذٌ
 * محجوز) تُقرأ من هنا — فلا يُولَد قاموسٌ ثامنٌ وتاسع. وهو نمطُ [`shared/invoiceStatus.ts`]
 * نفسه الذي أنهى سبعة قواميس حالةِ فاتورةٍ منجرفة.
 *
 * ⛔ لا شاشة تُعيد تعريف هذا القاموس محلّياً — يحرسه `workOrderStatus.test.ts`.
 */

/** القيم الخمس على `mysqlEnum("workOrderStatus")` في `drizzle/schema.ts` — بترتيبها هناك. */
export const WORK_ORDER_STATUSES = [
  "RECEIVED",
  "IN_PROGRESS",
  "READY",
  "DELIVERED",
  "CANCELLED",
] as const;

export type WorkOrderStatus = (typeof WORK_ORDER_STATUSES)[number];

const LABELS: Record<WorkOrderStatus, string> = {
  RECEIVED: "مُستلَم",
  IN_PROGRESS: "قيد التنفيذ",
  READY: "جاهز للتسليم",
  DELIVERED: "مُسلَّم",
  CANCELLED: "ملغى",
};

export function isWorkOrderStatus(v: unknown): v is WorkOrderStatus {
  return typeof v === "string" && (WORK_ORDER_STATUSES as readonly string[]).includes(v);
}

/**
 * التسمية العربية. **لا تسقط على المفتاح الخامّ**: قيمةٌ غريبة تعني عموداً تغيّر ولم يُسمَّ،
 * وعرضُ «IN_REVIEW» للموظّف أسوأ من «غير معروفة» لأنّه يبدو مقصوداً.
 */
export function workOrderStatusLabel(v: string | null | undefined): string {
  if (v == null) return "—";
  return isWorkOrderStatus(v) ? LABELS[v] : "حالة غير معروفة";
}

/** أمرٌ ما زال في دورة العمل — يُحسب في الطوابير والأحمال وقيمة العمل الجاري. */
export const WO_ACTIVE_STATUSES: readonly WorkOrderStatus[] = ["RECEIVED", "IN_PROGRESS", "READY"];
/** أمرٌ خرج من دورة العمل — لا يُطالَب به منفّذٌ ولا يدخل حملاً. */
export const WO_CLOSED_STATUSES: readonly WorkOrderStatus[] = ["DELIVERED", "CANCELLED"];

export function isWorkOrderActive(v: string | null | undefined): boolean {
  return isWorkOrderStatus(v) && (WO_ACTIVE_STATUSES as readonly string[]).includes(v);
}
export function isWorkOrderClosed(v: string | null | undefined): boolean {
  return isWorkOrderStatus(v) && (WO_CLOSED_STATUSES as readonly string[]).includes(v);
}

/**
 * درجةُ اللون على عجلة الألوان لكل حالة — تُغذّي متغيّرات CSS في اللوحة (`colVars`)، فهي
 * **مدخلُ توكنٍ لا لونٌ خامّ** (حارس `check:colors`). الملغى بلا درجة: يُعرَض محايداً.
 */
export const WO_STATUS_HUE: Record<WorkOrderStatus, number | null> = {
  RECEIVED: 72,
  IN_PROGRESS: 250,
  READY: 293,
  DELIVERED: 155,
  CANCELLED: null,
};
/** الدرجة المحايدة حين لا درجةَ للحالة (أو الحالة غير معروفة). */
export const WO_HUE_NEUTRAL = 255;

export function workOrderStatusHue(v: string | null | undefined): number {
  if (!isWorkOrderStatus(v)) return WO_HUE_NEUTRAL;
  return WO_STATUS_HUE[v] ?? WO_HUE_NEUTRAL;
}

/** موقعُ الحالة على شريط التقدّم (الملغاة خارجه — ليست مرحلةً بل خروجاً). */
export const WO_STAGE_INDEX: Record<WorkOrderStatus, number> = {
  RECEIVED: 0,
  IN_PROGRESS: 1,
  READY: 2,
  DELIVERED: 3,
  CANCELLED: -1,
};
/** المراحل الثلاث المعروضة على شريط التقدّم (بلا التسليم — نهايةٌ لا مرحلة). */
export const WO_PROGRESS_STAGES: readonly { key: WorkOrderStatus; label: string }[] = [
  { key: "RECEIVED", label: LABELS.RECEIVED },
  { key: "IN_PROGRESS", label: LABELS.IN_PROGRESS },
  { key: "READY", label: LABELS.READY },
];

/**
 * الحالات التي يُنتقَل **إليها** أماميّاً. «مُستلَم» بدايةٌ لا هدف، و«ملغى» **خروجٌ لا تقدّم**
 * (مسارُه `workOrders.cancel` بحرّاسه وسببه، لا زرُّ الخطوة التالية) — والنوع يمنع خلطهما.
 */
export type WorkOrderAdvanceTarget = Exclude<WorkOrderStatus, "RECEIVED" | "CANCELLED">;

/** الانتقال الأماميّ الوحيد المسموح من كل حالة (يقود زرّ «الخطوة التالية»). */
export const WO_NEXT_STATUS: Partial<Record<WorkOrderStatus, WorkOrderAdvanceTarget>> = {
  RECEIVED: "IN_PROGRESS",
  IN_PROGRESS: "READY",
  READY: "DELIVERED",
};

/**
 * أفعال الخطّ الزمنيّ — **الأحد عشر** المُسجَّلة فعلاً بـ`entityType:"workOrder"` في
 * `server/routers/workOrderRouter.ts`. كان القاموس يغطّي ستّةً، فتظهر الخمسةُ الباقية
 * بمفاتيحها الإنجليزية في سجلٍّ يقرؤه موظّفٌ عربيّ.
 */
export const WO_TIMELINE_LABEL: Record<string, string> = {
  "workOrder.create": "استُلم الطلب",
  "workOrder.receptionCheckout": "استُلم من محطّة الاستقبال",
  "workOrder.assign": "أُعيد الإسناد",
  "workOrder.claim": "سحبه الفنّي",
  "workOrder.start": "بدأ التنفيذ — خُصمت المواد",
  "workOrder.setMaterials": "عُدِّلت المواد",
  "workOrder.update": "عُدِّلت بيانات الأمر",
  "workOrder.setDeliveryMethod": "تغيّرت طريقة التسليم",
  "workOrder.markReady": "جاهز للتسليم",
  "workOrder.deliver": "سُلّم وصدرت الفاتورة",
  "workOrder.cancel": "أُلغي الأمر",
  "workOrder.reverseServiceInvoice": "عُكس التسليم وأُرجعت الفاتورة",
};

/** الأفعال التي **يجب** أن يغطّيها القاموس — يطابقها الاختبار مع الراوتر. */
export const WO_TIMELINE_ACTIONS = Object.keys(WO_TIMELINE_LABEL);

export function workOrderTimelineLabel(action: string): string {
  return WO_TIMELINE_LABEL[action] ?? action;
}

/**
 * أصنافُ شارة الحالة (Tailwind). كانت مكرّرةً حرفياً في شاشتَين **بألوانٍ خامّة**
 * (`bg-amber-100 text-amber-700`) لا تتكيّف مع السمة الداكنة ⇒ خلفيةٌ فاتحةٌ بنصٍّ فاتح.
 * وُحّدت هنا على **توكنز `sem-*`** التي يُعرَّف لها مقابلٌ داكن في `tokens.css` — فالنقل
 * إصلاحٌ لا إخفاءٌ من حارس `check:colors` (وهو يمسح `client/src/pages` وحدها).
 */
export const WO_STATUS_BADGE_CLS: Record<WorkOrderStatus, string> = {
  RECEIVED: "bg-muted text-foreground/70",
  IN_PROGRESS: "bg-[var(--sem-info-bg)] text-[var(--sem-info)]",
  READY: "bg-[var(--sem-warn-bg)] text-[var(--sem-warn)]",
  DELIVERED: "bg-[var(--sem-pos-bg)] text-[var(--sem-pos)]",
  CANCELLED: "bg-[var(--sem-neg-bg)] text-[var(--sem-neg)]",
};

export function workOrderStatusBadgeCls(v: string | null | undefined): string {
  return isWorkOrderStatus(v) ? WO_STATUS_BADGE_CLS[v] : "bg-muted";
}

/**
 * **خريطة الطباعة** — الراسم النقطيّ لا يقرأ متغيّرات CSS، فيلزمه لونٌ حرفيّ. وُضعت هنا
 * بوصفها خريطةً صريحةً لمخرَجٍ غير متصفّحيّ، لا لوناً خامّاً في شاشة (يبقى حارس
 * `check:colors` مصيباً: الشاشات تستعمل `workOrderStatusHue` والتوكنز).
 */
export const WO_STATUS_PRINT_COLOR: Record<WorkOrderStatus, string> = {
  RECEIVED: "#1A9B78",
  IN_PROGRESS: "#CC7E3F",
  READY: "#3B82F6",
  DELIVERED: "#059669",
  CANCELLED: "#DC2626",
};
/** لون السقوط للحالة غير المعروفة على المطبوع (القيمة القائمة في `printTemplates.ts`). */
export const WO_PRINT_COLOR_FALLBACK = "#92400E";

export function workOrderStatusPrintColor(v: string | null | undefined): string {
  return isWorkOrderStatus(v) ? WO_STATUS_PRINT_COLOR[v] : WO_PRINT_COLOR_FALLBACK;
}
