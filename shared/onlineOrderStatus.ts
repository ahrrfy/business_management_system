/**
 * حالة طلب المتجر الإلكتروني — **مصدر الحقيقة الوحيد** للتعريب، ولون الشارة،
 * ولون شريط الرسم البياني، وخطوة الانتقال التالية.
 *
 * لماذا مشتركةً (`shared/`) لا في `client/src/lib/labels.ts`: الخادم يستهلك القيم في
 * الاستعلامات والقواميس والاختبار (workflow، تقارير الأداء)، والواجهة تحتاج التعريب.
 * تعريفان منفصلان ينجرفان — تحذير CLAUDE.md من «سبعة قواميس فاتورة منجرفة» ما زال قائماً
 * لعائلة onlineOrders قبل هذا الملف (٤ نسخ محلّية في Storefront/OrderFulfillment/
 * StoreDashboard/StoreAnalytics بترجماتٍ وألوانٍ متفاوتة).
 *
 * **⛔ لا تُعِد تعريف قاموس حالة طلب المتجر محلّياً في شاشة** — استهلك من هنا.
 * كلّ قيمة تحتاج مطابقةً مع `mysqlEnum('orderStatus', [...])` في [drizzle/schema.ts:4444].
 * يحرسه اختبار نصّيّ (`./onlineOrderStatus.test.ts`).
 */

/** كل قيم `onlineOrders.status` (مرآة الـenum). الترتيب = الترتيب الطبيعيّ للمسار (لا أبجديّاً). */
export const ONLINE_ORDER_STATUSES = [
  "PENDING",
  "CONFIRMED",
  "PROCESSING",
  "SHIPPED",
  "DELIVERED",
  "CANCELLED",
] as const;

export type OnlineOrderStatus = (typeof ONLINE_ORDER_STATUSES)[number];

/** الحالات النهائيّة (لا انتقال منها في `ORDER_NEXT_STEP`). */
export const TERMINAL_ONLINE_ORDER_STATUSES = ["DELIVERED", "CANCELLED"] as const;

export function isTerminalOnlineOrderStatus(s: string | null | undefined): boolean {
  return s != null && (TERMINAL_ONLINE_ORDER_STATUSES as readonly string[]).includes(s);
}

/**
 * التعريب الإداريّ (لوحة الموظف). كلمات موجزة تُلائم أعمدة الجدول والشارات:
 * «وارد/مثبَّت/قيد التجهيز/مع المندوب/سُلّم/ملغى». نُقلت حرفياً من StoreDashboard.tsx/
 * StoreAnalytics.tsx/OrderFulfillment.tsx التي كانت متطابقةً معجمياً ⇒ اختلافُها كان في
 * اللون فقط، لا التسمية.
 */
export const ONLINE_ORDER_STATUS_AR: Record<string, string> = {
  PENDING: "وارد",
  CONFIRMED: "مثبَّت",
  PROCESSING: "قيد التجهيز",
  SHIPPED: "مع المندوب",
  DELIVERED: "سُلّم",
  CANCELLED: "ملغى",
};

/** فارغ/مجهول ⇒ «—» (لا يتسرّب رمزٌ إنجليزيّ خامّ إلى شاشةٍ عربيّة أو تصديرٍ أو طباعة). */
export function orderStatusLabel(s: string | null | undefined): string {
  if (!s) return "—";
  return ONLINE_ORDER_STATUS_AR[s] ?? s;
}

/**
 * تعريب موجَّهٌ للعميل — لغةٌ أدفأ للمستهلك في شاشة تتبّع الطلب العلنيّة (Storefront.tsx):
 * «قيد المراجعة» بدل «وارد»، «تمّ التأكيد» بدل «مثبَّت». نُقل حرفياً من `TRACK_STATUS`.
 * القاموسان متعمَّدان — الموظف يعرف مصطلحه، والعميل يقرأ لغته.
 */
export const ONLINE_ORDER_STATUS_AR_CUSTOMER: Record<string, string> = {
  PENDING: "قيد المراجعة",
  CONFIRMED: "تمّ التأكيد",
  PROCESSING: "قيد التجهيز",
  SHIPPED: "مع المندوب",
  DELIVERED: "تمّ التسليم",
  CANCELLED: "أُلغي الطلب",
};

export function orderStatusLabelForCustomer(s: string | null | undefined): string {
  if (!s) return "—";
  return ONLINE_ORDER_STATUS_AR_CUSTOMER[s] ?? s;
}

