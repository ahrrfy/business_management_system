// مطابقة أرصدة: رصيدنا الدفتري (حتى تاريخ قطع اختياري) مقابل رصيد كشف الصيرفة الخارجي — قراءة فقط.
import Decimal from "decimal.js";
import { and, desc, eq, gte, lte } from "drizzle-orm";
import { exchangeHouses, exchangeTransactions } from "../../../drizzle/schema";
import { getDb } from "../../db";
import { money, round2, toDbMoney } from "../money";

export interface ReconcileInput {
  exchangeHouseId: number;
  statedBalanceIqd: string;
  statedBalanceUsd: string;
  asOfDate?: string; // YYYY-MM-DD
}

/** مطابقة أرصدة: تقارن رصيدنا الدفتري (حتى تاريخ القطع) برصيد كشف الصيرفة، وتُظهر البنود المعلّقة.
 *  قراءة فقط — أي فرق حقيقي يُسوّى لاحقاً بقيد تصحيح يدوي صريح (لا تسوية صامتة). */
export async function reconcileExchange(input: ReconcileInput) {
  const db = getDb();
  if (!db) return null;
  const house = (await db.select().from(exchangeHouses).where(eq(exchangeHouses.id, input.exchangeHouseId)).limit(1))[0];
  if (!house) return null;

  let ourIqd = money(house.balanceIqd);
  let ourUsd = money(house.balanceUsd);
  let pending: Array<Record<string, unknown>> = [];

  if (input.asOfDate) {
    const cutoff = new Date(input.asOfDate + "T23:59:59Z");
    // الرصيد حتى تاريخ القطع = لقطة آخر عملية ≤ القطع (balanceAfter).
    const asOfTxn = (
      await db
        .select()
        .from(exchangeTransactions)
        .where(and(eq(exchangeTransactions.exchangeHouseId, input.exchangeHouseId), lte(exchangeTransactions.createdAt, cutoff)))
        .orderBy(desc(exchangeTransactions.createdAt), desc(exchangeTransactions.id))
        .limit(1)
    )[0];
    ourIqd = asOfTxn ? money(asOfTxn.balanceIqdAfter) : new Decimal(0);
    ourUsd = asOfTxn ? money(asOfTxn.balanceUsdAfter) : new Decimal(0);

    // البنود المعلّقة = عمليات بعد تاريخ القطع (تفسّر فروق التوقيت — لا تُسوّى).
    const after = await db
      .select()
      .from(exchangeTransactions)
      .where(and(eq(exchangeTransactions.exchangeHouseId, input.exchangeHouseId), gte(exchangeTransactions.createdAt, new Date(input.asOfDate + "T00:00:01Z"))))
      .orderBy(exchangeTransactions.createdAt);
    pending = after
      .filter((t) => new Date(t.createdAt as Date) > cutoff)
      .map((t) => ({
        txnNumber: t.txnNumber,
        type: t.type,
        currency: t.currency,
        iqdAmount: t.iqdAmount,
        usdAmount: t.usdAmount,
        createdAt: t.createdAt instanceof Date ? t.createdAt.toISOString() : String(t.createdAt),
      }));
  }

  const statedIqd = round2(input.statedBalanceIqd);
  const statedUsd = round2(input.statedBalanceUsd);
  return {
    asOfDate: input.asOfDate ?? null,
    ourBalanceIqd: toDbMoney(ourIqd),
    ourBalanceUsd: toDbMoney(ourUsd),
    statedBalanceIqd: toDbMoney(statedIqd),
    statedBalanceUsd: toDbMoney(statedUsd),
    diffIqd: toDbMoney(ourIqd.minus(statedIqd)),
    diffUsd: toDbMoney(ourUsd.minus(statedUsd)),
    matched: ourIqd.minus(statedIqd).abs().lte("0.01") && ourUsd.minus(statedUsd).abs().lte("0.01"),
    pending,
  };
}
