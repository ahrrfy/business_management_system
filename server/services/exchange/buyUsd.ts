// شراء دولار من الصيرفة (نموذج الدَّين، قرار مالك ٣/٨): الصيرفة تُسلِّم الدولار فوراً نقداً — لا تحويل
// داخل محفظةٍ مزعومة. يخفض control الصيرفة (وقد يحوّله من أصل إلى التزام) مع حفظ كلفة الطرفين، ولا يمسّ الدينار
// إطلاقاً (كان الكود القديم يخصم الدينار المُفتَرَض إيداعه مسبقاً — افتراضٌ لا يطابق واقع التعامل).
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { exchangeTransactions } from "../../../drizzle/schema";
import { extractInsertId } from "../../lib/insertId";
import { findIdempotentRefId, recordIdempotencyKey } from "../idempotency";
import { postEntry } from "../ledgerService";
import { createPostingIntent, creditLine, debitLine } from "../accounting/postingEngine";
import { money, round2, toDbMoney } from "../money";
import { withTx, type Actor } from "../tx";
import { lockBranchMonthCloseGate } from "../reports/monthCloseGate";
import { lockHouse, nextTxnNumber, toDbRate } from "./helpers";
import { calculateSignedUsdMovement, persistSignedUsdControl } from "./reverse";
import { postExchangeControlReclassification } from "./controlClassification";

export interface BuyUsdInput {
  exchangeHouseId: number;
  branchId: number;
  usdAmount: string;
  exchangeRate: string; // دينار/دولار — كلفة الدولار المادي وسعر نشوء الطرف الجديد من control الصيرفة
  notes?: string | null;
  clientRequestId?: string | null;
  /** يُطلَب فقط عند أوّل عبورٍ من رصيدٍ دولاري غير سالب إلى سالب — لا عند كل عملية (دَينٌ متجدّد طبيعي). */
  confirmNegative?: boolean;
}

/** شراء دولار من الصيرفة: استلام أصل USD مادي مقابل خفض control الصيرفة؛ عبور الصفر يغلق الطرف
 *  القديم بكلفته ويفتح الطرف الجديد بسعر الصفقة، مع فرق صرف صريح. */
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

    const iqdSpent = round2(usd.times(rate)); // قيمة الصفقة authoritative إلى سنت — لا تُعاد من WAVG المخزّن.
    await lockBranchMonthCloseGate(tx, input.branchId);
    const house = await lockHouse(tx, input.exchangeHouseId);
    const availUsd = money(house.balanceUsd);
    if (usd.gt(availUsd) && availUsd.gte(0) && !input.confirmNegative) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: `الشراء سيجعل رصيد الدولار لدى الصيرفة سالباً (${availUsd.toFixed(2)}$ متاح مقابل ${usd.toFixed(2)}$ مطلوب) — أي دَيناً دولارياً لكم عليها. أرسل confirmNegative=true للتجاوز.`,
      });
    }

    // متوسط الكلفة المرجّح الجديد لدَينٍ متعمّق: (قيمة الدَّين القائم بكلفته + قيمة الدَّين الجديد بسعره) / (إجمالي الدولار).
    // كلا الرصيدين (oldUsd الجديد) سالبان عادةً؛ الصيغة سليمة جبرياً لأنها نسبة قيمةٍ إلى كمّيةٍ بإشارتين متطابقتين.
    const oldUsd = money(house.balanceUsd);
    const oldCarrying = money(house.balanceUsdCarryingIqd);
    const movement = calculateSignedUsdMovement(oldUsd, oldCarrying, usd.negated(), iqdSpent);

    await persistSignedUsdControl(tx, input.exchangeHouseId, movement);

    const balIqdAfter = money(house.balanceIqd); // لا يتغيّر إطلاقاً بشراء الدولار.
    const balUsdAfter = movement.balanceUsd;

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
      fxDiff: toDbMoney(movement.fxGainIqd),
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
      createdBy: actor.userId,
      exchangeHouseId: input.exchangeHouseId,
      amount: iqdSpent,
      dedupeKey: `EXFXB:${txnNumber}`,
      notes: `شراء ${usd.toFixed(2)}$ بسعر ${rate.toFixed(2)}`,
      postingIntent: createPostingIntent(
        "EXCHANGE_FX_BUY",
        "EXCHANGE_FX_BUY",
        [
          debitLine("FOREIGN_CASH_USD", iqdSpent),
          creditLine("EXCHANGE_WALLET_USD", iqdSpent),
        ],
      ),
      postingSourceComponents: {
        roleDebits: { FOREIGN_CASH_USD: iqdSpent },
        roleCredits: { EXCHANGE_WALLET_USD: iqdSpent },
      },
    });

    if (!movement.fxGainIqd.isZero()) {
      const fxAmount = movement.fxGainIqd.abs();
      const fxComponents = movement.fxGainIqd.isPositive()
        ? { roleDebits: { EXCHANGE_WALLET_USD: fxAmount }, roleCredits: { FX_GAIN: fxAmount } }
        : { roleDebits: { FX_LOSS: fxAmount }, roleCredits: { EXCHANGE_WALLET_USD: fxAmount } };
      await postEntry(tx, {
        entryType: "EXCHANGE_FX_DIFF",
        branchId: input.branchId,
        createdBy: actor.userId,
        exchangeHouseId: input.exchangeHouseId,
        amount: movement.fxGainIqd,
        dedupeKey: `EXFXB:FX:${txnNumber}`,
        notes: "فرق كلفة عند استلام دولار فعلي من الصيرفة",
        postingSourceComponents: fxComponents,
        postingIntent: movement.fxGainIqd.isPositive()
          ? createPostingIntent("EXCHANGE_FX_GAIN", "EXCHANGE_FX_DIFF", [debitLine("EXCHANGE_WALLET_USD", fxAmount), creditLine("FX_GAIN", fxAmount)], fxComponents)
          : createPostingIntent("EXCHANGE_FX_LOSS", "EXCHANGE_FX_DIFF", [debitLine("FX_LOSS", fxAmount), creditLine("EXCHANGE_WALLET_USD", fxAmount)], fxComponents),
      });
    }

    await postExchangeControlReclassification(tx, {
      exchangeHouseId: input.exchangeHouseId,
      currency: "USD",
      beforeSignedIqd: oldCarrying,
      afterSignedIqd: movement.balanceCarryingIqd,
      sourceKey: txnNumber,
      notes: `تصنيف ذمة الصيرفة لشراء الدولار ${txnNumber}`,
      createdBy: actor.userId,
    });

    if (input.clientRequestId) {
      await recordIdempotencyKey(tx, "exchange.buyUsd", input.clientRequestId, txnId);
    }
    return { txnId, txnNumber, newRate: toDbRate(movement.usdCostRate) };
  });
}
