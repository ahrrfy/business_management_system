// عقد السندات المشترك (PaymentMethod/PartyType داخليان للحزمة، الباقي عام).

type PaymentMethod = "CASH" | "CARD" | "CHECK" | "TRANSFER" | "WALLET";
type PartyType = "CUSTOMER" | "SUPPLIER" | "OTHER";

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
  /** Idempotency: نفس المفتاح ⇒ سند واحد (لا صرف/قبض نقدي مزدوج عند النقر المزدوج/إعادة الشبكة). */
  clientRequestId?: string | null;
}

export interface VoucherResult {
  receiptId: number;
  voucherNumber: string;
  direction: "IN" | "OUT";
  /** APPROVED = أَثَّر مباشرةً؛ PENDING_APPROVAL = يَحتاج اعتماد مدير ثانٍ قبل التأثير. */
  approvalStatus: "APPROVED" | "PENDING_APPROVAL" | "REJECTED";
}


export type { PaymentMethod, PartyType };
