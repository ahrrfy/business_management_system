// عقد الشراء المشترك (أمر الشراء/الاستلام/تسديد فاتورة الدولار).

type PaymentMethod = "CASH" | "CARD" | "CHECK" | "TRANSFER" | "WALLET";

export interface PurchaseLineInput {
  variantId: number;
  productUnitId: number;
  quantity: string; // in purchase unit
  unitPrice: string; // price per purchase unit
}
export interface CreatePurchaseOrderInput {
  supplierId: number;
  branchId: number;
  taxRatePercent?: string | null;
  status?: "DRAFT" | "SENT" | "CONFIRMED";
  items: PurchaseLineInput[];
  notes?: string | null;
  clientRequestId?: string;
  /** usd-po-reconcile: مطابقة سعر الشراء بالدولار (إعلامي بحت — لا يمسّ total/paidAmount الديناريَين). */
  agreedCurrency?: "IQD" | "USD";
  /** مبلغ فاتورة المورد الفعلية بالدولار — إلزامي فقط حين agreedCurrency=USD. */
  usdTotal?: string | null;
  /** سعر التثبيت بالدينار لكل دولار. وجوده يعني أن unitPrice في البنود سعر المورد بالدولار. */
  agreedRate?: string | null;
  /** landed-cost: تكلفة الشحن الكلّية على أمر الشراء (تُرسمَل في تكلفة المخزون عند الاستلام، لا مصروف P&L). */
  shippingCost?: string | null;
  /** landed-cost: تكلفة الكمرك الكلّية على أمر الشراء (تُرسمَل مثل الشحن تماماً). */
  customsCost?: string | null;
}

export interface SettlePurchaseUsdDirectInput {
  purchaseOrderId: number;
  settledUsd: string;
  chargedIqd: string;
  feeIqd?: string | null;
  method: "CARD" | "TRANSFER" | "WALLET";
  referenceNumber: string;
  clientRequestId?: string | null;
}

export interface ReceiveLineInput {
  purchaseOrderItemId: number;
  receivedBaseQuantity: number;
}
export interface ReceivePurchaseInput {
  purchaseOrderId: number;
  lines: ReceiveLineInput[];
  payment?: { amount: string; method: PaymentMethod } | null;
  /**
   * طريقة دفع **مصروف الشحن/الكمرك** المُسجَّل لحظة الاستلام (قرار المالك ٥/٨/٢٦: الشحن مصروفُ
   * شركةٍ لا ذمّةُ مورّد). الافتراضي نقديّ — ويمرّ عندها بحارس وردية/خزينة الصندوق. مستقلٌّ تماماً
   * عن `payment` أعلاه (تلك دفعةٌ للمورّد، وهذه دفعةٌ لشركة النقل).
   */
  shippingPaymentMethod?: PaymentMethod | null;
  /** مرجع أداة تسوية الشحن؛ إلزامي للتحويل والصك ويُحفظ في السند المالي. */
  shippingPaymentReference?: string | null;
  /** آخر أربعة أرقام للبطاقة عند اختيار CARD. */
  shippingCardLastFour?: string | null;
  /** طرف النقل المسجّل إن كان مورّداً؛ وإلا يلزم الاسم الحر مع دليل المصدر. */
  shippingBeneficiarySupplierId?: number | null;
  shippingBeneficiaryName?: string | null;
  /** رقم فاتورة/وصل الناقل أو مستند الكمرك الذي يثبت الاعتراف، لا مرجع الدفع اللاحق. */
  shippingEvidenceReference?: string | null;
  /** Idempotency: نفس المفتاح يُعاد تشغيله بنتيجة الاستلام الأول (لا تكرار للمخزون/AP). */
  clientRequestId?: string | null;
}
