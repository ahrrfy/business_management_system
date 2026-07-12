// عقد البيع (POS/عبر القنوات) المشترك.
import type { PriceTier } from "../pricing";

// تصدير داخلي للحزمة فقط (يستهلكه create/payment) — لا يُعاد تصديره من البرميل saleService.ts.
export type PaymentMethod = "CASH" | "CARD" | "CHECK" | "TRANSFER" | "WALLET";

export interface SaleLineInput {
  variantId: number;
  productUnitId: number;
  quantity: string;
  unitPriceOverride?: string | null;
  discountPercent?: string | null;
  discountAmount?: string | null;
  /** promotions v2 (٨/٧/٢٦): معرّف العرض الذي عرضه POS للعميل — الخادم يتحقّق (idempotent)
   *  أن العرض ما زال ساري ويحسب `expectedDiscount = discountForUnit × qty` ويقارن مع `discountAmount`.
   *  إن طابق ⇒ يُخزَّن `promotionId` + `promotionDiscount` على invoiceItem. إن لم يطابق ⇒ لا نُخزّن
   *  (نعامل الخصم كيدوي) — لا نرفض لتفادي فشل بيع بعد تعديل عرض بين العرض والحفظ. */
  promotionId?: number | null;
}

export interface CreateSaleInput {
  branchId: number;
  shiftId?: number | null;
  customerId?: number | null;
  priceTier?: PriceTier | null;
  sourceType: "POS" | "ONLINE" | "ORDER" | "WORKORDER";
  lines: SaleLineInput[];
  invoiceDiscount?: string | null;
  /** أجرة توصيل/شحن تُضاف على رأس الفاتورة كإيراد شحن (بلا تكلفة/مخزون). تُستعمل في إرسال طلب المتجر
   *  (COD) كي تكون invoice.total = subtotal + الشحن = ما وافق عليه الزبون، فيُحصّل المندوب كامل المبلغ. */
  deliveryFee?: string | null;
  taxRatePercent?: string | null;
  payment?: { amount: string; method: PaymentMethod } | null;
  clientRequestId?: string | null;
  notes?: string | null;
  /** موافقة مدير على تجاوز حدّ الائتمان (يضبطها الراوتر بعد التحقّق من هوية المدير).
   *  B5: إن كانت true يجب توفير إمّا creditApprovalId (تدفّق UI جديد) أو managerOverrideByUserId (تدفّق router قديم). */
  creditApproved?: boolean;
  /** B5: معرّف صفّ creditApprovals موجود (سقف صريح + انتهاء + single-use) — للتدفّق الجديد. */
  creditApprovalId?: number;
  /** B5: userId لمدير وُثِّقَت هويته خادمياً (الراوتر يمرّره بعد verifyManagerApproval) —
   *  الخدمة تُنشئ صفّ creditApproval ذرّياً داخل نفس withTx (مرتبط بالعميل، single-use، 5min TTL). */
  managerOverrideByUserId?: number;
  /** تاريخ استحقاق الفاتورة (YYYY-MM-DD) — للبيع الآجل. يظهر في AR aging والتنبيهات. */
  dueDate?: string | null;
  /** تقريب نقدي عراقي للبيع النقدي الكامل (يضبطه POS): الخادم يقرّب الإجمالي ويُسجّل الفرق ADJUST. */
  cashRoundIQD?: boolean;
  /** SALES-01/02: موافقة على البيع بأقل من التكلفة (سعر override أو خصم يَنزل بالبند/الفاتورة تحت COGS).
   *  يضبطها الراوتر: مدير/أدمن لهما السلطة ذاتياً، والكاشير يحتاج managerApproval مُتحقَّقاً. */
  priceOverrideApproved?: boolean;
}

export interface CreateSaleResult {
  invoiceId: number;
  invoiceNumber: string;
  total: string;
  status: "PENDING" | "PARTIALLY_PAID" | "PAID";
  idempotentReplay?: boolean;
  /** SALES-01/02: صحيح إن باع بند/فاتورة تحت التكلفة (طُبِّق بموافقة) — للتدقيق. */
  priceOverride?: boolean;
}