/**
 * صنف CSS لشارة (chip/pill) — Tailwind. يفضّل التوكنز الدلاليّة (`--sem-*`) حيث أمكن،
 * ويبقى `teal` لـSHIPPED (حالة «في الطريق») كلوندلاليٍّ متميّز لا يوازيه توكن دلاليّ.
 * الاختيار: pillsstop-word لا variants — تُستهلكه شاشات <span> مباشرةً بلا مكوّن Badge.
 */
const ONLINE_ORDER_STATUS_CHIP: Record<OnlineOrderStatus, string> = {
  PENDING: "bg-[var(--sem-warn-bg)] text-[var(--sem-warn)]",
  CONFIRMED: "bg-[var(--sem-info-bg)] text-[var(--sem-info)]",
  PROCESSING: "bg-[var(--sem-info-bg)] text-[var(--sem-info)]",
  SHIPPED: "bg-teal-100 text-teal-800 dark:bg-teal-500/15 dark:text-teal-300",
  DELIVERED: "bg-[var(--sem-pos-bg)] text-[var(--sem-pos)]",
  CANCELLED: "bg-[var(--sem-neg-bg)] text-[var(--sem-neg)]",
};

export function orderStatusChipClass(s: string | null | undefined): string {
  if (!s) return "bg-muted text-muted-foreground";
  return ONLINE_ORDER_STATUS_CHIP[s as OnlineOrderStatus] ?? "bg-muted text-muted-foreground";
}

/**
 * variant Badge (`@/components/ui/badge`) — للشاشات التي تستعمل مكوّن Badge لا `<span>` خام.
 * نمط مطابقٌ لـ`invoiceStatusBadgeVariant` (نفس المجموعة الآمنة عبر Badge وMobileDataCard):
 * success/warning/secondary/outline.
 */
export type OnlineOrderStatusBadgeVariant = "success" | "warning" | "secondary" | "outline";

const ONLINE_ORDER_STATUS_BADGE: Record<OnlineOrderStatus, OnlineOrderStatusBadgeVariant> = {
  PENDING: "warning",
  CONFIRMED: "secondary",
  PROCESSING: "secondary",
  SHIPPED: "secondary",
  DELIVERED: "success",
  CANCELLED: "outline",
};

export function orderStatusBadgeVariant(s: string | null | undefined): OnlineOrderStatusBadgeVariant {
  if (!s) return "outline";
  return ONLINE_ORDER_STATUS_BADGE[s as OnlineOrderStatus] ?? "outline";
}

/**
 * لون شريط الرسم البيانيّ (StoreAnalytics.tsx) — ألوان مستقلّة عن الشارة عمداً:
 * الرسم يحتاج تمييزاً بصرياً بين ست فئاتٍ متجاورة، بينما الشارة تحتاج دلالةً عاطفيّة
 * (تحذير/إيجاب/إلخ). خلطهما يُنتج رسماً مربكاً أو شارات باهتة.
 */
const ONLINE_ORDER_STATUS_CHART: Record<OnlineOrderStatus, string> = {
  PENDING: "bg-amber-400",
  CONFIRMED: "bg-sky-400",
  PROCESSING: "bg-violet-400",
  SHIPPED: "bg-indigo-400",
  DELIVERED: "bg-emerald-500",
  CANCELLED: "bg-rose-400",
};

export function orderStatusChartColor(s: string | null | undefined): string {
  if (!s) return "bg-slate-300";
  return ONLINE_ORDER_STATUS_CHART[s as OnlineOrderStatus] ?? "bg-slate-300";
}

/**
 * الانتقال التالي المسموح من كلّ حالة — خطوة حالةٍ بحتة **بلا أثرٍ ماليّ**.
 * الانتقالات الماليّة (SHIPPED عبر orders.dispatch = فاتورة COD + خصم مخزون) تُدار بمسارٍ
 * منفصلٍ خادميّاً؛ هنا فقط CONFIRMED→PROCESSING البسيط الذي يسبق منتقي المندوب.
 * SHIPPED→DELIVERED مُبقاةٌ لأنّها انتقالُ حالةٍ بحت (البيع وقع عند SHIPPED).
 */
export const ORDER_NEXT_STEP: Partial<Record<OnlineOrderStatus, { to: OnlineOrderStatus; label: string }>> = {
  PENDING: { to: "CONFIRMED", label: "تثبيت الطلب" },
  CONFIRMED: { to: "PROCESSING", label: "بدء التجهيز" },
  SHIPPED: { to: "DELIVERED", label: "تم التسليم" },
};
