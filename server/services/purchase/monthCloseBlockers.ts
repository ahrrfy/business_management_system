import { TRPCError } from "@trpc/server";
import { and, eq, inArray, lte, sql } from "drizzle-orm";
import {
  goodsReceipts,
  purchaseCharges,
  purchaseChargeControlRequests,
  purchaseIntegrityCases,
  purchaseReturnRequests,
  purchaseReturnReversalRequests,
  supplierInvoices,
  supplierPaymentRefundRequests,
  supplierPaymentRequests,
} from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { withTx, type Actor } from "../tx";
import { assertPurchaseBranch } from "./internal";

export interface PurchaseMonthCloseBlocker {
  code: string;
  severity: "HIGH" | "CRITICAL";
  count: number;
  message: string;
}

export function hasUncoveredGrniQuantity(
  acceptedBaseQuantity: number,
  reversedBaseQuantity: number,
  returnedBaseQuantity: number,
  matchedPostedBaseQuantity: number,
): boolean {
  return Math.max(acceptedBaseQuantity - reversedBaseQuantity - returnedBaseQuantity, 0) > Math.max(matchedPostedBaseQuantity, 0);
}

async function countRows(tx: Tx, table: any, where: any): Promise<number> {
  const row = (await tx.select({ count: sql<number>`COUNT(*)` }).from(table).where(where))[0];
  return Number(row?.count ?? 0);
}

