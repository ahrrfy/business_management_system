import type { ColumnDef } from "@tanstack/react-table";
import {
  INBOUND_ENABLED_PAYMENT_METHODS,
  type InboundEnabledPaymentMethod,
} from "@shared/inboundPaymentPolicy";
import { paymentMethodCompact } from "@shared/terms";

export interface VoucherFormProps {
  voucherType: "RECEIPT" | "PAYMENT";
  embedded?: boolean;
  initialPartyType?: "CUSTOMER" | "SUPPLIER" | "DELIVERY_PARTY" | "OTHER";
  initialPartyId?: number | null;
  initialAmount?: string;
  initialCurrentBalance?: string;
  initialPendingReserved?: string;
  onSubmitted?: () => void;
  onCancel?: () => void;
}

export type LedgerPreviewRow = {
  side: string;
  account: string;
  amount: string;
};
export const ledgerPreviewColumns: ColumnDef<LedgerPreviewRow, unknown>[] = [
  {
    id: "side",
    header: "المحدد",
    accessorFn: (r) => r.side,
    enableSorting: false,
    meta: { align: "center" },
    cell: ({ row }) => <span className="font-bold">{row.original.side}</span>,
  },
  {
    id: "account",
    header: "الحساب",
    accessorFn: (r) => r.account,
    enableSorting: false,
    meta: { wrap: true },
    cell: ({ row }) => row.original.account,
  },
  {
    id: "amount",
    header: "المبلغ",
    accessorFn: (r) => r.amount,
    enableSorting: false,
    meta: { kind: "money" },
    cell: ({ row }) => row.original.amount,
  },
];
export type MethodValue = InboundEnabledPaymentMethod;
export const METHODS = INBOUND_ENABLED_PAYMENT_METHODS.map((value) => ({
  value,
  label: paymentMethodCompact(value),
}));
export function todayYmd(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
