import { sql } from "drizzle-orm";

/** A neutral journal on this receipt or its documented receipt pair identifies internal custody. */
export function internalCashMovementSql() {
  return sql`EXISTS (
    SELECT 1 FROM accountingEntries internalEntry
    INNER JOIN receipts internalReceipt ON internalReceipt.id = internalEntry.receiptId
    WHERE internalEntry.entryType IN ('SHIFT_FLOAT_OUT','CASH_HANDOVER','CASH_TRANSFER_OUT','CASH_TRANSFER_IN')
      AND (internalReceipt.id = r.id OR (
        r.referenceNumber IS NOT NULL AND internalReceipt.referenceNumber = r.referenceNumber
        AND internalReceipt.amount = r.amount AND internalReceipt.paymentMethod = r.paymentMethod
        AND internalReceipt.direction <> r.direction
        AND r.voucherNumber IS NULL AND r.invoiceId IS NULL AND r.workOrderId IS NULL
      ))
  )`;
}
