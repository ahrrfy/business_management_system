export const PRINT_DOCUMENT_TYPES = [
  "PURCHASE_RETURN",
  "EXCHANGE_TRANSACTION",
  "VOUCHER",
  "CUSTOMER_STATEMENT",
  "SUPPLIER_STATEMENT",
] as const;

export type PrintDocumentType = (typeof PRINT_DOCUMENT_TYPES)[number];
export type PrintChannel = "BROWSER" | "PDF" | "THERMAL" | "SERVER_BRIDGE";
export type PrintOutcome = "REQUESTED" | "DIALOG_OPENED" | "DISPATCHED" | "FAILED";
