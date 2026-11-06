/** Refund rail is explicit: a cash collection can only be refunded in cash. */
export type DigitalRefundMethod = "CASH" | "CARD";
export type DigitalRefundStage = "RESERVE" | "RELEASE" | "EVIDENCE" | "EXECUTE";
export type DigitalRefundTender =
  | { method: "CASH" }
  | { method: "CARD"; reference: string; confirmed: true };

export type DigitalCardRefundControl =
  | { stage: "RESERVE"; expectedAmount: string }
  | { stage: "EVIDENCE"; tender: DigitalRefundTender }
  | { stage: "RELEASE"; noRefundConfirmed: true; reason: string; grantToken?: string };

export const DIGITAL_PARTIAL_SETTLEMENT = "SETTLE_PARTIAL" as const;

export function digitalRefundMethodAllowed(originalMethod: string, refundMethod: string): boolean {
  return ["CASH", "CARD", "CREDIT"].includes(originalMethod) &&
    (refundMethod === "CASH" || (originalMethod === "CARD" && refundMethod === "CARD"));
}
