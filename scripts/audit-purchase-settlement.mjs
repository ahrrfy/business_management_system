// Read-only incident inventory. A missing allocation is a review finding,
// never proof that cash was or was not physically paid.
import "dotenv/config";
import { createConnection } from "mysql2/promise";

const connection = await createConnection(process.env.DATABASE_URL);
try {
  await connection.query("SET TRANSACTION READ ONLY");
  await connection.query("START TRANSACTION WITH CONSISTENT SNAPSHOT");
  const [rows] = await connection.query(`
    SELECT p.id AS purchaseOrderId, p.poNumber, p.supplierId, p.branchId,
      p.settlementType, p.total, p.paidAmount AS cachedPaidAmount,
      i.id AS supplierInvoiceId, i.invoiceNumber, i.status AS invoiceStatus,
      i.paymentGate, i.totalAmount AS invoiceTotal,
      i.legacySettledAmount,
      COALESCE(a.paid, 0) AS allocatedPaidAmount,
      COALESCE(a.paidCurrency, 0) AS allocatedPaidCurrencyAmount,
      GREATEST(COALESCE(cr.credited, 0) - COALESCE(rv.reversedCredit, 0), 0) AS creditedAmount,
      GREATEST(i.totalAmount - i.legacySettledAmount - COALESCE(a.paid, 0)
        - GREATEST(COALESCE(cr.credited, 0) - COALESCE(rv.reversedCredit, 0), 0), 0) AS invoiceRemainingAmount,
      CASE WHEN p.paidAmount > i.legacySettledAmount + COALESCE(a.paid, 0)
        THEN 'NATIVE_CACHE_EXCEEDS_ALLOCATIONS'
        ELSE 'CASH_INTENT_WITH_OPEN_BALANCE' END AS reviewReason
    FROM supplierInvoices i
    JOIN accountingEntries e ON e.id = i.postingEntryId
    JOIN purchaseOrders p ON p.id = e.purchaseOrderId
    LEFT JOIN (
      SELECT supplierInvoiceId, SUM(allocatedAmount - refundedAmount) AS paid,
        SUM(allocatedCurrencyAmount - refundedCurrencyAmount) AS paidCurrency
      FROM supplierPaymentAllocations GROUP BY supplierInvoiceId
    ) a ON a.supplierInvoiceId = i.id
    LEFT JOIN (
      SELECT supplierInvoiceId, SUM(creditOffsetAmount) AS credited
      FROM purchaseReturns GROUP BY supplierInvoiceId
    ) cr ON cr.supplierInvoiceId = i.id
    LEFT JOIN (
      SELECT r.supplierInvoiceId, SUM(r.totalAmount) AS reversedCredit
      FROM purchaseReturnReversals r
      JOIN purchaseReturns pr ON pr.id = r.purchaseReturnId AND pr.settlement = 'CREDIT'
      GROUP BY r.supplierInvoiceId
    ) rv ON rv.supplierInvoiceId = i.id
    WHERE i.origin = 'NATIVE' AND i.liabilityClass = 'NATIVE_AP' AND i.status = 'POSTED'
      AND (p.paidAmount > i.legacySettledAmount + COALESCE(a.paid, 0)
        OR (p.settlementType = 'CASH' AND i.paymentGate = 'OPEN'))
    ORDER BY p.id
  `);
  console.log(
    JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        mode: "READ_ONLY",
        interpretation:
          "Cash intent is not payment evidence. Cache drift requires document reconciliation; do not disburse again or rewrite historical cash records.",
        scope:
          "Native posted supplier invoices with an unambiguous posting-entry purchase order link",
        count: rows.length,
        rows,
      },
      null,
      2,
    ),
  );
} finally {
  await connection.rollback();
  await connection.end();
}
