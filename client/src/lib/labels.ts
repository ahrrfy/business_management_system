/**
 * قواميس التعريب المركزية للأكواد المعروضة — تُستهلك في الشاشات والتصدير والطباعة معاً.
 * (نمط عرضي كشفه تدقيق الشاشات ٣/٨/٢٦: التصدير كان يُخرج PENDING/POS خاماً بينما الشاشة معرّبة.)
 * طرق الدفع في lib/paymentMethod.ts والأدوار في lib/roles.ts — لا تكرّرها هنا.
 */

/**
 * حالة فاتورة البيع (invoices.status).
 *
 * **PENDING = «غير مدفوعة»** (تصحيح مسرد ١٧/٨/٢٦ بطلب المالك — كانت «معلّقة»): الحالة مشتقّة
 * من المال وحده (`computeInvoiceStatus`: المدفوع صفر ⇒ PENDING)، فالبيع الآجل النافذ كان يُقرأ
 * «موقوفاً/بانتظار إجراء» ويقلق الموظّف والمالك. التسمية المالية هي الصادقة.
 *
 * `CONFIRMED` و`SUPERSEDED` مضافتان هنا كي لا يتسرّب الرمز الإنجليزيّ الخام إلى الشاشات
 * والتصدير والطباعة عبر `?? s` (كانت `SUPERSEDED` تظهر خاماً في كل مستهلكٍ لهذا القاموس).
 */
export const INVOICE_STATUS_AR: Record<string, string> = {
  PAID: "مدفوعة",
  PARTIALLY_PAID: "مدفوعة جزئياً",
  PENDING: "غير مدفوعة",
  CONFIRMED: "مؤكّدة",
  RETURNED: "مُرتجَعة",
  CANCELLED: "ملغاة",
  SUPERSEDED: "مستبدلة بفاتورة مصححة",
};
export function invoiceStatusLabel(s: string | null | undefined): string {
  if (!s) return "—";
  return INVOICE_STATUS_AR[s] ?? s;
}

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
