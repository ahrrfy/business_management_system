import type { InboundEnabledPaymentMethod } from "./inboundPaymentPolicy";

/** Raw new tender for goods/services only; held deposits and delivery fees are separate. */
export interface ReceptionPaymentLeg {
  amount: string;
  method: InboundEnabledPaymentMethod;
  externalPaymentAttemptId?: number | null;
  externalPaymentDeviceId?: string | null;
}
export interface ReceptionPaymentSummary {
  tenderedAmount: string;
  appliedAmount: string;
  changeAmount: string;
}
/** Actual new receipt allocations, never the raw cash tender or an existing held receipt. */
export interface ReceptionPaymentAllocation {
  paymentIndex: number;
  receiptId: number;
  invoiceId?: number;
  workOrderId?: number;
  method: InboundEnabledPaymentMethod;
  amount: string;
  reference: string | null;
}
export interface ReceptionPaymentMetadata {
  paymentSummary?: ReceptionPaymentSummary;
  paymentAllocations?: ReceptionPaymentAllocation[];
}
