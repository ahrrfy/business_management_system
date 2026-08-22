// عكس عملية صيرفة خاطئة (تدقيق ١٧/٧): يعلّم العملية REVERSED، يعكس أثرها المحاسبيّ والخزينيّ وذمّة
// المورّد، ثم **يُعيد اشتقاق أرصدة المحفظة ومتوسط الكلفة WAVG من سجلّ العمليات النشطة** (الطريقة
// الوحيدة الصحيحة لأن WAVG يعتمد على المسار). بفصل مهام (مُنشئ ≠ مُنفِّذ العكس، admin مُستثنى).
import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import { accountingEntries, exchangeHouses, exchangeTransactions, purchaseOrders, receipts, suppliers } from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { adjustSupplierBalance, adjustSupplierBalanceUsd, postEntry } from "../ledgerService";
import {
  createPostingIntent,
  signedPostingLines,
  type AccountRole,
  type PostingIntent,
  type PostingSourceComponents,
} from "../accounting/postingEngine";
import { money, round2, toDbMoney, type DecimalInput } from "../money";
import { withTx, type Actor } from "../tx";
import { assertCashOutAvailable, assertNonPhysicalOutReceipt, assertTreasuryOutException, lockCashSourceForUpdate } from "../cash/cashAvailability";
import { lockBranchMonthCloseGate } from "../reports/monthCloseGate";
import { lockHouse, toDbRate } from "./helpers";
import { postExchangeControlReclassification } from "./controlClassification";

function signedSourceComponents(
  debitRole: AccountRole,
  creditRole: AccountRole,
  signedAmount: DecimalInput,
): PostingSourceComponents {
  const amount = round2(signedAmount);
  return amount.isPositive()
    ? { roleDebits: { [debitRole]: amount }, roleCredits: { [creditRole]: amount } }
    : { roleDebits: { [creditRole]: amount.abs() }, roleCredits: { [debitRole]: amount.abs() } };
}

export interface ForeignCashUsdPosition {
  quantityUsd: Decimal;
  carryingIqd: Decimal;
  wavgRate: Decimal;
}

export interface SignedUsdMovement {
  balanceUsd: Decimal;
  balanceCarryingIqd: Decimal;
  usdCostRate: Decimal;
  walletDeltaIqd: Decimal;
  fxGainIqd: Decimal;
}

/** Persist quantity, authoritative carrying and display WAVG in one CHECK-safe statement. */
export async function persistSignedUsdControl(
  tx: Tx,
  houseId: number,
  movement: Pick<SignedUsdMovement, "balanceUsd" | "balanceCarryingIqd" | "usdCostRate">,
): Promise<void> {
  await tx.update(exchangeHouses).set({
    balanceUsd: toDbMoney(movement.balanceUsd),
    balanceUsdCarryingIqd: toDbMoney(movement.balanceCarryingIqd),
    usdCostRate: toDbRate(movement.usdCostRate),
  }).where(eq(exchangeHouses.id, houseId));
}

function assertSignedUsdControl(balance: Decimal, carrying: Decimal, context: string): void {
  if (balance.isZero() !== carrying.isZero()) {
    throw new TRPCError({
      code: "CONFLICT",
      message: `${context}: كمية الدولار وقيمتها الدفترية لا تُصفّران معاً`,
    });
  }
  if (!balance.isZero() && balance.isPositive() !== carrying.isPositive()) {
    throw new TRPCError({
      code: "CONFLICT",
      message: `${context}: إشارة قيمة الدولار الدفترية لا تطابق إشارة الكمية`,
    });
  }
}

/** Allocate an authoritative cent carrying value without going through the 4-decimal display WAVG. */
export function allocateCarryingIqd(
  totalCarryingInput: DecimalInput,
  quantityInput: DecimalInput,
  totalQuantityInput: DecimalInput,
): Decimal {
  const totalCarrying = round2(totalCarryingInput);
  const quantity = money(quantityInput);
  const totalQuantity = money(totalQuantityInput);
  if (totalCarrying.lte(0) || quantity.lte(0) || totalQuantity.lte(0) || quantity.gt(totalQuantity)) {
    throw new TRPCError({ code: "CONFLICT", message: "تعذر توزيع القيمة الدفترية للدولار على كمية غير صالحة" });
  }
  return quantity.eq(totalQuantity)
    ? totalCarrying
    : round2(totalCarrying.times(quantity).div(totalQuantity));
}

