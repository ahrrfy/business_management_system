// أجور التوصيل — صرفٌ بسند مستقلّ عن التوريد (فردياً لإرسالية، أو مجمّعاً لكل مستحقّات الجهة).
// المستحقّ يُشتقّ من دفتر التوصيل حصراً (FEE_EARNED − FEE_REFUNDED − FEE_PAID − FEE_OFFSET)
// لا من عمود deliveryFee: الدفترُ يعرف ما صُرف من أيّ مسارٍ كان، والعمود لا يعرف.
import { TRPCError } from "@trpc/server";
import type Decimal from "decimal.js";
import { and, eq, sql } from "drizzle-orm";
import { accountingEntries, deliveryConsignments, deliveryLedgerEntries, deliveryParties, invoices, receipts } from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { checkIdempotency, idempotencyHash, recordIdempotencyKey } from "../idempotency";
import { postEntry } from "../ledgerService";
import { money, round2, toDbMoney } from "../money";
import { resolveBranchCashShiftTx } from "../shiftService";
import { assertCashOutAvailable, lockCashSourceForUpdate } from "../cash/cashAvailability";
import { withTx } from "../tx";
import { appendDeliveryLedgerEntry } from "./lifecycle";
import { deliveryFeeHeldPayoutIntent, deliveryFeeSettlementIntent } from "./posting";
import type { DeliveryTxActor } from "./types";

/** المستحقّ الدفتري لأجرة إرسالية = Σ(FEE_EARNED − FEE_REFUNDED) − Σ(FEE_PAID + FEE_OFFSET). */
async function ledgerFeeDue(tx: Tx, consignmentId: number): Promise<Decimal> {
  const sums = (await tx.select({
    earned: sql<string>`COALESCE(SUM(CASE WHEN ${deliveryLedgerEntries.entryType} = 'FEE_EARNED' THEN ${deliveryLedgerEntries.amount} WHEN ${deliveryLedgerEntries.entryType} = 'FEE_REFUNDED' THEN -${deliveryLedgerEntries.amount} ELSE 0 END),0)`,
    paid: sql<string>`COALESCE(SUM(CASE WHEN ${deliveryLedgerEntries.entryType} IN ('FEE_PAID','FEE_OFFSET') THEN ${deliveryLedgerEntries.amount} ELSE 0 END),0)`,
  }).from(deliveryLedgerEntries).where(eq(deliveryLedgerEntries.consignmentId, consignmentId)))[0];
  return round2(money(sums?.earned ?? "0").minus(money(sums?.paid ?? "0")));
}

/**
 * أثر دفع أجرة إرسالية واحدة — قيد الدفتر التشغيلي + القيد المحاسبي + ختم `feeSettledAt`
 * عند اكتمال الدفع. **مشتركٌ حرفياً** بين السند الفردي والسند المجمّع كي لا ينجرف المساران:
 * COUNTER أمانةٌ تُبرَّأ (DELIVERY_FEE_HELD بإشارة سالبة، Σ المستند = 0 ⇔ مُبرَّأة)، وغيرها
 * تسويةُ التزامٍ مستحَقٍّ سلفاً (DELIVERY_FEE بلا مصروفٍ ثانٍ — المصروف قُيّد عند التسليم).
 */
async function postFeePayment(
  tx: Tx,
  cn: {
    id: number | string;
    branchId: number | string;
    partyId: number | string;
    invoiceId: number | string;
    consignmentNumber: string;
    feeCollection: string | null;
  },
  amount: Decimal,
  fullyPaid: boolean,
  receiptId: number,
  /** لاحقة مفاتيح idempotency للقيدين — clientRequestId للفردي، BULK:{receipt} للمجمّع. */
  keySuffix: string,
  actor: DeliveryTxActor,
): Promise<void> {
  await appendDeliveryLedgerEntry(tx, {
    eventKey: `CN:${cn.id}:FEE_PAID:${keySuffix}`,
    partyId: Number(cn.partyId),
    consignmentId: Number(cn.id),
    branchId: Number(cn.branchId),
    entryType: "FEE_PAID",
    amount: toDbMoney(amount),
    actorUserId: actor.userId,
  });
  await postEntry(tx, {
    entryType: cn.feeCollection === "COUNTER" ? "DELIVERY_FEE_HELD" : "DELIVERY_FEE",
    postingIntent: cn.feeCollection === "COUNTER"
      ? deliveryFeeHeldPayoutIntent(amount.neg(), "DRAWER")
      : deliveryFeeSettlementIntent(amount, "DRAWER"),
    postingSourceComponents: {
      roleDebits: { COURIER_PAYABLE: amount },
      roleCredits: { CASH: amount },
    },
    dedupeKey: `DELIVERY_FEE_PAID:${cn.id}:${keySuffix}`,
    branchId: Number(cn.branchId),
    invoiceId: Number(cn.invoiceId),
    deliveryPartyId: Number(cn.partyId),
    receiptId,
    amount: cn.feeCollection === "COUNTER" ? amount.neg() : amount,
    notes: `دفع أجرة ${cn.consignmentNumber}`,
  });
  if (fullyPaid) {
    await tx.update(deliveryConsignments).set({ feeSettledAt: new Date() }).where(eq(deliveryConsignments.id, Number(cn.id)));
  }
}

