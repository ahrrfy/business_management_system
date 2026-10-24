/** Barcode stations share real source identities; a scan is always read-only. */
export const WORKFLOW_STATIONS = [
  "dispatch",
  "collect",
  "cancelAssignment",
  "return",
  "edit",
  "aftercare",
] as const;
export type WorkflowStation = (typeof WORKFLOW_STATIONS)[number];
export const WORKFLOW_SOURCE_KINDS = [
  "invoice",
  "workOrder",
  "onlineOrder",
  "consignment",
  "fulfillmentRequest",
  "aftercareExecution",
  "charge",
] as const;
export type WorkflowSourceKind = (typeof WORKFLOW_SOURCE_KINDS)[number];
export type WorkflowAction = WorkflowStation | "reassign" | "declareReturn";
export interface WorkflowSourceIdentity {
  kind: WorkflowSourceKind;
  id: number;
  number: string;
  branchId: number;
  /** Opaque snapshot token, including current source relationships and amounts. */
  version: string;
  canonicalKey: string;
}
export interface WorkflowScanPreview {
  source: WorkflowSourceIdentity;
  printSource: {
    sourceType:
      | "INVOICE"
      | "WORK_ORDER"
      | "ONLINE_ORDER"
      | "FULFILLMENT_REQUEST"
      | "AFTERCARE_EXECUTION"
      | "CHARGE"
      | "CONSIGNMENT";
    sourceId: number;
    number: string;
    invoiceId?: number;
    invoiceNumber?: string;
    workOrderId?: number;
    fulfillmentRequestId?: number;
    aftercareExecutionId?: number;
  };
  status: string;
  relations: {
    invoiceId?: number;
    workOrderId?: number;
    onlineOrderId?: number;
    consignmentId?: number;
    fulfillmentRequestId?: number;
    aftercareCaseId?: number;
    aftercareCaseStatus?: string;
    aftercareExecutionId?: number;
    chargeId?: number;
    correctedByInvoiceId?: number;
    originalInvoiceId?: number;
  };
  recipient: {
    customerId: number | null;
    name: string | null;
    phone: string | null;
    address: string | null;
  };
  money: {
    currentTotal: string;
    paidAmount: string;
    remainingAmount: string;
    codAmount: string;
    cashInCourierCustody: string;
    heldDeliveryFee: string;
    serviceCharges: string;
    deliveryFee: string;
    feeCollection: "COURIER" | "COUNTER" | "SHOP";
    paymentMode: "PREPAID" | "COD" | "CREDIT" | null;
    heldReceipts: {
      id: number;
      amount: string;
      direction: "IN" | "OUT";
      status: string;
    }[];
    pendingRefundReceiptIds: number[];
  };
  actions: { action: WorkflowAction; allowed: boolean; reason?: string }[];
  returnState?: {
    declared: boolean;
    received: boolean;
    heldCustomerOwned: boolean;
    commercialActionRequired: boolean;
    sourceClosureRequired: boolean;
    refundActionRequired: boolean;
    nextStep: string;
    reissueAllowed: boolean;
    reissueBlockedReason?: string;
    members: {
      consignmentId: number;
      consignmentNumber: string;
      invoiceId: number | null;
      invoiceNumber: string | null;
      invoiceSourceType: string | null;
      workOrderId: number | null;
      workOrderNumber: string | null;
      declared: boolean;
      canReceive: boolean;
      cashInCourierCustody: string;
      received: boolean;
      receivedAt: string | null;
      heldCustomerOwned: boolean;
      commercialActionRequired: boolean;
      sourceClosureRequired: boolean;
    }[];
  };
  group?: {
    key: string;
    leaderConsignmentId: number | null;
    consignmentNumber: string | null;
    consignmentIds: number[];
    invoiceIds: number[];
    fulfillmentRequestId: number | null;
    partyId: number | null;
  };
}
export interface WorkflowDispatchSource {
  kind: WorkflowSourceKind;
  id: number;
  expectedVersion: string;
}
export interface WorkflowDispatchBatchInput {
  sources: WorkflowDispatchSource[];
  branchId?: number;
  partyId: number;
  assignedUserId?: number;
  deliveryFee: string;
  feeCollection: "COURIER" | "COUNTER" | "SHOP";
  recipientName: string;
  recipientPhone: string;
  deliveryAddress: string;
  externalTrackingRef?: string;
  notes?: string;
  clientRequestId: string;
}
export interface WorkflowDispatchBatchResult {
  consignmentId: number;
  consignmentNumber: string;
  fulfillmentRequestId: number | null;
  invoiceIds: number[];
  idempotentReplay: boolean;
}
export interface WorkflowBatchPreview {
  sources: WorkflowScanPreview[];
  duplicateCanonicalKeys: string[];
  summary: {
    currentTotal: string;
    paidAmount: string;
    remainingAmount: string;
    codAmount: string;
    heldDeliveryFee: string;
    serviceCharges: string;
    goodsCodAmount: string;
    courierFeeAmount: string;
  };
  blockedReasons: string[];
  feeRequirement?: {
    heldAmount: string;
    requestedFee: string;
    refundRequired: string;
    receiptIds: number[];
    reason: string | null;
  };
}
