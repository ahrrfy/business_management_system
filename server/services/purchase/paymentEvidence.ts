import { TRPCError } from "@trpc/server";
import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import { appErrorMessage } from "@shared/errors";
import type { PurchaseTenderInput } from "@shared/purchaseTender";
import type { PurchasePaymentReceiptEvidence } from "@shared/purchasePaymentEvidence";
import {
  accountingEntries,
  exchangeTransactions,
  receipts,
  supplierInvoices,
  supplierBookSettlementAllocations as allocations,
  supplierBookSettlementSources as sources,
} from "../../../drizzle/schema";
import type { DB, Tx } from "../../db";
import { money, toDbMoney } from "../money";
import { sha256 } from "./grniAccounting";
import { isOwnedSupplierIncoming } from "./advanceRefundOwnership";

const MAX_ROWS = 500;
function invalid(why: string): never {
  throw new TRPCError({
    code: "CONFLICT",
    message: appErrorMessage({
      what: "تعذر قراءة سندات سداد فاتورة الشراء",
      why,
      doThis: "راجع دليل السند وتخصيصه قبل طباعة الفاتورة",
    }),
  });
}
function bounded(rows: readonly unknown[]) {
  if (rows.length > MAX_ROWS) invalid("تجاوز دليل السداد حد القراءة الآمنة");
}
function project(
  row: typeof receipts.$inferSelect,
): PurchasePaymentReceiptEvidence {
  if (row.status !== "COMPLETED" && row.status !== "REVERSED")
    invalid("حالة السند غير صالحة للعرض كدليل سداد");
  return {
    id: row.id,
    voucherNumber: row.voucherNumber,
    direction: row.direction,
    paymentMethod: row.paymentMethod,
    cashBucket: row.cashBucket,
    shiftId: row.shiftId,
    amount: row.amount,
    referenceNumber: row.referenceNumber,
    cardLastFour: row.cardLastFour,
    status: row.status,
  };
}