export async function payDeliveryFee(
  input: {
    consignmentId: number;
    shiftId: number;
    amount?: string | null;
    clientRequestId: string;
  },
  actor: DeliveryTxActor,
) {
  const hash = idempotencyHash(input);
  return withTx(async (tx) => {
    const replay = await checkIdempotency(tx, "delivery.payFee", input.clientRequestId, hash);
    if (replay != null) return { receiptId: replay, replay: true };
    const cnPreview = (
      await tx
        .select({
          branchId: deliveryConsignments.branchId,
          partyId: deliveryConsignments.partyId,
          invoiceId: deliveryConsignments.invoiceId,
        })
        .from(deliveryConsignments)
        .where(eq(deliveryConsignments.id, input.consignmentId))
        .limit(1)
    )[0];
    if (!cnPreview) throw new TRPCError({ code: "NOT_FOUND", message: "الإرسالية غير موجودة" });
    if (actor.role !== "admin" && actor.branchId != null && Number(cnPreview.branchId) !== Number(actor.branchId)) {
      throw new TRPCError({ code: "FORBIDDEN", message: "الإرسالية تخص فرعاً آخر" });
    }
    const resolved = await resolveBranchCashShiftTx(tx, Number(cnPreview.branchId), input.shiftId);
    await lockCashSourceForUpdate(tx, {
      branchId: Number(cnPreview.branchId), cashBucket: "DRAWER", shiftId: resolved.shiftId,
    });
    const party = (
      await tx.select({ id: deliveryParties.id }).from(deliveryParties)
        .where(eq(deliveryParties.id, Number(cnPreview.partyId))).for("update").limit(1)
    )[0];
    if (!party) throw new TRPCError({ code: "CONFLICT", message: "جهة توصيل الإرسالية غير موجودة" });
    const cn = (await tx.select().from(deliveryConsignments).where(eq(deliveryConsignments.id, input.consignmentId)).for("update").limit(1))[0];
    if (!cn) throw new TRPCError({ code: "NOT_FOUND", message: "الإرسالية غير موجودة" });
    if (
      Number(cn.branchId) !== Number(cnPreview.branchId) ||
      Number(cn.partyId) !== Number(cnPreview.partyId) ||
      Number(cn.invoiceId) !== Number(cnPreview.invoiceId)
    ) {
      throw new TRPCError({ code: "CONFLICT", message: "تغيّرت أطراف الإرسالية أثناء دفع الأجرة؛ أعد المحاولة" });
    }
    const invoice = (
      await tx.select({ id: invoices.id }).from(invoices)
        .where(eq(invoices.id, Number(cn.invoiceId))).for("update").limit(1)
    )[0];
    if (!invoice) throw new TRPCError({ code: "CONFLICT", message: "فاتورة الإرسالية غير موجودة" });
    if (cn.parcelStatus !== "DELIVERED") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "لا تستحق الأجرة قبل نجاح التوصيل" });
    if (actor.role !== "admin" && actor.branchId != null && Number(cn.branchId) !== Number(actor.branchId)) {
      throw new TRPCError({ code: "FORBIDDEN", message: "الإرسالية تخص فرعاً آخر" });
    }
    const due = await ledgerFeeDue(tx, input.consignmentId);
    const amount = round2(money(input.amount ?? due));
    if (amount.lte(0) || amount.gt(due)) throw new TRPCError({ code: "BAD_REQUEST", message: `المبلغ يجب أن يكون ضمن المستحق ${due.toFixed(2)}` });

    await assertCashOutAvailable(tx, {
      branchId: Number(cn.branchId), cashBucket: "DRAWER", shiftId: resolved.shiftId,
      amount, operation: "دفع أجرة التوصيل من الدرج",
    });
    const inserted = await tx.insert(receipts).values({
      branchId: Number(cn.branchId),
      shiftId: resolved.shiftId,
      invoiceId: Number(cn.invoiceId),
      direction: "OUT",
      amount: toDbMoney(amount),
      paymentMethod: "CASH",
      cashBucket: "DRAWER",
      status: "COMPLETED",
      partyType: "OTHER",
      referenceNumber: cn.consignmentNumber,
      description: `دفع أجرة توصيل ${cn.consignmentNumber}`,
      createdBy: actor.userId,
    });
    const receiptId = extractInsertId(inserted);
    await postFeePayment(tx, cn, amount, amount.eq(due), receiptId, input.clientRequestId, actor);
    await recordIdempotencyKey(tx, "delivery.payFee", input.clientRequestId, receiptId, hash);
    return { receiptId, paid: amount.toFixed(2), remaining: due.minus(amount).toFixed(2), replay: false };
  });
}

