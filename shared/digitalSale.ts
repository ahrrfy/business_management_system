/**
 * Common rules for the human-entered evidence attached to a digital sale.
 *
 * This is deliberately an internal record only.  It does not call or validate
 * against a provider/platform API; it merely keeps the cashier, invoice and
 * reconciliation reports on the same normalized value.
 */
export function normalizeDigitalSaleReference(value: string | null | undefined): string {
  return (value ?? "").trim().replace(/\s+/g, "");
}

export function digitalSaleReferenceLabel(offeringType: string | null | undefined): string {
  return offeringType === "EDUCATIONAL_SUBSCRIPTION"
    ? "رقم الاشتراك أو ID"
    : "رقم العملية أو ID الكرت";
}

/** One external provider operation can contain several individually tracked cards. */
export const DIGITAL_BASKET_REFERENCE_LABEL = "رقم عملية المزود للسلة";

export function digitalOfferingTypeLabel(offeringType: string | null | undefined): string {
  switch (offeringType) {
    case "TELECOM_CARD": return "بطاقة اتصالات";
    case "GLOBAL_CARD": return "بطاقة عالمية";
    case "EDUCATIONAL_SUBSCRIPTION": return "اشتراك تعليمي";
    default: return "بطاقة رقمية";
  }
}

export function digitalOfferingDescription(input: {
  offeringType?: string | null;
  faceValue?: string | null;
  subscriptionDurationDays?: number | null;
}): string {
  const parts = [digitalOfferingTypeLabel(input.offeringType)];
  if (input.faceValue != null) parts.push(`القيمة الاسمية: ${input.faceValue}`);
  if (input.subscriptionDurationDays != null) parts.push(`المدة: ${input.subscriptionDurationDays} يوم`);
  return parts.join(" · ");
}

/** Public ordinary-product fields only: no cost overrides or internal sale capabilities. */
export interface DigitalCheckoutRegularLineInput {
  lineKey: string;
  variantId: number;
  productUnitId: number;
  quantity: string;
  unitPriceOverride?: string | null;
  discountAmount?: string | null;
  discountPercent?: string | null;
  promotionId?: number | null;
  isGift?: boolean;
}

export interface DigitalCheckoutRegularLineSnapshot {
  lineKey: string;
  variantId: number;
  productUnitId: number;
  quantity: string;
  unitPrice: string;
  discountAmount: string;
  total: string;
  promotionId: number | null;
  isGift: boolean;
}

/** ملخص خادمي لبَوّابات السعر؛ لا يقبل أي قيمة من العميل. */
export interface DigitalCheckoutPricingGuardSnapshot {
  paidCostTotal: string;
  giftCostTotal: string;
  paidLineBelowCost: boolean;
  manualLineDiscountGate: boolean;
  referenceGrossTotal: string;
}

/**
 * قفل كتالوج/مخزون دائم مرتبط بنية البيع المختلط.
 * reservedBase=0 يعني قفل معنى المصدر فقط (خدمة عمالية أو صنف backorder)، ولا يحجز كمية.
 */
export interface DigitalCheckoutInventoryReservationSnapshot {
  sourceVariantId: number;
  stockVariantId: number;
  /** الطلب الحقيقي من التعريف المتجمّد؛ يبقى موجباً حتى لو كان الصنف backorder بلا حجز. */
  demandedBase: number;
  reservedBase: number;
}

/** Server-owned, durable checkout binding; legacy digital-only intents have NULL. */
export interface DigitalCheckoutSnapshot {
  version: 1;
  requestFingerprint: string;
  customerId: number | null;
  priceTier: "RETAIL" | "WHOLESALE" | "GOVERNMENT";
  regularLines: DigitalCheckoutRegularLineSnapshot[];
  /** غائب في النيات التاريخية قبل هجرة 0362. */
  inventoryReservations?: DigitalCheckoutInventoryReservationSnapshot[];
  /** لقطة سلطة اعتماد السعر، بلا أي كلمة مرور أو سر مصادقة. */
  priceOverrideApproved?: boolean;
  priceApprovedBy?: number | null;
  /** غائب فقط في النيات التاريخية السابقة لتشديد بوابة ما قبل الإصدار. */
  pricingGuard?: DigitalCheckoutPricingGuardSnapshot;
  expectedSubtotal: string;
  /** حقول الفاتورة المتقدمة التي يجب أن تبقى مرتبطة بالنيّة حتى التثبيت/الاسترداد. */
  dueDate?: string | null;
  notes?: string | null;
  /** هوية مدير تحقّق منها الراوتر؛ لا تقبلها الخدمة من قناة عامة مباشرة. */
  managerApprovedByUserId?: number | null;
  /** موافقة ائتمان محدّدة بالعميل والمبلغ، تُستهلك ذرّياً عند إنشاء الفاتورة. */
  creditApprovalId?: number | null;
  sourceType?: "POS" | "INVOICE" | "RECEPTION";
  sourcePayload?: any;
}
