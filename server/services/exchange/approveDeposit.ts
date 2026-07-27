// اعتماد إيداع الدولار المباشر المعلّق (SOD، تدقيق ٢٥/٧) — المعتمِد ≠ المُنشئ (admin مُستثنى).
// قبل الاعتماد لا أثر إطلاقاً (deposit.ts يُنشئ العملية PENDING_APPROVAL بلا رفع رصيد/WAVG/قيد،
// وrecomputeHouseFromLog يرشّح ACTIVE فيستثنيها). عند الاعتماد يُطبَّق الأثر كاملاً تحت قفل المحفظة:
// WAVG + رفع الرصيد الدولاري + قيد EXCHANGE_DEPOSIT إعلاميّ، ثم تُعلَّم ACTIVE. يمنع تضخيم المحفظة
// بدولارٍ لم يصل فعلاً (كان يُخلق أصلٌ بلا طرفٍ مقابلٍ مُدقَّق).
import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { and, asc, eq } from "drizzle-orm";
import { exchangeHouses, exchangeTransactions } from "../../../drizzle/schema";
import { adjustExchangeBalanceUsd, postEntry } from "../ledgerService";
import { money, round2, toDbMoney } from "../money";
import { requireDb, withTx, type Actor } from "../tx";
import { lockHouse, toDbRate } from "./helpers";

/** إيداعات الدولار المعلّقة (بانتظار اعتماد ثانٍ) — طابور الاعتماد للراوتر/الواجهة. */
export async function listPendingExchangeDeposits(exchangeHouseId?: number) {
  const db = requireDb();
  const conds = [
    eq(exchangeTransactions.status, "PENDING_APPROVAL"),
    eq(exchangeTransactions.type, "DEPOSIT"),
    eq(exchangeTransactions.currency, "USD"),
  ];
  if (exchangeHouseId != null) conds.push(eq(exchangeTransactions.exchangeHouseId, exchangeHouseId));
  return db
    .select({
      id: exchangeTransactions.id,
      txnNumber: exchangeTransactions.txnNumber,
      exchangeHouseId: exchangeTransactions.exchangeHouseId,
      houseName: exchangeHouses.name,
      branchId: exchangeTransactions.branchId,
      usdAmount: exchangeTransactions.usdAmount,
      exchangeRate: exchangeTransactions.exchangeRate,
      notes: exchangeTransactions.notes,
      createdBy: exchangeTransactions.createdBy,
      createdAt: exchangeTransactions.createdAt,
    })
    .from(exchangeTransactions)
    .leftJoin(exchangeHouses, eq(exchangeTransactions.exchangeHouseId, exchangeHouses.id))
    .where(and(...conds))
    .orderBy(asc(exchangeTransactions.id));
}

/**
 * اعتماد إيداع دولار معلّق: يطبّق أثره كاملاً (WAVG + رفع الرصيد الدولاري + قيد إعلاميّ) ويعلّمه ACTIVE.
 * فصل مهام: المعتمِد ≠ مُنشئ الإيداع (admin مُستثنى للتصحيح الإداري). ذرّيّ تحت قفل المحفظة.
 */
export async function approveExchangeDeposit(
  txnId: number,
  actor: Actor,
): Promise<{ txnId: number; txnNumber: string; status: "ACTIVE" }> {
  return withTx(async (tx) => {
    const [txn] = await tx
      .select()
      .from(exchangeTransactions)
      .where(eq(exchangeTransactions.id, txnId))
      .for("update")
      .limit(1);
    if (!txn) throw new TRPCError({ code: "NOT_FOUND", message: "عملية الصيرفة غير موجودة" });
    if (txn.status !== "PENDING_APPROVAL") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا يوجد إيداع دولار معلّق بهذا المعرّف" });
    }
    if (!(txn.type === "DEPOSIT" && txn.currency === "USD")) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "الاعتماد مخصّص لإيداعات الدولار المعلّقة فقط" });
    }
    // فصل المهام: المعتمِد ≠ المُنشئ (admin مُستثنى).
    if (actor.role !== "admin" && txn.createdBy != null && Number(txn.createdBy) === actor.userId) {
      throw new TRPCError({ code: "FORBIDDEN", message: "لا يجوز اعتماد إيداعٍ أنشأته بنفسك — يلزم شخصٌ آخر (فصل المهام)." });
    }

    const houseId = Number(txn.exchangeHouseId);
    const house = await lockHouse(tx, houseId);
    const amount = money(txn.usdAmount);
    const rate = money(txn.exchangeRate);

    // تطبيق الأثر (نظير مسار الإيداع القديم، لكن الآن باعتماد ثانٍ): WAVG + رفع الرصيد الدولاري.
    const oldUsd = money(house.balanceUsd);
    const oldRate = money(house.usdCostRate);
    const newUsd = oldUsd.plus(amount);
    const newCostBasis = oldUsd.times(oldRate).plus(amount.times(rate));
    const newRate = newUsd.isZero() ? new Decimal(0) : newCostBasis.div(newUsd);

    await adjustExchangeBalanceUsd(tx, houseId, amount);
    await tx.update(exchangeHouses).set({ usdCostRate: toDbRate(newRate) }).where(eq(exchangeHouses.id, houseId));
    await tx
      .update(exchangeTransactions)
      .set({ status: "ACTIVE", balanceUsdAfter: toDbMoney(newUsd) })
      .where(eq(exchangeTransactions.id, txnId));

    // قيمة دينارية معادِلة إعلامية فقط (نظير قيد الرصيد الافتتاحي) — dedupeKey فريد يمنع الازدواج عند إعادة المحاولة.
    await postEntry(tx, {
      entryType: "EXCHANGE_DEPOSIT",
      branchId: txn.branchId != null ? Number(txn.branchId) : null,
      exchangeHouseId: houseId,
      amount: round2(amount.times(rate)),
      dedupeKey: `EXDEP:${txn.txnNumber}`,
      notes: txn.notes ?? "إيداع دولار مباشر (معتمَد)",
    });

    return { txnId, txnNumber: txn.txnNumber, status: "ACTIVE" as const };
  });
}
