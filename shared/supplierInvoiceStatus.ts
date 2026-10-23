/** Supplier invoice lifecycle labels shared by the approval queue and detail drawer. */
export const SUPPLIER_INVOICE_STATUS_LABEL = {
  DRAFT: "مسودة",
  ON_HOLD: "محجوزة",
  MATCHED: "مطابقة — بانتظار الترحيل",
  POSTED: "مرحلة",
  REVERSED: "معكوسة",
} as const;
export type SupplierInvoiceStatus = keyof typeof SUPPLIER_INVOICE_STATUS_LABEL;
