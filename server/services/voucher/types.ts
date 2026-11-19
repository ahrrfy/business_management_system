// عقد السندات المشترك (PaymentMethod/PartyType داخليان للحزمة، الباقي عام).

type PaymentMethod = "CASH" | "CARD" | "CHECK" | "TRANSFER" | "WALLET" | "EXCHANGE";
type PartyType = "CUSTOMER" | "SUPPLIER" | "DELIVERY_PARTY" | "OTHER";

export interface VoucherInput {
  /** نوع السند: RECEIPT = قبض (IN)، PAYMENT = صرف (OUT). */
  voucherType: "RECEIPT" | "PAYMENT";
  branchId: number;
  amount: string; // موجبة بالطريقة money
  paymentMethod: PaymentMethod;
  partyType: PartyType;
  partyId?: number | null; // لـCUSTOMER/SUPPLIER، إلزامي؛ لـOTHER null.
  description: string;
  referenceNumber?: string | null;
  checkNumber?: string | null;
  cardLastFour?: string | null;
  // vouchers-pro:
  voucherCategoryId?: number | null;
  counterpartyName?: string | null;
  voucherDate?: string | null;       // YYYY-MM-DD (الافتراضي = اليوم المحلي)
  attachmentUrl?: string | null;
  internalNote?: string | null;
  /** attachment-upload (٥/٧): ربط سند العميل بفاتورة بيع مُحدَّدة (تظهر في سجلّ دفعات الفاتورة). partyType=CUSTOMER فقط. */
  invoiceId?: number | null;
  /** Frozen supplier invoice allocations; omission proposes oldest eligible invoices first. */
  supplierAllocations?: import("@shared/supplierVoucherSettlement").SupplierVoucherAllocation[];
  supplierCashSource?: { mode: "DRAWER" | "TREASURY"; shiftId?: number | null };
  /** Original approved supplier OUT receipt whose advance is being refunded. */
  supplierAdvanceRefundReceiptId?: number;
  /** التصنيف الصريح لسند قبض من مورد: استرداد دفعة سابقة أو إشعار/مبلغ دائن يرفع ذمة المورد. */
  supplierReceiptPurpose?: "ADVANCE_REFUND" | "CREDIT_OBLIGATION";
  /** السماح الصريح بصرف لمورد عادي يتجاوز الرصيد المستحق المسجّل حالياً (إنشاء رصيد «لنا عليه»). */
  allowSupplierOverpay?: boolean;
  /** Idempotency: نفس المفتاح ⇒ سند واحد (لا صرف/قبض نقدي مزدوج عند النقر المزدوج/إعادة الشبكة). */
  clientRequestId: string;
}

export interface VoucherResult {
  receiptId: number;
  voucherNumber: string;
  direction: "IN" | "OUT";
  /** APPROVED = أَثَّر مباشرةً؛ PENDING_APPROVAL = يَحتاج اعتماد مدير ثانٍ قبل التأثير. */
  approvalStatus: "APPROVED" | "PENDING_APPROVAL" | "REJECTED";
  balanceBefore?: string;
  balanceAfter?: string;
  excessUnallocatedAmount?: string;
}


export type { PaymentMethod, PartyType };
