// عقد الشراء المشترك (أمر الشراء/الاستلام/تسديد فاتورة الدولار).

type PaymentMethod = "CASH" | "CARD" | "CHECK" | "TRANSFER" | "WALLET";
export type PurchaseSettlementType = "CASH" | "CREDIT";

export interface PurchaseLineInput {
  variantId: number;
  productUnitId: number;
  quantity: string; // in purchase unit
  /**
   * سعر الوحدة **بعملة الأمر** (`PurchaseDocumentInput.agreedCurrency`) لا بالدينار دائماً:
   * الدينار حتى منزلتين، والدولار حتى أربع (`shared/moneyPrecision`). يفرض ذلك
   * `computePurchaseDocument` صراحةً — تجاوزُ الدقّة يُردّ برسالة لا يُقصّ صامتاً.
   */
  unitPrice: string;
}
/**
 * الحقول التي يُشتقّ منها حسابُ أمر الشراء (البنود والإجماليات) — يتقاسمها الإنشاء والتعديل
 * عبر `computePurchaseDocument` كي لا ينجرف الحسابان. لا تحمل هويّة الأمر ولا حالته.
 */
export interface PurchaseDocumentInput {
  taxRatePercent?: string | null;
  items: PurchaseLineInput[];
  /** usd-po-reconcile: مطابقة سعر الشراء بالدولار (إعلامي بحت — لا يمسّ total/paidAmount الديناريَين). */
  agreedCurrency?: "IQD" | "USD";
  /** مبلغ فاتورة المورد الفعلية بالدولار — إلزامي فقط حين agreedCurrency=USD. */
  usdTotal?: string | null;
  /**
   * **قيمة فاتورة المورّد الورقيّة بعملة الأمر** — ضابطُ مطابقةٍ اختياريّ لا حقيقةٌ مستقلّة:
   * حين تُرسَل يجب أن تساوي الإجماليَّ المشتقّ من البنود بالضبط، وإلّا رُفض الحفظ برسالةٍ تحمل
   * الرقمين والفرق. فائدتُها أنّ الأمر المحفوظ لا يخالف مستنده أبداً (بلاغ المالك ١٧/٨/٢٦:
   * «لا يتم قبول الفاتورة ولا يمكن مطابقتها مع المورد وقيمة الفاتورة»).
   * لا تُخزَّن عموداً مستقلاً: بعد المطابقة هي نفسها `total` (أو `usdTotal` للأمر الدولاريّ).
   */
  supplierInvoiceTotal?: string | null;
  /** سعر التثبيت بالدينار لكل دولار. وجوده يعني أن unitPrice في البنود سعر المورد بالدولار. */
  agreedRate?: string | null;
  /**
   * **خصم فاتورة المورّد بعملة المستند** (0204) — مبلغٌ فاتوريّ لا سطريّ، كما يُحرّره المورّد.
   * يُوزَّع خادمياً بنسبة القيمة فتُخزَّن أعمدةُ المال **صافيةً**؛ ومن ثمّ يَنقص ذمّةَ المورّد
   * وتكلفةَ المخزون (WAVG) تلقائياً — وهي المعالجة المحاسبية القياسية للخصم التجاريّ، والموافِقة
   * لقرار المالك «تكلفة الصنف = سعر المورّد وحده» (وخصمُه جزءٌ من سعره لا إيرادٌ مستقلّ).
   */
  invoiceDiscount?: string | null;
  /** landed-cost: تكلفة الشحن الكلّية على أمر الشراء (مصروف نقلٍ لحظة الاستلام — لا ذمّة مورّد ولا تكلفة صنف). */
  shippingCost?: string | null;
  /** landed-cost: تكلفة الكمرك الكلّية على أمر الشراء (تُعامَل مثل الشحن تماماً). */
  customsCost?: string | null;
}

export interface CreatePurchaseOrderInput extends PurchaseDocumentInput {
  supplierId: number;
  branchId: number;
  /** CASH = طلب صرف تلقائي لقيمة كل استلام؛ CREDIT = تبقى ذمة حتى دفع صريح. */
  settlementType?: PurchaseSettlementType;
  status?: "DRAFT" | "SENT" | "CONFIRMED";
  notes?: string | null;
  clientRequestId?: string;
}

/**
 * تعديل أمر شراء قبل أيّ أثرٍ ماليّ/مخزنيّ. الفرع ورقم الأمر والحالة **غير قابلة للتعديل**:
 * الفرع يحدّد ترقيم الأمر وعزلَه الأمنيّ، والحالة لها إجراؤها المستقلّ (اعتماد/إلغاء).
 */
export interface UpdatePurchaseOrderInput extends PurchaseDocumentInput {
  purchaseOrderId: number;
  supplierId: number;
  notes?: string | null;
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
