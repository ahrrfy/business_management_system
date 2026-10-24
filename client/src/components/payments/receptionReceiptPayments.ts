import { D, round2 } from "@/lib/money";
import { paymentMethodCompact } from "@shared/terms";
import type { ReceptionPaymentMetadata } from "@shared/receptionPayments";
import type { ReceiptBrowserData } from "@/lib/printing/print";

/** New receipt allocations exclude delivery fees; held money is disclosed separately. */
export function receptionDocumentPaymentLegs(
  metadata: ReceptionPaymentMetadata,
  target: { invoiceId?: number; workOrderId?: number },
  paid: string,
): ReceiptBrowserData["paymentLegs"] {
  if (!metadata.paymentAllocations) return null;
  const allocations = metadata.paymentAllocations.filter((a) =>
    target.invoiceId != null
      ? a.invoiceId === target.invoiceId
      : a.workOrderId === target.workOrderId,
  );
  const rows = allocations.map((a) => ({
    method: paymentMethodCompact(a.method),
    amount: a.amount,
    reference: a.reference,
  }));
  const newPaid = rows.reduce((sum, row) => sum.plus(D(row.amount)), D(0));
  const prior = round2(D(paid).minus(newPaid));
  if (prior.lt(0))
    throw new Error("تفصيل الدفعات لا يطابق المقبوض المسجل للمستند.");
  return [
    ...(prior.gt(0)
      ? [{ method: "مقبوض سابقاً", amount: prior.toFixed(2), reference: null }]
      : []),
    ...rows,
  ];
}
