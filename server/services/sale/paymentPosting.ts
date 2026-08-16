import type { AccountRole } from "../accounting/postingEngine";

export type PostingCashBucket = "DRAWER" | "TREASURY" | null | undefined;
export type PostingDirection = "IN" | "OUT";

/** Resolve the asset account actually touched by a receipt; never guess an instrument. */
export function paymentAssetRole(
  method: string | null | undefined,
  cashBucket: PostingCashBucket,
  direction: PostingDirection,
): Extract<
  AccountRole,
  | "CASH"
  | "TREASURY_CASH"
  | "CARD_BANK"
  | "CHECKS_RECEIVABLE"
  | "PAYMENT_WALLET"
  | "TELECOM_BALANCE"
> {
  if (method === "CASH" && cashBucket === "DRAWER") return "CASH";
  if (method === "CASH" && cashBucket === "TREASURY") return "TREASURY_CASH";
  if (method === "CARD" || method === "TRANSFER") return "CARD_BANK";
  // A received cheque is our receivable instrument. Issuing/refunding by cheque
  // reduces the bank asset unless a future workflow explicitly endorses a held cheque.
  if (method === "CHECK")
    return direction === "IN" ? "CHECKS_RECEIVABLE" : "CARD_BANK";
  if (method === "WALLET") return "PAYMENT_WALLET";
  if (method === "TELECOM") return "TELECOM_BALANCE";
  throw new Error(
    `تعذّر تحديد حساب الدفع (الطريقة=${method ?? "NULL"}، الدلو=${cashBucket ?? "NULL"})`,
  );
}
