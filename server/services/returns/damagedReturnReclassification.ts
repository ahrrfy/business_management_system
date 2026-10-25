import Decimal from "decimal.js";
import { eq } from "drizzle-orm";

import { accountingEntries } from "../../../drizzle/schema";
import type { Tx } from "../../db";
import {
  createPostingIntent,
  creditLine,
  debitLine,
} from "../accounting/postingEngine";
import { postEntry } from "../ledgerService";
import { money, round2, toDbMoney } from "../money";

export interface DamagedReturnReclassificationInput {
  branchId: number;
  invoiceId: number;
  sourceReturnEntryId: number;
  historicalCost: Decimal;
  createdBy: number;
  createdByNameSnapshot?: string | null;
}

/**
 * يعيد تصنيف كلفة بضاعة مملوكة راجعة تالفة من COGS إلى LOSSES فقط.
 * لا يغيّر ربح العملية التحليلي ولا النقد ولا المخزون؛ ومفتاحه مرتبط بقيد RETURN
 * الفعلي كي لا يُنشئ المرتجع الجزئي اللاحق أو إعادة المحاولة خسارةً مكررة.
 */
export async function postDamagedReturnReclassificationTx(
  tx: Tx,
  input: DamagedReturnReclassificationInput,
): Promise<number | null> {
  const historicalCost = round2(input.historicalCost);
  if (historicalCost.lte(0)) return null;

  const dedupeKey = `DAMAGED_RETURN_RECLASS:${input.sourceReturnEntryId}`;
  const existing = (
    await tx
      .select({ id: accountingEntries.id })
      .from(accountingEntries)
      .where(eq(accountingEntries.dedupeKey, dedupeKey))
      .limit(1)
  )[0];
  if (existing) return Number(existing.id);

  const zero = money(0);
  const postingSourceComponents = {
    roleDebits: { LOSSES: historicalCost },
    roleCredits: { COGS: historicalCost },
  } as const;
  return postEntry(tx, {
    entryType: "ADJUST",
    dedupeKey,
    branchId: input.branchId,
    invoiceId: input.invoiceId,
    amount: zero,
    revenue: zero,
    cost: zero,
    profit: zero,
    taxAmount: zero,
    createdBy: input.createdBy,
    createdByNameSnapshot: input.createdByNameSnapshot ?? null,
    notes:
      `إعادة تصنيف مرتجع تالف من تكلفة المبيعات إلى الخسائر؛ ` +
      `قيد المرتجع #${input.sourceReturnEntryId}؛ الكلفة التاريخية=${toDbMoney(historicalCost)}`,
    postingIntent: createPostingIntent(
      "ADJUST_DAMAGED_RETURN_RECLASS",
      "ADJUST",
      [debitLine("LOSSES", historicalCost), creditLine("COGS", historicalCost)],
      postingSourceComponents,
    ),
    postingSourceComponents,
  });
}
