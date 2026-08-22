// اعتماد إيداع الدولار المباشر المعلّق (SOD، تدقيق ٢٥/٧) — المعتمِد ≠ المُنشئ (admin مُستثنى).
// قبل الاعتماد لا أثر إطلاقاً (deposit.ts يُنشئ العملية PENDING_APPROVAL بلا رفع رصيد/WAVG/قيد،
// وrecomputeHouseFromLog يرشّح ACTIVE فيستثنيها). عند الاعتماد يُطبَّق الأثر كاملاً تحت قفل المحفظة:
// تتحقق الحيازة المادية المشتقة، ثم تخرجها بـWAVG إلى control الصيرفة وتُرحّل القيد، ثم تُعلَّم ACTIVE.
// لا يُقبل سعر الطلب الحر كمصدر كلفة ولا يُنشأ دولار من العدم.
import { TRPCError } from "@trpc/server";
import { and, asc, eq } from "drizzle-orm";
import { exchangeHouses, exchangeTransactions } from "../../../drizzle/schema";
import { postEntry } from "../ledgerService";
import { createPostingIntent, creditLine, debitLine } from "../accounting/postingEngine";
import { money, toDbMoney } from "../money";
import { requireDb, withTx, type Actor } from "../tx";
import { lockBranchMonthCloseGate } from "../reports/monthCloseGate";
import { lockHouse, toDbRate } from "./helpers";
import { allocateCarryingIqd, calculateSignedUsdMovement, deriveForeignCashUsdPosition, persistSignedUsdControl } from "./reverse";
import { postExchangeControlReclassification } from "./controlClassification";

