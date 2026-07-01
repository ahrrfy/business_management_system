// سحب نقد (دينار) إلى خزينة الفرع، أو سحب دولار مباشر من محفظة الصيرفة الدولارية (معزولتان).
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { exchangeTransactions, receipts } from "../../../drizzle/schema";
import { extractInsertId } from "../../lib/insertId";
import { findIdempotentRefId, recordIdempotencyKey } from "../idempotency";
import { adjustExchangeBalanceIqd, adjustExchangeBalanceUsd, postEntry } from "../ledgerService";
import { money, round2, toDbMoney } from "../money";
import { withTx, type Actor } from "../tx";
import { lockHouse, nextTxnNumber, toDbRate } from "./helpers";

export interface WithdrawInput {
  exchangeHouseId: number;
  branchId: number;
  amount: string; // بعملة `currency`
  /** IQD (افتراضي) = نقد دينار يعود لخزينة الفرع. USD = سحب دولار مباشر (بلا receipt، بلا أثر
   *  على الدينار — محفظتان معزولتان تماماً). متوسط الكلفة WAVG لا يتغيّر عند السحب. */
  currency?: "IQD" | "USD";
  notes?: string | null;
  clientRequestId?: string | null;
  confirmNegative?: boolean;
}

/** سحب نقد (دينار) من محفظة الصيرفة → خزينة الفرع، أو سحب دولار مباشر من محفظتها الدولارية
 *  (عكس الإيداع بكلتا العملتين، كلٌّ بمعزل عن الآخر). */
export async function withdrawFromExchange(input: WithdrawInput, actor: Actor): Promise<{ txnId: number; txnNumber: string }> {
  return withTx(async (tx) => {
    if (input.clientRequestId) {
      const existing = await findIdempotentRefId(tx, "exchange.withdraw", input.clientRequestId);
      if (existing != null) {
        const t = (await tx.select().from(exchangeTransactions).where(eq(exchangeTransactions.id, existing)).limit(1))[0];
        return { txnId: existing, txnNumber: t?.txnNumber ?? "" };
      }
    }
    const amount = round2(input.amount);
    if (amount.lte(0)) throw new TRPCError({ code: "BAD_REQUEST", message: "المبلغ يجب أن يكون موجباً" });

    const house = await lockHouse(tx, input.exchangeHouseId);

    if (input.currency === "USD") {
      const availUsd = money(house.balanceUsd);
      if (amount.gt(availUsd) && !input.confirmNegative) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `رصيد الدولار لدى الصيرفة ${availUsd.toFixed(2)}$ أقلّ من المطلوب ${amount.toFixed(2)}$. أرسل confirmNegative=true للتجاوز.`,
        });
      }

      await adjustExchangeBalanceUsd(tx, input.exchangeHouseId, amount.negated());
      const balUsdAfter = availUsd.minus(amount);
      const rate = money(house.usdCostRate);

      const txnNumber = await nextTxnNumber(tx, input.branchId);
      const txRes = await tx.insert(exchangeTransactions).values({
        txnNumber,
        exchangeHouseId: input.exchangeHouseId,
        branchId: input.branchId,
        type: "WITHDRAW",
        currency: "USD",
        usdAmount: toDbMoney(amount),
        exchangeRate: toDbRate(rate),
        balanceIqdAfter: toDbMoney(money(house.balanceIqd)),
        balanceUsdAfter: toDbMoney(balUsdAfter),
        status: "ACTIVE",
        notes: input.notes ?? null,
        createdBy: actor.userId,
      });
      const txnId = extractInsertId(txRes);

      await postEntry(tx, {
        entryType: "EXCHANGE_WITHDRAW",
        branchId: input.branchId,
        exchangeHouseId: input.exchangeHouseId,
        amount: round2(amount.times(rate)),
        dedupeKey: `EXWD:${txnNumber}`,
        notes: input.notes ?? "سحب دولار مباشر",
      });

      if (input.clientRequestId) {
        await recordIdempotencyKey(tx, "exchange.withdraw", input.clientRequestId, txnId);
      }
      return { txnId, txnNumber };
    }

    const availIqd = money(house.balanceIqd);
    if (amount.gt(availIqd) && !input.confirmNegative) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: `رصيد الدينار لدى الصيرفة ${availIqd.toFixed(2)} أقلّ من المطلوب ${amount.toFixed(2)}. أرسل confirmNegative=true للتجاوز.`,
      });
    }

    const recRes = await tx.insert(receipts).values({
      branchId: input.branchId,
      shiftId: null,
      direction: "IN",
      amount: toDbMoney(amount),
      paymentMethod: "CASH",
      cashBucket: "TREASURY",
      status: "COMPLETED",
      partyType: "OTHER",
      description: `سحب من الصيرفة «${house.name}»`,
      createdBy: actor.userId,
    });
    const receiptId = extractInsertId(recRes);

    await adjustExchangeBalanceIqd(tx, input.exchangeHouseId, amount.negated());
    const balIqdAfter = availIqd.minus(amount);
    const balUsdAfter = money(house.balanceUsd);

    const txnNumber = await nextTxnNumber(tx, input.branchId);
    const txRes = await tx.insert(exchangeTransactions).values({
      txnNumber,
      exchangeHouseId: input.exchangeHouseId,
      branchId: input.branchId,
      type: "WITHDRAW",
      currency: "IQD",
      iqdAmount: toDbMoney(amount),
      balanceIqdAfter: toDbMoney(balIqdAfter),
      balanceUsdAfter: toDbMoney(balUsdAfter),
      receiptId,
      status: "ACTIVE",
      notes: input.notes ?? null,
      createdBy: actor.userId,
    });
    const txnId = extractInsertId(txRes);

    await postEntry(tx, {
      entryType: "EXCHANGE_WITHDRAW",
      branchId: input.branchId,
      exchangeHouseId: input.exchangeHouseId,
      receiptId,
      amount,
      dedupeKey: `EXWD:${txnNumber}`,
      notes: input.notes ?? undefined,
    });

    if (input.clientRequestId) {
      await recordIdempotencyKey(tx, "exchange.withdraw", input.clientRequestId, txnId);
    }
    return { txnId, txnNumber };
  });
}
