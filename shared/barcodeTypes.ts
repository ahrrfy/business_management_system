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
export type DocType = "INV" | "WO" | "PO" | "QUO" | "CUST";

/**
 * نتيجة تحليل أي مدخل ماسح — discriminated union لتوجيه الإجراء.
 * Strategy Pattern: كل نوع يُعالَج بطريقة مستقلة في scanRouter.
 */
export type ScanResult =
  | { type: "invoice";       number: string }
  | { type: "workOrder";     number: string }
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

/** استجابة إجراء verify على الخادم */
export interface VerifyResult {
  valid: boolean;
  docType?: DocType;
  number?: string;
  date?: string;
  amount?: string;
  branchId?: number;
}
