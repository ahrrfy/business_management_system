/**
 * Barcode/QR Service — shared types (server + client)
 * Contract-First design: يُعرَّف العقد هنا قبل أي تنفيذ.
 */

/**
 * مجموعة باركود مستند واحد تشمل Code128 وQR وعرضاً إنسانياً.
 * يُنشئها barcodeService على الخادم (موقَّعة بـ HMAC)، ويعرضها BarcodeDisplay على الواجهة.
 */
export interface BarcodeSet {
  /** رقم المستند بصيغته الأصلية — يُعرض كـ Code128 */
  barcode128: string;
  /** payload موقَّعة بـ HMAC-SHA256 بصيغة pipe-delimited — تُشفَّر كـ QR */
  qrPayload: string;
  /** نص إنساني يُطبع أسفل QR (غير موقَّع) */
  displayLabel: string;
}

/** أنواع المستندات المدعومة في النظام */
export type DocType = "INV" | "WO" | "PO" | "QUO" | "CUST" | "ORD";

/** القاموس المركزي للتسميات العربية لأنواع المستندات المرمزة */
export const DOC_TYPE_AR: Record<DocType, string> = {
  INV: "فاتورة مبيعات",
  WO: "أمر شغل / طلب خدمة",
  PO: "أمر شراء",
  QUO: "عرض سعر",
  CUST: "ملف عميل",
  ORD: "طلب متجر إلكتروني",
};

export function docTypeLabel(type: string | null | undefined): string {
  if (!type) return "مستند نظام";
  return (DOC_TYPE_AR as Record<string, string>)[type] ?? type;
}


/**
 * نتيجة تحليل أي مدخل ماسح — discriminated union لتوجيه الإجراء.
 * Strategy Pattern: كل نوع يُعالَج بطريقة مستقلة في scanRouter.
 */
export type ScanResult =
  | { type: "invoice";       number: string }
  | { type: "workOrder";     number: string }
  | { type: "consignment";   number: string }
  | { type: "purchaseOrder"; number: string }
  | { type: "quotation";     number: string }
  | { type: "customer";      id: number }
  | { type: "employee";      id: number }
  | { type: "user";          id: number }
  | { type: "product";       barcode: string }
  | { type: "unknown";       raw: string };

/** البيانات الدنيا لبناء payload الفاتورة */
export interface InvoicePayloadFields {
  invoiceNumber: string;
  invoiceDate: string;  // ISO date string YYYY-MM-DD
  total: string;        // نص عشري (من decimal.js)
  branchId: number;
}

/** البيانات الدنيا لبناء payload أمر الشغل */
export interface WorkOrderPayloadFields {
  orderNumber: string;
  createdAt: Date;
  branchId: number;
}

/** البيانات الدنيا لبناء payload طلب الشراء */
export interface PurchaseOrderPayloadFields {
  poNumber: string;
  createdAt: Date;
  branchId: number;
}

/** البيانات الدنيا لبناء payload العميل */
export interface CustomerPayloadFields {
  id: number;
  name: string;
}

/** البيانات الدنيا لبناء payload طلب المتجر الإلكتروني */
export interface OnlineOrderPayloadFields {
  orderNumber: string;
  orderDate?: string | Date;
  total?: string;
  branchId?: number;
}

/** استجابة إجراء verify على الخادم */
export interface VerifyResult {
  valid: boolean;
  docType?: DocType;
  number?: string;
  date?: string;
  amount?: string;
  branchId?: number;
  status?: string;
  customerName?: string;
}

