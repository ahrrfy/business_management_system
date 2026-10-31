import { validExecutionEvidence } from "./returnEvidence";
import { and, eq } from "drizzle-orm";
import {
  accountingEntries,
  exchangeTransactions,
  purchaseReturns,
  purchaseReturnRequests,
  receipts,
  supplierPaymentRefunds,
  supplierPaymentRefundRequests,
} from "../../../drizzle/schema";
import type { DB, Tx } from "../../db";
import { money } from "../money";
import { sha256 } from "./grniAccounting";

type Receipt = typeof receipts.$inferSelect;
type Database = DB | Tx;

async function paymentEntry(
  db: Database,
  receipt: Receipt,
  id?: number,
  dedupeKey?: string,
) {
  const entries = await db
    .select()
    .from(accountingEntries)
    .where(eq(accountingEntries.receiptId, receipt.id))
    .limit(2);
  const entry = entries[0];
  return (
    entries.length === 1 &&
    entry.entryType ===
      (receipt.direction === "IN" ? "PAYMENT_IN" : "PAYMENT_OUT") &&
    entry.supplierId === receipt.partyId &&
    entry.branchId === receipt.branchId &&
    money(entry.amount).eq(receipt.amount) &&
    (id == null || entry.id === id) &&
    (dedupeKey == null || entry.dedupeKey === dedupeKey)
  );
}

/** Prefixes locate candidates only; document ownership and posted ledger establish authority. */
export async function isOwnedSupplierIncoming(
  db: Database,
  receipt: Receipt,
): Promise<boolean> {
  const [native] = await db
    .select()
    .from(supplierPaymentRefunds)
    .where(eq(supplierPaymentRefunds.receiptId, receipt.id))
    .limit(1);
  if (native) {
    const [request] = await db
      .select()
      .from(supplierPaymentRefundRequests)
      .where(eq(supplierPaymentRefundRequests.id, native.requestId))
      .limit(1);
    return (
      native.supplierId === receipt.partyId &&
      native.branchId === receipt.branchId &&
      money(native.amount).eq(receipt.amount) &&
      sha256(native.payloadCanonical) === native.payloadHash &&
      request?.status === "APPROVED" &&
      request.supplierPaymentId === native.supplierPaymentId &&
      request.branchId === native.branchId &&
      money(request.requestedAmount).eq(native.amount) &&
      request.refundMethod === receipt.paymentMethod &&
      (await paymentEntry(db, receipt, native.accountingEntryId))
    );
  }
  const [returned] = await db
    .select()
    .from(purchaseReturns)
    .where(eq(purchaseReturns.cashRefundReceiptId, receipt.id))
    .limit(1);
  if (returned) {
    if (
      !["NATIVE", "OWNER_EXCEPTION"].includes(returned.origin) ||
      (returned.origin === "OWNER_EXCEPTION" &&
        (returned.purchaseOrderId != null ||
          returned.supplierInvoiceId != null ||
          returned.matchRunId != null ||
          !validExecutionEvidence(returned))) ||
      returned.settlement !== "CASH" ||
      returned.requestId == null ||
      !returned.payloadCanonical ||
      sha256(returned.payloadCanonical) !== returned.payloadHash ||
      returned.supplierId !== receipt.partyId ||
      returned.branchId !== receipt.branchId ||
      returned.paymentMethod !== receipt.paymentMethod ||
      receipt.status !== "COMPLETED" ||
      !money(returned.cashRefundAmount).eq(receipt.amount) ||
      !["POSTED", "PARTIALLY_REVERSED", "REVERSED"].includes(returned.status)
    )
      return false;
    const [request] = await db
      .select()
      .from(purchaseReturnRequests)
      .where(eq(purchaseReturnRequests.id, returned.requestId))
      .limit(1);
    const [entry] =
      returned.accountingEntryId == null
        ? []
        : await db
            .select()
            .from(accountingEntries)
            .where(eq(accountingEntries.id, returned.accountingEntryId))
            .limit(1);
    return (
      request?.status === "APPROVED" &&
      request.sourceKind ===
        (returned.origin === "OWNER_EXCEPTION"
          ? "OWNER_EXCEPTION"
          : "SOURCE_BOUND") &&
      request.reviewedBy === returned.postedBy &&
      sha256(request.payloadCanonical) === request.payloadHash &&
      request.supplierId === returned.supplierId &&
      request.branchId === returned.branchId &&
      request.supplierInvoiceId === returned.supplierInvoiceId &&
      request.payloadHash === returned.payloadHash &&
      entry?.entryType === "RETURN" &&
      entry.supplierId === returned.supplierId &&
      entry.branchId === returned.branchId &&
      entry.purchaseOrderId === returned.purchaseOrderId &&
      money(entry.amount).eq(money(returned.totalAmount).negated()) &&
      entry.dedupeKey === `PURCHASE_RETURN:${returned.id}` &&
      (await paymentEntry(
        db,
        receipt,
        undefined,
        `PURCHASE_RETURN_REFUND:${returned.id}`,
      ))
    );
  }
  if (
    receipt.paymentMethod === "EXCHANGE" &&
    receipt.voucherNumber == null &&
    receipt.status === "COMPLETED" &&
    receipt.referenceNumber?.startsWith("REV-EX-")
  ) {
    const [txn] = await db
      .select()
      .from(exchangeTransactions)
      .where(
        eq(exchangeTransactions.txnNumber, receipt.referenceNumber.slice(7)),
      )
      .limit(1);
    if (
      !txn ||
      txn.type !== "SETTLE" ||
      txn.status !== "REVERSED" ||
      txn.receiptId == null ||
      txn.supplierId !== receipt.partyId ||
      txn.branchId !== receipt.branchId
    )
      return false;
    const [original] = await db
      .select()
      .from(receipts)
      .where(eq(receipts.id, txn.receiptId))
      .limit(1);
    const counters = await db
      .select({ id: receipts.id })
      .from(receipts)
      .where(eq(receipts.referenceNumber, receipt.referenceNumber))
      .limit(2);
    const entries = await db
      .select()
      .from(accountingEntries)
      .where(
        and(
          eq(accountingEntries.exchangeHouseId, txn.exchangeHouseId),
          eq(accountingEntries.dedupeKey, `EXSET:${txn.txnNumber}`),
        ),
      )
      .limit(2);
    const inverses = await db
      .select()
      .from(accountingEntries)
      .where(
        and(
          eq(accountingEntries.exchangeHouseId, txn.exchangeHouseId),
          eq(accountingEntries.dedupeKey, `EXREV:EXSET:${txn.txnNumber}`),
        ),
      )
      .limit(2);
    const entry = entries[0],
      inverse = inverses[0];
    const amount = money(txn.settledIqd).gt(0) ? txn.settledIqd : txn.iqdAmount;
    return (
      original?.direction === "OUT" &&
      original.status === "REVERSED" &&
      original.approvalStatus === "APPROVED" &&
      original.paymentMethod === "EXCHANGE" &&
      original.referenceNumber === txn.txnNumber &&
      original.partyType === "SUPPLIER" &&
      original.partyId === txn.supplierId &&
      original.branchId === txn.branchId &&
      money(original.amount).eq(amount) &&
      money(receipt.amount).eq(amount) &&
      counters.length === 1 &&
      counters[0].id === receipt.id &&
      entries.length === 1 &&
      inverses.length === 1 &&
      entry.entryType === "EXCHANGE_SETTLE" &&
      entry.receiptId === original.id &&
      entry.supplierId === txn.supplierId &&
      entry.branchId === txn.branchId &&
      money(entry.amount).eq(amount) &&
      inverse.entryType === entry.entryType &&
      inverse.supplierId === txn.supplierId &&
      inverse.branchId === txn.branchId &&
      money(inverse.amount).eq(money(amount).negated())
    );
  }
  return false;
}

