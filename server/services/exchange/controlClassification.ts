import Decimal from "decimal.js";
import type { Tx } from "../../db";
import { postEntry } from "../ledgerService";
import { money, round2, type DecimalInput } from "../money";
import {
  createPostingIntent,
  creditLine,
  debitLine,
  type AccountRole,
  type JournalLine,
  type PostingSourceComponents,
} from "../accounting/postingEngine";

type ExchangeCurrency = "IQD" | "USD";

function positivePart(value: Decimal): Decimal {
  return Decimal.max(0, value);
}

/**
 * Formal gross reclassification per exchange-house counterparty.
 * Operational profiles move the legacy wallet clearing role; this entry clears
 * that movement to the proper receivable/payable role. Across zero it closes
 * one side and opens the other, so no two counterparties are ever netted.
 */
export async function postExchangeControlReclassification(
  tx: Tx,
  input: {
    exchangeHouseId: number;
    currency: ExchangeCurrency;
    beforeSignedIqd: DecimalInput;
    afterSignedIqd: DecimalInput;
    sourceKey: string;
    notes: string;
    createdBy: number;
  },
): Promise<void> {
  const before = round2(input.beforeSignedIqd);
  const after = round2(input.afterSignedIqd);
  const delta = round2(after.minus(before));
  if (delta.isZero()) return;

  const rawRole = `EXCHANGE_WALLET_${input.currency}` as AccountRole;
  const receivableRole = `EXCHANGE_RECEIVABLE_${input.currency}` as AccountRole;
  const payableRole = `EXCHANGE_PAYABLE_${input.currency}` as AccountRole;
  const receivableDelta = round2(positivePart(after).minus(positivePart(before)));
  const payableBefore = positivePart(before.negated());
  const payableAfter = positivePart(after.negated());
  const payableDelta = round2(payableAfter.minus(payableBefore));

  const lines: JournalLine[] = [];
  const roleDebits: Partial<Record<AccountRole, Decimal>> = {};
  const roleCredits: Partial<Record<AccountRole, Decimal>> = {};
  const addDebit = (role: AccountRole, amount: Decimal) => {
    if (!amount.gt(0)) return;
    lines.push(debitLine(role, amount));
    roleDebits[role] = money(roleDebits[role] ?? 0).plus(amount);
  };
  const addCredit = (role: AccountRole, amount: Decimal) => {
    if (!amount.gt(0)) return;
    lines.push(creditLine(role, amount));
    roleCredits[role] = money(roleCredits[role] ?? 0).plus(amount);
  };

  // Offset the operational clearing movement exactly.
  if (delta.gt(0)) addCredit(rawRole, delta);
  else addDebit(rawRole, delta.abs());
  if (receivableDelta.gt(0)) addDebit(receivableRole, receivableDelta);
  else if (receivableDelta.lt(0)) addCredit(receivableRole, receivableDelta.abs());
  // Liability natural balance is credit: an increase credits, a decrease debits.
  if (payableDelta.gt(0)) addCredit(payableRole, payableDelta);
  else if (payableDelta.lt(0)) addDebit(payableRole, payableDelta.abs());

  const postingSourceComponents: PostingSourceComponents = { roleDebits, roleCredits };
  await postEntry(tx, {
    entryType: "ADJUST",
    branchId: null, // control is company-level; physical FOREIGN_CASH_USD remains branch-scoped.
    createdBy: input.createdBy,
    exchangeHouseId: input.exchangeHouseId,
    amount: delta,
    dedupeKey: `EXCTRL:${input.sourceKey}`,
    notes: input.notes,
    postingSourceComponents,
    postingIntent: createPostingIntent(
      "ADJUST_EXCHANGE_CONTROL_RECLASS",
      "ADJUST",
      lines,
      postingSourceComponents,
    ),
  });
}
