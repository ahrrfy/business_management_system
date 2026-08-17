/**
 * ثوابت طرق الدفع الموحّدة للواجهة — تسمية + شارة ملوّنة + قائمة الاختيار.
 * تُستخدم في POS (أزرار الدفع)، Invoices (عمود «طريقة الدفع»)، InvoiceDetail (سجل الدفعات)،
 * وحوار إغلاق الوردية (تفصيل الطرق). مصدر واحد ⇒ لا انحراف تسمية بين الشاشات.
 *
 * القيم تطابق `receipts.paymentMethod` (mysqlEnum صارم في drizzle/schema.ts) —
 * أي قيمة جديدة يجب أن تُضاف للـenum الخادميّ **أولاً** لضمان الحفظ الصحيح.
 * CHECK محذوف عمداً من واجهات البيع بقرار المالك «لا تعامل بالصكوك».
 */
import {
  INBOUND_ENABLED_PAYMENT_METHODS,
  type InboundEnabledPaymentMethod,
} from "@shared/inboundPaymentPolicy";

export type PaymentMethod = "CASH" | "CARD" | "CHECK" | "TRANSFER" | "WALLET" | "TELECOM" | "EXCHANGE" | "MIXED";

export const METHOD_LABEL: Record<PaymentMethod, string> = {
  CASH: "نقدي",
  CARD: "بطاقة",
  CHECK: "صك",
  TRANSFER: "تحويل",
  WALLET: "محفظة",
  // ش٥ — رصيد اتصال زين (أكواد كروت شحن): «زين حصراً» بنيوياً — لا مزوّد آخر يُمثَّل.
  TELECOM: "رصيد زين",
  // EXCHANGE — سند صرفٍ عبر الصيرفة (تسديد مورّد؛ يكتبه `exchange/settleSupplier.ts`)؛ لا يمسّ
  // الخزينة ولا الدرج. كان ناقصاً هنا ⇒ `paymentMethodLabel` تُرجع الرمز الإنجليزيّ خاماً على
  // شاشة الخزينة/السندات. القيمة موجودة في enum العمود منذ البداية.
  EXCHANGE: "صيرفة",
  // MIXED — فاتورةٌ سُدّدت بأكثر من طريقة (نقد + تحويل مثلاً). قيمةُ عرضٍ وفلترةٍ فقط تكتبها
  // `sale/payment.ts` عند اختلاف الدفعة الجديدة عن المخزَّن، بدل «آخر دفعة تفوز» التي كانت
  // تُسقِط الفاتورة من فلتر رافدها الأكبر وتكسر مطابقة يوم البطاقات.
  MIXED: "مختلطة",
};

/**
 * **طريقة فاتورةٍ ≠ طريقة إيصال.** الاتحاد `PaymentMethod` أعلاه يخدم **التعريب/العرض** ويغطّي
 * كل قيم `receipts.paymentMethod`؛ أمّا `invoices.paymentMethod` فأضيق: `EXCHANGE` لا تُكتب
 * عليه قطّ — كاتبها الوحيد `exchange/settleSupplier.ts` على إيصال تسديد المورّد عبر الصيرفة.
 *
 * ⇒ فلاتر شاشات الفواتير/التقارير تشتقّ من هذا الثابت الأضيق، لا من `Object.keys(METHOD_LABEL)`:
 * زودا `sales.list` و`reports.salesReport` يرفضان `EXCHANGE` عمداً، فإظهارها خياراً = خيارٌ
 * بصفر مسار نجاح (نفس علّة «صك» في شاشتَي الأصول والمصروفات).
 */
export type InvoiceFilterMethod = Exclude<PaymentMethod, "EXCHANGE">;

export const INVOICE_FILTER_METHODS: readonly InvoiceFilterMethod[] = [
  "CASH",
  "CARD",
  "CHECK",
  "TRANSFER",
  "WALLET",
  "TELECOM",
] as const;

