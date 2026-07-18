// عكس عملية صيرفة خاطئة (تدقيق ١٧/٧): يعلّم العملية REVERSED، يعكس أثرها المحاسبيّ والخزينيّ وذمّة
// المورّد، ثم **يُعيد اشتقاق أرصدة المحفظة ومتوسط الكلفة WAVG من سجلّ العمليات النشطة** (الطريقة
// الوحيدة الصحيحة لأن WAVG يعتمد على المسار). بفصل مهام (مُنشئ ≠ مُنفِّذ العكس، admin مُستثنى).
import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { and, asc, eq, sql } from "drizzle-orm";
import { accountingEntries, exchangeHouses, exchangeTransactions, receipts } from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { adjustSupplierBalance, postEntry } from "../ledgerService";
import { money, round2, toDbMoney } from "../money";
import { withTx, type Actor } from "../tx";
import { lockHouse, toDbRate } from "./helpers";

/**
 * يُعيد اشتقاق (balanceIqd, balanceUsd, usdCostRate) للمحفظة من كل عملياتها **النشطة** بالترتيب —
 * يعكس اشتقاق العمليات الأصلية تماماً (الاقتناء يرفع WAVG، الصرف يُنقص الرصيد بالكلفة الجارية بلا
 * تغيير المعدّل). مصدرُ حقيقةٍ واحد ⇒ بلا منطق عكسٍ لكل نوع على حدة.
 */
export async function recomputeHouseFromLog(tx: Tx, houseId: number): Promise<void> {
  const txns = await tx
    .select()
    .from(exchangeTransactions)
    .where(and(eq(exchangeTransactions.exchangeHouseId, houseId), eq(exchangeTransactions.status, "ACTIVE")))
    .orderBy(asc(exchangeTransactions.createdAt), asc(exchangeTransactions.id));

  let iqd = new Decimal(0);
  let usd = new Decimal(0);
  let basis = new Decimal(0); // كلفة الدولار المملوك بالدينار (basis/usd = WAVG)
  const disposeUsd = (amt: Decimal) => {
    const r = usd.isZero() ? new Decimal(0) : basis.div(usd);
    basis = basis.minus(amt.times(r));
    usd = usd.minus(amt);
  };
  for (const t of txns) {
    const iqdAmt = money(t.iqdAmount);
    const usdAmt = money(t.usdAmount);
    const rate = money(t.exchangeRate);
    const comm = money(t.commission);
    const commIqd = money(t.commissionIqd);
    switch (t.type) {
      case "OPENING":
        iqd = iqd.plus(iqdAmt);
        if (usdAmt.gt(0)) {
          basis = basis.plus(usdAmt.times(rate));
          usd = usd.plus(usdAmt);
        }
        break;
      case "DEPOSIT":
        if (t.currency === "USD") {
          basis = basis.plus(usdAmt.times(rate));
          usd = usd.plus(usdAmt);
        } else iqd = iqd.plus(iqdAmt);
        break;
      case "WITHDRAW":
        if (t.currency === "USD") disposeUsd(usdAmt);
        else iqd = iqd.minus(iqdAmt);
        break;
      case "FX_BUY":
        iqd = iqd.minus(iqdAmt);
        basis = basis.plus(iqdAmt); // كلفة الدولار المُشترى = الدينار المنفَق
        usd = usd.plus(usdAmt);
        break;
      case "SETTLE":
        if (t.currency === "USD") disposeUsd(usdAmt.plus(comm)); // مبدأ + عمولة بالدولار
        else iqd = iqd.minus(iqdAmt.plus(commIqd)); // مبدأ + عمولة بالدينار
        break;
    }
  }
  const finalRate = usd.isZero() ? new Decimal(0) : basis.div(usd);
  await tx
    .update(exchangeHouses)
    .set({
      balanceIqd: toDbMoney(round2(iqd)),
      balanceUsd: toDbMoney(round2(usd)),
      usdCostRate: toDbRate(finalRate),
    })
    .where(eq(exchangeHouses.id, houseId));
}

