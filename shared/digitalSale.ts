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

/** Server-owned, durable checkout binding; legacy digital-only intents have NULL. */
export interface DigitalCheckoutSnapshot {
  version: 1;
  requestFingerprint: string;
  customerId: number | null;
  priceTier: "RETAIL" | "WHOLESALE" | "GOVERNMENT";
  regularLines: DigitalCheckoutRegularLineSnapshot[];
  expectedSubtotal: string;
}