/**
 * أصناف tailwind لشارة كل طريقة (خلفية + نص). تُطبَّق بلا `border` كي تعمل على
 * سمة داكنة/فاتحة عبر توكنات oklch — الألوان محفوظة بمستوى تباين WCAG AA.
 */
export const METHOD_CLS: Record<PaymentMethod, string> = {
  CASH:     "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
  CARD:     "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-200",
  CHECK:    "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200",
  TRANSFER: "bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-200",
  WALLET:   "bg-fuchsia-100 text-fuchsia-800 dark:bg-fuchsia-950 dark:text-fuchsia-200",
  TELECOM:  "bg-teal-100 text-teal-800 dark:bg-teal-950 dark:text-teal-200",
  EXCHANGE: "bg-slate-100 text-slate-800 dark:bg-slate-900 dark:text-slate-200",
  // مختلطة: محايدة اللون — ليست رافداً بذاتها بل إفصاحٌ عن تعدّد الروافد.
  MIXED: "badge-status-pending",
};

/**
 * ترتيب أزرار POS: نقدي أوّلاً (الأكثر شيوعاً)، ثم بطاقة، ثم تحويل، ثم محفظة.
 * CHECK غير معروض في هذه القائمة (قرار المالك). التغيير هنا يغيّر ترتيب أزرار POS
 * تلقائياً لأن الأزرار تُبنى من هذه القائمة عبر map().
 */
/** ش٥: النوع مضيَّق على القيم الفعلية — CHECK محذوف بقرار المالك، وTELECOM (رصيد زين) مقصور
 *  على محطة الاستقبال خلف ضوابطها (لا يظهر في POS التجزئة/التسديد العام/تصحيح الطريقة).
 *  وEXCHANGE طريقةُ إيصالِ صيرفةٍ خادميّة بحتة — لا يختارها كاشيرٌ من شاشة. */
// MIXED مُستثناة: قيمةٌ **مشتقّة للعرض** تكتبها الخدمة عند تعدّد روافد السداد — لا يختارها
// كاشيرٌ قطّ، ولا تُرسَل في أيّ حمولة دفع.
export type PosPaymentMethod = Exclude<PaymentMethod, "CHECK" | "TELECOM" | "EXCHANGE" | "MIXED">;

export const POS_METHODS: readonly { v: PosPaymentMethod; label: string }[] = [
  { v: "CASH",     label: "نقدي" },
  { v: "CARD",     label: "بطاقة" },
  { v: "TRANSFER", label: "تحويل" },
  { v: "WALLET",   label: "محفظة" },
] as const;

/**
 * خيارات **القبض/الاسترداد** المسموح بها فعلياً — مشتقّة من سياسة القبض المشتركة لا مُعدَّدة يدوياً.
 *
 * كل مسار قبضٍ يمرّ بـ`assertInboundPaymentMethodEnabled` ([voucher/create.ts:433]) ⇒ اختيارُ
 * «صك» من شاشةٍ ينتهي حتماً بـPRECONDITION_FAILED («لا تعامل بالصكوك» — قرار المالك ٢٢/٧).
 * الاشتقاق يمنع تكرار العلّة: أيّ تغيير في السياسة يسري على الشاشات تلقائياً.
 */
export const INBOUND_METHOD_OPTIONS: readonly { v: InboundEnabledPaymentMethod; label: string }[] =
  INBOUND_ENABLED_PAYMENT_METHODS.map((v) => ({ v, label: METHOD_LABEL[v] }));

/** يُرجع نصّاً لعرضه عندما تكون الطريقة null (فاتورة قديمة قبل بدء تسجيل الطريقة). */
export function paymentMethodLabel(m: string | null | undefined): string {
  if (!m) return "—";
  return METHOD_LABEL[m as PaymentMethod] ?? m;
}

/** يُرجع تصنيف الشارة (يقع خلف strategy واحدة عبر الشاشات). */
export function paymentMethodClass(m: string | null | undefined): string {
  if (!m) return "bg-muted text-muted-foreground";
  return METHOD_CLS[m as PaymentMethod] ?? "bg-muted";
}
