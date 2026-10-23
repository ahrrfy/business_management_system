import { D, round2 } from "@/lib/money";

export type ReceiptPaymentAllocation = {
  appliedKind: "INVOICE" | "WORKORDER";
  appliedId: number;
  amount: string;
};

/** Display only: committed allocations already changed the invoice, never collect them again. */
export function receptionReceiptSettlement(input: {
  invoiceId: number;
  total: string;
  newlyPaid: string;
  appliedPayments?: readonly ReceiptPaymentAllocation[];
}) {
  const held = (input.appliedPayments ?? []).reduce(
    (sum, payment) =>
      payment.appliedKind === "INVOICE" && payment.appliedId === input.invoiceId
        ? sum.plus(D(payment.amount))
        : sum,
    D(0),
  );
  const paid = round2(D(input.newlyPaid).plus(held).clamp(0, D(input.total)));
  const remaining = round2(D(input.total).minus(paid));
  return {
    paid: paid.toFixed(2),
    credit: remaining.gt(0) ? remaining.toFixed(2) : null,
    held: held.gt(0) ? held.toFixed(2) : null,
  };
}

type ReceiptInvoice = { invoiceId: number; total: string };

/** Match server allocation order while consuming new cash only against each invoice's unpaid part. */
export function receptionReceiptSettlements(input: {
  regular: ReceiptInvoice | null;
  print: ReceiptInvoice | null;
  newlyPaid: string;
  appliedPayments?: readonly ReceiptPaymentAllocation[];
  printFirst: boolean;
}) {
  let left = round2(D(input.newlyPaid).clamp(0, Infinity));
  const settle = (invoice: ReceiptInvoice | null) => {
    if (!invoice) return null;
    const held = (input.appliedPayments ?? []).reduce(
      (sum, payment) =>
        payment.appliedKind === "INVOICE" &&
        payment.appliedId === invoice.invoiceId
          ? sum.plus(D(payment.amount))
          : sum,
      D(0),
    );
    const unpaid = round2(D(invoice.total).minus(held).clamp(0, Infinity));
    const newlyPaid = round2(left.lte(unpaid) ? left : unpaid);
    left = round2(left.minus(newlyPaid));
    return {
      ...receptionReceiptSettlement({
        ...invoice,
        newlyPaid: newlyPaid.toFixed(2),
        appliedPayments: input.appliedPayments,
      }),
      newlyPaid: newlyPaid.toFixed(2),
    };
  };
  if (input.printFirst) {
    const print = settle(input.print);
    return { regular: settle(input.regular), print };
  }
  const regular = settle(input.regular);
  return { regular, print: settle(input.print) };
}

export function receptionReceiptChange(
  method: string,
  tendered: string,
  due: string,
): string | null {
  const change = round2(D(tendered).minus(D(due)));
  return method === "CASH" && change.gt(0) ? change.toFixed(2) : null;
}

/** Prior held money is paid even when no new collection method was used at commit. */
export function receptionReceiptMethodLabel(input: {
  settlement: { newlyPaid: string; held: string | null };
  methodLabel: string;
  paymentMode: string;
}): string | null {
  const hasNew = D(input.settlement.newlyPaid).gt(0);
  if (D(input.settlement.held).gt(0)) {
    return hasNew
      ? `${input.methodLabel} + عربون مقبوض سابقاً`
      : "عربون مقبوض سابقاً";
  }
  if (hasNew) return input.methodLabel;
  return input.paymentMode === "COD"
    ? "دفع عند الاستلام (COD)"
    : input.paymentMode === "CREDIT"
      ? "آجل (حساب آجل)"
      : null;
}

export function receptionDialogBlocksInput(
  dialogs: readonly unknown[],
): boolean {
  return dialogs.some(Boolean);
}
