import Decimal from "decimal.js";
import { isDeadInvoiceStatus } from "./invoiceStatus";

interface InvoiceDeliveryCollectionInput {
  remainingAmount: string | number;
  paymentMode?: string | null;
  fee?: string | number | null;
  feeCollection?: "COURIER" | "COUNTER" | "SHOP" | null;
  status?: string | null;
}

/** Customer credit remains payable to the shop; it was never assigned as courier COD. */
export function invoiceDeliveryCollection(
  input: InvoiceDeliveryCollectionInput,
) {
  const dead = isDeadInvoiceStatus(input.status);
  const remaining = dead
    ? new Decimal(0)
    : Decimal.max(0, input.remainingAmount);
  const credit = input.paymentMode === "CREDIT";
  const goods = credit ? new Decimal(0) : remaining;
  const fee =
    !dead && input.feeCollection === "COURIER"
      ? Decimal.max(0, input.fee ?? 0)
      : new Decimal(0);
  const amount = (value: Decimal) =>
    value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
  return {
    goodsDue: amount(goods),
    creditDue: amount(credit ? remaining : new Decimal(0)),
    feeDue: amount(fee),
    atDoorDue: amount(goods.plus(fee)),
  };
}

export function isInvoiceCodInTransit(input: {
  paymentMode?: string | null;
  consignmentStatus?: string | null;
  status?: string | null;
  consignmentCodAmount?: string | number | null;
}) {
  return (
    !isDeadInvoiceStatus(input.status) &&
    input.paymentMode !== "CREDIT" &&
    (input.paymentMode === "COD" || input.paymentMode == null || new Decimal(input.consignmentCodAmount ?? 0).gt(0)) &&
    (input.consignmentStatus === "DISPATCHED" ||
      input.consignmentStatus === "PARTIAL")
  );
}