export async function isOwnedVoucherCancellation(
  db: Database,
  original: Receipt,
  counter: Receipt,
) {
  const { parseSystemPaymentRequest, isCanonicalSystemPaymentRequest } =
    await import("../voucher/create");
  const request = parseSystemPaymentRequest(counter.internalNote);
  return (
    request?.kind === "VOUCHER_CANCELLATION" &&
    isCanonicalSystemPaymentRequest(request, counter.referenceNumber) &&
    request.originalReceiptId === original.id &&
    request.originalDirection === original.direction &&
    request.originalPaymentMethod === original.paymentMethod &&
    request.originalCreatorId === original.createdBy &&
    request.originalReferenceNumber ===
      (original.referenceNumber?.trim() || null) &&
    request.originalCheckNumber === (original.checkNumber?.trim() || null) &&
    request.originalCardLastFour === (original.cardLastFour?.trim() || null) &&
    request.originalCategoryId === original.voucherCategoryId &&
    original.status === "REVERSED" &&
    original.approvalStatus === "APPROVED" &&
    counter.status === "COMPLETED" &&
    counter.approvalStatus === "APPROVED" &&
    original.partyType === "SUPPLIER" &&
    counter.partyType === "SUPPLIER" &&
    original.partyId === counter.partyId &&
    original.branchId === counter.branchId &&
    original.direction !== counter.direction &&
    original.paymentMethod === counter.paymentMethod &&
    money(original.amount).eq(counter.amount) &&
    (await paymentEntry(db, original)) &&
    (await paymentEntry(db, counter))
  );
}
