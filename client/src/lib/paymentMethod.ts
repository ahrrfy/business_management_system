/**
 * ثوابت طرق الدفع الموحّدة للواجهة — تسمية + شارة ملوّنة + قائمة الاختيار.
 * تُستخدم في POS (أزرار الدفع)، Invoices (عمود «طريقة الدفع»)، InvoiceDetail (سجل الدفعات)،
 * وحوار إغلاق الوردية (تفصيل الطرق). مصدر واحد ⇒ لا انحراف تسمية بين الشاشات.
 *
 * القيم الخمس تطابق `receipts.paymentMethod` (mysqlEnum صارم في drizzle/schema.ts) —
 * أي قيمة جديدة يجب أن تُضاف للـenum الخادميّ **أولاً** لضمان الحفظ الصحيح.
 * CHECK محذوف عمداً من واجهات البيع بقرار المالك «لا تعامل بالصكوك».
 */

export type PaymentMethod = "CASH" | "CARD" | "CHECK" | "TRANSFER" | "WALLET";

export const METHOD_LABEL: Record<PaymentMethod, string> = {
  CASH: "نقدي",
  CARD: "بطاقة",
  CHECK: "صك",
  TRANSFER: "تحويل",
  WALLET: "محفظة",
};

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
};

/**
 * ترتيب أزرار POS: نقدي أوّلاً (الأكثر شيوعاً)، ثم بطاقة، ثم تحويل، ثم محفظة.
 * CHECK غير معروض في هذه القائمة (قرار المالك). التغيير هنا يغيّر ترتيب أزرار POS
 * تلقائياً لأن الأزرار تُبنى من هذه القائمة عبر map().
 */
export const POS_METHODS: readonly { v: PaymentMethod; label: string }[] = [
  { v: "CASH",     label: "نقدي" },
  { v: "CARD",     label: "بطاقة" },
  { v: "TRANSFER", label: "تحويل" },
  { v: "WALLET",   label: "محفظة" },
] as const;

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