export interface PayPartyDeliveryFeesInput {
  partyId: number;
  branchId: number;
  shiftId: number;
  clientRequestId: string;
}

export interface PayPartyDeliveryFeesResult {
  receiptId: number;
  /** Σ المصروف فعلاً بهذا السند. */
  paidTotal: string;
  /** عدد الإرساليات التي صُرفت أجرتها. */
  count: number;
  replay: boolean;
}

/**
 * **صرف أجور الجهة مجمّعاً** (٢٢/٨): كل إرساليات الجهة المُسلَّمة (`parcelStatus=DELIVERED`)
 * ذات مستحقٍّ دفتريّ موجب تُصرف بسند صرفٍ واحد وقيودٍ لكل إرسالية.
 *
 * لماذا: الشركة تُسلّم عشرات الطرود دفعةً واحدة، وصرفُ كل أجرةٍ بسند `payDeliveryFee` مستقلّ
 * يعني عشرات الإيصالات لعملية دفعٍ واحدة — فكانت الأجور لا تُصرف أصلاً ويتراكم `feeDue`
 * التزاماً معلّقاً بلا نهاية. السند واحدٌ (إيصال OUT واحد يطابق النقد الخارج فعلاً من الدرج)
 * والقيود لكل إرسالية (نفس `postFeePayment` المشترك) — فيبقى كل دينارٍ منسوباً إلى طرده.
 *
 * idempotent بمفتاحٍ واحد للعملية كلّها: التكرار يُعيد نفس السند بنتيجته لا سنداً ثانياً.
 */
