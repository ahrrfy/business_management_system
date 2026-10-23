import Decimal from "decimal.js";
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
): Promise<Decimal> {
  const rows = await tx
    .select({ entryType: deliveryLedgerEntries.entryType, amount: deliveryLedgerEntries.amount })
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
  // Locking reads see commits made while waiting for the party lock under REPEATABLE READ.
  const amount = rows.reduce((sum, row) => row.entryType === "COD_COLLECTED"
    ? sum.plus(money(row.amount)) : sum.minus(money(row.amount)), money(0));
  return Decimal.max(round2(amount), 0);
}
