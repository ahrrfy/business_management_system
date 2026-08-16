// سحب نقد (دينار) إلى خزينة الفرع، أو سحب دولار مباشر من محفظة الصيرفة الدولارية (معزولتان).
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { exchangeTransactions, receipts } from "../../../drizzle/schema";
import { extractInsertId } from "../../lib/insertId";
import { findIdempotentRefId, recordIdempotencyKey } from "../idempotency";
import { adjustExchangeBalanceIqd, postEntry } from "../ledgerService";
import { createPostingIntent, creditLine, debitLine } from "../accounting/postingEngine";
import { money, round2, toDbMoney } from "../money";
import { withTx, type Actor } from "../tx";
import { lockCashSourceForUpdate } from "../cash/cashAvailability";
import { lockBranchMonthCloseGate } from "../reports/monthCloseGate";
import { lockHouse, nextTxnNumber, toDbRate } from "./helpers";
import { allocateCarryingIqd, calculateSignedUsdMovement, persistSignedUsdControl } from "./reverse";
import { postExchangeControlReclassification } from "./controlClassification";

export interface WithdrawInput {
  exchangeHouseId: number;
  branchId: number;
  amount: string; // بعملة `currency`
  /** IQD (افتراضي) = نقد دينار يعود لخزينة الفرع. USD = استلام دولار مادي من control موجب
   *  بكلفته WAVG (بلا receipt ديناري). لا يعبر USD صفراً لأن المدخل لا يحمل سعر نشوء التزام جديد. */
  currency?: "IQD" | "USD";
  notes?: string | null;
  clientRequestId?: string | null;
  confirmNegative?: boolean;
}

/** سحب IQD إلى الخزينة، أو استلام USD مادي من control الصيرفة ضمن الرصيد ذي الكلفة المحفوظة. */
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
    await lockBranchMonthCloseGate(tx, input.branchId);

    // IQD creates a physical TREASURY IN. Reversal of another withdrawal takes the
    // branch source before the house, so a new withdrawal must use the same order;
    // house→receipt(FK branch) would form branch↔house under concurrency.
    if ((input.currency ?? "IQD") === "IQD") {
      await lockCashSourceForUpdate(tx, { branchId: input.branchId, cashBucket: "TREASURY" });
    }
    const house = await lockHouse(tx, input.exchangeHouseId);

    if (input.currency === "USD") {
      const availUsd = money(house.balanceUsd);
      // Direct custody withdrawal carries no user-supplied rate.  It can only
      // release an existing receivable at its saved WAVG; opening a liability
      // would otherwise invent its source rate.
      if (availUsd.lte(0) || amount.gt(availUsd)) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `السحب المباشر لا يجوز أن يعبر رصيد الصيرفة الدولاري صفراً بلا سعر مصدر صريح (${availUsd.toFixed(2)}$ متاح مقابل ${amount.toFixed(2)}$ مطلوب)`,
        });
      }

      const oldCarrying = money(house.balanceUsdCarryingIqd);
      const carryingIqd = allocateCarryingIqd(oldCarrying, amount, availUsd);
      const rate = oldCarrying.abs().div(availUsd.abs());
      const movement = calculateSignedUsdMovement(availUsd, oldCarrying, amount.negated(), carryingIqd);
      await persistSignedUsdControl(tx, input.exchangeHouseId, movement);

      const txnNumber = await nextTxnNumber(tx, input.branchId);
      const txRes = await tx.insert(exchangeTransactions).values({
        txnNumber,
        exchangeHouseId: input.exchangeHouseId,
        branchId: input.branchId,
        type: "WITHDRAW",
        currency: "USD",
        iqdAmount: toDbMoney(carryingIqd),
        usdAmount: toDbMoney(amount),
        exchangeRate: toDbRate(rate),
        balanceIqdAfter: toDbMoney(money(house.balanceIqd)),
        balanceUsdAfter: toDbMoney(movement.balanceUsd),
        status: "ACTIVE",
        notes: input.notes ?? null,
        createdBy: actor.userId,
      });
      const txnId = extractInsertId(txRes);

      await postEntry(tx, {
        entryType: "EXCHANGE_WITHDRAW",
        branchId: input.branchId,
        exchangeHouseId: input.exchangeHouseId,
        amount: carryingIqd,
        dedupeKey: `EXWD:${txnNumber}`,
        notes: input.notes ?? "سحب دولار مباشر",
        postingIntent: createPostingIntent(
          "EXCHANGE_WITHDRAW_USD_CASH",
          "EXCHANGE_WITHDRAW",
          [debitLine("FOREIGN_CASH_USD", carryingIqd), creditLine("EXCHANGE_WALLET_USD", carryingIqd)],
        ),
        postingSourceComponents: {
          roleDebits: { FOREIGN_CASH_USD: carryingIqd },
          roleCredits: { EXCHANGE_WALLET_USD: carryingIqd },
        },
      });

      await postExchangeControlReclassification(tx, {
        exchangeHouseId: input.exchangeHouseId,
        currency: "USD",
        beforeSignedIqd: oldCarrying,
        afterSignedIqd: movement.balanceCarryingIqd,
        sourceKey: txnNumber,
        notes: `تصنيف ذمة الصيرفة لسحب الدولار ${txnNumber}`,
      });

      if (input.clientRequestId) {
        await recordIdempotencyKey(tx, "exchange.withdraw", input.clientRequestId, txnId);
      }
      return { txnId, txnNumber };
    }

    const availIqd = money(house.balanceIqd);
    if (amount.gt(availIqd) && availIqd.gte(0) && !input.confirmNegative) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: `السحب سيجعل رصيد الدينار لدى الصيرفة سالباً (${availIqd.toFixed(2)} متاح مقابل ${amount.toFixed(2)} مطلوب) — أي دَيناً لكم عليها. أرسل confirmNegative=true للتجاوز.`,
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
      approvalStatus: "APPROVED",
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
    const postingSourceComponents = {
      roleDebits: { TREASURY_CASH: amount },
      roleCredits: { EXCHANGE_WALLET_IQD: amount },
    } as const;

    await postEntry(tx, {
      entryType: "EXCHANGE_WITHDRAW",
      branchId: input.branchId,
      exchangeHouseId: input.exchangeHouseId,
      receiptId,
      amount,
      dedupeKey: `EXWD:${txnNumber}`,
      notes: input.notes ?? undefined,
      postingIntent: createPostingIntent(
        "EXCHANGE_WITHDRAW_IQD",
        "EXCHANGE_WITHDRAW",
        [debitLine("TREASURY_CASH", amount), creditLine("EXCHANGE_WALLET_IQD", amount)],
        postingSourceComponents,
      ),
      postingSourceComponents,
    });

    await postExchangeControlReclassification(tx, {
      exchangeHouseId: input.exchangeHouseId,
      currency: "IQD",
      beforeSignedIqd: availIqd,
      afterSignedIqd: balIqdAfter,
      sourceKey: txnNumber,
      notes: `تصنيف ذمة الصيرفة لسحب الدينار ${txnNumber}`,
    });

    if (input.clientRequestId) {
      await recordIdempotencyKey(tx, "exchange.withdraw", input.clientRequestId, txnId);
    }
    return { txnId, txnNumber };
  });
}