export async function payPartyDeliveryFees(
  input: PayPartyDeliveryFeesInput,
  actor: DeliveryTxActor,
): Promise<PayPartyDeliveryFeesResult> {
  const hash = idempotencyHash(input);
  return withTx(async (tx) => {
    /** إعادةُ نتيجة السند المسجَّل: المبلغ من إيصاله، والعدد من قيوده المحاسبية المرتبطة به. */
    const replayResult = async (receiptId: number): Promise<PayPartyDeliveryFeesResult> => {
      const receipt = (
        await tx.select({ amount: receipts.amount }).from(receipts).where(eq(receipts.id, receiptId)).limit(1)
      )[0];
      const cntRow = (
        await tx
          .select({ n: sql<number>`COUNT(*)` })
          .from(accountingEntries)
          .where(and(
            eq(accountingEntries.receiptId, receiptId),
            sql`${accountingEntries.entryType} IN ('DELIVERY_FEE','DELIVERY_FEE_HELD')`,
          ))
      )[0];
      return {
        receiptId,
        paidTotal: toDbMoney(round2(money(receipt?.amount ?? "0"))),
        count: Number(cntRow?.n ?? 0),
        replay: true,
      };
    };
    const replay = await checkIdempotency(tx, "delivery.payPartyFees", input.clientRequestId, hash);
    if (replay != null) return replayResult(replay);

    // نفس حارس الفرع الصفري في settle.ts: سندٌ على فرعٍ وهميّ يسقط من كل التقارير.
    if (!Number.isInteger(Number(input.branchId)) || Number(input.branchId) <= 0) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا فرع مسند لصرف الأجور — اختر الفرع صراحةً" });
    }
    if (actor.role !== "admin" && actor.branchId != null && Number(input.branchId) !== Number(actor.branchId)) {
      throw new TRPCError({ code: "FORBIDDEN", message: "صرف أجور فرعٍ آخر غير مسموح" });
    }

    // ترتيب الأقفال مرآةُ payDeliveryFee والتوريد حرفياً: مصدر النقد ← الجهة ← الإرساليات
    // تصاعدياً بمعرّفها (وفاتورةُ كلٍّ معها) — نفس الترتيب في كل مسار ⇒ لا جمود متقاطع.
    const resolved = await resolveBranchCashShiftTx(tx, Number(input.branchId), input.shiftId);
    await lockCashSourceForUpdate(tx, {
      branchId: Number(input.branchId), cashBucket: "DRAWER", shiftId: resolved.shiftId,
    });
    const party = (
      await tx.select({ id: deliveryParties.id, branchId: deliveryParties.branchId }).from(deliveryParties)
        .where(eq(deliveryParties.id, Number(input.partyId))).for("update").limit(1)
    )[0];
    if (!party) throw new TRPCError({ code: "NOT_FOUND", message: "جهة التوصيل غير موجودة" });
    if (party.branchId != null && Number(party.branchId) !== Number(input.branchId)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "جهة التوصيل لا تخصّ فرع الصرف" });
    }
    const replayAfterLock = await checkIdempotency(tx, "delivery.payPartyFees", input.clientRequestId, hash);
    if (replayAfterLock != null) return replayResult(replayAfterLock);

    // المرشّحون بلا قفل أولاً (المستحقّ يُعاد حسابه تحت القفل) — القفل الفعلي واحدةً واحدة
    // بترتيب المعرّف التصاعدي، وكلُّ صفٍّ يُعاد التحقق من أهليته بعد قفله (نمط التوريد).
    const candidates = await tx
      .select({ id: deliveryConsignments.id })
      .from(deliveryConsignments)
      .where(and(
        eq(deliveryConsignments.partyId, Number(input.partyId)),
        eq(deliveryConsignments.branchId, Number(input.branchId)),
        eq(deliveryConsignments.parcelStatus, "DELIVERED"),
      ))
      .orderBy(deliveryConsignments.id);

    type FeeItem = {
      cn: {
        id: number; branchId: number; partyId: number; invoiceId: number;
        consignmentNumber: string; feeCollection: string | null;
      };
      due: Decimal;
    };
    const items: FeeItem[] = [];
    let total = round2(money("0"));
    for (const candidate of candidates) {
      const cn = (
        await tx.select().from(deliveryConsignments)
          .where(eq(deliveryConsignments.id, Number(candidate.id))).for("update").limit(1)
      )[0];
      if (!cn) continue;
      if (
        Number(cn.partyId) !== Number(input.partyId)
        || Number(cn.branchId) !== Number(input.branchId)
        || cn.parcelStatus !== "DELIVERED"
      ) continue; // تغيّر بين الترشيح والقفل — يسقط من هذا السند بلا خطأ.
      const invoice = (
        await tx.select({ id: invoices.id }).from(invoices)
          .where(eq(invoices.id, Number(cn.invoiceId))).for("update").limit(1)
      )[0];
      if (!invoice) throw new TRPCError({ code: "CONFLICT", message: `فاتورة الإرسالية ${cn.consignmentNumber} غير موجودة` });
      const due = await ledgerFeeDue(tx, Number(cn.id));
      if (due.lte(0)) continue;
      items.push({
        cn: {
          id: Number(cn.id),
          branchId: Number(cn.branchId),
          partyId: Number(cn.partyId),
          invoiceId: Number(cn.invoiceId),
          consignmentNumber: cn.consignmentNumber,
          feeCollection: cn.feeCollection,
        },
        due,
      });
      total = round2(total.plus(due));
    }
    if (!items.length || total.lte(0)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا أجور مستحقّة للجهة على هذا الفرع" });
    }

    await assertCashOutAvailable(tx, {
      branchId: Number(input.branchId), cashBucket: "DRAWER", shiftId: resolved.shiftId,
      amount: total, operation: "صرف أجور توصيل مجمّع من الدرج",
    });
    const inserted = await tx.insert(receipts).values({
      branchId: Number(input.branchId),
      shiftId: resolved.shiftId,
      // سندٌ واحد لعدّة فواتير ⇒ لا invoiceId على الإيصال؛ النسبةُ لكل فاتورةٍ في قيودها.
      direction: "OUT",
      amount: toDbMoney(total),
      paymentMethod: "CASH",
      cashBucket: "DRAWER",
      status: "COMPLETED",
      partyType: "OTHER",
      referenceNumber: `DLV-FEES-${input.partyId}`,
      description: `صرف أجور توصيل مجمّع — جهة #${input.partyId} (${items.length} إرسالية)`,
      createdBy: actor.userId,
    });
    const receiptId = extractInsertId(inserted);
    for (const item of items) {
      // اللاحقة برقم الإيصال لا clientRequestId: القيود تظلّ قابلة للإحصاء عند الإعادة
      // (replayResult) بلا مطابقة نصوصٍ حرّة، والإيصالُ فريدٌ ففريدةٌ مفاتيحُه حتماً.
      await postFeePayment(tx, item.cn, item.due, true, receiptId, `BULK:${receiptId}`, actor);
    }
    await recordIdempotencyKey(tx, "delivery.payPartyFees", input.clientRequestId, receiptId, hash);
    return { receiptId, paidTotal: total.toFixed(2), count: items.length, replay: false };
  });
}
