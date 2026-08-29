// إيداع نقد (دينار) من خزينة الفرع، أو إيداع دولار مباشر لمحفظة الصيرفة الدولارية (معزولتان).
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { exchangeTransactions } from "../../../drizzle/schema";
import { extractInsertId } from "../../lib/insertId";
import { findIdempotentRefId, recordIdempotencyKey } from "../idempotency";
import { money, round2, toDbMoney } from "../money";
import { withTx, type Actor } from "../tx";
import { lockCashSourceForUpdate } from "../cash/cashAvailability";
import { createSystemPaymentRequestTx } from "../voucher/create";
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
        return {
          txnId: existing,
          txnNumber: t?.txnNumber ?? "",
          pendingApproval: t?.status === "PENDING_APPROVAL",
        };
      }
    }
    const amount = round2(input.amount);
    if (amount.lte(0)) throw new TRPCError({ code: "BAD_REQUEST", message: "المبلغ يجب أن يكون موجباً" });

    // في الإيداع الديناري ترتيب الأقفال الحاكم: مصدر الخزينة → محفظة الصيرفة → receipt.
    // إيداع الدولار لا يمس خزينة الدينار، فيبقى قفل المحفظة وحده.
    if (input.currency !== "USD") {
      // الطلب لا يحجز الرصيد ولا يصرفه، لكن قفل المصدر يحافظ على الترتيب العالمي
      // branch/source → house → document كي لا ينعكس مع اعتماد طلب آخر.
      await lockCashSourceForUpdate(tx, {
        branchId: input.branchId,
        cashBucket: "TREASURY",
        shiftId: null,
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

    // الإيداع الديناري دفعٌ إلى أمين خارجي، لا نقلٌ داخلي. نثبت طلب الحركة فقط؛
    // لا house balance ولا receipt مادي ولا ledger حتى يعتمد مالك مختلف سند الصرف.
    const txnNumber = await nextTxnNumber(tx, input.branchId);
    const txRes = await tx.insert(exchangeTransactions).values({
      txnNumber,
      exchangeHouseId: input.exchangeHouseId,
      branchId: input.branchId,
      type: "DEPOSIT",
      currency: "IQD",
      iqdAmount: toDbMoney(amount),
      balanceIqdAfter: toDbMoney(money(house.balanceIqd)),
      balanceUsdAfter: toDbMoney(money(house.balanceUsd)),
      receiptId: null,
      status: "PENDING_APPROVAL",
      notes: input.notes ?? null,
      createdBy: actor.userId,
    });
    const txnId = extractInsertId(txRes);
    const request = await createSystemPaymentRequestTx(tx, {
      branchId: input.branchId,
      amount: toDbMoney(amount),
      paymentMethod: "CASH",
      partyType: "OTHER",
      counterpartyName: house.name,
      description: `طلب إيداع نقد لدى الصيرفة «${house.name}»`,
      referenceNumber: `EXCHANGE-IQD-DEP-${txnId}`,
      clientRequestId: `exchange-iqd-deposit-${txnId}`,
      internalNote: null,
    }, actor, {
      kind: "EXCHANGE_IQD_DEPOSIT",
      transactionId: txnId,
      exchangeHouseId: input.exchangeHouseId,
      expectedAmount: toDbMoney(amount),
    });
    await tx
      .update(exchangeTransactions)
      .set({ receiptId: request.receiptId })
      .where(eq(exchangeTransactions.id, txnId));

    if (input.clientRequestId) {
      await recordIdempotencyKey(tx, "exchange.deposit", input.clientRequestId, txnId);
    }
    return { txnId, txnNumber, pendingApproval: true };
  });
}
