import { isDeadInvoiceStatus } from "@shared/invoiceStatus";

export interface ReceptionInvoiceCorrectionCandidate {
  status?: string | null;
  returnedTotal?: string | number | null;
  workOrderId?: string | number | null;
  consignmentId?: string | number | null;
}

/**
 * حارس واجهة فقط؛ الخادم يعيد جميع الفحوص تحت الأقفال داخل معاملة التصحيح.
 * إبقاء السبب نصاً يتيح إظهاره لاحقاً من دون نسخ منطق الأهلية في كل طابور.
 */
export function receptionInvoiceCorrectionBlockReason(
  invoice: ReceptionInvoiceCorrectionCandidate,
): string | null {
  if (isDeadInvoiceStatus(invoice.status)) return "الفاتورة منتهية ولا تقبل إعادة إصدار أخرى";
  if (invoice.workOrderId != null) return "فاتورة أمر الشغل تُصحَّح من مسار أمر الشغل";
  if (invoice.consignmentId != null) return "افصل مسار التوصيل أو عالجه قبل تصحيح الفاتورة";
  if (Number(invoice.returnedTotal ?? 0) > 0) return "للفاتورة مرتجع سابق؛ تُعالج من شاشة المرتجعات";
  return null;
}

