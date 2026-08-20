// ترحيل (D8): خصم الأجرة وتوريد الصافي. gross-up: PAYMENT_IN=COD كامل + DELIVERY_FEE=أجرة ⇒ صافي الدرج=المورَّد.
import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { eq, sql } from "drizzle-orm";
import {
  accountingEntries,
  deliveryConsignments,
  deliveryParties,
  deliveryRemittanceLines,
  deliveryRemittances,
  invoices,
  receipts,
} from "../../../drizzle/schema";
import { extractInsertId } from "../../lib/insertId";
import { createPostingIntent, creditLine, debitLine } from "../accounting/postingEngine";
import { appendDeliveryEvent, appendDeliveryLedgerEntry } from "./lifecycle";
import {
  checkIdempotency,
  idempotencyHash,
  recordIdempotencyKey,
} from "../idempotency";
import {
  adjustCustomerBalance,
  adjustDeliveryBalance,
  computeInvoiceStatus,
  postEntry,
} from "../ledgerService";
import { money, round2, toDbMoney } from "../money";
import { shiftIdForCashTx } from "../shiftService";
import {
  assertTreasuryOutException,
  lockCashSourceForUpdate,
} from "../cash/cashAvailability";
import { withTx } from "../tx";
import { nextRemittanceNumber } from "./numbering";
import {
  deliveryCustomerCollectionIntent,
  deliveryFeeHeldPayoutIntent,
  deliveryFeeSettlementIntent,
  deliveryRemitIntent,
  paymentAccountRole,
} from "./posting";
import type { DeliveryTxActor } from "./types";

/** ترحيل (D8): خصم الأجرة وتوريد الصافي. gross-up: PAYMENT_IN=COD كامل + DELIVERY_FEE=أجرة ⇒ صافي الدرج=المورَّد. */
export interface RemittanceLineInput {
  consignmentId: number;
  collectedAmount: string; // المُحصَّل لهذه الإرسالية (0..المتبقّي)
}

export interface RemittanceInput {
  branchId: number;
  partyId: number;
  lines: RemittanceLineInput[];
  /** النقد الذي عدّه المستلم فعلياً؛ يجب أن يطابق صافي التوريد بعد الأجور. */
  countedCash: string;
  shiftType?: "RECEPTION" | "RETAIL";
  clientRequestId?: string | null;
  /**
   * **كشف شركة التوصيل** (١٩/٨) — مستند الشركة الذي قاد هذه التسوية (إطار المالك نسخة ٢:
   * «كشف الشركة هو الدليل الأساسيّ للشركات التي لا تملك بوابة»).
   *
   * وجودُه يغيّر ثلاثة أشياء ولا يغيّر المسار الماليّ:
   *  ① أسطرُه تُثبِت التسليم أوّلاً حين لا يكون الطرد مختوماً `DELIVERED` (عبر
   *    `confirmConsignmentDelivery` بشاهد الكشف) — فالتسليم والتحصيل والتوريد عمليةٌ واحدة.
   *  ② رقمُه **فريدٌ لكل جهة** (قيدٌ في القاعدة) ⇒ إعادةُ إدخال الكشف نفسه ترتدّ بدل أن
   *    تضاعف القيود — مفتاح عدم التكرار الأعماليّ فوق idempotency التقنيّ.
   *  ③ استقطاعاتُه **مصروف شركةٍ مستقلّ** يُوثَّق على المستند، لا تخفيضُ ذمّة عميل.
   */
  companyStatement?: {
    statementNumber: string;
    statementDate?: string | null;
    attachmentUrl?: string | null;
    /** استقطاعات الشركة من الحصيلة (أجور توصيل حسمتها قبل التوريد) — إفصاحٌ على المستند. */
    deductionsTotal?: string | null;
    notes?: string | null;
  } | null;
}

