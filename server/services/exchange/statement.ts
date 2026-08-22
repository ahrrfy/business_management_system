// كشف حساب صيرفة: كل العمليات + إجماليات الفترة.
import Decimal from "decimal.js";
import { and, eq, gte, inArray, lt } from "drizzle-orm";
import { branches, exchangeHouses, exchangeTransactions, receipts, suppliers, users } from "../../../drizzle/schema";
import { getDb } from "../../db";
import { money, toDbMoney } from "../money";
import { baghdadDayRangeUtc } from "../businessDay";

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
  if (input.from) conds.push(gte(exchangeTransactions.createdAt, baghdadDayRangeUtc(input.from, input.from).start));
  if (input.to) conds.push(lt(exchangeTransactions.createdAt, baghdadDayRangeUtc(input.to, input.to).endExclusive));

  // JOIN لاسم المُنشئ والمورّد والفرع وسند الصرف المرتبط (لعرض الطباعة — سند صيرفة يحتاج أسماءً لا معرّفات خامة).
  const rows = await db
    .select({
      txn: exchangeTransactions,
      createdByName: users.name,
      supplierName: suppliers.name,
      branchName: branches.name,
      voucherNumber: receipts.voucherNumber,
    })
    .from(exchangeTransactions)
    .leftJoin(users, eq(exchangeTransactions.createdBy, users.id))
    .leftJoin(suppliers, eq(exchangeTransactions.supplierId, suppliers.id))
    .leftJoin(branches, eq(exchangeTransactions.branchId, branches.id))
    .leftJoin(receipts, eq(exchangeTransactions.receiptId, receipts.id))
    .where(and(...conds))
    .orderBy(exchangeTransactions.createdAt, exchangeTransactions.id);
  const txns = rows.map((r) => r.txn);

  // الحيازة المادية current state على مستوى الفرع، مستقلة عن نطاق كشف الحركات.
  const custodyRows = await db
    .select({
      txnNumber: exchangeTransactions.txnNumber,
      branchId: exchangeTransactions.branchId,
      branchName: branches.name,
      type: exchangeTransactions.type,
      usdAmount: exchangeTransactions.usdAmount,
      iqdAmount: exchangeTransactions.iqdAmount,
    })
    .from(exchangeTransactions)
    .leftJoin(branches, eq(exchangeTransactions.branchId, branches.id))
    .where(and(
      eq(exchangeTransactions.exchangeHouseId, input.exchangeHouseId),
      eq(exchangeTransactions.status, "ACTIVE"),
      eq(exchangeTransactions.currency, "USD"),
      inArray(exchangeTransactions.type, ["FX_BUY", "WITHDRAW", "DEPOSIT"]),
    ));
  const custodyByBranch = new Map<number, { branchName: string; quantityUsd: Decimal; carryingIqd: Decimal }>();
  for (const row of custodyRows) {
    if (row.branchId == null) throw new Error(`حركة الحيازة ${row.txnNumber} بلا فرع`);
    const quantity = money(row.usdAmount);
    const carrying = money(row.iqdAmount);
    if (quantity.lte(0) || carrying.lte(0)) {
      throw new Error(`حركة الحيازة ${row.txnNumber} بلا كمية/قيمة دفترية authoritative`);
    }
    const branchId = Number(row.branchId);
    const current = custodyByBranch.get(branchId) ?? {
      branchName: row.branchName ?? `فرع ${branchId}`,
      quantityUsd: new Decimal(0),
      carryingIqd: new Decimal(0),
    };
    const sign = row.type === "DEPOSIT" ? -1 : 1;
    current.quantityUsd = current.quantityUsd.plus(quantity.times(sign));
    current.carryingIqd = current.carryingIqd.plus(carrying.times(sign));
    custodyByBranch.set(branchId, current);
  }
  const physicalUsdByBranch = Array.from(custodyByBranch.entries())
    .map(([branchId, value]) => {
      if (value.quantityUsd.isNegative() || value.carryingIqd.isNegative()) {
        throw new Error(`حيازة الدولار سالبة في الفرع ${value.branchName}`);
      }
      if (value.quantityUsd.isZero() !== value.carryingIqd.isZero()) {
        throw new Error(`كمية وقيمة حيازة الدولار غير متطابقتين في الفرع ${value.branchName}`);
      }
      return {
        branchId,
        branchName: value.branchName,
        quantityUsd: toDbMoney(value.quantityUsd),
        carryingIqd: toDbMoney(value.carryingIqd),
        wavgRate: value.quantityUsd.isZero() ? "0.0000" : value.carryingIqd.div(value.quantityUsd).toDecimalPlaces(4).toFixed(4),
      };
    })
    .sort((a, b) => a.branchId - b.branchId);

  let totalDepositIqd = new Decimal(0);
  let totalWithdrawIqd = new Decimal(0);
  let totalDepositUsd = new Decimal(0);
  let totalWithdrawUsd = new Decimal(0);
  let totalSettledIqd = new Decimal(0);
  let totalFeesIqd = new Decimal(0);
  let totalFxDiff = new Decimal(0);
  let totalUsdBought = new Decimal(0);
  for (const t of txns) {
    // السجل يعرض الطلبات المعلّقة والمعكوسة للتدقيق، لكن الإجماليات تمثّل الحركة
    // النافذة وحدها. PENDING_APPROVAL لا يرفع رصيد الصيرفة ولا يخرج نقداً بعد.
    if (t.status !== "ACTIVE") continue;
    // iqdAmount on direct USD custody is its auditable IQD carrying value, not
    // an IQD wallet movement; currency keeps the two statement totals isolated.
    if (t.type === "DEPOSIT") {
      if (t.currency === "USD") totalDepositUsd = totalDepositUsd.plus(money(t.usdAmount));
      else totalDepositIqd = totalDepositIqd.plus(money(t.iqdAmount));
    }
    if (t.type === "WITHDRAW") {
      if (t.currency === "USD") totalWithdrawUsd = totalWithdrawUsd.plus(money(t.usdAmount));
      else totalWithdrawIqd = totalWithdrawIqd.plus(money(t.iqdAmount));
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
      balanceUsdCarryingIqd: house.balanceUsdCarryingIqd,
      usdCostRate: house.usdCostRate,
    },
    transactions: rows.map(({ txn: t, createdByName, supplierName, branchName, voucherNumber }) => ({
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
      supplierName: supplierName ?? null,
      purchaseOrderId: t.purchaseOrderId ? Number(t.purchaseOrderId) : null,
      settledUsd: t.settledUsd,
      settledIqd: t.settledIqd,
      balanceIqdAfter: t.balanceIqdAfter,
      balanceUsdAfter: t.balanceUsdAfter,
      status: t.status,
      notes: t.notes,
      createdAt: t.createdAt instanceof Date ? t.createdAt.toISOString() : String(t.createdAt),
      createdByName: createdByName ?? null,
      branchName: branchName ?? null,
      voucherNumber: voucherNumber ?? null,
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
      currentControlCarryingIqd: house.balanceUsdCarryingIqd,
      iqdControlReceivableIqd: toDbMoney(Decimal.max(0, money(house.balanceIqd))),
      iqdControlPayableIqd: toDbMoney(Decimal.max(0, money(house.balanceIqd).negated())),
      usdControlReceivableIqd: toDbMoney(Decimal.max(0, money(house.balanceUsdCarryingIqd))),
      usdControlPayableIqd: toDbMoney(Decimal.max(0, money(house.balanceUsdCarryingIqd).negated())),
    },
    physicalUsdByBranch,
  };
}
