export type DrilldownTarget =
  | { type: "INVOICE"; invoiceId: number; title?: string }
  | { type: "PURCHASE_ORDER"; poId: number; title?: string }
  | { type: "VOUCHER"; receiptId: number; title?: string }
  | {
      type: "GENERIC";
      title: string;
      subtitle?: string;
      amount: string;
      date?: string;
      direction: "DEBIT" | "CREDIT";
      details?: Record<string, string | number | null | undefined>;
    };
