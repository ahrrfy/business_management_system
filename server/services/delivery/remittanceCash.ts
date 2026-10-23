import { sql, type SQLWrapper } from "drizzle-orm";
import { deliveryRemittances } from "../../../drizzle/schema";

/** Gross custody clearance and cash received differ by the linked withholding receipt. */
export function remittanceCashReceivedSql() {
  const receiptCash = (id: SQLWrapper, direction: "IN" | "OUT") => sql`
    COALESCE((SELECT r.amount FROM receipts r WHERE r.id = ${id}
      AND r.branchId = ${deliveryRemittances.branchId} AND r.direction = ${direction}
      AND r.receiptStatus = 'COMPLETED' AND r.paymentMethod = 'CASH'
      AND (r.receiptApprovalStatus IS NULL OR r.receiptApprovalStatus = 'APPROVED')), 0)`;
  return sql<string>`CASE WHEN ${deliveryRemittances.receiptInId} IS NOT NULL
    THEN ${receiptCash(deliveryRemittances.receiptInId, "IN")} - ${receiptCash(deliveryRemittances.receiptOutId, "OUT")}
    ELSE COALESCE((SELECT SUM(drl.cashReceived) FROM deliveryRemittanceLines drl
      WHERE drl.remittanceId = ${deliveryRemittances.id}), 0) END`;
}
