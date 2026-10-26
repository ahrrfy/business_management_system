import { paymentMethodCompact } from "./terms";

/** Executed, document-linked receipt evidence; amounts are IQD ledger amounts. */
export interface PurchasePaymentReceiptEvidence {
  id: number;
  voucherNumber: string | null;
  direction: "IN" | "OUT";
  paymentMethod: string;
  cashBucket: "DRAWER" | "TREASURY" | null;
  shiftId: number | null;
  amount: string;
  referenceNumber: string | null;
  cardLastFour: string | null;
  status: "COMPLETED" | "REVERSED";
  /** Current unreversed portion allocated to this PO. Original receipt amount remains unchanged. */
  allocatedAmount?: string;
}

export interface PurchaseAdvanceRefundLinks {
  kind: "ADVANCE_SOURCE" | "ADVANCE_REFUND" | "ADVANCE_REFUND_CANCELLATION";
  sourceReceiptId: number;
  refundedReceiptId?: number | null;
  refundReceiptIds: readonly number[];
  cancellationReceiptIds: readonly number[];
}

/** Documentary references only; never a second financial effect or amount. */
export function advanceRefundLinkText(
  links?: PurchaseAdvanceRefundLinks | null,
): string {
  if (!links) return "";
  if (links.kind === "ADVANCE_REFUND")
    return `استرداد مرتبط بسند الدفعة الأصلية #${links.sourceReceiptId}`;
  if (links.kind === "ADVANCE_REFUND_CANCELLATION")
    return `عكس الاسترداد #${links.refundedReceiptId} المرتبط بسند الدفعة الأصلية #${links.sourceReceiptId}`;
  return [
    links.refundReceiptIds.length
      ? `سندات الاسترداد المرتبطة: ${links.refundReceiptIds.map((id) => `#${id}`).join("، ")}`
      : "",
    links.cancellationReceiptIds.length
      ? `عكوس الاسترداد: ${links.cancellationReceiptIds.map((id) => `#${id}`).join("، ")}`
      : "",
  ]
    .filter(Boolean)
    .join("؛ ");
}

export function purchasePaymentSourceLabel(
  row: PurchasePaymentReceiptEvidence,
): string {
  if (row.paymentMethod === "CASH") {
    if (row.cashBucket === "TREASURY") return "نقد من الخزنة";
    if (row.cashBucket === "DRAWER")
      return `نقد من الوردية${row.shiftId ? ` #${row.shiftId}` : ""}`;
    return "نقد — المصدر التاريخي غير محدد";
  }
  const method = paymentMethodCompact(row.paymentMethod);
  return row.paymentMethod === "CARD" && row.cardLastFour
    ? `${method} •••• ${row.cardLastFour}`
    : method;
}

export function purchasePaymentReceiptLabel(
  row: PurchasePaymentReceiptEvidence,
): string {
  return `${row.direction === "IN" ? "استرداد" : "صرف"} ${row.voucherNumber ?? `#${row.id}`}${row.status === "REVERSED" ? " (معكوس)" : row.allocatedAmount === "0.00" ? " (التخصيص معكوس)" : ""}`;
}
