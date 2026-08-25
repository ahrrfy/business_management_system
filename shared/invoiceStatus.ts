/**
 * حالة فاتورة البيع — **مصدر الحقيقة الوحيد** للتعريب ولمفهوم «المستند الميت».
 *
 * لماذا مشتركةً (`shared/`) لا في `client/src/lib/labels.ts`: الخادم يحتاج المفهوم نفسه في
 * الاستعلامات (تقارير، فلاتر، حرّاس الربط)، والواجهة تحتاج التعريب. تعريفان منفصلان ينجرفان.
 *
 * **الدرس المُكلِف (تصحيح الفاتورة، هجرة 0168):** أُضيفت `SUPERSEDED` إلى الـenum ونُسيت في
 * المواضع التي تفلتر المستندات الميتة — فصار كلّ تصحيح فاتورة:
 *   • يضاعف المبيعات ويضيف ربحاً وهمياً بقيمتها كاملة (تقرير المبيعات),
 *   • ويُظهر الأصل الميت «مستحقّاً» فيُقبل ربط سند قبضٍ به،
 *   • ويتسرّب رمزاً إنجليزياً خاماً إلى ٦ شاشات وملفات Excel والطباعة.
 * لذلك: **لا تُكرّر `NOT IN ('CANCELLED', …)` في استعلامٍ جديد** — استهلك `DEAD_INVOICE_STATUSES`
 * أو `isDeadInvoiceStatus` كي تسري أيّ حالةٍ تُضاف مستقبلاً تلقائياً على كلّ القرّاء.
 */

/** كل قيم `invoices.status` (مرآة الـenum في `drizzle/schema.ts`). */
export const INVOICE_STATUSES = [
  "PENDING",
  "CONFIRMED",
  "PAID",
  "PARTIALLY_PAID",
  "CANCELLED",
  "RETURNED",
  "SUPERSEDED",
] as const;

export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

/**
 * المستند الميت: لا التزامَ عليه ولا يُحتسب بيعاً قائماً.
 *  • `CANCELLED`  — أُلغيت بعكسٍ موثَّق.
 *  • `RETURNED`   — أُرجعت بالكامل.
 *  • `SUPERSEDED` — عُكِست بالكامل وأُعيد إصدارها مصحَّحةً؛ **البديلة** تحمل الالتزام.
 *
 * ⚠️ `SUPERSEDED` أخطرها في الاستعلامات: `correct.ts` يترك الأصل بـ`total` كاملاً و
 * `returnedTotal` **مُصفَّراً صراحةً** ⇒ يبدو لكلّ قارئٍ غافلٍ بيعاً حيّاً كامل القيمة
 * ومستحقّاً بالكامل، بينما `CANCELLED`/`RETURNED` يعادلهما `returnedTotal` غالباً.
 */
export const DEAD_INVOICE_STATUSES = ["CANCELLED", "RETURNED", "SUPERSEDED"] as const;

export function isDeadInvoiceStatus(status: string | null | undefined): boolean {
  return status != null && (DEAD_INVOICE_STATUSES as readonly string[]).includes(status);
}

/**
 * الفاتورة **المُبطَلة**: لم تعد تمثّل عمليةَ بيعٍ وقعت أصلاً ⇒ تُستبعَد من تجميع المبيعات كلّياً.
 *
 * **لماذا `RETURNED` ليست منها** (فرقٌ جوهريّ لا سهو): الفاتورة المُرتجَعة **بيعٌ وقع فعلاً ثمّ
 * أُرجِع**، و`returnedTotal = total` يجعل صافيها صفراً حسابياً بينما تبقى مرئيّةً في عمود
 * «المرتجعات» — وهو رقمٌ يحتاجه المالك. استبعادها من التجميع يُخفي المرتجع بدل أن يُظهره.
 * أمّا `CANCELLED` و`SUPERSEDED` فلم يقع بهما بيعٌ قائم: الأولى عُكِست، والثانية حلّت محلّها
 * فاتورةٌ أخرى تُحتسب بذاتها ⇒ إبقاؤهما يضاعف.
 */
export const VOIDED_INVOICE_STATUSES = ["CANCELLED", "SUPERSEDED"] as const;

export function isVoidedInvoiceStatus(status: string | null | undefined): boolean {
  return status != null && (VOIDED_INVOICE_STATUSES as readonly string[]).includes(status);
}

