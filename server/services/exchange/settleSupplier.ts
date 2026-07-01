// تسديد ذمّة مورد عبر الصيرفة: يخفض المحفظة (مبدأ+عمولة) ودين المورد؛ يُسجّل فرق الصرف والعمولة.
import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { eq } from "drizzle-orm";
import { exchangeHouses, exchangeTransactions, suppliers } from "../../../drizzle/schema";
import { extractInsertId } from "../../lib/insertId";
import { findIdempotentRefId, recordIdempotencyKey } from "../idempotency";
import { adjustExchangeBalanceIqd, adjustExchangeBalanceUsd, adjustSupplierBalance, postEntry } from "../ledgerService";
import { money, round2, toDbMoney } from "../money";
import { withTx, type Actor } from "../tx";
import { lockHouse, nextTxnNumber, toDbRate } from "./helpers";

export interface SettleSupplierInput {
  exchangeHouseId: number;
  branchId: number;
  supplierId: number;
  currency: "USD" | "IQD";
  /** المبلغ المخصوم من المحفظة (المبدأ) بعملة المحفظة. */
  walletAmount: string;
  /** الدين الديناري المُطفأ من ذمّة المورد. */
  settledIqd: string;
  /** عمولة الصيرفة بعملة المحفظة (تُخصم من المحفظة، مصروف). */
  commission?: string | null;
  /** سعر الصرف وقت التسديد (للتدقيق، عملة USD). */
  exchangeRate?: string | null;
  notes?: string | null;
  clientRequestId?: string | null;
  confirmNegative?: boolean;
}

/** تسديد ذمّة مورد عبر الصيرفة. يخفض المحفظة (مبدأ+عمولة) ودين المورد؛ يُسجّل فرق الصرف والعمولة.
 *  ⚠️ لا يمسّ الخزينة (النقد غادر عند الإيداع). فرق الصرف = settledIqd − (walletAmount بالدينار بالكلفة). */
