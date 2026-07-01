// شراء دولار من الصيرفة: تحويل دينار→دولار داخل المحفظة، يُحدّث متوسط الكلفة WAVG.
import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { eq } from "drizzle-orm";
import { exchangeHouses, exchangeTransactions } from "../../../drizzle/schema";
import { extractInsertId } from "../../lib/insertId";
import { findIdempotentRefId, recordIdempotencyKey } from "../idempotency";
import { adjustExchangeBalanceIqd, adjustExchangeBalanceUsd, postEntry } from "../ledgerService";
import { money, round2, toDbMoney } from "../money";
import { withTx, type Actor } from "../tx";
import { lockHouse, nextTxnNumber, toDbRate } from "./helpers";

export interface BuyUsdInput {
  exchangeHouseId: number;
  branchId: number;
  usdAmount: string;
  exchangeRate: string; // دينار/دولار
  notes?: string | null;
  clientRequestId?: string | null;
  confirmNegative?: boolean;
}

/** شراء دولار من الصيرفة: تحويل دينار→دولار داخل المحفظة بسعر r، يُحدّث متوسط الكلفة WAVG (نقل أصل، 0/0/0). */
export async function buyUsdAtExchange(input: BuyUsdInput, actor: Actor): Promise<{ txnId: number; txnNumber: string; newRate: string }> {
  return withTx(async (tx) => {
    if (input.clientRequestId) {
      const existing = await findIdempotentRefId(tx, "exchange.buyUsd", input.clientRequestId);
      if (existing != null) {
        const t = (await tx.select().from(exchangeTransactions).where(eq(exchangeTransactions.id, existing)).limit(1))[0];
        return { txnId: existing, txnNumber: t?.txnNumber ?? "", newRate: "" };
      }
    }
    const usd = round2(input.usdAmount);
    const rate = money(input.exchangeRate);
    if (usd.lte(0)) throw new TRPCError({ code: "BAD_REQUEST", message: "مبلغ الدولار يجب أن يكون موجباً" });
    if (rate.lte(0)) throw new TRPCError({ code: "BAD_REQUEST", message: "سعر الصرف يجب أن يكون موجباً" });

    const iqdSpent = round2(usd.times(rate));
    const house = await lockHouse(tx, input.exchangeHouseId);
    const availIqd = money(house.balanceIqd);
    if (iqdSpent.gt(availIqd) && !input.confirmNegative) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: `رصيد الدينار ${availIqd.toFixed(2)} أقلّ من كلفة الشراء ${iqdSpent.toFixed(2)}. أرسل confirmNegative=true للتجاوز.`,
      });
    }

    // متوسط الكلفة المرجّح الجديد: (قيمة الدولار القديم بالكلفة + الدينار المنفَق) / (الدولار الجديد).
    const oldUsd = money(house.balanceUsd);
    const oldRate = money(house.usdCostRate);
    const newUsd = oldUsd.plus(usd);
    const newCostBasisIqd = oldUsd.times(oldRate).plus(iqdSpent);
    const newRate = newUsd.isZero() ? new Decimal(0) : newCostBasisIqd.div(newUsd);

    await adjustExchangeBalanceIqd(tx, input.exchangeHouseId, iqdSpent.negated());
    await adjustExchangeBalanceUsd(tx, input.exchangeHouseId, usd);
    await tx.update(exchangeHouses).set({ usdCostRate: toDbRate(newRate) }).where(eq(exchangeHouses.id, input.exchangeHouseId));

    const balIqdAfter = availIqd.minus(iqdSpent);
    const balUsdAfter = newUsd;

    const txnNumber = await nextTxnNumber(tx, input.branchId);
    const txRes = await tx.insert(exchangeTransactions).values({
      txnNumber,
      exchangeHouseId: input.exchangeHouseId,
      branchId: input.branchId,
      type: "FX_BUY",
      currency: "USD",
      iqdAmount: toDbMoney(iqdSpent),
      usdAmount: toDbMoney(usd),
      exchangeRate: toDbRate(rate),
      balanceIqdAfter: toDbMoney(balIqdAfter),
      balanceUsdAfter: toDbMoney(balUsdAfter),
      status: "ACTIVE",
      notes: input.notes ?? null,
      createdBy: actor.userId,
    });
    const txnId = extractInsertId(txRes);

    await postEntry(tx, {
      entryType: "EXCHANGE_FX_BUY",
      branchId: input.branchId,
      exchangeHouseId: input.exchangeHouseId,
      amount: iqdSpent,
      dedupeKey: `EXFXB:${txnNumber}`,
      notes: `شراء ${usd.toFixed(2)}$ بسعر ${rate.toFixed(2)}`,
    });

    if (input.clientRequestId) {
      await recordIdempotencyKey(tx, "exchange.buyUsd", input.clientRequestId, txnId);
    }
    return { txnId, txnNumber, newRate: toDbRate(newRate) };
  });
}
