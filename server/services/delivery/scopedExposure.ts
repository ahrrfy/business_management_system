import { and, eq, inArray, sql } from "drizzle-orm";
import { deliveryLedgerEntries } from "../../../drizzle/schema";
import { DELIVERY_CASH_CUSTODY_SIGN } from "@shared/deliveryLedgerEntryType";
import type { Tx } from "../../db";
import { money, round2 } from "../money";
import { loadPartyExposureInputsTx } from "./exposureInputs";

/** Keep the shared exposure model, with ledger facts restricted to the caller branch. */
export async function loadScopedPartyExposureInputsTx(
  tx: Tx,
  partyIds: number[],
  branchId: number | null,
) {
  const inputs = await loadPartyExposureInputsTx(tx, partyIds, branchId);
  if (branchId == null || !partyIds.length) return inputs;
  const rows = await tx
    .select({
      partyId: deliveryLedgerEntries.partyId,
      entryType: deliveryLedgerEntries.entryType,
      amount: sql<string>`SUM(${deliveryLedgerEntries.amount})`,
    })
    .from(deliveryLedgerEntries)
    .where(
      and(
        inArray(deliveryLedgerEntries.partyId, partyIds),
        eq(deliveryLedgerEntries.branchId, branchId),
      ),
    )
    .groupBy(deliveryLedgerEntries.partyId, deliveryLedgerEntries.entryType);
  for (const partyId of partyIds) {
    const input = inputs.get(partyId) ?? {
      parcels: [],
      ledger: [],
      cashInHandLedger: "0.00",
    };
    input.ledger = rows
      .filter((r) => Number(r.partyId) === partyId)
      .map((r) => ({ entryType: r.entryType, amount: String(r.amount) }));
    input.cashInHandLedger = round2(
      input.ledger.reduce((sum, entry) => {
        const sign =
          DELIVERY_CASH_CUSTODY_SIGN[
            entry.entryType as keyof typeof DELIVERY_CASH_CUSTODY_SIGN
          ];
        return sign == null ? sum : sum.plus(money(entry.amount).times(sign));
      }, money(0)),
    ).toFixed(2);
    inputs.set(partyId, input);
  }
  return inputs;
}