export async function getPurchaseMonthCloseBlockersTx(
  tx: Tx,
  input: { branchId: number | null; cutoffDate: string },
): Promise<PurchaseMonthCloseBlocker[]> {
  const cutoffEnd = new Date(`${input.cutoffDate}T23:59:59.999Z`);
  const scoped = (branchColumn: any, ...conditions: any[]) =>
    input.branchId == null ? and(...conditions) : and(eq(branchColumn, input.branchId), ...conditions);
  const specs: Array<{ code: string; severity: "HIGH" | "CRITICAL"; message: string; table: any; where: any }> = [
    { code: "PURCHASE_INTEGRITY_OPEN", severity: "CRITICAL", message: "قضايا نزاهة شراء عالية/حرجة غير محسومة", table: purchaseIntegrityCases, where: scoped(purchaseIntegrityCases.branchId, inArray(purchaseIntegrityCases.status, ["OPEN", "IN_REVIEW", "PENDING_RESOLUTION"]), inArray(purchaseIntegrityCases.severity, ["HIGH", "CRITICAL"]), lte(purchaseIntegrityCases.detectedAt, cutoffEnd)) },
    { code: "PURCHASE_RETURN_PENDING", severity: "HIGH", message: "طلبات مرتجع شراء معلّقة ضمن الفترة", table: purchaseReturnRequests, where: scoped(purchaseReturnRequests.branchId, eq(purchaseReturnRequests.status, "PENDING"), lte(purchaseReturnRequests.requestedAt, cutoffEnd)) },
    { code: "PURCHASE_RETURN_REVERSAL_PENDING", severity: "HIGH", message: "طلبات عكس مرتجع معلّقة ضمن الفترة", table: purchaseReturnReversalRequests, where: scoped(purchaseReturnReversalRequests.branchId, eq(purchaseReturnReversalRequests.status, "PENDING"), lte(purchaseReturnReversalRequests.requestedAt, cutoffEnd)) },
    { code: "SUPPLIER_PAYMENT_PENDING", severity: "CRITICAL", message: "طلبات دفع مورد حجزت فواتير ولم تُحسم", table: supplierPaymentRequests, where: scoped(supplierPaymentRequests.branchId, eq(supplierPaymentRequests.status, "PENDING"), lte(supplierPaymentRequests.requestedAt, cutoffEnd)) },
    { code: "SUPPLIER_PAYMENT_REFUND_PENDING", severity: "HIGH", message: "طلبات استرداد دفعة مورد معلّقة", table: supplierPaymentRefundRequests, where: scoped(supplierPaymentRefundRequests.branchId, eq(supplierPaymentRefundRequests.status, "PENDING"), lte(supplierPaymentRefundRequests.requestedAt, cutoffEnd)) },
    { code: "PURCHASE_CHARGE_CONTROL_PENDING", severity: "HIGH", message: "طلبات ترحيل/عكس مصروف شراء معلّقة", table: purchaseChargeControlRequests, where: scoped(purchaseChargeControlRequests.branchId, eq(purchaseChargeControlRequests.status, "PENDING"), lte(purchaseChargeControlRequests.requestedAt, cutoffEnd)) },
    { code: "PURCHASE_CHARGE_PAYABLE_UNSETTLED", severity: "CRITICAL", message: "مصروفات شراء PAYABLE مرحّلة بلا التزام تسوية ذري مرتبط", table: purchaseCharges, where: scoped(purchaseCharges.branchId, eq(purchaseCharges.status, "POSTED"), eq(purchaseCharges.settlement, "PAYABLE"), lte(purchaseCharges.createdAt, cutoffEnd)) },
    { code: "SUPPLIER_INVOICE_UNPOSTED", severity: "CRITICAL", message: "فواتير مورد داخل الفترة لم تُرحّل أو ما زالت HOLD", table: supplierInvoices, where: scoped(supplierInvoices.branchId, inArray(supplierInvoices.status, ["DRAFT", "ON_HOLD", "MATCHED"]), lte(supplierInvoices.invoiceDate, input.cutoffDate)) },
    { code: "SUPPLIER_INVOICE_PAYMENT_BLOCKED", severity: "HIGH", message: "فواتير مورد مرحّلة محجوبة بسبب CASH_CLEARING أو مراجعة إرثية", table: supplierInvoices, where: scoped(supplierInvoices.branchId, eq(supplierInvoices.status, "POSTED"), inArray(supplierInvoices.paymentGate, ["BLOCKED_CASH_CLEARING", "BLOCKED_REVIEW"]), lte(supplierInvoices.invoiceDate, input.cutoffDate)) },
    { code: "GRN_WITHOUT_POSTED_INVOICE", severity: "CRITICAL", message: "أذونات استلام داخل الفترة غير مغطاة كمياً بالكامل بفواتير مورد مرحّلة", table: goodsReceipts, where: scoped(goodsReceipts.branchId, inArray(goodsReceipts.status, ["POSTED", "PARTIALLY_REVERSED"]), lte(goodsReceipts.receivedAt, cutoffEnd), sql`EXISTS (
      SELECT 1
      FROM goodsReceiptItems gri
      WHERE gri.goodsReceiptId = ${goodsReceipts.id}
        AND GREATEST(gri.acceptedBaseQuantity - gri.reversedBaseQuantity - gri.returnedBaseQuantity, 0) > (
          SELECT COALESCE(SUM(sima.matchedBaseQuantity), 0)
          FROM supplierInvoiceMatchAllocations sima
          INNER JOIN supplierInvoiceMatchRuns simr
            ON simr.id = sima.matchRunId
           AND simr.outcome <> 'HOLD'
           AND simr.runNo = (
             SELECT MAX(latestRun.runNo)
             FROM supplierInvoiceMatchRuns latestRun
             WHERE latestRun.supplierInvoiceId = simr.supplierInvoiceId
               AND latestRun.outcome <> 'HOLD'
           )
          INNER JOIN supplierInvoices si
            ON si.id = simr.supplierInvoiceId
           AND si.status = 'POSTED'
          WHERE sima.goodsReceiptItemId = gri.id
        )
    )`) },
    { code: "UNMATCHED_POSTED_INVOICE", severity: "CRITICAL", message: "فاتورة مورد أصلية مرحّلة بلا تشغيل مطابقة صالح", table: supplierInvoices, where: scoped(supplierInvoices.branchId, eq(supplierInvoices.origin, "NATIVE"), eq(supplierInvoices.status, "POSTED"), lte(supplierInvoices.invoiceDate, input.cutoffDate), sql`NOT EXISTS (
      SELECT 1 FROM supplierInvoiceMatchRuns simr
      WHERE simr.supplierInvoiceId = ${supplierInvoices.id} AND simr.outcome <> 'HOLD'
    )`) },
  ];
  const blockers: PurchaseMonthCloseBlocker[] = [];
  for (const spec of specs) {
    const count = await countRows(tx, spec.table, spec.where);
    if (count > 0) blockers.push({ code: spec.code, severity: spec.severity, count, message: spec.message });
  }
  return blockers;
}

export async function getPurchaseMonthCloseBlockers(input: { branchId: number; cutoffDate: string }, actor: Actor) {
  assertPurchaseBranch({ branchId: input.branchId }, actor);
  return withTx((tx) => getPurchaseMonthCloseBlockersTx(tx, input), { gate: "NONE" });
}

export async function assertNoPurchaseMonthCloseBlockersTx(tx: Tx, input: { branchId: number | null; cutoffDate: string }) {
  const blockers = await getPurchaseMonthCloseBlockersTx(tx, input);
  if (blockers.length) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `لا يمكن إغلاق الشهر: ${blockers.map((row) => `${row.message} (${row.count})`).join("، ")}` });
}
