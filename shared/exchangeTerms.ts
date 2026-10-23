/** Exchange-office statement/reconciliation transaction names. */
export type ExchangeTransactionType =
  | "DEPOSIT"
  | "WITHDRAW"
  | "FX_BUY"
  | "SETTLE"
  | "OPENING";
export const EXCHANGE_TRANSACTION_LABEL: Readonly<
  Record<ExchangeTransactionType, string> & Partial<Record<string, string>>
> = {
  DEPOSIT: "إيداع",
  WITHDRAW: "سحب",
  FX_BUY: "شراء دولار",
  SETTLE: "تسديد مورد",
  OPENING: "رصيد افتتاحي",
};