/**
 * Move the signed house USD control without mixing its receivable/liability basis
 * with the separately-derived physical USD asset.  A crossing closes the old
 * side at its own carrying rate and opens the other side at the movement rate.
 */
export function calculateSignedUsdMovement(
  oldBalanceInput: DecimalInput,
  oldSignedCarryingInput: DecimalInput,
  deltaUsdInput: DecimalInput,
  movementCarryingInput: DecimalInput,
): SignedUsdMovement {
  const oldBalance = money(oldBalanceInput);
  const oldSignedCarrying = round2(oldSignedCarryingInput);
  const deltaUsd = money(deltaUsdInput);
  const movementCarrying = round2(movementCarryingInput);
  if (deltaUsd.isZero() || movementCarrying.lte(0)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "حركة الدولار وقيمتها الدفترية يجب أن تكونا موجبتين" });
  }
  assertSignedUsdControl(oldBalance, oldSignedCarrying, "رصيد الصيرفة الدولاري قبل الحركة");

  const sameSide = oldBalance.isZero() || oldBalance.isPositive() === deltaUsd.isPositive();
  let walletDeltaMagnitude: Decimal;
  if (sameSide) {
    walletDeltaMagnitude = movementCarrying;
  } else {
    const closeQty = Decimal.min(oldBalance.abs(), deltaUsd.abs());
    const remainderQty = deltaUsd.abs().minus(closeQty);
    const closeBasis = allocateCarryingIqd(oldSignedCarrying.abs(), closeQty, oldBalance.abs());
    const remainderBasis = remainderQty.isZero()
      ? new Decimal(0)
      : allocateCarryingIqd(movementCarrying, remainderQty, deltaUsd.abs());
    walletDeltaMagnitude = closeBasis.plus(remainderBasis);
  }
  const walletDeltaIqd = round2(walletDeltaMagnitude).times(deltaUsd.isNegative() ? -1 : 1);
  const balanceUsd = round2(oldBalance.plus(deltaUsd));
  const newSignedBasis = round2(oldSignedCarrying.plus(walletDeltaIqd));
  assertSignedUsdControl(balanceUsd, newSignedBasis, "رصيد الصيرفة الدولاري بعد الحركة");
  const usdCostRate = balanceUsd.isZero() ? new Decimal(0) : newSignedBasis.abs().div(balanceUsd.abs());
  const mainWalletDelta = movementCarrying.times(deltaUsd.isNegative() ? -1 : 1);
  return {
    balanceUsd,
    balanceCarryingIqd: newSignedBasis,
    usdCostRate,
    walletDeltaIqd,
    fxGainIqd: round2(walletDeltaIqd.minus(mainWalletDelta)),
  };
}

