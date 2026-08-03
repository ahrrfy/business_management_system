// شراء دولار من الصيرفة (نموذج الدَّين، قرار مالك ٣/٨): الصيرفة تُسلِّم الدولار فوراً نقداً — لا تحويل
// داخل محفظةٍ مزعومة. يزيد ذمّتنا الدولارية عليها (balanceUsd ينخفض) بسعر نشوء الدَّين، ولا يمسّ الدينار
// إطلاقاً (كان الكود القديم يخصم الدينار المُفتَرَض إيداعه مسبقاً — افتراضٌ لا يطابق واقع التعامل).
import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { eq } from "drizzle-orm";
import { exchangeHouses, exchangeTransactions } from "../../../drizzle/schema";
import { extractInsertId } from "../../lib/insertId";
import { findIdempotentRefId, recordIdempotencyKey } from "../idempotency";
import { adjustExchangeBalanceUsd, postEntry } from "../ledgerService";
import { money, round2, toDbMoney } from "../money";
import { withTx, type Actor } from "../tx";
import { lockHouse, nextTxnNumber, toDbRate } from "./helpers";

export interface BuyUsdInput {
  exchangeHouseId: number;
  branchId: number;
  usdAmount: string;
  exchangeRate: string; // دينار/دولار — سعر نشوء هذا الدَّين (يُحدّث متوسط الكلفة WAVG لكامل الدَّين القائم)
  notes?: string | null;
  clientRequestId?: string | null;
  /** يُطلَب فقط عند أوّل عبورٍ من رصيدٍ دولاري غير سالب إلى سالب — لا عند كل عملية (دَينٌ متجدّد طبيعي). */
  confirmNegative?: boolean;
}

/** شراء دولار من الصيرفة: تُسلِّمه فوراً نقداً ⇒ يزيد دَيننا الدولاري عليها (balanceUsd ينخفض) بمتوسط
 *  كلفة مرجّح WAVG لسعر نشوء الدَّين (نقل التزام، 0/0/0 دينارياً — الدينار لا يُمسّ). */
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

    const iqdSpent = round2(usd.times(rate)); // القيمة الدينارية المعادِلة (إعلامية + أساس WAVG) — لا تُخصَم من محفظة الدينار.
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
    const oldRate = money(house.usdCostRate);
    const newUsd = oldUsd.minus(usd);
    const newCostBasisIqd = oldUsd.times(oldRate).minus(iqdSpent);
    const newRate = newUsd.isZero() ? new Decimal(0) : newCostBasisIqd.div(newUsd);

    await adjustExchangeBalanceUsd(tx, input.exchangeHouseId, usd.negated());
    await tx.update(exchangeHouses).set({ usdCostRate: toDbRate(newRate) }).where(eq(exchangeHouses.id, input.exchangeHouseId));

    const balIqdAfter = money(house.balanceIqd); // لا يتغيّر إطلاقاً بشراء الدولار.
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
