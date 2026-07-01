// كشف حساب صيرفة: كل العمليات + إجماليات الفترة.
import Decimal from "decimal.js";
import { and, eq, gte, lte } from "drizzle-orm";
import { exchangeHouses, exchangeTransactions } from "../../../drizzle/schema";
import { getDb } from "../../db";
import { money, toDbMoney } from "../money";

export interface StatementInput {
  exchangeHouseId: number;
  from?: string; // YYYY-MM-DD
  to?: string;
}

export async function getExchangeStatement(input: StatementInput) {
  const db = getDb();
  if (!db) return null;
  const house = (await db.select().from(exchangeHouses).where(eq(exchangeHouses.id, input.exchangeHouseId)).limit(1))[0];
  if (!house) return null;

  const conds = [eq(exchangeTransactions.exchangeHouseId, input.exchangeHouseId)];
  if (input.from) conds.push(gte(exchangeTransactions.createdAt, new Date(input.from + "T00:00:00Z")));
  if (input.to) conds.push(lte(exchangeTransactions.createdAt, new Date(input.to + "T23:59:59Z")));

  const txns = await db
    .select()
    .from(exchangeTransactions)
    .where(and(...conds))
    .orderBy(exchangeTransactions.createdAt, exchangeTransactions.id);

  let totalDepositIqd = new Decimal(0);
  let totalWithdrawIqd = new Decimal(0);
  let totalDepositUsd = new Decimal(0);
  let totalWithdrawUsd = new Decimal(0);
  let totalSettledIqd = new Decimal(0);
  let totalFeesIqd = new Decimal(0);
  let totalFxDiff = new Decimal(0);
  let totalUsdBought = new Decimal(0);
  for (const t of txns) {
    // إيداع/سحب دولار مباشر: iqdAmount=0 دائماً (محفظتان معزولتان) ⇒ مجموع IQD لا يتأثّر.
    if (t.type === "DEPOSIT") {
      totalDepositIqd = totalDepositIqd.plus(money(t.iqdAmount));
      if (t.currency === "USD") totalDepositUsd = totalDepositUsd.plus(money(t.usdAmount));
    }
    if (t.type === "WITHDRAW") {
      totalWithdrawIqd = totalWithdrawIqd.plus(money(t.iqdAmount));
      if (t.currency === "USD") totalWithdrawUsd = totalWithdrawUsd.plus(money(t.usdAmount));
    }
    if (t.type === "FX_BUY") totalUsdBought = totalUsdBought.plus(money(t.usdAmount));
    if (t.type === "SETTLE") totalSettledIqd = totalSettledIqd.plus(money(t.iqdAmount));
    totalFeesIqd = totalFeesIqd.plus(money(t.commissionIqd));
    totalFxDiff = totalFxDiff.plus(money(t.fxDiff));
  }

  return {
    house: {
      id: Number(house.id),
      name: house.name,
      balanceIqd: house.balanceIqd,
      balanceUsd: house.balanceUsd,
      usdCostRate: house.usdCostRate,
    },
    transactions: txns.map((t) => ({
      id: Number(t.id),
      txnNumber: t.txnNumber,
      type: t.type,
      currency: t.currency,
      iqdAmount: t.iqdAmount,
      usdAmount: t.usdAmount,
      exchangeRate: t.exchangeRate,
      commission: t.commission,
      commissionIqd: t.commissionIqd,
      fxDiff: t.fxDiff,
      supplierId: t.supplierId ? Number(t.supplierId) : null,
      balanceIqdAfter: t.balanceIqdAfter,
      balanceUsdAfter: t.balanceUsdAfter,
      status: t.status,
      notes: t.notes,
      createdAt: t.createdAt instanceof Date ? t.createdAt.toISOString() : String(t.createdAt),
    })),
    summary: {
      totalDepositIqd: toDbMoney(totalDepositIqd),
      totalWithdrawIqd: toDbMoney(totalWithdrawIqd),
      totalDepositUsd: toDbMoney(totalDepositUsd),
      totalWithdrawUsd: toDbMoney(totalWithdrawUsd),
      totalSettledIqd: toDbMoney(totalSettledIqd),
      totalFeesIqd: toDbMoney(totalFeesIqd),
      totalFxDiff: toDbMoney(totalFxDiff),
      totalUsdBought: toDbMoney(totalUsdBought),
      currentBalanceIqd: house.balanceIqd,
      currentBalanceUsd: house.balanceUsd,
    },
  };
}
