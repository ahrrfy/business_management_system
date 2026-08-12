/**
 * قواميس التعريب المركزية للأكواد المعروضة — تُستهلك في الشاشات والتصدير والطباعة معاً.
 * (نمط عرضي كشفه تدقيق الشاشات ٣/٨/٢٦: التصدير كان يُخرج PENDING/POS خاماً بينما الشاشة معرّبة.)
 * طرق الدفع في lib/paymentMethod.ts والأدوار في lib/roles.ts — لا تكرّرها هنا.
 */

/** حالة فاتورة البيع (invoices.status). PENDING = «معلّقة» بقرار المسرد (لا «غير مدفوعة»). */
export const INVOICE_STATUS_AR: Record<string, string> = {
  PAID: "مدفوعة",
  PARTIALLY_PAID: "جزئية",
  PENDING: "معلّقة",
  RETURNED: "مُرتجَعة",
  CANCELLED: "ملغاة",
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
