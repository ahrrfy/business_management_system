// إيداع نقد (دينار) من خزينة الفرع، أو إيداع دولار مباشر لمحفظة الصيرفة الدولارية (معزولتان).
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { exchangeTransactions, receipts } from "../../../drizzle/schema";
import { extractInsertId } from "../../lib/insertId";
import { findIdempotentRefId, recordIdempotencyKey } from "../idempotency";
import { adjustExchangeBalanceIqd, postEntry } from "../ledgerService";
import { money, round2, toDbMoney } from "../money";
import { withTx, type Actor } from "../tx";
import { assertCashOutAvailable, assertTreasuryOutException } from "../cash/cashAvailability";
import { lockHouse, nextTxnNumber, toDbRate } from "./helpers";

export interface DepositInput {
  exchangeHouseId: number;
  branchId: number;
  amount: string; // بعملة `currency`
  /** IQD (افتراضي) = نقد دينار حقيقي يغادر خزينة الفرع. USD = دولار مباشر (مصدره خارج خزينة الفرع
   *  الدينارية — لا خزينة دولارية رسمية بعد) ⇒ بلا receipt، ويتطلّب سعراً مرجعياً لتحديث WAVG. */
  currency?: "IQD" | "USD";
  /** سعر مرجعي (دينار/دولار) — إلزامي لإيداع الدولار فقط (يُحدّث متوسط كلفة المحفظة WAVG). */
  exchangeRate?: string | null;
  notes?: string | null;
  clientRequestId?: string | null;
}

/** إيداع نقد (دينار) من خزينة الفرع → محفظة الصيرفة، أو إيداع دولار مباشر لمحفظتها الدولارية
 *  (معزولتان تماماً — كلٌّ بعمليّاته الخاصّة، بلا أثر على الأخرى). نقل أصل (0/0/0 دينارياً). */
export async function depositToExchange(
  input: DepositInput,
  actor: Actor,
): Promise<{ txnId: number; txnNumber: string; pendingApproval?: boolean }> {
  return withTx(async (tx) => {
    if (input.clientRequestId) {
      const existing = await findIdempotentRefId(tx, "exchange.deposit", input.clientRequestId);
      if (existing != null) {
        const t = (await tx.select().from(exchangeTransactions).where(eq(exchangeTransactions.id, existing)).limit(1))[0];
        return { txnId: existing, txnNumber: t?.txnNumber ?? "" };
      }
    }
    const amount = round2(input.amount);
    if (amount.lte(0)) throw new TRPCError({ code: "BAD_REQUEST", message: "المبلغ يجب أن يكون موجباً" });

    // في الإيداع الديناري ترتيب الأقفال الحاكم: مصدر الخزينة → محفظة الصيرفة → receipt.
    // إيداع الدولار لا يمس خزينة الدينار، فيبقى قفل المحفظة وحده.
    if (input.currency !== "USD") {
      assertTreasuryOutException("EXCHANGE_DEPOSIT_INTERNAL");
      await assertCashOutAvailable(tx, {
        branchId: input.branchId,
        cashBucket: "TREASURY",
        amount,
        operation: "الإيداع النقدي لدى الصيرفة",
      });
    }
    const house = await lockHouse(tx, input.exchangeHouseId);

    if (input.currency === "USD") {
      const rate = money(input.exchangeRate ?? 0);
      if (rate.lte(0)) throw new TRPCError({ code: "BAD_REQUEST", message: "يلزم سعر صرف مرجعي موجب لإيداع الدولار" });

      // اعتماد ثانٍ (SOD، تدقيق ٢٥/٧): إيداع الدولار المباشر (مصدره خارج خزينة الفرع، لا نقد ديناريّ يغادر)
      // يُنشأ **معلّقاً بلا أيّ أثر** — لا رفع رصيد، لا WAVG، لا قيد — حتى يعتمده مديرٌ ثانٍ عبر
      // approveExchangeDeposit فيُطبَّق كاملاً تحت القفل. يمنع تضخيم المحفظة بدولارٍ لم يصل فعلاً
      // (كان يرفع الأصل بلا طرفٍ مقابلٍ مُدقَّق). recomputeHouseFromLog يرشّح ACTIVE فيستثني المعلّق،
      // وأرصدة After = الحالية إذ لم يُطبَّق بعد.
      const txnNumber = await nextTxnNumber(tx, input.branchId);
      const txRes = await tx.insert(exchangeTransactions).values({
        txnNumber,
        exchangeHouseId: input.exchangeHouseId,
        branchId: input.branchId,
        type: "DEPOSIT",
        currency: "USD",
        usdAmount: toDbMoney(amount),
        exchangeRate: toDbRate(rate),
        balanceIqdAfter: toDbMoney(money(house.balanceIqd)),
        balanceUsdAfter: toDbMoney(money(house.balanceUsd)),
        status: "PENDING_APPROVAL",
        notes: input.notes ?? null,
        createdBy: actor.userId,
      });
      const txnId = extractInsertId(txRes);

      if (input.clientRequestId) {
        await recordIdempotencyKey(tx, "exchange.deposit", input.clientRequestId, txnId);
      }
      return { txnId, txnNumber, pendingApproval: true };
    }

    // receipt OUT TREASURY — نقد فعلي يغادر خزينة الفرع إلى أصل الصيرفة.
    const recRes = await tx.insert(receipts).values({
      branchId: input.branchId,
      shiftId: null,
      direction: "OUT",
      amount: toDbMoney(amount),
      paymentMethod: "CASH",
      cashBucket: "TREASURY",
      status: "COMPLETED",
      partyType: "OTHER",
      description: `إيداع لدى الصيرفة «${house.name}»`,
      createdBy: actor.userId,
    });
    const receiptId = extractInsertId(recRes);

    await adjustExchangeBalanceIqd(tx, input.exchangeHouseId, amount);
    const balIqdAfter = money(house.balanceIqd).plus(amount);
    const balUsdAfter = money(house.balanceUsd);

    const txnNumber = await nextTxnNumber(tx, input.branchId);
    const txRes = await tx.insert(exchangeTransactions).values({
      txnNumber,
      exchangeHouseId: input.exchangeHouseId,
      branchId: input.branchId,
      type: "DEPOSIT",
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
      entryType: "EXCHANGE_DEPOSIT",
      branchId: input.branchId,
      exchangeHouseId: input.exchangeHouseId,
      receiptId,
      amount,
      dedupeKey: `EXDEP:${txnNumber}`,
      notes: input.notes ?? undefined,
    });

    if (input.clientRequestId) {
      await recordIdempotencyKey(tx, "exchange.deposit", input.clientRequestId, txnId);
    }
    return { txnId, txnNumber };
  });
}
