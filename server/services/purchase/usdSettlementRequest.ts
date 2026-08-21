import { money } from "../money";

export const PURCHASE_USD_REFERENCE_PREFIX = "PO-USD-PAY-";

export type PurchaseSupplierUsdSystemPaymentRequest = {
  kind: "PURCHASE_SUPPLIER_USD";
  purchaseOrderId: number;
  requestToken: string;
  settledUsd: string;
  carryingIqd: string;
  chargedIqd: string;
  feeIqd: string;
  expectedAmount: string;
  sourceTotal: string;
  sourceUsdTotal: string;
  sourceAgreedRate: string;
  paymentMethod: "CARD" | "TRANSFER" | "WALLET";
  paymentEvidenceReference: string;
  cardLastFour: string | null;
  /** Present only on a safely reconstructed pre-governance receipt. */
  legacyReceiptId: number | null;
};

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function isCanonicalPositiveMoney(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^(?:0|[1-9]\d*)\.\d{2}$/.test(value) &&
    money(value).gt(0)
  );
}

function isCanonicalNonNegativeMoney(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^(?:0|[1-9]\d*)\.\d{2}$/.test(value) &&
    money(value).gte(0)
  );
}

export function purchaseUsdSettlementReference(
  poNumber: string,
  requestToken: string,
): string {
  return `${PURCHASE_USD_REFERENCE_PREFIX}${poNumber}-${requestToken}`;
}

export function isCanonicalPurchaseUsdSystemPaymentRequest(
  request: PurchaseSupplierUsdSystemPaymentRequest,
  reference: string | null | undefined,
): boolean {
  if (
    !reference ||
    !isPositiveSafeInteger(request.purchaseOrderId) ||
    !/^[0-9a-f]{16}$/i.test(request.requestToken) ||
    !isCanonicalPositiveMoney(request.settledUsd) ||
    !isCanonicalPositiveMoney(request.carryingIqd) ||
    !isCanonicalPositiveMoney(request.chargedIqd) ||
    !isCanonicalNonNegativeMoney(request.feeIqd) ||
    !isCanonicalPositiveMoney(request.expectedAmount) ||
    !isCanonicalPositiveMoney(request.sourceTotal) ||
    !isCanonicalPositiveMoney(request.sourceUsdTotal) ||
    typeof request.sourceAgreedRate !== "string" ||
    !/^(?:0|[1-9]\d*)\.\d{4}$/.test(request.sourceAgreedRate) ||
    !money(request.sourceAgreedRate).gt(0) ||
    !["CARD", "TRANSFER", "WALLET"].includes(request.paymentMethod) ||
    typeof request.paymentEvidenceReference !== "string" ||
    request.paymentEvidenceReference.trim() !==
      request.paymentEvidenceReference ||
    request.paymentEvidenceReference.length === 0 ||
    request.paymentEvidenceReference.length > 200 ||
    (request.legacyReceiptId != null &&
      !isPositiveSafeInteger(request.legacyReceiptId))
  ) {
    return false;
  }
  if (
    request.paymentMethod === "CARD"
      ? request.legacyReceiptId == null
        ? !/^\d{4}$/.test(request.cardLastFour ?? "")
        : request.cardLastFour != null && !/^\d{4}$/.test(request.cardLastFour)
      : request.cardLastFour != null
  ) {
    return false;
  }
  return (
    money(request.expectedAmount).eq(
      money(request.chargedIqd).plus(money(request.feeIqd)),
    ) &&
    reference.startsWith(PURCHASE_USD_REFERENCE_PREFIX) &&
    reference.endsWith(`-${request.requestToken}`)
  );
}