/** Physical USD is an operationally-derived asset; signed house USD remains a separate control balance. */
export async function deriveForeignCashUsdPosition(
  tx: Tx,
  houseId: number,
  branchId: number,
  excludeTxnId?: number,
): Promise<ForeignCashUsdPosition> {
  const txns = await tx
    .select()
    .from(exchangeTransactions)
    .where(and(
      eq(exchangeTransactions.exchangeHouseId, houseId),
      eq(exchangeTransactions.branchId, branchId),
      eq(exchangeTransactions.status, "ACTIVE"),
    ))
    .orderBy(asc(exchangeTransactions.createdAt), asc(exchangeTransactions.id))
    .for("update");
  let quantityUsd = new Decimal(0);
  let carryingIqd = new Decimal(0);
  for (const txn of txns) {
    if (excludeTxnId != null && Number(txn.id) === excludeTxnId) continue;
    if (txn.currency !== "USD" || !["FX_BUY", "WITHDRAW", "DEPOSIT"].includes(txn.type)) continue;
    const quantity = money(txn.usdAmount);
    const carrying = round2(txn.iqdAmount);
    if (quantity.lte(0) || carrying.lte(0)) {
      throw new TRPCError({ code: "CONFLICT", message: `عملية ${txn.txnNumber} لا تحمل كمية/قيمة دفترية صالحة لحيازة الدولار` });
    }
    const isInflow = txn.type === "FX_BUY" || txn.type === "WITHDRAW";
    if (isInflow) {
      quantityUsd = quantityUsd.plus(quantity);
      carryingIqd = carryingIqd.plus(carrying);
    } else {
      quantityUsd = quantityUsd.minus(quantity);
      carryingIqd = carryingIqd.minus(carrying);
    }
  }
  quantityUsd = round2(quantityUsd);
  carryingIqd = round2(carryingIqd);
  if (quantityUsd.isNegative() || carryingIqd.isNegative()) {
    throw new TRPCError({ code: "CONFLICT", message: "حيازة الدولار الفعلية سالبة" });
  }
  if (quantityUsd.isZero() !== carryingIqd.isZero()) {
    throw new TRPCError({ code: "CONFLICT", message: "حيازة الدولار صفر لكن قيمتها الدفترية غير صفر (أو العكس)" });
  }
  return {
    quantityUsd,
    carryingIqd,
    wavgRate: quantityUsd.isZero() ? new Decimal(0) : carryingIqd.div(quantityUsd),
  };
}

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
    .orderBy(asc(exchangeTransactions.createdAt), asc(exchangeTransactions.id))
    // Current locking read: reverse starts with a nonlocking preview before waiting on the
    // house mutex. A snapshot read here could miss a settlement that committed while we
    // waited and overwrite its wallet effect during recomputation.
    .for("update");

  let iqd = new Decimal(0);
  let usd = new Decimal(0);
  let usdCarrying = new Decimal(0);
  for (const t of txns) {
    const iqdAmt = money(t.iqdAmount);
    const usdAmt = money(t.usdAmount);
    const rate = money(t.exchangeRate);
    const comm = money(t.commission);
    const commIqd = money(t.commissionIqd);
    switch (t.type) {
      case "OPENING":
        iqd = iqd.plus(iqdAmt);
        if (!usdAmt.isZero()) {
          usd = usd.plus(usdAmt);
          usdCarrying = usdCarrying.plus(round2(usdAmt.times(rate)));
        }
        break;
      case "DEPOSIT":
        if (t.currency === "USD") {
          if (iqdAmt.lte(0)) throw new TRPCError({ code: "CONFLICT", message: `الإيداع ${t.txnNumber} بلا قيمة دفترية authoritative` });
          usd = usd.plus(usdAmt);
          usdCarrying = usdCarrying.plus(iqdAmt).plus(round2(t.fxDiff));
        } else iqd = iqd.plus(iqdAmt);
        break;
      case "WITHDRAW":
        if (t.currency === "USD") {
          if (iqdAmt.lte(0)) throw new TRPCError({ code: "CONFLICT", message: `السحب ${t.txnNumber} بلا قيمة دفترية authoritative` });
          usd = usd.minus(usdAmt);
          usdCarrying = usdCarrying.minus(iqdAmt).plus(round2(t.fxDiff));
        }
        else iqd = iqd.minus(iqdAmt);
        break;
      case "FX_BUY":
        // نموذج الدَّين (قرار مالك ٣/٨): الصيرفة تُسلِّم الدولار فوراً نقداً ⇒ لا يُمسّ الدينار إطلاقاً؛
        // يتعمّق الدَّين الدولاري (usd سالب أكثر) بمتوسط كلفةٍ يشمل سعر نشوء هذا الدَّين تحديداً.
        usd = usd.minus(usdAmt);
        usdCarrying = usdCarrying.minus(iqdAmt).plus(round2(t.fxDiff));
        break;
      case "SETTLE":
        if (t.currency === "USD") {
          usd = usd.minus(usdAmt).minus(comm);
          usdCarrying = usdCarrying.minus(iqdAmt).minus(commIqd).plus(round2(t.fxDiff));
        }
        else iqd = iqd.minus(iqdAmt.plus(commIqd)); // مبدأ + عمولة بالدينار
        break;
    }
  }
  usd = round2(usd);
  usdCarrying = round2(usdCarrying);
  assertSignedUsdControl(usd, usdCarrying, "إعادة بناء رصيد الصيرفة الدولاري");
  await tx
    .update(exchangeHouses)
    .set({
      balanceIqd: toDbMoney(round2(iqd)),
      balanceUsd: toDbMoney(round2(usd)),
      balanceUsdCarryingIqd: toDbMoney(round2(usdCarrying)),
      usdCostRate: toDbRate(usd.isZero() ? new Decimal(0) : usdCarrying.abs().div(usd.abs())),
    })
    .where(eq(exchangeHouses.id, houseId));
}

