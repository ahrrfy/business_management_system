import Decimal from "decimal.js";

export type PurchaseSettlementStatus =
  | "UNPAID"
  | "PARTIAL"
  | "PAID"
  | "CREDITED";

export interface PurchaseSettlementEvidence {
  paidAmountIqd: string;
  returnedAmountIqd: string;
  remainingAmountIqd: string;
  paidAmountCurrency: string;
  returnedAmountCurrency: string;
  remainingAmountCurrency: string;
  status: PurchaseSettlementStatus;
  requiresReview: boolean;
  evidenceReason?: string;
}

export interface PurchaseSettlementInput {
  total?: string | number | null;
  paidAmount?: string | number | null;
  linkedCashPaidAmount?: string | number | null;
  returnedAmount?: string | number | null;
  agreedCurrency?: string | null;
  usdTotal?: string | number | null;
  paidUsd?: string | number | null;
  returnedUsd?: string | number | null;
  settlementType?: string | null;
  settlement?: PurchaseSettlementEvidence | null;
}

export function getPurchaseSettlementIntentLabel(type?: string | null): string {
  return type === "CASH" ? "نقدي (طريقة السداد)" : "آجل (طريقة السداد)";
}

export function getPurchaseSettlement(input: PurchaseSettlementInput) {
  const usd = input.agreedCurrency === "USD";
  const evidence = input.settlement;
  // Older responses may contain a legacy projection. New responses always use
  // the server's allocation evidence, even when the cached PO paid total is larger.
  const paid = evidence
    ? new Decimal(usd ? evidence.paidAmountCurrency : evidence.paidAmountIqd)
    : usd
      ? new Decimal(input.paidUsd ?? 0)
      : Decimal.max(input.paidAmount ?? 0, input.linkedCashPaidAmount ?? 0);
  const returned = evidence
    ? new Decimal(
        usd ? evidence.returnedAmountCurrency : evidence.returnedAmountIqd,
      )
    : new Decimal((usd ? input.returnedUsd : input.returnedAmount) ?? 0);
  const remaining = evidence
    ? new Decimal(
        usd ? evidence.remainingAmountCurrency : evidence.remainingAmountIqd,
      )
    : Decimal.max(
        new Decimal((usd ? input.usdTotal : input.total) ?? 0)
          .minus(paid)
          .minus(returned),
        0,
      );
  const status: PurchaseSettlementStatus =
    evidence?.status ??
    (remaining.gt(0)
      ? paid.gt(0)
        ? "PARTIAL"
        : "UNPAID"
      : returned.gt(0)
        ? "CREDITED"
        : "PAID");
  const requiresReview = evidence?.requiresReview ?? false;
  const labels: Record<PurchaseSettlementStatus, string> = {
    UNPAID: "غير مسددة",
    PARTIAL: "مسددة جزئياً",
    PAID: "مسددة بالكامل",
    CREDITED: "مقفلة بتخفيض الذمة",
  };
  return {
    paidAmount: paid.toFixed(2),
    returnedAmount: returned.toFixed(2),
    remainingAmount: remaining.toFixed(2),
    status,
    intentLabel: getPurchaseSettlementIntentLabel(input.settlementType),
    statusLabel: requiresReview ? "بحاجة إلى مطابقة السداد" : labels[status],
    requiresReview,
  };
}
