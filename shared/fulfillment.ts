/** Shared operational vocabulary; historical sale references are never claims. */
export const FULFILLMENT_REQUEST_STATUSES = [
  "DRAFT",
  "PREPARING",
  "READY",
  "PARTIALLY_RELEASED",
  "RELEASED",
  "CANCELLED",
] as const;
export type FulfillmentRequestStatus =
  (typeof FULFILLMENT_REQUEST_STATUSES)[number];
export const fulfillmentRequestStatusLabel: Record<
  FulfillmentRequestStatus,
  string
> = {
  DRAFT: "مسودة",
  PREPARING: "قيد التجهيز",
  READY: "جاهز للإرسال",
  PARTIALLY_RELEASED: "مرسل جزئياً",
  RELEASED: "مرسل",
  CANCELLED: "ملغى",
};
export const FULFILLMENT_CHARGE_CATEGORIES = [
  "SERVICE",
  "OUTSOURCED",
  "PASS_THROUGH",
  "SHOP_EXPENSE",
] as const;
export type FulfillmentChargeCategory =
  (typeof FULFILLMENT_CHARGE_CATEGORIES)[number];
export const fulfillmentChargeCategoryLabel: Record<
  FulfillmentChargeCategory,
  string
> = {
  SERVICE: "أجر خدمة المكتبة",
  OUTSOURCED: "خدمة منفذة خارجياً",
  PASS_THROUGH: "تحصيل بالنيابة",
  SHOP_EXPENSE: "مصروف على المكتبة",
};
export const FULFILLMENT_CHARGE_STATUSES = [
  "DRAFT",
  "APPROVED",
  "CANCELLED",
] as const;
export type FulfillmentChargeStatus =
  (typeof FULFILLMENT_CHARGE_STATUSES)[number];
export const fulfillmentChargeStatusLabel: Record<
  FulfillmentChargeStatus,
  string
> = { DRAFT: "بانتظار الاعتماد", APPROVED: "معتمد", CANCELLED: "ملغى" };
export const AFTERCARE_CASE_STATUSES = [
  "DRAFT",
  "APPROVED",
  "IN_PROGRESS",
  "RESOLVED",
  "CANCELLED",
] as const;
export type AftercareCaseStatus = (typeof AFTERCARE_CASE_STATUSES)[number];
export const aftercareCaseStatusLabel: Record<AftercareCaseStatus, string> = {
  DRAFT: "بانتظار المراجعة",
  APPROVED: "معتمد",
  IN_PROGRESS: "قيد المعالجة",
  RESOLVED: "معالج",
  CANCELLED: "ملغى",
};
export const AFTERCARE_DISPOSITIONS = [
  "MISSING_HELD",
  "REPLACEMENT",
  "REPRINT",
] as const;
export type AftercareDisposition = (typeof AFTERCARE_DISPOSITIONS)[number];
export const aftercareDispositionLabel: Record<AftercareDisposition, string> = {
  MISSING_HELD: "استكمال مبيع موجود بعهدتنا",
  REPLACEMENT: "صرف بديل إضافي",
  REPRINT: "إعادة طباعة أو تصنيع",
};
export const AFTERCARE_EXECUTION_STATUSES = [
  "PREPARED",
  "DISPATCHED",
  "DELIVERED",
  "RETURNED",
  "CANCELLED",
] as const;
export type AftercareExecutionStatus =
  (typeof AFTERCARE_EXECUTION_STATUSES)[number];
export const aftercareExecutionStatusLabel: Record<
  AftercareExecutionStatus,
  string
> = {
  PREPARED: "مجهز",
  DISPATCHED: "بعهدة الناقل",
  DELIVERED: "تم التسليم",
  RETURNED: "عادت العهدة",
  CANCELLED: "ملغى",
};
export type FulfillmentMutationIdentity = {
  clientRequestId: string;
  expectedVersion: number;
};

export type AftercareSettlementDecision = {
  executionLineId: number;
  usableBaseQuantity: number;
  consumedBaseQuantity: number;
  damagedBaseQuantity: number;
  evidence: string;
};
export type AftercareSettlementSourceRight = {
  invoiceItemId: number;
  originalBundleComponentId: number | null;
  componentVariantId: number;
  baseQuantity: number;
  originalMovementId: number;
  usableBaseQuantity: number;
  damagedBaseQuantity: number;
  commercialAmount: string;
  originalIssueValue: string;
  costEvidence: string;
  costEvidenceReference: string;
};
export type FulfillmentSource =
  | { invoiceId: number; workOrderId?: never }
  | { workOrderId: number; invoiceId?: never };
export type FulfillmentDeliverySource =
  | {
      sourceType: "FULFILLMENT_REQUEST";
      fulfillmentRequestId: number;
      aftercareExecutionId?: never;
    }
  | {
      sourceType: "AFTERCARE_EXECUTION";
      aftercareExecutionId: number;
      fulfillmentRequestId?: never;
    };
export type FulfillmentClaimSource =
  | { kind: "INVOICE"; invoiceId: number }
  | { kind: "FULFILLMENT_CHARGE"; chargeId: number };