/** إيداعات الدولار المعلّقة (بانتظار اعتماد ثانٍ) — طابور الاعتماد للراوتر/الواجهة. */
export async function listPendingExchangeDeposits(exchangeHouseId?: number, restrictBranchId?: number | null) {
  const db = requireDb();
  const conds = [
    eq(exchangeTransactions.status, "PENDING_APPROVAL"),
    eq(exchangeTransactions.type, "DEPOSIT"),
    eq(exchangeTransactions.currency, "USD"),
  ];
  if (exchangeHouseId != null) conds.push(eq(exchangeTransactions.exchangeHouseId, exchangeHouseId));
  // عزل مدير الفرع (قرار المالك ١٢/٨): يُمرَّر فرع المدير فيرى طابور فرعه فقط؛ المالك/الأدمن null = كلّ الفروع.
  if (restrictBranchId != null) conds.push(eq(exchangeTransactions.branchId, restrictBranchId));
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
    const [preview] = await tx
      .select({
        exchangeHouseId: exchangeTransactions.exchangeHouseId,
        branchId: exchangeTransactions.branchId,
      })
      .from(exchangeTransactions)
      .where(eq(exchangeTransactions.id, txnId))
      .limit(1);
    if (!preview) throw new TRPCError({ code: "NOT_FOUND", message: "عملية الصيرفة غير موجودة" });
    if (preview.branchId == null) {
      throw new TRPCError({ code: "CONFLICT", message: "إيداع الدولار المعلّق بلا فرع حيازة موثّق" });
    }
    const branchId = Number(preview.branchId);
    // ترتيب الأقفال الثابت لكل writers/reversal: branch → house → transaction rows.
    await lockBranchMonthCloseGate(tx, branchId);
    const houseId = Number(preview.exchangeHouseId);
    const house = await lockHouse(tx, houseId);
    const [txn] = await tx
      .select()
      .from(exchangeTransactions)
      .where(eq(exchangeTransactions.id, txnId))
      .for("update")
      .limit(1);
    if (!txn) throw new TRPCError({ code: "NOT_FOUND", message: "عملية الصيرفة غير موجودة" });
    if (Number(txn.exchangeHouseId) !== houseId || Number(txn.branchId) !== branchId) {
      throw new TRPCError({ code: "CONFLICT", message: "تغيّرت أطراف إيداع الدولار أثناء الاعتماد — أعد المحاولة" });
    }
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
    // عزل مدير الفرع (قرار المالك ١٢/٨): المالك/الأدمن فقط يعبُران؛ المدير لا يعتمد إيداع فرعٍ آخر.
    if (actor.role !== "admin" && txn.branchId != null && Number(txn.branchId) !== Number(actor.branchId)) {
      throw new TRPCError({ code: "FORBIDDEN", message: "عملية الصيرفة تخصّ فرعاً آخر" });
    }

    const amount = money(txn.usdAmount);
    const custody = await deriveForeignCashUsdPosition(tx, houseId, branchId);
    if (amount.gt(custody.quantityUsd)) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: `الإيداع يتجاوز حيازة الدولار الفعلية (${custody.quantityUsd.toFixed(2)}$ متاح مقابل ${amount.toFixed(2)}$ مطلوب)`,
      });
    }
    if (custody.wavgRate.lte(0)) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "لا توجد حيازة دولار فعلية بكلفة دفترية معلومة" });
    }
    const carryingIqd = allocateCarryingIqd(custody.carryingIqd, amount, custody.quantityUsd);

    // الإيداع يخرج دولاراً مادياً ويزيد control الصيرفة؛ كل جانب يحتفظ بكلفته المستقلة عند عبور الصفر.
    const oldUsd = money(house.balanceUsd);
    const oldCarrying = money(house.balanceUsdCarryingIqd);
    const movement = calculateSignedUsdMovement(oldUsd, oldCarrying, amount, carryingIqd);

    await persistSignedUsdControl(tx, houseId, movement);
    await tx
      .update(exchangeTransactions)
      .set({
        status: "ACTIVE",
        iqdAmount: toDbMoney(carryingIqd),
        exchangeRate: toDbRate(custody.wavgRate),
        fxDiff: toDbMoney(movement.fxGainIqd),
        balanceUsdAfter: toDbMoney(movement.balanceUsd),
      })
      .where(eq(exchangeTransactions.id, txnId));

    await postEntry(tx, {
      entryType: "EXCHANGE_DEPOSIT",
      branchId: txn.branchId != null ? Number(txn.branchId) : null,
      createdBy: actor.userId,
      exchangeHouseId: houseId,
      amount: carryingIqd,
      dedupeKey: `EXDEP:${txn.txnNumber}`,
      notes: txn.notes ?? "إيداع دولار مباشر (معتمَد)",
      postingIntent: createPostingIntent(
        "EXCHANGE_DEPOSIT_USD_CASH",
        "EXCHANGE_DEPOSIT",
        [debitLine("EXCHANGE_WALLET_USD", carryingIqd), creditLine("FOREIGN_CASH_USD", carryingIqd)],
      ),
      postingSourceComponents: {
        roleDebits: { EXCHANGE_WALLET_USD: carryingIqd },
        roleCredits: { FOREIGN_CASH_USD: carryingIqd },
      },
    });

    if (!movement.fxGainIqd.isZero()) {
      const fxAmount = movement.fxGainIqd.abs();
      const fxComponents = movement.fxGainIqd.isPositive()
        ? { roleDebits: { EXCHANGE_WALLET_USD: fxAmount }, roleCredits: { FX_GAIN: fxAmount } }
        : { roleDebits: { FX_LOSS: fxAmount }, roleCredits: { EXCHANGE_WALLET_USD: fxAmount } };
      await postEntry(tx, {
        entryType: "EXCHANGE_FX_DIFF",
        branchId: txn.branchId != null ? Number(txn.branchId) : null,
        createdBy: actor.userId,
        exchangeHouseId: houseId,
        amount: movement.fxGainIqd,
        dedupeKey: `EXDEP:FX:${txn.txnNumber}`,
        notes: "فرق كلفة عند إيداع دولار فعلي",
        postingSourceComponents: fxComponents,
        postingIntent: movement.fxGainIqd.isPositive()
          ? createPostingIntent("EXCHANGE_FX_GAIN", "EXCHANGE_FX_DIFF", [debitLine("EXCHANGE_WALLET_USD", fxAmount), creditLine("FX_GAIN", fxAmount)], fxComponents)
          : createPostingIntent("EXCHANGE_FX_LOSS", "EXCHANGE_FX_DIFF", [debitLine("FX_LOSS", fxAmount), creditLine("EXCHANGE_WALLET_USD", fxAmount)], fxComponents),
      });
    }

    await postExchangeControlReclassification(tx, {
      exchangeHouseId: houseId,
      currency: "USD",
      beforeSignedIqd: oldCarrying,
      afterSignedIqd: movement.balanceCarryingIqd,
      sourceKey: txn.txnNumber,
      notes: `تصنيف ذمة الصيرفة لإيداع الدولار ${txn.txnNumber}`,
      createdBy: actor.userId,
    });

    return { txnId, txnNumber: txn.txnNumber, status: "ACTIVE" as const };
  });
}
