/** Extra allocations are outside goods-only payment amounts, like held delivery. */
export interface CheckoutServiceCharge {
  description: string;
  amount: string;
}
export interface CheckoutApprovedChargeAllocation {
  chargeId: number;
  expectedVersion: number;
  amount: string;
}
export interface CheckoutChargePayment {
  paymentIndex: number;
  amount: string;
}
export interface CheckoutChargesInput {
  serviceCharges?: CheckoutServiceCharge[];
  approvedChargeAllocations?: CheckoutApprovedChargeAllocation[];
  chargePayments?: CheckoutChargePayment[];
}
export interface CheckoutChargeAllocation {
  chargeId: number;
  paymentId: number;
  receiptId: number;
  paymentIndex: number;
  amount: string;
}
export interface CheckoutReceiptAllocation {
  receiptId: number;
  paymentIndex: number;
  method: string;
  amount: string;
  reference: string | null;
  kind: "GOODS" | "DEPOSIT" | "SERVICE" | "CHARGE" | "HELD_DELIVERY";
}
export interface CheckoutChargesResult {
  chargeAllocations: CheckoutChargeAllocation[];
  checkoutReceipts: CheckoutReceiptAllocation[];
  checkoutPaymentSummary: {
    tenderedAmount: string;
    appliedAmount: string;
    changeAmount: string;
  };
}
