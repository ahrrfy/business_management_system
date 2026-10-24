import type { Tx } from "../../db";
import { canSeeCostForUser } from "../../trpc";
import { loadOperationUserTx } from "../authorization/operationAuthority";
import type { Actor } from "../tx";

/** Read current persisted authority; actor.role/owner flags never grant cost access. */
export async function fulfillmentCostVisibleTx(
  tx: Tx,
  actor: Actor,
): Promise<boolean> {
  return canSeeCostForUser(await loadOperationUserTx(tx, actor.userId));
}

/** Null denotes a concealed value; zero remains a real disclosed accounting value. */
export function projectFulfillmentChargeCost<
  T extends { externalCost: string | null; payeePaidAmount: string | null },
>(
  row: T,
  visible: boolean,
): Omit<T, "externalCost" | "payeePaidAmount"> & {
  externalCost: string | null;
  payeePaidAmount: string | null;
} {
  return {
    ...row,
    externalCost: visible ? row.externalCost : null,
    payeePaidAmount: visible ? row.payeePaidAmount : null,
  };
}