export async function reverseExchangeTransaction(
  txnId: number,
  actor: Actor,
): Promise<{ txnId: number; txnNumber: string; status: "REVERSED" }> {
  return withTx(async (tx) => {
    const [previewTxn] = await tx
      .select({
        receiptId: exchangeTransactions.receiptId,
        type: exchangeTransactions.type,
        supplierId: exchangeTransactions.supplierId,
        purchaseOrderId: exchangeTransactions.purchaseOrderId,
        exchangeHouseId: exchangeTransactions.exchangeHouseId,
        branchId: exchangeTransactions.branchId,
      })
      .from(exchangeTransactions)
      .where(eq(exchangeTransactions.id, txnId))
      .limit(1);
    if (previewTxn?.branchId != null) {
      await lockBranchMonthCloseGate(tx, Number(previewTxn.branchId));
    }
    let previewCashReceipt: { id: number; branchId: number } | null = null;
    if (previewTxn?.receiptId != null) {
      const [previewReceipt] = await tx
        .select({ id: receipts.id, branchId: receipts.branchId, paymentMethod: receipts.paymentMethod })
        .from(receipts)
        .where(eq(receipts.id, Number(previewTxn.receiptId)))
        .limit(1);
      if (previewReceipt?.paymentMethod === "CASH" && previewReceipt.branchId != null) {
        previewCashReceipt = { id: Number(previewReceipt.id), branchId: Number(previewReceipt.branchId) };
        await lockCashSourceForUpdate(tx, {
          branchId: previewCashReceipt.branchId,
          cashBucket: "TREASURY",
        });
      }
    }
    // تسوية جديدة تقفل branch→supplier→PO→house. العكس يجب أن يتبع الترتيب نفسه؛ قفل txn/house
    // أولاً ثم العودة إلى المورد يصنع دورةً مع تسوية متزامنة. المعاينة تحدد الحسابات بلا قفل،
    // ثم نعيد مطابقة الهويات بعد قفل العملية نفسها.
    if (previewTxn?.type === "SETTLE" && previewTxn.supplierId != null) {
      const [supplier] = await tx
        .select({ id: suppliers.id })
        .from(suppliers)
        .where(eq(suppliers.id, Number(previewTxn.supplierId)))
        .for("update")
        .limit(1);
      if (!supplier) throw new TRPCError({ code: "CONFLICT", message: "مورد التسوية غير موجود" });
      if (previewTxn.purchaseOrderId != null) {
        const [po] = await tx
          .select({ id: purchaseOrders.id })
          .from(purchaseOrders)
          .where(eq(purchaseOrders.id, Number(previewTxn.purchaseOrderId)))
          .for("update")
          .limit(1);
        if (!po) throw new TRPCError({ code: "CONFLICT", message: "فاتورة تسوية الصيرفة غير موجودة" });
      }
    }
    const lockedHouse = previewTxn ? await lockHouse(tx, Number(previewTxn.exchangeHouseId)) : null;
    const [txn] = await tx.select().from(exchangeTransactions).where(eq(exchangeTransactions.id, txnId)).for("update").limit(1);
    if (!txn) throw new TRPCError({ code: "NOT_FOUND", message: "عملية الصيرفة غير موجودة" });
    if (txn.status === "REVERSED") throw new TRPCError({ code: "BAD_REQUEST", message: "العملية معكوسة سابقاً" });
    if (previewCashReceipt && Number(txn.receiptId) !== previewCashReceipt.id) {
      throw new TRPCError({ code: "CONFLICT", message: "تغيّر إيصال عملية الصيرفة أثناء العكس — أعد المحاولة" });
    }
    if (
      !previewTxn ||
      txn.type !== previewTxn.type ||
      Number(txn.exchangeHouseId) !== Number(previewTxn.exchangeHouseId) ||
      Number(txn.supplierId ?? 0) !== Number(previewTxn.supplierId ?? 0) ||
      Number(txn.purchaseOrderId ?? 0) !== Number(previewTxn.purchaseOrderId ?? 0) ||
      Number(txn.branchId ?? 0) !== Number(previewTxn.branchId ?? 0)
    ) {
      throw new TRPCError({ code: "CONFLICT", message: "تغيّرت أطراف عملية الصيرفة أثناء العكس — أعد المحاولة" });
    }
    // عزل مدير الفرع (قرار المالك ١٢/٨): المالك/الأدمن فقط يعبُران (owner مُطبَّع ⇒ admin)؛ المدير لا يعكس عملية فرعٍ آخر.
    if (actor.role !== "admin" && txn.branchId != null && Number(txn.branchId) !== Number(actor.branchId)) {
      throw new TRPCError({ code: "FORBIDDEN", message: "عملية الصيرفة تخصّ فرعاً آخر" });
    }
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
    if (!lockedHouse) throw new TRPCError({ code: "CONFLICT", message: "تعذر قفل حساب الصيرفة للعكس" });
    const controlBeforeIqd = txn.currency === "USD"
      ? money(lockedHouse.balanceUsdCarryingIqd)
      : money(lockedHouse.balanceIqd);

    // حارس اتساق فرق الصرف (تدقيق ٢٥/٧): عكس اقتناءِ دولارٍ (FX_BUY أو DEPOSIT-USD) استهلكته عمليةٌ
    // لاحقة (تسوية/سحب دولار) يترك فرق الصرف المحقَّق لتلك العملية محسوباً على متوسط كلفةٍ بطَل بعد
    // إعادة الاشتقاق (recompute يصحّح الأرصدة لا القيود المُرحَّلة سابقاً) ⇒ انحراف P&L صامت دائم.
    // نمنعه: تُعكَس العمليات اللاحقة المستهلِكة للدولار أوّلاً (id تصاعديّ = ترتيب الإدراج، لا الساعة).
    if (txn.currency === "USD") {
      const laterSensitiveTypes = ["DEPOSIT", "SETTLE", "WITHDRAW", "FX_BUY"] as const;
      const [laterDisposal] = await tx
        .select({ txnNumber: exchangeTransactions.txnNumber })
        .from(exchangeTransactions)
        .where(
          and(
            eq(exchangeTransactions.exchangeHouseId, houseId),
            eq(exchangeTransactions.status, "ACTIVE"),
            eq(exchangeTransactions.currency, "USD"),
            inArray(exchangeTransactions.type, laterSensitiveTypes),
            gt(exchangeTransactions.id, txnId),
          ),
        )
        .limit(1);
      if (laterDisposal) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `لا يمكن عكس حركة الدولار قبل العملية اللاحقة ${laterDisposal.txnNumber}؛ اعكس الحركات الدولارية بترتيب عكسي أوّلاً.`,
        });
      }
    }

    if (txn.currency === "USD" && (txn.type === "FX_BUY" || txn.type === "WITHDRAW")) {
      if (txn.branchId == null) {
        throw new TRPCError({ code: "CONFLICT", message: "حركة حيازة الدولار بلا فرع موثّق" });
      }
      await deriveForeignCashUsdPosition(tx, houseId, Number(txn.branchId), txnId);
    }

    // ١) علّم العملية REVERSED (recompute أدناه يعتمد الحالة النشطة فيستثنيها).
    await tx.update(exchangeTransactions).set({ status: "REVERSED" }).where(eq(exchangeTransactions.id, txnId));

    // ٢) استعادة ذمّة المورد لتسديدٍ عكسناه (كان أطفأ settledIqd = iqdAmount).
    if (txn.type === "SETTLE" && txn.supplierId != null) {
      const carryingIqd = money(txn.settledIqd).gt(0) ? money(txn.settledIqd) : money(txn.iqdAmount);
      const settledUsd = money(txn.settledUsd);
      await adjustSupplierBalance(tx, Number(txn.supplierId), carryingIqd);
      if (settledUsd.gt(0)) await adjustSupplierBalanceUsd(tx, Number(txn.supplierId), settledUsd);
      if (txn.purchaseOrderId != null) {
        const [po] = await tx.select().from(purchaseOrders)
          .where(eq(purchaseOrders.id, Number(txn.purchaseOrderId))).for("update").limit(1);
        if (po) {
          await tx.update(purchaseOrders).set({
            paidAmount: toDbMoney(Decimal.max(0, money(po.paidAmount).minus(carryingIqd))),
            paidUsd: toDbMoney(Decimal.max(0, money(po.paidUsd).minus(settledUsd))),
          }).where(eq(purchaseOrders.id, Number(po.id)));
        }
      }
    }

    // ٣) كل إيصال مادي هو حدث تاريخي: الأصل يصبح REVERSED ويبقى مقروءاً، وتُنشأ ساق
    // تعويضية معاكسة. يشمل هذا سند EXCHANGE غير الخزيني؛ ترك OUT المعكوس بلا IN كان يجعل
    // تقارير التدفق/طرق الدفع تعرض الصرف وحده بعد العكس.
    if (txn.receiptId != null) {
      const [orig] = await tx.select().from(receipts).where(eq(receipts.id, Number(txn.receiptId))).for("update").limit(1);
      if (
        previewCashReceipt &&
        (!orig || orig.paymentMethod !== "CASH" || Number(orig.branchId) !== previewCashReceipt.branchId)
      ) {
        throw new TRPCError({ code: "CONFLICT", message: "تغيّر مصدر إيصال الصيرفة أثناء العكس — أعد المحاولة" });
      }
      if (orig && orig.status === "COMPLETED") {
        const compensationDirection = orig.direction === "OUT" ? "IN" : "OUT";
        if (compensationDirection === "OUT" && orig.paymentMethod === "CASH") {
          if (orig.branchId == null) throw new TRPCError({ code: "CONFLICT", message: "إيصال الصيرفة النقدي بلا فرع" });
          assertTreasuryOutException("EXCHANGE_REVERSAL_COMPENSATION");
          await assertCashOutAvailable(tx, {
            branchId: Number(orig.branchId), cashBucket: "TREASURY", shiftId: null,
            amount: orig.amount, operation: "عكس قبض عملية الصيرفة",
          });
        } else if (compensationDirection === "OUT") {
          assertNonPhysicalOutReceipt({
            classification: "NON_CASH_METHOD", paymentMethod: orig.paymentMethod,
            cashBucket: null, operation: "عكس قبض صيرفة غير نقدي",
          });
        }
        await tx.update(receipts).set({ status: "REVERSED" }).where(eq(receipts.id, Number(orig.id)));
        await tx.insert(receipts).values({
          branchId: orig.branchId,
          shiftId: null,
          cashBucket: orig.paymentMethod === "CASH" ? "TREASURY" : null,
          direction: compensationDirection,
          amount: orig.amount,
          paymentMethod: orig.paymentMethod,
          status: "COMPLETED",
          approvalStatus: "APPROVED",
          partyType: orig.partyType ?? "OTHER",
          partyId: orig.partyId,
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
      if (e.entryType === "ADJUST" && e.dedupeKey?.startsWith("EXCTRL:")) continue;
      const reversedAmount = money(e.amount).negated();
      const exchangeWalletRole = txn.currency === "USD" ? "EXCHANGE_WALLET_USD" as const : "EXCHANGE_WALLET_IQD" as const;
      let postingIntent: PostingIntent | undefined;
      let postingSourceComponents: PostingSourceComponents | undefined;
      switch (e.entryType) {
        case "EXCHANGE_DEPOSIT":
          postingSourceComponents = txn.currency === "USD"
            ? signedSourceComponents("EXCHANGE_WALLET_USD", "FOREIGN_CASH_USD", reversedAmount)
            : signedSourceComponents("EXCHANGE_WALLET_IQD", "TREASURY_CASH", reversedAmount);
          postingIntent = createPostingIntent(
            txn.currency === "USD" ? "EXCHANGE_DEPOSIT_USD_CASH" : "EXCHANGE_DEPOSIT_IQD",
            "EXCHANGE_DEPOSIT",
            txn.currency === "USD"
              ? signedPostingLines("EXCHANGE_WALLET_USD", "FOREIGN_CASH_USD", reversedAmount)
              : signedPostingLines("EXCHANGE_WALLET_IQD", "TREASURY_CASH", reversedAmount),
            postingSourceComponents,
          );
          break;
        case "EXCHANGE_WITHDRAW":
          postingSourceComponents = txn.currency === "USD"
            ? signedSourceComponents("FOREIGN_CASH_USD", "EXCHANGE_WALLET_USD", reversedAmount)
            : signedSourceComponents("TREASURY_CASH", "EXCHANGE_WALLET_IQD", reversedAmount);
          postingIntent = createPostingIntent(
            txn.currency === "USD" ? "EXCHANGE_WITHDRAW_USD_CASH" : "EXCHANGE_WITHDRAW_IQD",
            "EXCHANGE_WITHDRAW",
            txn.currency === "USD"
              ? signedPostingLines("FOREIGN_CASH_USD", "EXCHANGE_WALLET_USD", reversedAmount)
              : signedPostingLines("TREASURY_CASH", "EXCHANGE_WALLET_IQD", reversedAmount),
            postingSourceComponents,
          );
          break;
        case "EXCHANGE_FX_BUY":
          postingSourceComponents = signedSourceComponents("FOREIGN_CASH_USD", "EXCHANGE_WALLET_USD", reversedAmount);
          postingIntent = createPostingIntent(
            "EXCHANGE_FX_BUY",
            "EXCHANGE_FX_BUY",
            signedPostingLines("FOREIGN_CASH_USD", "EXCHANGE_WALLET_USD", reversedAmount),
            postingSourceComponents,
          );
          break;
        case "EXCHANGE_SETTLE":
          postingSourceComponents = signedSourceComponents("AP", exchangeWalletRole, reversedAmount);
          postingIntent = createPostingIntent(
            "EXCHANGE_SETTLE_SUPPLIER",
            "EXCHANGE_SETTLE",
            signedPostingLines("AP", exchangeWalletRole, reversedAmount),
            postingSourceComponents,
          );
          break;
        case "EXCHANGE_FEE":
          postingSourceComponents = signedSourceComponents("OPERATING_EXPENSE", exchangeWalletRole, reversedAmount);
          postingIntent = createPostingIntent(
            "EXCHANGE_FEE_EXPENSE",
            "EXCHANGE_FEE",
            signedPostingLines("OPERATING_EXPENSE", exchangeWalletRole, reversedAmount),
            postingSourceComponents,
          );
          break;
        case "EXCHANGE_FX_DIFF": {
          const originalAmount = money(e.amount);
          postingSourceComponents = originalAmount.isPositive()
            ? signedSourceComponents(exchangeWalletRole, "FX_GAIN", reversedAmount)
            : signedSourceComponents(exchangeWalletRole, "FX_LOSS", reversedAmount);
          postingIntent = originalAmount.isPositive()
            ? createPostingIntent(
              "EXCHANGE_FX_GAIN",
              "EXCHANGE_FX_DIFF",
              signedPostingLines(exchangeWalletRole, "FX_GAIN", reversedAmount),
              postingSourceComponents,
            )
            : createPostingIntent(
              "EXCHANGE_FX_LOSS",
              "EXCHANGE_FX_DIFF",
              signedPostingLines(exchangeWalletRole, "FX_LOSS", reversedAmount),
              postingSourceComponents,
            );
          break;
        }
      }
      if (!postingIntent || !postingSourceComponents) {
        throw new TRPCError({
          code: "CONFLICT",
          message: `قيد الصيرفة ${e.entryType} غير مدعوم في العكس الآمن`,
        });
      }
      await postEntry(tx, {
        entryType: e.entryType as never,
        branchId: e.branchId != null ? Number(e.branchId) : null,
        createdBy: actor.userId,
        purchaseOrderId: e.purchaseOrderId != null ? Number(e.purchaseOrderId) : null,
        exchangeHouseId: houseId,
        supplierId: e.supplierId != null ? Number(e.supplierId) : null,
        amount: reversedAmount,
        cost: money(e.cost).negated(),
        profit: money(e.profit).negated(),
        revenue: money(e.revenue).negated(),
        entryDate: new Date(),
        dedupeKey: `EXREV:${e.dedupeKey}`,
        notes: `عكس — ${e.notes ?? txn.txnNumber}`,
        postingIntent,
        postingSourceComponents,
      });
    }

    // ٥) إعادة اشتقاق أرصدة المحفظة وWAVG من العمليات النشطة (بعد استثناء المعكوسة).
    await recomputeHouseFromLog(tx, houseId);
    const [recomputedHouse] = await tx
      .select({
        balanceIqd: exchangeHouses.balanceIqd,
        balanceUsdCarryingIqd: exchangeHouses.balanceUsdCarryingIqd,
      })
      .from(exchangeHouses)
      .where(eq(exchangeHouses.id, houseId))
      .limit(1);
    if (!recomputedHouse) throw new TRPCError({ code: "CONFLICT", message: "تعذر قراءة رصيد الصيرفة بعد العكس" });
    await postExchangeControlReclassification(tx, {
      exchangeHouseId: houseId,
      currency: txn.currency,
      beforeSignedIqd: controlBeforeIqd,
      afterSignedIqd: txn.currency === "USD"
        ? recomputedHouse.balanceUsdCarryingIqd
        : recomputedHouse.balanceIqd,
      sourceKey: `REV:${txn.txnNumber}`,
      notes: `إعادة تصنيف ذمة الصيرفة بعد عكس ${txn.txnNumber}`,
      createdBy: actor.userId,
    });

    return { txnId, txnNumber: txn.txnNumber, status: "REVERSED" as const };
  });
}