export async function reverseExchangeTransaction(
  txnId: number,
  actor: Actor,
): Promise<{ txnId: number; txnNumber: string; status: "REVERSED" }> {
  return withTx(async (tx) => {
    const [txn] = await tx.select().from(exchangeTransactions).where(eq(exchangeTransactions.id, txnId)).for("update").limit(1);
    if (!txn) throw new TRPCError({ code: "NOT_FOUND", message: "عملية الصيرفة غير موجودة" });
    if (txn.status === "REVERSED") throw new TRPCError({ code: "BAD_REQUEST", message: "العملية معكوسة سابقاً" });
    if (txn.type === "OPENING") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا يُعكَس الرصيد الافتتاحي — عدّله بعمليةٍ صريحة" });
    }
    // فصل المهام (تدقيق ١٧/٧): مُنفِّذ العكس ≠ مُنشئ العملية (admin مُستثنى للتصحيح الإداري).
    if (actor.role !== "admin" && txn.createdBy != null && Number(txn.createdBy) === actor.userId) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "لا يجوز عكس عمليةٍ أنشأتها بنفسك — يلزم شخصٌ آخر (فصل المهام).",
      });
    }
    const houseId = Number(txn.exchangeHouseId);
    await lockHouse(tx, houseId); // قفل المحفظة قبل أيّ تعديل رصيد

    // ١) علّم العملية REVERSED (recompute أدناه يعتمد الحالة النشطة فيستثنيها).
    await tx.update(exchangeTransactions).set({ status: "REVERSED" }).where(eq(exchangeTransactions.id, txnId));

    // ٢) استعادة ذمّة المورد لتسديدٍ عكسناه (كان أطفأ settledIqd = iqdAmount).
    if (txn.type === "SETTLE" && txn.supplierId != null) {
      await adjustSupplierBalance(tx, Number(txn.supplierId), money(txn.iqdAmount));
    }

    // ٣) عكس الإيصال الخزينيّ (إيداع/سحب دينار): إيصالٌ تعويضيّ معاكس (shiftId=null ⇒ لا يمسّ درجاً).
    if (txn.receiptId != null) {
      const [orig] = await tx.select().from(receipts).where(eq(receipts.id, Number(txn.receiptId))).for("update").limit(1);
      if (orig && orig.status === "COMPLETED") {
        await tx.insert(receipts).values({
          branchId: orig.branchId,
          shiftId: null,
          cashBucket: "TREASURY",
          direction: orig.direction === "OUT" ? "IN" : "OUT",
          amount: orig.amount,
          paymentMethod: "CASH",
          status: "COMPLETED",
          partyType: "OTHER",
          referenceNumber: `REV-EX-${txn.txnNumber}`,
          description: `عكس عملية صيرفة ${txn.txnNumber}`,
          createdBy: actor.userId,
        });
      }
    }

    // ٤) عكس قيود الدفتر: كل قيود هذه العملية مفاتيحها تنتهي بـ:<txnNumber> ⇒ نُرحّل قيداً معاكساً
    // لكلٍّ (بكل الحقول منفيّة الإشارة) بتاريخ اليوم (لا يمسّ فترةً مقفَلة). مفتاح فريد يمنع الازدواج.
    const entries = await tx
      .select()
      .from(accountingEntries)
      .where(and(eq(accountingEntries.exchangeHouseId, houseId), sql`${accountingEntries.dedupeKey} LIKE ${`%:${txn.txnNumber}`}`));
    for (const e of entries) {
      await postEntry(tx, {
        entryType: e.entryType as never,
        branchId: e.branchId != null ? Number(e.branchId) : null,
        exchangeHouseId: houseId,
        supplierId: e.supplierId != null ? Number(e.supplierId) : null,
        amount: money(e.amount).negated(),
        cost: money(e.cost).negated(),
        profit: money(e.profit).negated(),
        revenue: money(e.revenue).negated(),
        entryDate: new Date(),
        dedupeKey: `EXREV:${e.dedupeKey}`,
        notes: `عكس — ${e.notes ?? txn.txnNumber}`,
      });
    }

    // ٥) إعادة اشتقاق أرصدة المحفظة وWAVG من العمليات النشطة (بعد استثناء المعكوسة).
    await recomputeHouseFromLog(tx, houseId);

    return { txnId, txnNumber: txn.txnNumber, status: "REVERSED" as const };
  });
}
