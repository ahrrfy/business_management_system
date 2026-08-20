/**
 * قواميس التعريب المركزية للأكواد المعروضة — تُستهلك في الشاشات والتصدير والطباعة معاً.
 * (نمط عرضي كشفه تدقيق الشاشات ٣/٨/٢٦: التصدير كان يُخرج PENDING/POS خاماً بينما الشاشة معرّبة.)
 * طرق الدفع في lib/paymentMethod.ts والأدوار في lib/roles.ts — لا تكرّرها هنا.
 */

/**
 * ⛔ حالة فاتورة البيع **ليست هنا** — مصدرها الوحيد `@shared/invoiceStatus`
 * (`INVOICE_STATUS_AR` · `invoiceStatusLabel` · `isDeadInvoiceStatus` · `INVOICE_STATUSES`).
 * كانت نسخةٌ محلّية هنا فانجرفت عن الخادم: أُضيفت `SUPERSEDED` إلى enum المخطّط (هجرة 0168)
 * ولم تصل هذا القاموس ⇒ تسرّب الرمز الإنجليزيّ الخام إلى ٦ شاشاتٍ وملفات Excel والطباعة.
 * الخادم يحتاج المفهوم نفسه في استعلاماته، فمكانُه `shared/` لا هنا. **لا تُعِد تعريفه.**
 */

/** مصدر الفاتورة (invoices.sourceType). */
export const SOURCE_TYPE_AR: Record<string, string> = {
  POS: "نقطة بيع",
  ONLINE: "متجر إلكتروني",
  ORDER: "طلب",
  WORKORDER: "أمر شغل",
};
export function sourceTypeLabel(s: string | null | undefined): string {
  if (!s) return "—";
  return SOURCE_TYPE_AR[s] ?? s;
}

/** نوع الوردية (`shifts.shiftType`) — كانت الدالّة مكرّرة حرفيّاً في ملفَّين،
 *  وثالثٌ (تفاصيل الفاتورة) كان يعرض قيمة الـenum الإنجليزيّة خامّاً للموظّف. */
export const SHIFT_TYPE_AR: Record<string, string> = {
  RETAIL: "تجزئة",
  RECEPTION: "استقبال",
  PRINT_SERVICES: "خدمات طباعة",
};
export function shiftTypeLabel(t: string | null | undefined): string {
  if (!t) return "—";
  return SHIFT_TYPE_AR[t] ?? "تجزئة";
}

/** فئة السعر (productPrices.tier / customers.defaultPriceTier). */
export const PRICE_TIER_AR: Record<string, string> = {
  RETAIL: "مفرد",
  WHOLESALE: "جملة",
  GOVERNMENT: "حكومي",
};
export function priceTierLabel(s: string | null | undefined): string {
  if (!s) return "—";
  return PRICE_TIER_AR[s] ?? s;
}
