// عكس عملية صيرفة خاطئة (تدقيق ١٧/٧): يعلّم العملية REVERSED، يعكس أثرها المحاسبيّ والخزينيّ وذمّة
// المورّد، ثم **يُعيد اشتقاق أرصدة المحفظة ومتوسط الكلفة WAVG من سجلّ العمليات النشطة** (الطريقة
// الوحيدة الصحيحة لأن WAVG يعتمد على المسار). بفصل مهام (مُنشئ ≠ مُنفِّذ العكس، admin مُستثنى).
import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import { accountingEntries, exchangeHouses, exchangeTransactions, purchaseOrders, receipts, suppliers } from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { adjustSupplierBalance, adjustSupplierBalanceUsd, postEntry } from "../ledgerService";
import { money, round2, toDbMoney } from "../money";
import { withTx, type Actor } from "../tx";
import { assertCashOutAvailable, assertNonPhysicalOutReceipt, lockCashSourceForUpdate } from "../cash/cashAvailability";
import { lockBranchMonthCloseGate } from "../reports/monthCloseGate";
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
    .orderBy(asc(exchangeTransactions.createdAt), asc(exchangeTransactions.id))
    // Current locking read: reverse starts with a nonlocking preview before waiting on the
    // house mutex. A snapshot read here could miss a settlement that committed while we
    // waited and overwrite its wallet effect during recomputation.
    .for("update");

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
        // نموذج الدَّين (قرار مالك ٣/٨): الصيرفة تُسلِّم الدولار فوراً نقداً ⇒ لا يُمسّ الدينار إطلاقاً؛
        // يتعمّق الدَّين الدولاري (usd سالب أكثر) بمتوسط كلفةٍ يشمل سعر نشوء هذا الدَّين تحديداً.
        basis = basis.minus(iqdAmt);
        usd = usd.minus(usdAmt);
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
    if (previewTxn) await lockHouse(tx, Number(previewTxn.exchangeHouseId));
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

    // حارس اتساق فرق الصرف (تدقيق ٢٥/٧): عكس اقتناءِ دولارٍ (FX_BUY أو DEPOSIT-USD) استهلكته عمليةٌ
    // لاحقة (تسوية/سحب دولار) يترك فرق الصرف المحقَّق لتلك العملية محسوباً على متوسط كلفةٍ بطَل بعد
    // إعادة الاشتقاق (recompute يصحّح الأرصدة لا القيود المُرحَّلة سابقاً) ⇒ انحراف P&L صامت دائم.
    // نمنعه: تُعكَس العمليات اللاحقة المستهلِكة للدولار أوّلاً (id تصاعديّ = ترتيب الإدراج، لا الساعة).
    if (txn.type === "FX_BUY" || (txn.type === "DEPOSIT" && txn.currency === "USD")) {
      const [laterDisposal] = await tx
        .select({ txnNumber: exchangeTransactions.txnNumber })
        .from(exchangeTransactions)
        .where(
          and(
            eq(exchangeTransactions.exchangeHouseId, houseId),
            eq(exchangeTransactions.status, "ACTIVE"),
            eq(exchangeTransactions.currency, "USD"),
            inArray(exchangeTransactions.type, ["SETTLE", "WITHDRAW"]),
            gt(exchangeTransactions.id, txnId),
          ),
        )
        .limit(1);
      if (laterDisposal) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `لا يمكن عكس هذا الاقتناء الدولاريّ: عمليةٌ لاحقة (${laterDisposal.txnNumber}) استهلكت دولاره ⇒ عكسه يترك فرق الصرف المحقَّق لتلك العملية على قيمةٍ خاطئة. اعكس العمليات اللاحقة المستهلِكة للدولار أوّلاً.`,
        });
      }
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
      await postEntry(tx, {
        entryType: e.entryType as never,
        branchId: e.branchId != null ? Number(e.branchId) : null,
        purchaseOrderId: e.purchaseOrderId != null ? Number(e.purchaseOrderId) : null,
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