export async function recordDeliveryRemittance(
  input: RemittanceInput,
  actor: DeliveryTxActor,
) {
  return withTx(async (tx) => {
    const canonicalLines = input.lines
      .map((line) => ({
        consignmentId: Number(line.consignmentId),
        collectedAmount: toDbMoney(round2(money(line.collectedAmount))),
      }))
      .sort((a, b) => a.consignmentId - b.consignmentId);
    const payloadHash = idempotencyHash({
      branchId: Number(input.branchId),
      partyId: Number(input.partyId),
      shiftType: input.shiftType ?? "RECEPTION",
      lines: canonicalLines,
      countedCash: toDbMoney(round2(money(input.countedCash))),
    });
    const replayResult = async () => {
      if (!input.clientRequestId) return null;
      const existingId = await checkIdempotency(
        tx,
        "delivery.remit",
        input.clientRequestId,
        payloadHash,
      );
      if (existingId == null) return null;
      const rm = (
        await tx
          .select()
          .from(deliveryRemittances)
          .where(eq(deliveryRemittances.id, existingId))
          .limit(1)
      )[0];
      const replayTotal = round2(
        input.lines.reduce(
          (sum, line) => sum.plus(money(line.collectedAmount)),
          new Decimal(0),
        ),
      );
      if (
        !rm ||
        Number(rm.branchId) !== Number(input.branchId) ||
        Number(rm.partyId) !== Number(input.partyId) ||
        !money(rm.collectedTotal).eq(replayTotal)
      ) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "تعارض idempotency: المفتاح مستعمل لتوريد مختلف",
        });
      }
      return {
        remittanceId: existingId,
        remittanceNumber: rm.remittanceNumber,
        collectedTotal: String(rm.collectedTotal),
        feesTotal: String(rm.feesTotal),
        netRemitted: String(rm.netRemitted),
        shortfallTotal: String(rm.shortfallTotal),
        status: rm.status,
        idempotentReplay: true as const,
      };
    };
    if (input.clientRequestId) {
      const replay = await replayResult();
      if (replay) return replay;
    }
    if (!input.lines.length)
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "لا إرساليات للتسوية",
      });
    const uniqueConsignmentIds = new Set(
      input.lines.map((line) => line.consignmentId),
    );
    if (uniqueConsignmentIds.size !== input.lines.length) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "لا يمكن تكرار الإرسالية نفسها داخل التوريد",
      });
    }

    // CASH IN participates in the same mutex graph as CASH OUT: source→party→consignment→invoice.
    // Locking party/documents first and the drawer only before receipt insert inverted delivery returns.
    const { shiftId, cashBucket } = await shiftIdForCashTx(
      tx,
      {
        userId: actor.userId,
        branchId: actor.branchId ?? undefined,
        role: actor.role,
      },
      input.branchId,
      "توريد مندوب",
      input.shiftType ?? "RECEPTION",
    );
    await lockCashSourceForUpdate(tx, {
      branchId: input.branchId,
      cashBucket,
      shiftId,
    });

    const party = (
      await tx
        .select()
        .from(deliveryParties)
        .where(eq(deliveryParties.id, input.partyId))
        .for("update")
        .limit(1)
    )[0];
    if (!party)
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "جهة التوصيل غير موجودة",
      });
    const replayAfterLock = await replayResult();
    if (replayAfterLock) return replayAfterLock;
    if (
      party.branchId != null &&
      Number(party.branchId) !== Number(input.branchId)
    ) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "جهة التوصيل لا تخصّ فرع التوريد",
      });
    }

    // المرور ١: قفل + تحقّق + حساب (بلا كتابة) — ترتيب أقفال الإرساليات تصاعدياً يمنع الجمود.
    type Work = {
      id: number;
      invoiceId: number;
      collected: Decimal;
      invoiceCredit: Decimal;
      newCollected: Decimal;
      delivered: boolean;
      fee: Decimal;
      remaining: Decimal;
      feeCollection: string;
      fromMoneyStatus: "UNSETTLED" | "PARTIAL";
    };
    const work: Work[] = [];
    let collectedTotal = new Decimal(0);
    let feesTotal = new Decimal(0);
    let expectedTotal = new Decimal(0);
    const sortedLines = [...input.lines].sort(
      (a, b) => a.consignmentId - b.consignmentId,
    );
    for (const line of sortedLines) {
      const cn = (
        await tx
          .select()
          .from(deliveryConsignments)
          .where(eq(deliveryConsignments.id, line.consignmentId))
          .for("update")
          .limit(1)
      )[0];
      if (!cn)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `إرسالية ${line.consignmentId} غير موجودة`,
        });
      if (Number(cn.partyId) !== input.partyId)
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "إرسالية لجهة أخرى",
        });
      if (Number(cn.branchId) !== Number(input.branchId)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `إرسالية ${cn.consignmentNumber} تخصّ فرعاً آخر`,
        });
      }
      if (cn.status !== "DISPATCHED" && cn.status !== "PARTIAL")
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `إرسالية ${cn.consignmentNumber} غير قابلة للتسوية`,
        });
      if (cn.parcelStatus !== "DELIVERED") {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `لا يمكن توريد ${cn.consignmentNumber} قبل إثبات وصول العميل`,
        });
      }
      if (cn.moneyStatus !== "UNSETTLED" && cn.moneyStatus !== "PARTIAL") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `الإرسالية ${cn.consignmentNumber} غير قابلة للتوريد المالي`,
        });
      }
      const collected = round2(money(line.collectedAmount));
      if (collected.lt(0))
        throw new TRPCError({ code: "BAD_REQUEST", message: "مبلغ سالب" });
      // سطرٌ صفريّ يُستثنى كلياً (مراجعة عدائية ٩/٨): كان يقلب DISPATCHED إلى PARTIAL بصفر
      // تحصيل ويختمها remittanceId ⇒ «حُصِّل جزئياً» كاذبة تُقفل باب returnConsignment
      // («يُرجَع فقط إرسالٌ لم يُحصَّل منه شيء») على بضاعةٍ لم يُحصَّل منها شيء فعلاً.
      // غير المحصَّل ليس توريداً — يبقى DISPATCHED كما هو (يُرجَع أو يُورَّد لاحقاً).
      if (collected.isZero()) continue;
      const remaining = round2(
        money(cn.codAmount).minus(money(cn.collectedAmount)),
      );
      if (collected.gt(remaining))
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `أكثر من المتبقّي للإرسالية ${cn.consignmentNumber}`,
        });
      // مراجعة عدائية (٥/٨) — حزامٌ ثانٍ: السقف على متبقّي **الفاتورة** الحيّ لا الإرسالية وحدها.
      // codAmount لُقط لحظة الإرسال؛ تسديدٌ كاونتريّ لاحق (قبل حارس collectOnInvoice أو من مسارٍ
      // آخر) يخفض متبقّي الفاتورة دون علم الإرسالية ⇒ بلا هذا السقف يصير paidAmount > total
      // وتنقلب ذمّة العميل سالبة بقيدَي PAYMENT_IN لبيعٍ واحد.
      const invRow = (
        await tx
          .select({
            total: invoices.total,
            paidAmount: invoices.paidAmount,
            returnedTotal: invoices.returnedTotal,
          })
          .from(invoices)
          .where(eq(invoices.id, Number(cn.invoiceId)))
          .for("update")
          .limit(1)
      )[0];
      const invRemaining = invRow
        ? round2(
            money(invRow.total)
              .minus(money(invRow.returnedTotal ?? "0"))
              .minus(money(invRow.paidAmount)),
          )
        : remaining;
      // New deliveries settle customer AR at the physical-delivery event and
      // move the amount to courier custody.  Legacy rows can still have a live
      // invoice remainder, so only that part is credited during remittance.
      //
      // ⚠️ ١٩/٨ — الشرط الحاسم: **هل سُوّيت ذمّةُ العميل لحظة التسليم لهذه الإرسالية؟**
      // كان الائتمان `min(المحصَّل, متبقّي الفاتورة)` وحدَه، وهو **صحيحٌ صدفةً** ما دام
      // التسليم يقبض COD كاملاً (فيصير المتبقّي صفراً والائتمان صفراً). لكن كشف الشركة يُجيز
      // تحصيلاً **جزئياً**: يُسدَّد ١٢٬٠٠٠ عند التسليم فيبقى ٨٬٠٠٠ حيّاً، فيأتي التوريد
      // ويعتمدها ⇒ الفاتورة تُسدَّد ٢٠٬٠٠٠ ولم يُقبض إلّا ١٢٬٠٠٠، وذمّةٌ حيّةٌ تُمحى بلا مال.
      //
      // الدليل القاطع هو **قيد التسديد المكتوب لحظة التسليم نفسه** (`PAYMENT_IN:COURIER_
      // DELIVERY:{cn}` في courier.ts) لا `custodyRecognizedAt`: الصفوف الموروثة قد تحمل
      // اعترافاً بالعهدة **بلا تسوية فاتورة** (نموذج ما قبل المرحلة الثانية — يحرسه اختبار
      // receptionReviewFixes/F2)، فالعلامة تكذب عليها بينما وجودُ القيد لا يكذب أبداً.
      // ووجودُه يعني: التوريد **نقلُ عهدةٍ إلى نقدٍ لا تسويةُ عميلٍ ثانية** (نصّ التعليق أعلاه).
      const settledAtDelivery = (
        await tx
          .select({ id: accountingEntries.id })
          .from(accountingEntries)
          .where(eq(accountingEntries.dedupeKey, `PAYMENT_IN:COURIER_DELIVERY:${Number(cn.id)}`))
          .limit(1)
      ).length > 0;
      const invoiceCredit = settledAtDelivery
        ? new Decimal(0)
        : Decimal.min(collected, Decimal.max(invRemaining, 0));
      const newCollected = round2(money(cn.collectedAmount).plus(collected));
      const delivered = newCollected.gte(money(cn.codAmount));
      // ٥/٨ — الأجرة تُخصَم من التوريد فقط إذا كانت **ما زالت مستحقّةً علينا** للمندوب:
      //   COURIER ⇒ يقبضها من الزبون مباشرةً، خارج دفترنا كلّياً ⇒ لا خصم (كان الخصم هنا يصرفها
      //             مرّةً ثانيةً بعد أن قبضها بنفسه).
      //   feeSettledAt ⇒ صُرفت نقداً لحظة الإرسال ⇒ لا خصم (حارس الصرف المزدوج).
      // وتبقى مستحقّةً عند التسليم الكامل فقط (تسليمٌ جزئيّ لا يستحقّ أجرةً).
      const feeStillOwed = false;
      const fee =
        delivered && feeStillOwed
          ? round2(money(cn.deliveryFee))
          : new Decimal(0);
      if (fee.gt(collected)) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `أجرة توصيل الإرسالية ${cn.consignmentNumber} تتجاوز النقد المورّد في هذه التسوية`,
        });
      }
      work.push({
        id: Number(cn.id),
        invoiceId: Number(cn.invoiceId),
        collected,
        invoiceCredit,
        newCollected,
        delivered,
        fee,
        remaining,
        feeCollection: String(cn.feeCollection ?? "SHOP"),
        fromMoneyStatus: cn.moneyStatus,
      });
      collectedTotal = collectedTotal.plus(collected);
      feesTotal = feesTotal.plus(fee);
      expectedTotal = expectedTotal.plus(remaining);
    }
    if (!work.length) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message:
          "لا مبالغ للتوريد — كل الأسطر صفرية. غير المحصَّل يبقى بالطريق (يُورَّد لاحقاً أو تُرجَع إرساليته)",
      });
    }
    collectedTotal = round2(collectedTotal);
    feesTotal = round2(feesTotal);
    const custodyBalance = round2(money(party.currentBalance));
    if (collectedTotal.gt(custodyBalance)) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: `مبلغ التوريد (${collectedTotal.toFixed(2)}) يتجاوز النقد المثبت بذمة الجهة (${custodyBalance.toFixed(2)}). شغّل المطابقة المالية قبل المتابعة.`,
      });
    }
    /**
     * **استقطاعُ الشركة نقدٌ لم يدخل الدرج قطّ** (تصويب مراجعة Codex، ٢٠/٨).
     *
     * كان يُخزَّن **بياناً وصفياً فقط**: `netRemitted` والنقدُ المعدود يُحسبان على المُحصَّل
     * كاملاً ⇒ إدخالُ النقد المستلَم فعلاً **يفشل في التحقّق**، وإدخالُ الإجماليّ ليمرّ
     * **يسجّل نقداً لم يدخل** ويترك الاستقطاع المُفصَح عنه خارج الدفتر — خرقٌ مزدوج لـ§٥.
     *
     * الآن يُطرح من الصافي، ويخرج بإيصال OUT ومصروفٍ مصنَّف `DELIVERY_EXPENSE` — مطابقةً
     * لقرار المالك في الشحن/الكمرك: مصروفُ شركةٍ يُعترف به لحظته ولا يمسّ ذمّة عميل.
     */
    const deductionsTotal = round2(money(input.companyStatement?.deductionsTotal ?? "0"));
    if (deductionsTotal.lt(0)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "استقطاع الكشف لا يصحّ أن يكون سالباً" });
    }
    if (deductionsTotal.gt(collectedTotal)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `استقطاع الكشف (${deductionsTotal.toFixed(2)}) يتجاوز المُحصَّل (${collectedTotal.toFixed(2)})`,
      });
    }
    const netRemitted = round2(collectedTotal.minus(feesTotal).minus(deductionsTotal));
    const countedCash = round2(money(input.countedCash));
    if (countedCash.lt(0)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "النقد المعدود لا يمكن أن يكون سالباً",
      });
    }
    if (!countedCash.eq(netRemitted)) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: `النقد المعدود (${countedCash.toFixed(2)}) لا يطابق صافي التوريد المتوقع (${netRemitted.toFixed(2)}). راجع مبالغ الإرساليات والأجور قبل التأكيد.`,
      });
    }
    // A partial allocation is not a cash shortage. Remaining COD is derived
    // from immutable allocation lines, not accumulated as historical deficit.
    const shortfallTotal = new Decimal(0);
    const status: "BALANCED" | "SHORT" | "OVER" = "BALANCED";

    // درج المُستلِم (RECEPTION افتراضياً): صافي النقد (collected − fee) يدخله فعلياً.
    const remittanceNumber = await nextRemittanceNumber(tx, input.branchId);

    const rmRes = await tx.insert(deliveryRemittances).values({
      remittanceNumber,
      branchId: input.branchId,
      partyId: input.partyId,
      shiftId,
      collectedTotal: toDbMoney(collectedTotal),
      feesTotal: toDbMoney(feesTotal),
      netRemitted: toDbMoney(netRemitted),
      shortfallTotal: toDbMoney(
        shortfallTotal.lt(0) ? new Decimal(0) : shortfallTotal,
      ),
      status,
      receivedBy: actor.userId,
      // كشف شركة التوصيل (١٩/٨) — مستند الشركة الذي قاد التسوية. القيد الفريد
      // (partyId, companyStatementNumber) يجعل إعادةَ إدخال الكشف ترتدّ بدل مضاعفة القيود.
      companyStatementNumber: input.companyStatement?.statementNumber?.trim() || null,
      statementDate: input.companyStatement?.statementDate
        ? new Date(input.companyStatement.statementDate)
        : null,
      statementAttachmentUrl: input.companyStatement?.attachmentUrl?.trim() || null,
      deductionsTotal: toDbMoney(deductionsTotal),
      notes: input.companyStatement?.notes?.trim() || null,
    });
    const remittanceId = extractInsertId(rmRes);

    // إيصال درج IN = COD المُحصَّل كاملاً (سلامة الفاتورة)، وOUT = الأجور (مصروف) ⇒ صافي الدرج = المورَّد.
    let receiptInId: number | null = null;
    let receiptOutId: number | null = null;
    if (collectedTotal.gt(0)) {
      const rIn = await tx.insert(receipts).values({
        branchId: input.branchId,
        shiftId,
        direction: "IN",
        amount: toDbMoney(collectedTotal),
        paymentMethod: "CASH",
        cashBucket,
        status: "COMPLETED",
        referenceNumber: remittanceNumber,
        partyType: "OTHER",
        description: `توريد تحصيلات مندوب ${remittanceNumber}`,
        createdBy: actor.userId,
      });
      receiptInId = extractInsertId(rIn);
    }
    if (feesTotal.gt(0)) {
      if (cashBucket === "TREASURY")
        assertTreasuryOutException("DELIVERY_REMITTANCE_CLEARING");
      const rOut = await tx.insert(receipts).values({
        branchId: input.branchId,
        shiftId,
        direction: "OUT",
        amount: toDbMoney(feesTotal),
        paymentMethod: "CASH",
        cashBucket,
        status: "COMPLETED",
        referenceNumber: remittanceNumber,
        partyType: "OTHER",
        description: `أجور توصيل ${remittanceNumber}`,
        createdBy: actor.userId,
      });
      receiptOutId = extractInsertId(rOut);
    }
    // استقطاعُ الشركة: نقدٌ خرج بحكم أنّه لم يصل — إيصالُ OUT مستقلٌّ عن الأجور كي يبقى
    // كلُّ مبلغٍ منسوباً إلى سببه في تسوية الدرج وZ-report، ومصروفٌ مصنَّف يظهر في تقريره.
    if (deductionsTotal.gt(0)) {
      if (cashBucket === "TREASURY") assertTreasuryOutException("DELIVERY_REMITTANCE_CLEARING");
      const rDed = await tx.insert(receipts).values({
        branchId: input.branchId,
        shiftId,
        direction: "OUT",
        amount: toDbMoney(deductionsTotal),
        paymentMethod: "CASH",
        cashBucket,
        status: "COMPLETED",
        referenceNumber: remittanceNumber,
        partyType: "OTHER",
        description: `استقطاع شركة التوصيل — كشف ${input.companyStatement?.statementNumber?.trim() ?? remittanceNumber}`,
        createdBy: actor.userId,
      });
      const deductionReceiptId = extractInsertId(rDed);
      const assetRole = paymentAccountRole("CASH", cashBucket, "OUT");
      const src = {
        roleDebits: { DELIVERY_EXPENSE: deductionsTotal },
        roleCredits: { [assetRole]: deductionsTotal },
      };
      await postEntry(tx, {
        entryType: "PAYMENT_OUT",
        dedupeKey: `DLV-STMT-DEDUCTION:${remittanceId}`,
        branchId: input.branchId,
        receiptId: deductionReceiptId,
        deliveryPartyId: input.partyId,
        amount: deductionsTotal,
        cost: deductionsTotal,
        notes: `استقطاع كشف شركة التوصيل ${remittanceNumber}`,
        postingIntent: createPostingIntent(
          "PAYMENT_OUT_EXPENSE",
          "PAYMENT_OUT",
          [debitLine("DELIVERY_EXPENSE", deductionsTotal), creditLine(assetRole, deductionsTotal)],
          src,
        ),
        postingSourceComponents: src,
      });
    }
    await tx
      .update(deliveryRemittances)
      .set({ receiptInId, receiptOutId })
      .where(eq(deliveryRemittances.id, remittanceId));

    // المرور ٢: تطبيق لكل إرسالية.
    for (const w of work) {
      const newStatus = w.delivered ? "DELIVERED" : "PARTIAL";
      await tx
        .update(deliveryConsignments)
        .set({
          collectedAmount: toDbMoney(w.newCollected),
          status: newStatus,
          moneyStatus: w.delivered ? "SETTLED" : "PARTIAL",
          remittanceId,
          settledAt: w.delivered ? new Date() : null,
        })
        .where(eq(deliveryConsignments.id, w.id));

      await tx.insert(deliveryRemittanceLines).values({
        remittanceId,
        consignmentId: w.id,
        grossApplied: toDbMoney(w.collected),
        feeOffset: "0.00",
        cashReceived: toDbMoney(w.collected),
        writtenOffAmount: "0.00",
      });
      await appendDeliveryLedgerEntry(tx, {
        eventKey: `CN:${w.id}:REMIT:${remittanceId}`,
        partyId: input.partyId,
        consignmentId: w.id,
        remittanceId,
        branchId: input.branchId,
        entryType: "COD_REMITTED",
        amount: toDbMoney(w.collected),
        actorUserId: actor.userId,
      });
      await appendDeliveryEvent(tx, {
        eventKey: `CN:${w.id}:MONEY:${remittanceId}`,
        consignmentId: w.id,
        eventType: w.delivered ? "MONEY_SETTLED" : "MONEY_PARTIAL",
        fromMoneyStatus: w.fromMoneyStatus,
        toMoneyStatus: w.delivered ? "SETTLED" : "PARTIAL",
        actorUserId: actor.userId,
        payload: { remittanceId, grossApplied: toDbMoney(w.collected) },
      });

      if (w.collected.gt(0)) {
        const inv = (
          await tx
            .select({
              total: invoices.total,
              paidAmount: invoices.paidAmount,
              returnedTotal: invoices.returnedTotal,
              customerId: invoices.customerId,
            })
            .from(invoices)
            .where(eq(invoices.id, w.invoiceId))
            .limit(1)
        )[0];
        // تسوية الفاتورة بالـCOD المُحصَّل كاملاً (PAYMENT_IN) — يربط إيصال IN الدفعة.
        if (w.invoiceCredit.gt(0))
          await postEntry(tx, {
            // dedupeKey بنيويّ (٩/٨): كان القيد الوحيد في مسارات التوصيل بلا مفتاح — محميّاً بمظلّة
            // idempotency التوريد وحدها؛ المفتاح يجعله محصَّناً بذاته كسائر قيود المنظومة.
            entryType: "PAYMENT_IN",
            dedupeKey: `PAYMENT_IN:REMIT:${w.id}:${remittanceId}`,
            postingIntent: deliveryCustomerCollectionIntent(w.invoiceCredit),
            branchId: input.branchId,
            invoiceId: w.invoiceId,
            receiptId: receiptInId,
            customerId: inv?.customerId != null ? Number(inv.customerId) : null,
            deliveryPartyId: input.partyId,
            amount: w.invoiceCredit,
            notes: `تسوية فاتورة قديمة ضمن ${remittanceNumber}`,
          });
        if (inv && w.invoiceCredit.gt(0)) {
          const newPaid = round2(money(inv.paidAmount).plus(w.invoiceCredit));
          await tx
            .update(invoices)
            .set({
              paidAmount: toDbMoney(newPaid),
              status: computeInvoiceStatus(
                String(inv.total),
                toDbMoney(newPaid),
                String(inv.returnedTotal ?? "0"),
              ),
              paymentDate: new Date(),
              paymentMethod: sql`COALESCE(${invoices.paymentMethod}, 'CASH')`,
            })
            .where(eq(invoices.id, w.invoiceId));
          // ش٠ (٥/٨، V14): فاتورةٌ آجلة **بعميلٍ مسجَّل** أُسندت للتوصيل (dispatchInvoice يُبقي
          // customerId) — سدّد الزبون للمندوب فذمّته تنخفض بما حُصِّل، مرآةً حرفيةً لمسار المتجر
          // (courier.ts). كان التوريد يرفع paidAmount ولا يمسّ currentBalance إطلاقاً ⇒ ذمّةٌ
          // لا تُغلق أبداً وكشفٌ يطالب من سدّد. وينطبق الآن أيضاً على فواتير أوامر الشغل
          // المرسلة التي بقيت منسوبةً إلى عميلها بدلاً من قطع سلسلة الذمم.
          if (inv.customerId != null) {
            await adjustCustomerBalance(
              tx,
              Number(inv.customerId),
              w.invoiceCredit.neg(),
            );
          }
        }
        // خفض العهدة بالـCOD المُحصَّل كاملاً (الأجرة netting لا تَمسّ العهدة).
        await adjustDeliveryBalance(tx, input.partyId, w.collected.neg());
        await postEntry(tx, {
          entryType: "DELIVERY_REMIT",
          dedupeKey: `DELIVERY_REMIT:${w.id}:${remittanceId}`,
          postingIntent: deliveryRemitIntent(w.collected, cashBucket),
          postingSourceComponents: {
            roleDebits: {
              [paymentAccountRole("CASH", cashBucket, "IN")]: w.collected,
            },
            roleCredits: { DELIVERY_FLOAT: w.collected },
          },
          branchId: input.branchId,
          invoiceId: w.invoiceId,
          receiptId: receiptInId,
          deliveryPartyId: input.partyId,
          amount: w.collected,
        });
      }
      // الأجرة عند التسليم الكامل (يربط إيصال OUT الدفعة). ٥/٨ — تُصنَّف بحسب مَن تحمّلها:
      //   COUNTER ⇒ قبضناها من الزبون أمانةً ⇒ تمريرٌ (amount فقط) لا مصروف ⇒ صفر أثرٍ على الربح.
      //   SHOP    ⇒ المكتبة تحمّلتها فعلاً ⇒ مصروفٌ حقيقيّ (cost-only) كما كان.
      if (w.fee.gt(0)) {
        const passThrough = w.feeCollection === "COUNTER";
        await postEntry(tx, {
          entryType: passThrough ? "DELIVERY_FEE_HELD" : "DELIVERY_FEE",
          postingIntent: passThrough
            ? deliveryFeeHeldPayoutIntent(w.fee.neg(), cashBucket)
            : deliveryFeeSettlementIntent(w.fee, cashBucket),
          postingSourceComponents: {
            roleDebits: { COURIER_PAYABLE: w.fee },
            roleCredits: {
              [paymentAccountRole("CASH", cashBucket, "OUT")]: w.fee,
            },
          },
          branchId: input.branchId,
          invoiceId: w.invoiceId,
          receiptId: receiptOutId,
          deliveryPartyId: input.partyId,
          // إشارة تبرئة الأمانة **سالبة** (٩/٨ — مرآة dispatch.ts وdispatchInvoice.ts حرفياً):
          // القبض في الدرج +fee والصرف للمندوب −fee ⇒ Σ(DELIVERY_FEE_HELD) للمستند = 0 ⇔ مُبرَّأة.
          // الفرع شبه ميت (COUNTER تُصرف لحظة الإرسال فيُختم feeSettledAt) لكن أيّ إرسالية قديمة
          // feeSettledAt=null كانت ستقيّد +fee فوق قيد القبض = ضعف الأجرة التزاماً وهمياً للأبد.
          amount: passThrough ? w.fee.neg() : w.fee,
          notes: `أجرة توصيل ${remittanceNumber}`,
        });
        await tx
          .update(deliveryConsignments)
          .set({ feeSettledAt: new Date() })
          .where(eq(deliveryConsignments.id, w.id));
      }
    }

    if (input.clientRequestId)
      await recordIdempotencyKey(
        tx,
        "delivery.remit",
        input.clientRequestId,
        remittanceId,
        payloadHash,
      );
    return {
      remittanceId,
      remittanceNumber,
      collectedTotal: collectedTotal.toFixed(2),
      feesTotal: feesTotal.toFixed(2),
      netRemitted: netRemitted.toFixed(2),
      shortfallTotal: (shortfallTotal.lt(0)
        ? new Decimal(0)
        : shortfallTotal
      ).toFixed(2),
      status,
    };
  });
}