/** Read-only evidence, never an attribution inferred from the PO paid-total or supplier balance. */
export async function loadPurchasePaymentEvidence(
  db: DB | Tx,
  order: { id: number; branchId: number; supplierId: number },
  tender: PurchaseTenderInput | null,
): Promise<PurchasePaymentReceiptEvidence[]> {
  const rows = await db
    .select({
      receipt: receipts,
      entryType: accountingEntries.entryType,
      entryAmount: accountingEntries.amount,
      entryDedupeKey: accountingEntries.dedupeKey,
      exchangeHouseId: accountingEntries.exchangeHouseId,
    })
    .from(accountingEntries)
    .innerJoin(receipts, eq(receipts.id, accountingEntries.receiptId))
    .where(
      and(
        eq(accountingEntries.purchaseOrderId, order.id),
        eq(accountingEntries.supplierId, order.supplierId),
        eq(accountingEntries.branchId, order.branchId),
        inArray(accountingEntries.entryType, [
          "PAYMENT_OUT",
          "PAYMENT_IN",
          "EXCHANGE_SETTLE",
        ]),
        eq(receipts.partyType, "SUPPLIER"),
        eq(receipts.partyId, order.supplierId),
        eq(receipts.branchId, order.branchId),
        eq(receipts.approvalStatus, "APPROVED"),
        inArray(receipts.status, ["COMPLETED", "REVERSED"]),
      ),
    )
    .orderBy(asc(receipts.id), asc(accountingEntries.id))
    .limit(MAX_ROWS + 1);
  bounded(rows);
  const result = new Map<number, PurchasePaymentReceiptEvidence>();
  for (const row of rows) {
    if (
      row.receipt.direction !==
        (row.entryType === "PAYMENT_IN" ? "IN" : "OUT") ||
      !money(row.entryAmount).abs().eq(row.receipt.amount)
    )
      invalid("قيد السند الأصلي لا يطابق اتجاهه أو قيمته");
    if (row.entryType === "EXCHANGE_SETTLE") {
      const transactions = await db
        .select()
        .from(exchangeTransactions)
        .where(eq(exchangeTransactions.receiptId, row.receipt.id))
        .limit(2);
      const txn = transactions[0];
      if (
        transactions.length !== 1 ||
        txn.type !== "SETTLE" ||
        txn.supplierId !== order.supplierId ||
        txn.branchId !== order.branchId ||
        txn.purchaseOrderId !== order.id ||
        txn.exchangeHouseId !== row.exchangeHouseId ||
        row.entryDedupeKey !== `EXSET:${txn.txnNumber}` ||
        row.receipt.paymentMethod !== "EXCHANGE" ||
        row.receipt.referenceNumber !== txn.txnNumber ||
        !money(row.entryAmount).gt(0) ||
        !money(row.receipt.amount).eq(
          money(txn.settledIqd).gt(0) ? txn.settledIqd : txn.iqdAmount,
        ) ||
        (txn.status === "ACTIVE"
          ? row.receipt.status !== "COMPLETED"
          : txn.status !== "REVERSED" || row.receipt.status !== "REVERSED")
      )
        invalid("ملكية سند تسوية الصيرفة لا تطابق العملية الأصلية");
      if (txn.status === "REVERSED") {
        const counters = await db
          .select()
          .from(receipts)
          .where(eq(receipts.referenceNumber, `REV-EX-${txn.txnNumber}`))
          .limit(2);
        const counter = counters[0];
        if (
          counters.length !== 1 ||
          counter.direction !== "IN" ||
          counter.approvalStatus !== "APPROVED" ||
          counter.partyType !== "SUPPLIER" ||
          counter.partyId !== order.supplierId ||
          counter.branchId !== order.branchId ||
          !(await isOwnedSupplierIncoming(db, counter))
        )
          invalid("تعذر إثبات سند عكس الصيرفة وقيده الأصلي");
        result.set(counter.id, project(counter));
      }
    }
    result.set(row.receipt.id, project(row.receipt));
  }

  if (tender?.previousReceiptId != null) {
    const previous = await db
      .select({ source: sources, allocation: allocations, receipt: receipts })
      .from(sources)
      .innerJoin(allocations, eq(allocations.sourceId, sources.id))
      .innerJoin(
        supplierInvoices,
        eq(supplierInvoices.id, allocations.supplierInvoiceId),
      )
      .innerJoin(receipts, eq(receipts.id, sources.sourceReceiptId))
      .where(
        and(
          eq(sources.sourceReceiptId, tender.previousReceiptId),
          eq(sources.supplierId, order.supplierId),
          eq(sources.branchId, order.branchId),
          eq(sources.kind, "PAYMENT"),
          eq(supplierInvoices.supplierId, order.supplierId),
          eq(supplierInvoices.branchId, order.branchId),
          or(
            eq(supplierInvoices.legacyPurchaseOrderId, order.id),
            sql`EXISTS (SELECT 1 FROM supplierInvoiceLines sil
              INNER JOIN purchaseOrderRevisionItems pori ON pori.id = sil.purchaseOrderRevisionItemId
              INNER JOIN purchaseOrderRevisions por ON por.id = pori.revisionId
              WHERE sil.supplierInvoiceId = ${supplierInvoices.id} AND por.purchaseOrderId = ${order.id})`,
            sql`EXISTS (SELECT 1 FROM supplierInvoiceMatchRuns simr
              INNER JOIN supplierInvoiceMatchAllocations sima ON sima.matchRunId = simr.id
              INNER JOIN goodsReceiptItems gri ON gri.id = sima.goodsReceiptItemId
              INNER JOIN purchaseOrderItems poi ON poi.id = gri.purchaseOrderItemId
              WHERE simr.supplierInvoiceId = ${supplierInvoices.id} AND poi.purchaseOrderId = ${order.id})`,
          ),
          eq(receipts.partyType, "SUPPLIER"),
          eq(receipts.partyId, order.supplierId),
          eq(receipts.branchId, order.branchId),
          eq(receipts.approvalStatus, "APPROVED"),
          inArray(receipts.status, ["COMPLETED", "REVERSED"]),
        ),
      )
      .orderBy(asc(sources.id), asc(allocations.id))
      .limit(MAX_ROWS + 1);
    bounded(previous);
    let allocated = money(0);
    let receipt: typeof receipts.$inferSelect | undefined;
    for (const row of previous) {
      if (
        row.source.sourceHash !== sha256(row.source.sourceSnapshot) ||
        row.allocation.targetHash !== sha256(row.allocation.targetSnapshot)
      )
        invalid("بصمة دليل الدفعة السابقة أو تخصيصها غير صالحة");
      let target: {
        purchaseOrderId?: number;
        invoice?: { id?: number; supplierId?: number; branchId?: number };
      };
      try {
        target = JSON.parse(row.allocation.targetSnapshot);
      } catch {
        invalid("لقطة تخصيص الدفعة السابقة غير قابلة للقراءة");
      }
      if (!target || typeof target !== "object")
        invalid("لقطة تخصيص الدفعة السابقة غير صالحة");
      if (target.purchaseOrderId !== order.id) continue;
      if (
        target.invoice?.id !== row.allocation.supplierInvoiceId ||
        target.invoice?.supplierId !== order.supplierId ||
        target.invoice?.branchId !== order.branchId
      )
        invalid("نطاق تخصيص الدفعة السابقة لا يطابق الفاتورة");
      let original: {
        receipt?: {
          id?: number;
          branchId?: number;
          partyId?: number;
          amount?: string;
          voucherNumber?: string | null;
          paymentMethod?: string;
          referenceNumber?: string | null;
          cardLastFour?: string | null;
          shiftId?: number | null;
          cashBucket?: string | null;
        };
      };
      try {
        original = JSON.parse(row.source.sourceSnapshot);
      } catch {
        invalid("لقطة سند الدفعة السابقة غير قابلة للقراءة");
      }
      if (!original || typeof original !== "object")
        invalid("لقطة سند الدفعة السابقة غير صالحة");
      const savedReceipt = original.receipt;
      if (
        !savedReceipt ||
        savedReceipt.id !== row.receipt.id ||
        savedReceipt.branchId !== order.branchId ||
        savedReceipt.partyId !== order.supplierId ||
        savedReceipt.amount !== row.receipt.amount ||
        savedReceipt.voucherNumber !== row.receipt.voucherNumber ||
        savedReceipt.paymentMethod !== row.receipt.paymentMethod ||
        savedReceipt.referenceNumber !== row.receipt.referenceNumber ||
        savedReceipt.cardLastFour !== row.receipt.cardLastFour ||
        savedReceipt.shiftId !== row.receipt.shiftId ||
        savedReceipt.cashBucket !== row.receipt.cashBucket ||
        !money(row.source.amount).eq(row.receipt.amount)
      )
        invalid("قيم سند الدفعة السابقة تغيرت عن دليله الأصلي");
      if (
        row.receipt.direction !== "OUT" ||
        !money(row.allocation.allocatedAmount).gt(0)
      )
        invalid("الدفعة السابقة ليست سند صرف مخصصاً بقيمة موجبة");
      allocated = allocated.plus(
        money(row.allocation.allocatedAmount).minus(
          row.allocation.reversedAmount,
        ),
      );
      receipt = row.receipt;
    }
    if (receipt) {
      if (allocated.gt(receipt.amount))
        invalid("قيمة تخصيص الدفعة السابقة تتجاوز سندها الأصلي");
      result.set(receipt.id, {
        ...project(receipt),
        allocatedAmount: toDbMoney(allocated),
      });
    }
  }
  return Array.from(result.values()).sort((a, b) => a.id - b.id);
}