/**
 * التعريب الموحَّد. `PENDING = «غير مدفوعة»` (تصحيح مسرد ١٧/٨/٢٦ بطلب المالك — كانت «معلّقة»):
 * الحالة مشتقّة من المال وحده (`computeInvoiceStatus`: المدفوع صفر ⇒ PENDING)، فالبيع الآجل
 * النافذ كان يُقرأ «موقوفاً/بانتظار إجراء». التسمية المالية هي الصادقة.
 */
export const INVOICE_STATUS_AR: Record<string, string> = {
  PENDING: "غير مدفوعة",
  PARTIALLY_PAID: "مدفوعة جزئياً",
  PAID: "مدفوعة",
  CONFIRMED: "مؤكّدة",
  CANCELLED: "ملغاة",
  RETURNED: "مُرتجَعة",
  SUPERSEDED: "مستبدلة بفاتورة مصححة",
};

/** فارغ/مجهول ⇒ «—» (لا يتسرّب رمزٌ إنجليزيّ خام إلى شاشةٍ عربية أو تصديرٍ أو طباعة). */
export function invoiceStatusLabel(s: string | null | undefined): string {
  if (!s) return "—";
  return INVOICE_STATUS_AR[s] ?? s;
}

/**
 * variant Badge (`@/components/ui/badge`) لحالة الفاتورة — **مصدرٌ وحيد** يمنع خرائط منجرفة.
 *
 * قبله كانت ٣ خرائط محلّية متباينة تُترجم نفس الحالة إلى variants مختلفة:
 *   • Invoices.tsx: PAID=success · PARTIALLY_PAID=warning · CANCELLED/RETURNED=destructive
 *   • ReceptionInvoiceQueue.tsx: PAID=default · PARTIALLY_PAID=secondary · else=outline
 *   • InvoiceDetail.tsx: قاموس classes مباشر (`bg-emerald-100 text-emerald-700`) يتجاوز variants كلياً
 *
 * ⇒ الشاشات الثلاث كانت تعرض حالة `PAID` بصورةٍ مختلفة بصرياً (أخضر/أزرق/سِمن). دُلالة الحالة
 * الواحدة تنكسر عبر الشاشات.
 *
 * المجموعة الثابتة (لا variants جديدة بلا تحديث Badge component + tokens):
 *   • PAID          → success   (badge-status-active — أخضر دلاليّ)
 *   • PARTIALLY_PAID→ warning   (badge-stock-low — كهرمانيّ دلاليّ)
 *   • PENDING       → secondary (محايد رماديّ؛ «غير مدفوعة» حالة قائمة لا خطأ)
 *   • CONFIRMED     → secondary (مؤكّدة قبل الدفع)
 *   • CANCELLED     → outline   (مستند ميت — يُخفَّض بصرياً، لا يُصعَّق بلونٍ ناريّ)
 *   • RETURNED      → outline   (مستند ميت — بيعٌ وقع ثمّ أُرجع)
 *   • SUPERSEDED    → outline   (مستند ميت — البديلة تحمل الالتزام)
 *
 * فارغ/مجهول ⇒ "outline" (لا يتسرّب rendering مكسور).
 *
 * ملاحظة: القيم الأربع مدعومة **عالمياً** عبر مستهلكي variant — Badge وMobileDataCard كلاهما.
 * تجنّبنا `info` عمداً: MobileDataCard لا يعرفه، فيصير عقدُنا هشّاً أمام الاستهلاك المتعدّد.
 */
export type InvoiceStatusBadgeVariant = "success" | "warning" | "secondary" | "outline";

const INVOICE_STATUS_BADGE_VARIANT: Record<InvoiceStatus, InvoiceStatusBadgeVariant> = {
  PAID: "success",
  PARTIALLY_PAID: "warning",
  PENDING: "secondary",
  CONFIRMED: "secondary",
  CANCELLED: "outline",
  RETURNED: "outline",
  SUPERSEDED: "outline",
};

export function invoiceStatusBadgeVariant(s: string | null | undefined): InvoiceStatusBadgeVariant {
  if (!s) return "outline";
  return INVOICE_STATUS_BADGE_VARIANT[s as InvoiceStatus] ?? "outline";
}
