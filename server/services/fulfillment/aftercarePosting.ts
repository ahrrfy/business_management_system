import type Decimal from "decimal.js";
import type { Tx } from "../../db";
import {
  createPostingIntent,
  debitLine,
  creditLine,
} from "../accounting/postingEngine";
import { postEntry } from "../ledgerService";

/** Current issue value only. No historical component-cost reconstruction. */
export async function postAftercareIssueTx(
  tx: Tx,
  input: {
    executionId: number;
    branchId: number;
    actorId: number;
    cost: Decimal;
  },
) {
  if (input.cost.isZero()) return;
  await postEntry(tx, {
    entryType: "ADJUST",
    branchId: input.branchId,
    createdBy: input.actorId,
    dedupeKey: `AFTERCARE_ISSUE:${input.executionId}`,
    amount: input.cost,
    cost: input.cost,
    profit: input.cost.neg(),
    postingIntent: createPostingIntent(
      "ADJUST_INVENTORY_LOSS",
      "ADJUST",
      [debitLine("LOSSES", input.cost), creditLine("INVENTORY", input.cost)],
      {
        roleDebits: { LOSSES: input.cost },
        roleCredits: { INVENTORY: input.cost },
      },
    ),
    postingSourceComponents: {
      roleDebits: { LOSSES: input.cost },
      roleCredits: { INVENTORY: input.cost },
    },
    notes: `مصروف جودة ومعالجة — دفعة ${input.executionId}`,
  });
}
