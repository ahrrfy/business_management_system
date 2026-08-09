// ترحيل (D8): خصم الأجرة وتوريد الصافي. gross-up: PAYMENT_IN=COD كامل + DELIVERY_FEE=أجرة ⇒ صافي الدرج=المورَّد.
import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { eq } from "drizzle-orm";
import { deliveryConsignments, deliveryParties, deliveryRemittances, invoices, receipts } from "../../../drizzle/schema";
import { extractInsertId } from "../../lib/insertId";
import { checkIdempotency, idempotencyHash, recordIdempotencyKey } from "../idempotency";
import { adjustCustomerBalance, adjustDeliveryBalance, computeInvoiceStatus, postEntry } from "../ledgerService";
import { money, round2, toDbMoney } from "../money";
import { shiftIdForCashTx } from "../shiftService";
import { withTx } from "../tx";
import { nextRemittanceNumber } from "./numbering";
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
}

export async function recordDeliveryRemittance(input: RemittanceInput, actor: DeliveryTxActor) {
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
    if (input.clientRequestId) {
      const existingId = await checkIdempotency(tx, "delivery.remit", input.clientRequestId, payloadHash);
      if (existingId != null) {
        const rm = (await tx.select().from(deliveryRemittances).where(eq(deliveryRemittances.id, existingId)).limit(1))[0];
        const replayTotal = round2(input.lines.reduce((sum, line) => sum.plus(money(line.collectedAmount)), new Decimal(0)));
        if (
          !rm
          || Number(rm.branchId) !== Number(input.branchId)
          || Number(rm.partyId) !== Number(input.partyId)
          || !money(rm.collectedTotal).eq(replayTotal)
        ) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "تعارض idempotency: المفتاح مستعمل لتوريد مختلف",
          });
        }
        return {
          remittanceId: existingId,
          remittanceNumber: rm?.remittanceNumber ?? "",
          collectedTotal: String(rm?.collectedTotal ?? "0"),
          feesTotal: String(rm?.feesTotal ?? "0"),
          netRemitted: String(rm?.netRemitted ?? "0"),
          shortfallTotal: String(rm?.shortfallTotal ?? "0"),
          status: rm?.status ?? "BALANCED",
          idempotentReplay: true as const,
        };
      }
    }
    if (!input.lines.length) throw new TRPCError({ code: "BAD_REQUEST", message: "لا إرساليات للتسوية" });
    const uniqueConsignmentIds = new Set(input.lines.map((line) => line.consignmentId));
    if (uniqueConsignmentIds.size !== input.lines.length) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن تكرار الإرسالية نفسها داخل التوريد" });
    }

    const party = (await tx.select().from(deliveryParties).where(eq(deliveryParties.id, input.partyId)).for("update").limit(1))[0];
    if (!party) throw new TRPCError({ code: "NOT_FOUND", message: "جهة التوصيل غير موجودة" });
    if (party.branchId != null && Number(party.branchId) !== Number(input.branchId)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "جهة التوصيل لا تخصّ فرع التوريد" });
    }

    // المرور ١: قفل + تحقّق + حساب (بلا كتابة) — ترتيب أقفال الإرساليات تصاعدياً يمنع الجمود.
    type Work = { id: number; invoiceId: number; collected: Decimal; newCollected: Decimal; delivered: boolean; fee: Decimal; remaining: Decimal; feeCollection: string };
    const work: Work[] = [];
    let collectedTotal = new Decimal(0);
    let feesTotal = new Decimal(0);
    let expectedTotal = new Decimal(0);
    const sortedLines = [...input.lines].sort((a, b) => a.consignmentId - b.consignmentId);
    for (const line of sortedLines) {
      const cn = (await tx.select().from(deliveryConsignments).where(eq(deliveryConsignments.id, line.consignmentId)).for("update").limit(1))[0];
      if (!cn) throw new TRPCError({ code: "NOT_FOUND", message: `إرسالية ${line.consignmentId} غير موجودة` });
      if (Number(cn.partyId) !== input.partyId) throw new TRPCError({ code: "BAD_REQUEST", message: "إرسالية لجهة أخرى" });
      if (Number(cn.branchId) !== Number(input.branchId)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `إرسالية ${cn.consignmentNumber} تخصّ فرعاً آخر` });
      }
      if (cn.status !== "DISPATCHED" && cn.status !== "PARTIAL") throw new TRPCError({ code: "BAD_REQUEST", message: `إرسالية ${cn.consignmentNumber} غير قابلة للتسوية` });
      const collected = round2(money(line.collectedAmount));
      if (collected.lt(0)) throw new TRPCError({ code: "BAD_REQUEST", message: "مبلغ سالب" });
      // سطرٌ صفريّ يُستثنى كلياً (مراجعة عدائية ٩/٨): كان يقلب DISPATCHED إلى PARTIAL بصفر
      // تحصيل ويختمها remittanceId ⇒ «حُصِّل جزئياً» كاذبة تُقفل باب returnConsignment
      // («يُرجَع فقط إرسالٌ لم يُحصَّل منه شيء») على بضاعةٍ لم يُحصَّل منها شيء فعلاً.
      // غير المحصَّل ليس توريداً — يبقى DISPATCHED كما هو (يُرجَع أو يُورَّد لاحقاً).
      if (collected.isZero()) continue;
      const remaining = round2(money(cn.codAmount).minus(money(cn.collectedAmount)));
      if (collected.gt(remaining)) throw new TRPCError({ code: "BAD_REQUEST", message: `أكثر من المتبقّي للإرسالية ${cn.consignmentNumber}` });
      // مراجعة عدائية (٥/٨) — حزامٌ ثانٍ: السقف على متبقّي **الفاتورة** الحيّ لا الإرسالية وحدها.
      // codAmount لُقط لحظة الإرسال؛ تسديدٌ كاونتريّ لاحق (قبل حارس collectOnInvoice أو من مسارٍ
      // آخر) يخفض متبقّي الفاتورة دون علم الإرسالية ⇒ بلا هذا السقف يصير paidAmount > total
      // وتنقلب ذمّة العميل سالبة بقيدَي PAYMENT_IN لبيعٍ واحد.
      const invRow = (
        await tx
          .select({ total: invoices.total, paidAmount: invoices.paidAmount, returnedTotal: invoices.returnedTotal })
          .from(invoices)
          .where(eq(invoices.id, Number(cn.invoiceId)))
          .for("update")
          .limit(1)
      )[0];
      const invRemaining = invRow
        ? round2(money(invRow.total).minus(money(invRow.returnedTotal ?? "0")).minus(money(invRow.paidAmount)))
        : remaining;
      if (collected.gt(invRemaining)) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `المُحصَّل للإرسالية ${cn.consignmentNumber} يتجاوز متبقّي فاتورتها الحيّ (${invRemaining.toFixed(2)}) — سُدِّد جزءٌ في الكاونتر؛ سوِّ الفارق مع المندوب وأدخل المتبقّي فقط`,
        });
      }
      const newCollected = round2(money(cn.collectedAmount).plus(collected));
      const delivered = newCollected.gte(money(cn.codAmount));
      // ٥/٨ — الأجرة تُخصَم من التوريد فقط إذا كانت **ما زالت مستحقّةً علينا** للمندوب:
      //   COURIER ⇒ يقبضها من الزبون مباشرةً، خارج دفترنا كلّياً ⇒ لا خصم (كان الخصم هنا يصرفها
      //             مرّةً ثانيةً بعد أن قبضها بنفسه).
      //   feeSettledAt ⇒ صُرفت نقداً لحظة الإرسال ⇒ لا خصم (حارس الصرف المزدوج).
      // وتبقى مستحقّةً عند التسليم الكامل فقط (تسليمٌ جزئيّ لا يستحقّ أجرةً).
      const feeStillOwed = cn.feeCollection !== "COURIER" && cn.feeSettledAt == null;
      const fee = delivered && feeStillOwed ? round2(money(cn.deliveryFee)) : new Decimal(0);
      if (fee.gt(collected)) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `أجرة توصيل الإرسالية ${cn.consignmentNumber} تتجاوز النقد المورّد في هذه التسوية`,
        });
      }
      work.push({ id: Number(cn.id), invoiceId: Number(cn.invoiceId), collected, newCollected, delivered, fee, remaining, feeCollection: String(cn.feeCollection ?? "SHOP") });
      collectedTotal = collectedTotal.plus(collected);
      feesTotal = feesTotal.plus(fee);
      expectedTotal = expectedTotal.plus(remaining);
    }
    if (!work.length) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا مبالغ للتوريد — كل الأسطر صفرية. غير المحصَّل يبقى بالطريق (يُورَّد لاحقاً أو تُرجَع إرساليته)" });
    }
    collectedTotal = round2(collectedTotal);
    feesTotal = round2(feesTotal);
    const netRemitted = round2(collectedTotal.minus(feesTotal));
    const countedCash = round2(money(input.countedCash));
    if (countedCash.lt(0)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "النقد المعدود لا يمكن أن يكون سالباً" });
    }
    if (!countedCash.eq(netRemitted)) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: `النقد المعدود (${countedCash.toFixed(2)}) لا يطابق صافي التوريد المتوقع (${netRemitted.toFixed(2)}). راجع مبالغ الإرساليات والأجور قبل التأكيد.`,
      });
    }
    const shortfallTotal = round2(round2(expectedTotal).minus(collectedTotal)); // عجز يبقى عهدة (D4)
    const status: "BALANCED" | "SHORT" | "OVER" = shortfallTotal.gt("0.01") ? "SHORT" : shortfallTotal.lt("-0.01") ? "OVER" : "BALANCED";

    // درج المُستلِم (RECEPTION افتراضياً): صافي النقد (collected − fee) يدخله فعلياً.
    const { shiftId, cashBucket } = await shiftIdForCashTx(tx, { userId: actor.userId, branchId: actor.branchId ?? undefined, role: actor.role }, input.branchId, "توريد مندوب", input.shiftType ?? "RECEPTION");
    const remittanceNumber = await nextRemittanceNumber(tx, input.branchId);

    const rmRes = await tx.insert(deliveryRemittances).values({
      remittanceNumber,
      branchId: input.branchId,
      partyId: input.partyId,
      shiftId,
      collectedTotal: toDbMoney(collectedTotal),
      feesTotal: toDbMoney(feesTotal),
      netRemitted: toDbMoney(netRemitted),
      shortfallTotal: toDbMoney(shortfallTotal.lt(0) ? new Decimal(0) : shortfallTotal),
      status,
      receivedBy: actor.userId,
    });
    const remittanceId = extractInsertId(rmRes);

    // إيصال درج IN = COD المُحصَّل كاملاً (سلامة الفاتورة)، وOUT = الأجور (مصروف) ⇒ صافي الدرج = المورَّد.
    let receiptInId: number | null = null;
    let receiptOutId: number | null = null;
    if (collectedTotal.gt(0)) {
      const rIn = await tx.insert(receipts).values({
        branchId: input.branchId, shiftId, direction: "IN", amount: toDbMoney(collectedTotal),
        paymentMethod: "CASH", cashBucket, status: "COMPLETED", referenceNumber: remittanceNumber,
        partyType: "OTHER", description: `توريد تحصيلات مندوب ${remittanceNumber}`, createdBy: actor.userId,
      });
      receiptInId = extractInsertId(rIn);
    }
    if (feesTotal.gt(0)) {
      const rOut = await tx.insert(receipts).values({
        branchId: input.branchId, shiftId, direction: "OUT", amount: toDbMoney(feesTotal),
        paymentMethod: "CASH", cashBucket, status: "COMPLETED", referenceNumber: remittanceNumber,
        partyType: "OTHER", description: `أجور توصيل ${remittanceNumber}`, createdBy: actor.userId,
      });
      receiptOutId = extractInsertId(rOut);
    }
    await tx.update(deliveryRemittances).set({ receiptInId, receiptOutId }).where(eq(deliveryRemittances.id, remittanceId));

    // المرور ٢: تطبيق لكل إرسالية.
    for (const w of work) {
      const newStatus = w.delivered ? "DELIVERED" : "PARTIAL";
      await tx.update(deliveryConsignments).set({
        collectedAmount: toDbMoney(w.newCollected),
        status: newStatus,
        remittanceId,
        settledAt: w.delivered ? new Date() : null,
      }).where(eq(deliveryConsignments.id, w.id));

      if (w.collected.gt(0)) {
        const inv = (await tx.select({ total: invoices.total, paidAmount: invoices.paidAmount, customerId: invoices.customerId }).from(invoices).where(eq(invoices.id, w.invoiceId)).limit(1))[0];
        // تسوية الفاتورة بالـCOD المُحصَّل كاملاً (PAYMENT_IN) — يربط إيصال IN الدفعة.
        await postEntry(tx, {
          // dedupeKey بنيويّ (٩/٨): كان القيد الوحيد في مسارات التوصيل بلا مفتاح — محميّاً بمظلّة
          // idempotency التوريد وحدها؛ المفتاح يجعله محصَّناً بذاته كسائر قيود المنظومة.
          entryType: "PAYMENT_IN", dedupeKey: `PAYMENT_IN:REMIT:${w.id}:${remittanceId}`,
          branchId: input.branchId, invoiceId: w.invoiceId, receiptId: receiptInId,
          customerId: inv?.customerId != null ? Number(inv.customerId) : null,
          amount: w.collected, notes: `توريد ${remittanceNumber}`,
        });
        if (inv) {
          const newPaid = round2(money(inv.paidAmount).plus(w.collected));
          await tx.update(invoices).set({ paidAmount: toDbMoney(newPaid), status: computeInvoiceStatus(String(inv.total), toDbMoney(newPaid)), paymentDate: new Date() }).where(eq(invoices.id, w.invoiceId));
          // ش٠ (٥/٨، V14): فاتورةٌ آجلة **بعميلٍ مسجَّل** أُسندت للتوصيل (dispatchInvoice يُبقي
          // customerId) — سدّد الزبون للمندوب فذمّته تنخفض بما حُصِّل، مرآةً حرفيةً لمسار المتجر
          // (courier.ts). كان التوريد يرفع paidAmount ولا يمسّ currentBalance إطلاقاً ⇒ ذمّةٌ
          // لا تُغلق أبداً وكشفٌ يطالب من سدّد. (فواتير أوامر الشغل customerId=NULL عمداً ⇒ لا أثر.)
          if (inv.customerId != null) {
            await adjustCustomerBalance(tx, Number(inv.customerId), w.collected.neg());
          }
        }
        // خفض العهدة بالـCOD المُحصَّل كاملاً (الأجرة netting لا تَمسّ العهدة).
        await adjustDeliveryBalance(tx, input.partyId, w.collected.neg());
        await postEntry(tx, {
          entryType: "DELIVERY_REMIT", dedupeKey: `DELIVERY_REMIT:${w.id}:${remittanceId}`,
          branchId: input.branchId, invoiceId: w.invoiceId, deliveryPartyId: input.partyId, amount: w.collected,
        });
      }
      // الأجرة عند التسليم الكامل (يربط إيصال OUT الدفعة). ٥/٨ — تُصنَّف بحسب مَن تحمّلها:
      //   COUNTER ⇒ قبضناها من الزبون أمانةً ⇒ تمريرٌ (amount فقط) لا مصروف ⇒ صفر أثرٍ على الربح.
      //   SHOP    ⇒ المكتبة تحمّلتها فعلاً ⇒ مصروفٌ حقيقيّ (cost-only) كما كان.
      if (w.fee.gt(0)) {
        const passThrough = w.feeCollection === "COUNTER";
        await postEntry(tx, {
          entryType: passThrough ? "DELIVERY_FEE_HELD" : "DELIVERY_FEE",
          branchId: input.branchId, invoiceId: w.invoiceId, receiptId: receiptOutId,
          deliveryPartyId: input.partyId,
          // إشارة تبرئة الأمانة **سالبة** (٩/٨ — مرآة dispatch.ts وdispatchInvoice.ts حرفياً):
          // القبض في الدرج +fee والصرف للمندوب −fee ⇒ Σ(DELIVERY_FEE_HELD) للمستند = 0 ⇔ مُبرَّأة.
          // الفرع شبه ميت (COUNTER تُصرف لحظة الإرسال فيُختم feeSettledAt) لكن أيّ إرسالية قديمة
          // feeSettledAt=null كانت ستقيّد +fee فوق قيد القبض = ضعف الأجرة التزاماً وهمياً للأبد.
          amount: passThrough ? w.fee.neg() : w.fee,
          ...(passThrough ? {} : { cost: w.fee, profit: w.fee.neg() }),
          notes: `أجرة توصيل ${remittanceNumber}`,
        });
        await tx.update(deliveryConsignments).set({ feeSettledAt: new Date() }).where(eq(deliveryConsignments.id, w.id));
      }
    }

    if (input.clientRequestId) await recordIdempotencyKey(tx, "delivery.remit", input.clientRequestId, remittanceId, payloadHash);
    return {
      remittanceId, remittanceNumber,
      collectedTotal: collectedTotal.toFixed(2), feesTotal: feesTotal.toFixed(2),
      netRemitted: netRemitted.toFixed(2), shortfallTotal: (shortfallTotal.lt(0) ? new Decimal(0) : shortfallTotal).toFixed(2),
      status,
    };
  });
}