export async function settleSupplierViaExchange(
  input: SettleSupplierInput,
  actor: Actor,
): Promise<{ txnId: number; txnNumber: string; fxDiff: string }> {
  return withTx(async (tx) => {
    if (input.clientRequestId) {
      const existing = await findIdempotentRefId(tx, "exchange.settle", input.clientRequestId);
      if (existing != null) {
        const t = (await tx.select().from(exchangeTransactions).where(eq(exchangeTransactions.id, existing)).limit(1))[0];
        return { txnId: existing, txnNumber: t?.txnNumber ?? "", fxDiff: t?.fxDiff ?? "0.00" };
      }
    }
    const walletAmount = round2(input.walletAmount);
    const settledIqd = round2(input.settledIqd);
    const commission = round2(input.commission ?? 0);
    if (walletAmount.lte(0)) throw new TRPCError({ code: "BAD_REQUEST", message: "مبلغ التسديد يجب أن يكون موجباً" });
    if (settledIqd.lte(0)) throw new TRPCError({ code: "BAD_REQUEST", message: "الدين المُسوّى يجب أن يكون موجباً" });
    if (commission.isNegative()) throw new TRPCError({ code: "BAD_REQUEST", message: "العمولة لا تكون سالبة" });

    const supplier = (await tx.select().from(suppliers).where(eq(suppliers.id, input.supplierId)).limit(1))[0];
    if (!supplier) throw new TRPCError({ code: "BAD_REQUEST", message: "المورد غير موجود" });

    const house = await lockHouse(tx, input.exchangeHouseId);
    const usdRate = money(house.usdCostRate);

    let walletCostIqd: Decimal;
    let commissionIqd: Decimal;
    let usdAmountCol = new Decimal(0);
    let iqdAmountCol = settledIqd;

    if (input.currency === "USD") {
      if (usdRate.lte(0)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "لا يوجد رصيد دولاري بكلفة معروفة — اشترِ دولاراً أولاً" });
      }
      walletCostIqd = round2(walletAmount.times(usdRate));
      commissionIqd = round2(commission.times(usdRate));
      const totalUsdOut = walletAmount.plus(commission);
      const availUsd = money(house.balanceUsd);
      if (totalUsdOut.gt(availUsd) && !input.confirmNegative) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `رصيد الدولار ${availUsd.toFixed(2)}$ أقلّ من المطلوب ${totalUsdOut.toFixed(2)}$. أرسل confirmNegative=true للتجاوز.`,
        });
      }
      await adjustExchangeBalanceUsd(tx, input.exchangeHouseId, totalUsdOut.negated());
      usdAmountCol = walletAmount;
    } else {
      // بالدينار لا صرف عملة ⇒ المسحوب من المحفظة = الدين المُسوّى. حارس ضدّ تباين يُنتج fxDiff وهمياً
      // ويُفسد إجمالي «المُسدَّد» في الكشف (الكشف يجمع iqdAmount لصفوف SETTLE). الواجهة تُرسلهما متساويَين.
      if (!walletAmount.eq(settledIqd)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "للتسديد بالدينار يجب تساوي المبلغ المسحوب والدين المُسوّى" });
      }
      walletCostIqd = walletAmount;
      commissionIqd = commission;
      const totalIqdOut = walletAmount.plus(commission);
      const availIqd = money(house.balanceIqd);
      if (totalIqdOut.gt(availIqd) && !input.confirmNegative) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `رصيد الدينار ${availIqd.toFixed(2)} أقلّ من المطلوب ${totalIqdOut.toFixed(2)}. أرسل confirmNegative=true للتجاوز.`,
        });
      }
      await adjustExchangeBalanceIqd(tx, input.exchangeHouseId, totalIqdOut.negated());
      // iqdAmountCol يبقى = settledIqd (= walletAmount) ⇒ إجمالي الكشف صحيح بلا fxDiff وهميّ.
    }

    // فرق الصرف المحقَّق = الدين المُطفأ − كلفة ما خرج من المحفظة (بلا العمولة).
    const fxDiff = settledIqd.minus(walletCostIqd);

    // إطفاء دين المورد (التسديد الفعلي — هنا فقط).
    await adjustSupplierBalance(tx, input.supplierId, settledIqd.negated());

    // قراءة الرصيد بعد كل الخصومات (لقطة الكشف).
    const after = (await tx.select().from(exchangeHouses).where(eq(exchangeHouses.id, input.exchangeHouseId)).limit(1))[0];

    const txnNumber = await nextTxnNumber(tx, input.branchId);
    const txRes = await tx.insert(exchangeTransactions).values({
      txnNumber,
      exchangeHouseId: input.exchangeHouseId,
      branchId: input.branchId,
      type: "SETTLE",
      currency: input.currency,
      iqdAmount: toDbMoney(iqdAmountCol),
      usdAmount: toDbMoney(usdAmountCol),
      exchangeRate: input.currency === "USD" ? toDbRate(money(input.exchangeRate ?? usdRate)) : "0.0000",
      commission: toDbMoney(commission),
      commissionIqd: toDbMoney(commissionIqd),
      fxDiff: toDbMoney(fxDiff),
      supplierId: input.supplierId,
      balanceIqdAfter: after ? toDbMoney(money(after.balanceIqd)) : "0.00",
      balanceUsdAfter: after ? toDbMoney(money(after.balanceUsd)) : "0.00",
      status: "ACTIVE",
      notes: input.notes ?? null,
      createdBy: actor.userId,
    });
    const txnId = extractInsertId(txRes);

    // قيد التسديد (0/0/0 — حركة إطفاء ذمّة، مُستثناة من الإيراد).
    await postEntry(tx, {
      entryType: "EXCHANGE_SETTLE",
      branchId: input.branchId,
      exchangeHouseId: input.exchangeHouseId,
      supplierId: input.supplierId,
      amount: settledIqd,
      dedupeKey: `EXSET:${txnNumber}`,
      notes: `تسديد مورد «${supplier.name}» عبر الصيرفة`,
    });

    // فرق الصرف المحقَّق (amount موقَّع، معزول عن إيراد البيع).
    if (!fxDiff.isZero()) {
      await postEntry(tx, {
        entryType: "EXCHANGE_FX_DIFF",
        branchId: input.branchId,
        exchangeHouseId: input.exchangeHouseId,
        supplierId: input.supplierId,
        amount: fxDiff,
        dedupeKey: `EXFX:${txnNumber}`,
        notes: fxDiff.isPositive() ? "مكسب صرف محقَّق" : "خسارة صرف محقَّقة",
      });
    }

    // العمولة مصروف (cost=amount، profit سالب) — تظهر في P&L والكشف.
    if (commissionIqd.gt(0)) {
      await postEntry(tx, {
        entryType: "EXCHANGE_FEE",
        branchId: input.branchId,
        exchangeHouseId: input.exchangeHouseId,
        supplierId: input.supplierId,
        amount: commissionIqd,
        cost: commissionIqd,
        profit: commissionIqd.negated(),
        dedupeKey: `EXFEE:${txnNumber}`,
        notes: "عمولة صيرفة",
      });
    }

    if (input.clientRequestId) {
      await recordIdempotencyKey(tx, "exchange.settle", input.clientRequestId, txnId);
    }
    return { txnId, txnNumber, fxDiff: toDbMoney(fxDiff) };
  });
}
