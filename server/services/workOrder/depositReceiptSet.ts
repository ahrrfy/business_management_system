import { and, asc, eq, inArray, isNull, notLike, or } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { accountingEntries, receipts } from "../../../drizzle/schema";
import { appErrorMessage } from "@shared/errors";
import type { Tx } from "../../db";
import { money, round2 } from "../money";

type Source = { id: number; branchId?: number; depositReceiptId?: number | null };
/** Real creation-deposit receipts, with the historical anchor retained; delivery and fee receipts are excluded. */
export async function loadWorkOrderDepositReceiptSet(tx: Tx, order: Source, expected?: string, options: { lock?: boolean } = {}) {
  const entries = await tx.select({ receiptId: accountingEntries.receiptId }).from(accountingEntries)
    .where(and(eq(accountingEntries.entryType, "PAYMENT_IN"), eq(accountingEntries.notes, `[WO_DEPOSIT:${order.id}]`)));
  const ids = new Set(entries.flatMap(r => r.receiptId == null ? [] : [Number(r.receiptId)]));
  if (order.depositReceiptId != null) ids.add(Number(order.depositReceiptId));
  if (ids.size === 0 && expected != null && money(expected).eq(0)) return [];
  const source = tx.select().from(receipts).where(ids.size
    ? inArray(receipts.id, Array.from(ids))
    : and(eq(receipts.workOrderId, order.id), eq(receipts.direction, "IN"), eq(receipts.status, "COMPLETED"), eq(receipts.approvalStatus, "APPROVED"), or(isNull(receipts.referenceNumber), notLike(receipts.referenceNumber, "DLV-FEE-%"))));
  const ordered = source.orderBy(asc(receipts.id));
  const rows = await (options.lock === false ? ordered : ordered.for("update"));
  const result = ids.size ? rows : rows.slice(0, 1);
  if (expected != null && (!round2(result.reduce((sum, r) => sum.plus(money(r.amount)), money(0))).eq(money(expected)) || result.some(r =>
    r.direction !== "IN" || r.status !== "COMPLETED" || r.approvalStatus !== "APPROVED" || r.workOrderId !== order.id || order.branchId != null && Number(r.branchId) !== Number(order.branchId)))) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: appErrorMessage({ what: "عربون أمر الشغل لا يطابق إيصالاته", why: "مجموع إيصالات القبض المنفذة المعتمدة لا يساوي العربون المباشر أو يخص مصدراً آخر", doThis: "راجع إيصالات عربون الطلب قبل التسليم أو الإلغاء" }) });
  }
  return result;
}
