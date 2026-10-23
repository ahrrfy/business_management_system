import { isDeadInvoiceStatus } from "@shared/invoiceStatus";
import { D } from "@/lib/money";
import type { RouterOutputs } from "@/lib/trpc";

export type VoucherInvoiceOption = RouterOutputs["sales"]["list"][number];

/** OUT reverses allocated money even when the invoice has become terminal. */
export function voucherInvoiceEligible(
  invoice: Pick<VoucherInvoiceOption, "status" | "paidAmount">,
  direction: "IN" | "OUT",
): boolean {
  return direction === "IN"
    ? !isDeadInvoiceStatus(invoice.status)
    : D(invoice.paidAmount ?? 0).gt(0);
}

export function voucherInvoiceRemaining(
  invoice: Pick<VoucherInvoiceOption, "total" | "paidAmount" | "returnedTotal">,
): string {
  return D(invoice.total ?? 0)
    .minus(invoice.paidAmount ?? 0)
    .minus(invoice.returnedTotal ?? 0)
    .toFixed(2);
}
