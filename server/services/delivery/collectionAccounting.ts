import Decimal from "decimal.js";
import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";
import { and, asc, eq, inArray } from "drizzle-orm";
import { deliveryLedgerEntries } from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { money, round2 } from "../money";
import { effectiveDeliveryLedgerEntrySql } from "./legacyLedger";

/** Cash already proved for this consignment is remitted before any new collection.
 * Fees and assigned shortfalls are separate rights, not customer cash to collect again.
 * The caller holds the party lock, shared with collection and remittance writers.
 */
export async function unremittedCollectionForConsignmentTx(
  tx: Tx,
  consignmentId: number,
  identity?: { partyId: number; branchId: number },
): Promise<Decimal> {
  const rows = await tx
    .select({ entryType: deliveryLedgerEntries.entryType, amount: deliveryLedgerEntries.amount,
      partyId: deliveryLedgerEntries.partyId, branchId: deliveryLedgerEntries.branchId,
      eventKey: deliveryLedgerEntries.eventKey })
    .from(deliveryLedgerEntries)
    .where(
      and(
        eq(deliveryLedgerEntries.consignmentId, consignmentId),
        inArray(deliveryLedgerEntries.entryType, ["COD_COLLECTED", "COD_REMITTED", "COD_RETURNED", "COD_WRITTEN_OFF"]),
        effectiveDeliveryLedgerEntrySql(),
      ),
    )
    .orderBy(asc(deliveryLedgerEntries.id))
    .for("share");
  if (identity) {
    const wrongIdentity = rows.some((row) => Number(row.partyId) !== identity.partyId ||
      row.branchId == null || Number(row.branchId) !== identity.branchId);
    const ambiguousLegacy = rows.some((row) => row.eventKey.startsWith("BACKFILL:") &&
      rows.some((other) => other.entryType === row.entryType && !other.eventKey.startsWith("BACKFILL:")));
    if (wrongIdentity || ambiguousLegacy) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: appErrorMessage({
        what: `تعذّر التحقق من نقد الإرسالية ${consignmentId}`,
        why: "قيود الجهة أو الفرع أو القيود التاريخية ملتبسة",
        doThis: "اطلب مطابقة القيود مع مستندات الجهة قبل التوريد",
      }) });
    }
  }
  // Locking reads see commits made while waiting for the party lock under REPEATABLE READ.
  const amount = rows.reduce((sum, row) => row.entryType === "COD_COLLECTED"
    ? sum.plus(money(row.amount)) : sum.minus(money(row.amount)), money(0));
  if (identity && amount.lt(0)) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: appErrorMessage({
      what: `تعذّر التحقق من نقد الإرسالية ${consignmentId}`,
      why: "التوريدات المسجلة تتجاوز التحصيل المثبت",
      doThis: "اطلب مطابقة سجل التحصيل والتوريد قبل المتابعة",
    }) });
  }
  return Decimal.max(round2(amount), 0);
}
