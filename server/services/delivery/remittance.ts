// ترحيل (D8): توريد COD المُحصَّل كاملاً إلى الدرج. أجورُ الجهة **لا تُخصَم هنا** — تُصرف
// بسند صرفٍ مستقلّ (payDeliveryFee / payPartyDeliveryFees في fees.ts) كي يبقى لكل دينارٍ
// خارجٍ إيصالُه وسببُه. netRemitted = المُحصَّل − استقطاع كشف الشركة (إن وُجد).
import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { and, eq, or, sql } from "drizzle-orm";
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
  assertCashOutAvailable,
  assertTreasuryOutException,
  lockCashSourceForUpdate,
} from "../cash/cashAvailability";
import { withTx } from "../tx";
import { nextRemittanceNumber } from "./numbering";
import {
  deliveryCustomerCollectionIntent,
  deliveryRemitIntent,
  paymentAccountRole,
} from "./posting";
import type { DeliveryTxActor } from "./types";

/** سطر توريد: المُحصَّل لإرسالية واحدة (0..متبقّيها الحيّ). */
export interface RemittanceLineInput {
  consignmentId: number;
  collectedAmount: string; // المُحصَّل لهذه الإرسالية (0..المتبقّي الحيّ)
}

export interface RemittanceInput {
  branchId: number;
  partyId: number;
  lines: RemittanceLineInput[];
  /** النقد الذي عدّه المستلم فعلياً؛ يجب أن يطابق صافي التوريد بعد استقطاع الكشف. */
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
        // Slice H: يُعاد في مسار replay كي يظل شكلُ العائد متطابقاً (ULV: نفس المفاتيح).
        courierCommissionAmount: rm.courierCommissionAmount != null ? String(rm.courierCommissionAmount) : null,
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
      remaining: Decimal;
      fromMoneyStatus: "UNSETTLED" | "PARTIAL";
    };
    const work: Work[] = [];
    let collectedTotal = new Decimal(0);
    // الأجور لا تُخصَم من التوريد بنيوياً (تُصرف بسند مستقل في fees.ts) — الصفر هنا ثابتٌ
    // لا فرعَ ميّتاً: يُخزَّن في feesTotal للمخطط ويُبقي netRemitted = المُحصَّل − الاستقطاع.
    const feesTotal = new Decimal(0);
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
      // المتبقّي **الحيّ** للإرسالية = codAmount − collectedAmount − counterSettledAmount
      // (٢٢/٨، عمود 0249): ما سدّده الزبون بالكاونتر بعد ثبوت التسليم لم يمرّ بيد الجهة،
      // فلا يُطالَب به المندوب ولا يُقبل توريده — سقفُ السطر بدونه كان يقبل نقداً عن مبلغٍ
      // سُدِّد في الدرج سلفاً ⇒ paidAmount يتجاوز الصافي وتنقلب ذمّة العميل سالبة.
      const remaining = round2(
        money(cn.codAmount)
          .minus(money(cn.collectedAmount))
          .minus(money(cn.counterSettledAmount ?? "0")),
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
      // ⚠️ ٢٢/٨ — الفحص **مبلغيٌّ لا وجوديّ**: كان يكفي وجودُ قيد
      // `PAYMENT_IN:COURIER_DELIVERY:{cn}` ليُصفَّر ائتمانُ الفاتورة كلّياً. وهو صحيحٌ ما دام
      // التسليم قبض COD كاملاً، لكنّ كشف الشركة يُجيز تحصيلاً **جزئياً**: كشفٌ يُثبت ١٢٬٠٠٠
      // من ٢٠٬٠٠٠ يكتب القيد، ثم يأتي توريدُ الـ٨٬٠٠٠ المتمِّم فيجد «القيد موجوداً» ⇒ النقد
      // يدخل الدرج والفاتورة تبقى ناقصةَ التسديد إلى الأبد — عكسُ العطب القديم تماماً.
      //
      // الميزان الصحيح: **المُحصَّل التراكمي − المقيَّد على الفاتورة سلفاً** من مسارَي هذه
      // الإرسالية حصراً (قيدُ التسليم `PAYMENT_IN:COURIER_DELIVERY:{cn}` + قيودُ التوريدات
      // `PAYMENT_IN:REMIT:{cn}:{rm}`). الصفوف الموروثة بلا قيد تسليم (نموذج ما قبل المرحلة
      // الثانية — يحرسه اختبار receptionReviewFixes/F2) تبقى كما كانت: مقيَّدُها صفر فيُقيَّد
      // المحصَّلُ كلُّه؛ والمختومة كاملاً عند التسليم يبقى ائتمانُها صفراً. ولا يتجاوز الائتمان
      // متبقّي الفاتورة الحيّ أبداً (تسديدٌ كاونتريّ موازٍ يخفضه من خارج هذين المفتاحين).
      const creditedRow = (
        await tx
          .select({
            v: sql<string>`COALESCE(SUM(CAST(${accountingEntries.amount} AS DECIMAL(15,2))), 0)`,
          })
          .from(accountingEntries)
          .where(and(
            eq(accountingEntries.entryType, "PAYMENT_IN"),
            or(
              eq(accountingEntries.dedupeKey, `PAYMENT_IN:COURIER_DELIVERY:${Number(cn.id)}`),
              sql`${accountingEntries.dedupeKey} LIKE ${`PAYMENT_IN:REMIT:${Number(cn.id)}:%`}`,
            ),
          ))
      )[0];
      const alreadyCredited = round2(money(creditedRow?.v ?? "0"));
      const newCollected = round2(money(cn.collectedAmount).plus(collected));
      const uncredited = Decimal.max(round2(newCollected.minus(alreadyCredited)), 0);
      const invoiceCredit = Decimal.min(
        collected,
        Decimal.max(invRemaining, 0),
        uncredited,
      );
      // الإغلاق المالي يقيس المتبقّي **الحيّ**: ما غطّاه الكاونتر ليس مطلوباً من الجهة، فتوريدُ
      // بقيّته يُقفل الإرسالية SETTLED — إبقاؤها PARTIAL كان يتركها زومبي في شاشة التوريد.
      const delivered = round2(
        newCollected.plus(money(cn.counterSettledAmount ?? "0")),
      ).gte(money(cn.codAmount));
      // الأجرة لا تُخصَم من التوريد إطلاقاً (٢٢/٨ — كان هنا فرعٌ ميّت `feeStillOwed=false`
      // يصف منطقاً غير موجود): COURIER يقبضها من الزبون مباشرةً، وCOUNTER/SHOP تُصرف بسند
      // مستقل (payDeliveryFee / payPartyDeliveryFees) بإيصال OUT خاصٍّ بها.
      work.push({
        id: Number(cn.id),
        invoiceId: Number(cn.invoiceId),
        collected,
        invoiceCredit,
        newCollected,
        delivered,
        remaining,
        fromMoneyStatus: cn.moneyStatus,
      });
      collectedTotal = collectedTotal.plus(collected);
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

    // Slice H (٢٩/٨/٢٦) — عمولة المندوب: إن كانت للجهة قاعدةٌ فعّالة، تُحسَب بحسبها لكل الأسطر
    // المشمولة بهذا التوريد وتُخزَّن على السجلّ. **حاليّاً informational فقط** — لا تُغيّر التدفّق
    // النقديّ (feesTotal + مسار payPartyDeliveryFees القائم بلا مساس). المدير يرى الرقم في تسوية
    // المندوب ويقارنه بالأجرة الفعلية قبل أيّ ضبطٍ يدويّ. القيدُ التلقائيّ الكاملُ يأتي في مرحلةٍ
    // لاحقة بعد اطلاع المالك على أرقامٍ حقيقيّةٍ من ميدانه.
    let courierCommissionAmount: Decimal | null = null;
    try {
      const { previewCommission } = await import("./commissionRules");
      // نستعمل fee-total الوسيط للجهة كأجرة توصيلٍ لمعاينة PERCENT_OF_FEE، وorder=collectedTotal لـPERCENT_OF_ORDER.
      // لـFLAT_PER_DELIVERY (المتوقّع): يُضرَب flatAmount في عدد الأسطر.
      const perLineQuotes = await Promise.all(
        input.lines.map(async () => {
          return previewCommission(tx as never, Number(input.partyId), Number(feesTotal.toFixed(2)) / Math.max(1, input.lines.length), Number(collectedTotal.toFixed(2)) / Math.max(1, input.lines.length));
        }),
      );
      const validQuotes = perLineQuotes.filter((q): q is NonNullable<typeof q> => q != null);
      if (validQuotes.length > 0) {
        const total = validQuotes.reduce((sum, q) => sum.plus(q.commission), new Decimal(0));
        courierCommissionAmount = round2(total);
      }
    } catch {
      // فشل معاينة العمولة لا يُبطل التوريد — informational فقط.
      courierCommissionAmount = null;
    }

    const rmRes = await tx.insert(deliveryRemittances).values({
      remittanceNumber,
      branchId: input.branchId,
      partyId: input.partyId,
      shiftId,
      collectedTotal: toDbMoney(collectedTotal),
      feesTotal: toDbMoney(feesTotal),
      courierCommissionAmount: courierCommissionAmount != null ? toDbMoney(courierCommissionAmount) : null,
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

    // إيصال درج IN = COD المُحصَّل كاملاً (سلامة الفاتورة). لا إيصال OUT للأجور هنا —
    // صرفُها بسنده المستقل في fees.ts. أمّا إيصال OUT للاستقطاع فيُربَط بـ`receiptOutId`
    // كي يُظهر المستندَ صراحةً لا ضمنياً (Codex P2 #6 — ٢٢/٨: نقدٌ خرج بلا حاشيةٍ في صفّ التوريد).
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
    // استقطاعُ الشركة: نقدٌ خرج بحكم أنّه لم يصل — إيصالُ OUT مستقلٌّ كي يبقى كلُّ مبلغٍ
    // منسوباً إلى سببه في تسوية الدرج وZ-report، ومصروفٌ مصنَّف يظهر في تقريره.
    if (deductionsTotal.gt(0)) {
      if (cashBucket === "TREASURY") assertTreasuryOutException("DELIVERY_REMITTANCE_CLEARING");
      // الحارس المركزي لكل CASH OUT (عقد cashNonnegativeCore): إيصالُ IN بكامل المُحصَّل كُتب
      // للتوّ في نفس المعاملة والاستقطاع ≤ المُحصَّل ⇒ يمرّ دائماً على درجٍ سليم، ولا يمرّ
      // على درجٍ سالبٍ موروث — صرفٌ غير مموَّل يُرفض لا يُقيَّد.
      await assertCashOutAvailable(tx, {
        branchId: input.branchId,
        cashBucket,
        shiftId,
        amount: deductionsTotal,
        operation: "استقطاع كشف شركة التوصيل من صافي التوريد",
      });
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
      receiptOutId = deductionReceiptId;
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
      // لا قيد أجرةٍ هنا: استحقاقُها يُسجَّل عند التسليم (courier.ts) وصرفُها بسند
      // payDeliveryFee / payPartyDeliveryFees — التوريد ينقل عهدة COD وحدها.
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
      // Slice H — يُعاد للواجهة كي تُظهره في تقرير التسوية جانبَ الأجرة الفعلية (مقارنةٌ سريعة).
      courierCommissionAmount: courierCommissionAmount != null ? courierCommissionAmount.toFixed(2) : null,
      netRemitted: netRemitted.toFixed(2),
      shortfallTotal: (shortfallTotal.lt(0)
        ? new Decimal(0)
        : shortfallTotal
      ).toFixed(2),
      status,
    };
  });
}
