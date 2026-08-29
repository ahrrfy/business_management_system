/**
 * أنواعُ أحداث الفاتورة — مصدر الحقيقة الوحيد لأسماء الأحداث.
 * تُستعمل في `invoiceEvents.eventType` (drizzle/schema.ts + هجرة 0281).
 */

export const INVOICE_EVENT_TYPES = [
  "CREATED",
  "PAID",
  "PARTIALLY_PAID",
  "RETURNED",
  "CANCELLED",
  "SUPERSEDED",
  "CORRECTED",
  "PAYMENT_APPLIED",
  "PAYMENT_REVERSED",
] as const;

export type InvoiceEventType = (typeof INVOICE_EVENT_TYPES)[number];

export const INVOICE_EVENT_LABEL: Record<InvoiceEventType, string> = {
  CREATED: "أُنشئت الفاتورة",
  PAID: "سُدِّدت بالكامل",
  PARTIALLY_PAID: "سُدِّدت جزئياً",
  RETURNED: "أُرجعت",
  CANCELLED: "أُلغيت",
  SUPERSEDED: "استُبدلت بفاتورةٍ مصحَّحة",
  CORRECTED: "أُنشئت كتصحيحٍ للأصل",
  PAYMENT_APPLIED: "طُبِّق سندُ قبض",
  PAYMENT_REVERSED: "عُكس سندُ قبض",
};

export function invoiceEventLabel(eventType: string | null | undefined): string {
  if (!eventType) return "—";
  return INVOICE_EVENT_LABEL[eventType as InvoiceEventType] ?? eventType;
}

export function buildInvoiceEventKey(
  invoiceId: number,
  eventType: InvoiceEventType,
  seq?: string | number | null,
): string {
  const base = `inv:${invoiceId}:${eventType}`;
  return seq == null ? base : `${base}:${seq}`;
}
