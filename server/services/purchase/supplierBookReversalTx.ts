import { eq } from "drizzle-orm";
import { supplierBookSettlementSources } from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { withGovernanceTx, withTx } from "../tx";

type BookSourceIdentity =
  | { sourceReceiptId: number }
  | { sourceAccountingEntryId: number }
  | { sourceExchangeTransactionId: number };

const needsExclusiveGate = Symbol("supplier-book-reversal-exclusive-gate");

/**
 * Classify under the shared financial gate before the operation takes domain
 * locks. BOOK adoption takes the exclusive gate, so an absent source cannot
 * appear before this transaction commits. An existing source instead restarts
 * the whole operation under the exclusive gate; never upgrade a held gate.
 */
export async function withSupplierBookReversalTx<T>(
  resolveSource: (tx: Tx) => Promise<BookSourceIdentity | null>,
  operation: (tx: Tx) => Promise<T>,
): Promise<T> {
  try {
    return await withTx(async (tx) => {
      const source = await resolveSource(tx);
      if (source) {
        const predicate =
          "sourceReceiptId" in source
            ? eq(
                supplierBookSettlementSources.sourceReceiptId,
                source.sourceReceiptId,
              )
            : "sourceAccountingEntryId" in source
              ? eq(
                  supplierBookSettlementSources.sourceAccountingEntryId,
                  source.sourceAccountingEntryId,
                )
              : eq(
                  supplierBookSettlementSources.sourceExchangeTransactionId,
                  source.sourceExchangeTransactionId,
                );
        const [owned] = await tx
          .select({ id: supplierBookSettlementSources.id })
          .from(supplierBookSettlementSources)
          .where(predicate)
          .for("share")
          .limit(1);
        if (owned) throw needsExclusiveGate;
      }
      return operation(tx);
    });
  } catch (error) {
    if (error !== needsExclusiveGate) throw error;
    return withGovernanceTx(operation);
  }
}
