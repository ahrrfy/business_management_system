// تسوية عهدة نقداً + شطب عجز عهدة كمصروف (مدير فقط، بلا نقد) + استرداد عجز مشطوب.
//
// حوكمة ٩/٨ (مراجعة عدائية): التسوية الحرّة والشطب المجمّع محصوران بالعهدة **السائبة**
// (currentBalance − Σ متبقّي الإرساليات المفتوحة) — تصفيةُ عهدةٍ مدعومةٍ بإرسالية من غير مسار
// التوريد كانت تترك الفاتورة غير مسدَّدة وذمّة العميل قائمة والإرسالية مفتوحة للأبد.
// وعجز إرساليةٍ بعينها يُشطَب **موجَّهاً** (consignmentId): يقفل الإرسالية WRITTEN_OFF ويقيّد
// الفاتورة وذمّة العميل — لأنّ دلالته «المندوب حصّل من الزبون وضيّع النقد»: الزبون بريء،
// والخسارة على المكتبة، ولا إرسالية زومبي تبقى في شاشة التوريد تقبل توريداً يقلب الرصيد سالباً.
import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  accountingEntries,
  deliveryConsignments,
  deliveryEvents,
  deliveryLedgerEntries,
  deliveryParties,
  deliveryRemittanceLines,
  deliveryRemittances,
  invoices,
  receipts,
} from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { checkIdempotency, idempotencyHash, recordIdempotencyKey } from "../idempotency";
import { adjustCustomerBalance, adjustDeliveryBalance, computeInvoiceStatus, postEntry } from "../ledgerService";
import { money, round2, toDbMoney } from "../money";
import { shiftIdForCashTx } from "../shiftService";
import { lockCashSourceForUpdate } from "../cash/cashAvailability";
import { withTx } from "../tx";
import { consignmentBackedBalance } from "./guards";
import { appendDeliveryEvent, appendDeliveryLedgerEntry } from "./lifecycle";
import { deliveryCustomerCollectionIntent, deliveryRemitIntent, deliveryWriteoffIntent, paymentAccountRole } from "./posting";
import type { DeliveryTxActor } from "./types";

/** تسوية عهدة: الجهة تدفع نقداً لخفض رصيدها (عجز توريدٍ سابق أو عهدة تحصيلات متجر). */
export interface SettleInput {
  branchId: number;
  partyId: number;
  amount: string;
  shiftType?: "RECEPTION" | "RETAIL";
  notes?: string | null;
  clientRequestId?: string | null;
}

/**
 * حارس الفرع الصفري (٢٢/٨): مديرٌ بلا فرعٍ مُسنَد كان يمرّر `branchId=0` (افتراض واجهةٍ صامت)
 * فتُكتب الإيصالات والقيود على فرعٍ لا وجود له — خارج كل تقرير وتسوية درجٍ ومطابقة مفرَّعة.
 * المال لا يُقيَّد على فرعٍ وهميّ: الرفض هنا أرخص من مطاردة قيودٍ يتيمة لاحقاً.
 */
function assertBranchAssigned(branchId: unknown, operation: string): void {
  const n = Number(branchId);
  if (!Number.isInteger(n) || n <= 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `لا فرع مسند لعملية ${operation} — اختر الفرع صراحةً قبل تنفيذها`,
    });
  }
}

export async function settleDeliveryBalance(input: SettleInput, actor: DeliveryTxActor) {
  return withTx(async (tx) => {
    assertBranchAssigned(input.branchId, "تسوية العهدة");
    const amount = round2(money(input.amount));
    const payloadHash = idempotencyHash({
      branchId: Number(input.branchId),
      partyId: Number(input.partyId),
      amount: toDbMoney(amount),
      shiftType: input.shiftType ?? "RECEPTION",
    });
    if (input.clientRequestId) {
      const existingId = await checkIdempotency(tx, "delivery.settle", input.clientRequestId, payloadHash);
      if (existingId != null) {
        const existing = (await tx.select().from(receipts).where(eq(receipts.id, existingId)).limit(1))[0];
        const expectedReference = `DLV-SETTLE-${input.partyId}`;
        if (
          !existing
          || Number(existing.branchId) !== Number(input.branchId)
          || existing.referenceNumber !== expectedReference
          || !money(existing.amount).eq(money(input.amount))
        ) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "تعارض idempotency: المفتاح مستعمل لتسوية عهدة مختلفة",
          });
        }
        return { receiptId: existingId, idempotentReplay: true as const };
      }
    }
    if (amount.lte(0)) throw new TRPCError({ code: "BAD_REQUEST", message: "المبلغ يجب أن يكون موجباً" });
    const resolvedCash = await shiftIdForCashTx(
      tx,
      { userId: actor.userId, branchId: actor.branchId ?? undefined, role: actor.role },
      input.branchId,
      "تسوية عهدة مندوب",
      input.shiftType ?? "RECEPTION",
    );
    await lockCashSourceForUpdate(tx, {
      branchId: input.branchId,
      cashBucket: resolvedCash.cashBucket,
      shiftId: resolvedCash.shiftId,
    });
    const party = (await tx.select().from(deliveryParties).where(eq(deliveryParties.id, input.partyId)).for("update").limit(1))[0];
    if (!party) throw new TRPCError({ code: "NOT_FOUND", message: "جهة التوصيل غير موجودة" });
    if (input.clientRequestId) {
      const replayAfterLock = await checkIdempotency(tx, "delivery.settle", input.clientRequestId, payloadHash);
      if (replayAfterLock != null) return { receiptId: replayAfterLock, idempotentReplay: true as const };
    }
    const balance = round2(money(party.currentBalance));
    if (party.branchId != null && Number(party.branchId) !== Number(input.branchId)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "جهة التوصيل لا تخصّ فرع التسوية" });
    }
    if (amount.gt(balance)) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: `مبلغ التسوية (${amount.toFixed(2)}) يتجاوز عهدة المندوب القائمة (${balance.toFixed(2)})`,
      });
    }
    // حوكمة ٩/٨ — التسوية الحرّة على العهدة السائبة فقط: نقدُ إرساليةٍ مفتوحة يُستلَم حصراً من
    // شاشة «تسوية المناديب» (التوريد) كي تُقيَّد فاتورتُه وتُخفَّض ذمّة عميله وتُقفَل إرساليته.
    // بدون هذا الحارس كان زرّ «تسوية» يصفّر العهدة ويترك الفاتورة PENDING للأبد وكشف العميل
    // يطالبه بما دفعه للمندوب فعلاً. (عهدة المتجر بلا إرساليات ⇒ سائبة بطبيعتها — لا تتأثّر.)
    const backed = await consignmentBackedBalance(tx, input.partyId);
    const loose = round2(balance.minus(backed));
    if (amount.gt(loose)) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: `المبلغ يتجاوز العهدة السائبة (${loose.toFixed(2)}) — ${backed.toFixed(2)} من العهدة مرتبطة بإرساليات مفتوحة تُسوَّى من شاشة «تسوية المناديب» (توريد بالإرسالية) كي تُقيَّد فواتيرها`,
      });
    }

    const rIn = await tx.insert(receipts).values({
      branchId: input.branchId, shiftId: resolvedCash.shiftId, direction: "IN", amount: toDbMoney(amount),
      paymentMethod: "CASH", cashBucket: resolvedCash.cashBucket, status: "COMPLETED", approvalStatus: "APPROVED", partyType: "OTHER",
      referenceNumber: `DLV-SETTLE-${input.partyId}`, description: input.notes ?? `تسوية عهدة جهة توصيل #${input.partyId}`, createdBy: actor.userId,
    });
    const receiptId = extractInsertId(rIn);
    await adjustDeliveryBalance(tx, input.partyId, amount.neg());
    await appendDeliveryLedgerEntry(tx, {
      eventKey: `PARTY:${input.partyId}:COD_REMITTED:RECEIPT:${receiptId}`,
      partyId: input.partyId,
      branchId: input.branchId,
      entryType: "COD_REMITTED",
      amount: toDbMoney(amount),
      actorUserId: actor.userId,
      notes: input.notes ?? "Loose delivery custody remittance",
    });
    await postEntry(tx, {
      entryType: "DELIVERY_REMIT", dedupeKey: `DELIVERY_SETTLE:${receiptId}`,
      postingIntent: deliveryRemitIntent(amount, resolvedCash.cashBucket),
      postingSourceComponents: {
        roleDebits: { [paymentAccountRole("CASH", resolvedCash.cashBucket)]: amount },
        roleCredits: { DELIVERY_FLOAT: amount },
      },
      branchId: input.branchId, deliveryPartyId: input.partyId, receiptId, amount, notes: "تسوية عهدة جهة توصيل",
    });
    if (input.clientRequestId) await recordIdempotencyKey(tx, "delivery.settle", input.clientRequestId, receiptId, payloadHash);
    return { receiptId, partyBalanceAfter: balance.minus(amount).toFixed(2) };
  });
}

/** شطب عجز عهدة كمصروف (مدير فقط، بلا نقد). consignmentId يوجّه الشطب لإرسالية بعينها. */
export interface WriteOffInput {
  branchId: number;
  partyId: number;
  amount: string;
  reason: string;
  /** إثباتٌ وصفيّ أو رابط مرفق؛ يلزم واحدٌ منهما على الأقل. */
  evidenceNote?: string | null;
  attachmentUrl?: string | null;
  /** شطب موجَّه: يقفل الإرسالية WRITTEN_OFF ويقيّد فاتورتها (المندوب حصّل وضيّع). */
  consignmentId?: number | null;
  clientRequestId?: string | null;
}

const WRITE_OFF_SOD_EVENT_TYPES = [
  "ASSIGNED",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
  "SUPPLEMENTARY_COLLECTION",
  "COUNTER_SETTLED",
] as const;

const WRITE_OFF_SOD_LEDGER_TYPES = [
  "COD_ASSIGNED",
  "COD_COLLECTED",
  "COD_REMITTED",
  "SHORTFALL_ASSIGNED",
] as const;

function normalizedWriteOffEvidence(input: WriteOffInput): {
  reason: string;
  evidenceNote: string | null;
  attachmentUrl: string | null;
  summary: string;
} {
  const reason = input.reason?.trim() ?? "";
  const evidenceNote = input.evidenceNote?.trim() || null;
  const attachmentUrl = input.attachmentUrl?.trim() || null;
  if (reason.length < 3) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "سبب الشطب مطلوب (٣ أحرف على الأقل)." });
  }
  if (!evidenceNote && !attachmentUrl) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "يلزم إثبات وصفي أو رابط مرفق قبل شطب عهدة COD.",
    });
  }
  const evidence = [evidenceNote ? `إثبات: ${evidenceNote}` : null, attachmentUrl ? `مرفق: ${attachmentUrl}` : null]
    .filter(Boolean)
    .join(" | ");
  return { reason, evidenceNote, attachmentUrl, summary: `${reason} | ${evidence}` };
}

/**
 * الحزام الخادمي لفصل مهام الشطب: حتى الأدمن لا يشطب عهدةً كان هو من أنشأها أو
 * أثبت تسليمها/تحصيلها أو استلم توريدها/سوّاها. لا نعتمد على إخفاء زر الواجهة.
 */
async function assertWriteOffSegregation(
  tx: Tx,
  input: WriteOffInput,
  actor: DeliveryTxActor,
  consignment: typeof deliveryConsignments.$inferSelect | null,
): Promise<void> {
  if (consignment) {
    if (consignment.dispatchedBy != null && Number(consignment.dispatchedBy) === actor.userId) {
      throw new TRPCError({ code: "FORBIDDEN", message: "من أرسل الإرسالية لا يعتمد شطب عهدتها (فصل مهام)." });
    }
    const [eventByActor] = await tx
      .select({ id: deliveryEvents.id })
      .from(deliveryEvents)
      .where(
        and(
          eq(deliveryEvents.consignmentId, Number(consignment.id)),
          eq(deliveryEvents.actorUserId, actor.userId),
          inArray(deliveryEvents.eventType, [...WRITE_OFF_SOD_EVENT_TYPES]),
        ),
      )
      .limit(1);
    if (eventByActor) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "من أثبت التسليم أو التحصيل لهذه الإرسالية لا يعتمد شطب عهدتها (فصل مهام).",
      });
    }
    const [ledgerByActor] = await tx
      .select({ id: deliveryLedgerEntries.id })
      .from(deliveryLedgerEntries)
      .where(
        and(
          eq(deliveryLedgerEntries.consignmentId, Number(consignment.id)),
          eq(deliveryLedgerEntries.createdBy, actor.userId),
          inArray(deliveryLedgerEntries.entryType, [...WRITE_OFF_SOD_LEDGER_TYPES]),
        ),
      )
      .limit(1);
    if (ledgerByActor) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "من سجّل تحصيل/توريد عهدة الإرسالية لا يعتمد شطبها (فصل مهام).",
      });
    }
    const [remittanceByActor] = await tx
      .select({ id: deliveryRemittances.id })
      .from(deliveryRemittanceLines)
      .innerJoin(deliveryRemittances, eq(deliveryRemittances.id, deliveryRemittanceLines.remittanceId))
      .where(
        and(
          eq(deliveryRemittanceLines.consignmentId, Number(consignment.id)),
          eq(deliveryRemittances.receivedBy, actor.userId),
        ),
      )
      .limit(1);
    if (remittanceByActor) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "مستلم توريد الإرسالية لا يعتمد شطب عهدتها (فصل مهام).",
      });
    }
    return;
  }

  const [looseLedgerByActor] = await tx
    .select({ id: deliveryLedgerEntries.id })
    .from(deliveryLedgerEntries)
    .where(
      and(
        eq(deliveryLedgerEntries.partyId, input.partyId),
        isNull(deliveryLedgerEntries.consignmentId),
        eq(deliveryLedgerEntries.createdBy, actor.userId),
        inArray(deliveryLedgerEntries.entryType, [...WRITE_OFF_SOD_LEDGER_TYPES]),
      ),
    )
    .limit(1);
  const [settlementByActor] = await tx
    .select({ id: receipts.id })
    .from(receipts)
    .where(
      and(
        eq(receipts.createdBy, actor.userId),
        eq(receipts.referenceNumber, `DLV-SETTLE-${input.partyId}`),
      ),
    )
    .limit(1);
  if (looseLedgerByActor || settlementByActor) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "من حصّل/ورّد/سوّى العهدة السائبة لا يعتمد شطبها (فصل مهام).",
    });
  }
}

/**
 * نواة الشطب داخل معاملة يملكها المستدعي. تستعملها دورة الاعتماد كي يكون ختم الطلب
 * والأثر المالي/التشغيلي وحدة ذرّية واحدة، ويبقى الغلاف العام متوافقاً مع المستدعين القدماء.
 */
export async function writeOffDeliveryShortfallInTx(
  tx: Tx,
  input: WriteOffInput,
  actor: DeliveryTxActor,
  options: {
    /** بعد قفل الجهة وقبل أي أثر؛ دورة الاعتماد تقفل الطلب وتطابق نسخته هنا. */
    beforeApply?: (party: typeof deliveryParties.$inferSelect) => Promise<void>;
    /** رمز داخلي لا يمرّ من API: الراوتر والخدمة أثبتا طلب تحكم معتمداً. */
    controlRequestAuthorized?: boolean;
  } = {},
) {
  if (actor.role !== "admin" && options.controlRequestAuthorized !== true) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "شطب عهدة COD يتطلب سلطة المالك/الأدمن.",
    });
  }
  assertBranchAssigned(input.branchId, "شطب العجز");
    const amount = round2(money(input.amount));
    const evidence = normalizedWriteOffEvidence(input);
    // ٩/٨ — payloadHash (كان findIdempotentRefId بلا hash): إعادة نفس المفتاح بمبلغ/سبب مختلف
    // كانت تعود «نجاحاً» صامتاً دون تطبيق — المدير يظنّ العجز الجديد مشطوباً وهو قائم.
    const payloadHash = idempotencyHash({
      branchId: Number(input.branchId),
      partyId: Number(input.partyId),
      amount: toDbMoney(amount),
      consignmentId: input.consignmentId != null ? Number(input.consignmentId) : null,
      reason: evidence.reason,
      evidenceNote: evidence.evidenceNote,
      attachmentUrl: evidence.attachmentUrl,
    });
    if (input.clientRequestId) {
      const existingId = await checkIdempotency(tx, "delivery.writeoff", input.clientRequestId, payloadHash);
      if (existingId != null) return { partyId: input.partyId, idempotentReplay: true as const };
    }
    const party = (await tx.select().from(deliveryParties).where(eq(deliveryParties.id, input.partyId)).for("update").limit(1))[0];
    if (!party) throw new TRPCError({ code: "NOT_FOUND", message: "جهة التوصيل غير موجودة" });
    if (amount.lte(0)) throw new TRPCError({ code: "BAD_REQUEST", message: "المبلغ يجب أن يكون موجباً" });
    // ٩/٨ — اتساق الفرع (مرآة settle/remit): خسارة الشطب كانت تقع على فرع الفاعل ولو خصّت
    // الجهةُ فرعاً آخر ⇒ أرباح الفروع المقارنة تكذب بلا أيّ انحراف في رصيد الجهة يكشفها.
    if (party.branchId != null && Number(party.branchId) !== Number(input.branchId)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "جهة التوصيل لا تخصّ فرع الشطب" });
    }
    if (amount.gt(round2(money(party.currentBalance)))) throw new TRPCError({ code: "BAD_REQUEST", message: "الشطب يتجاوز العهدة القائمة" });
    await options.beforeApply?.(party);

    let invoiceId: number | null = null;
    if (input.consignmentId != null) {
      // شطب موجَّه — دلالته «الزبون سدّد للمندوب والمندوب ضيّع النقد»: نغلق القصّة الثلاثية
      // كاملةً (عهدة/فاتورة/إرسالية) وإلا بقيت الإرسالية زومبي في شاشة التوريد تقبل توريداً
      // لاحقاً يقلب الرصيد سالباً ويُبقي خسارة الشطب مقيَّدة عن دينارٍ وصل (مراجعة عدائية ٩/٨).
      const cn = (await tx.select().from(deliveryConsignments).where(eq(deliveryConsignments.id, Number(input.consignmentId))).for("update").limit(1))[0];
      if (!cn) throw new TRPCError({ code: "NOT_FOUND", message: "الإرسالية غير موجودة" });
      if (Number(cn.partyId) !== Number(input.partyId)) throw new TRPCError({ code: "BAD_REQUEST", message: "الإرسالية لجهة أخرى" });
      if (Number(cn.branchId) !== Number(input.branchId)) throw new TRPCError({ code: "BAD_REQUEST", message: "الإرسالية تخصّ فرعاً آخر" });
      if (cn.parcelStatus !== "DELIVERED" || (cn.moneyStatus !== "UNSETTLED" && cn.moneyStatus !== "PARTIAL")) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `لا يمكن شطب ${cn.consignmentNumber} قبل إثبات التسليم الفعلي أو بعد إغلاقها المالي` });
      }
      await assertWriteOffSegregation(tx, input, actor, cn);
      const remaining = round2(money(cn.codAmount).minus(money(cn.collectedAmount)));
      if (!amount.eq(remaining)) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `شطب الإرسالية ${cn.consignmentNumber} يكون بكامل متبقّيها (${remaining.toFixed(2)}) — المُحصَّل جزئياً يُورَّد أولاً من شاشة التسوية`,
        });
      }
      invoiceId = Number(cn.invoiceId);
      // الفاتورة تُقيَّد بالمبلغ (الزبون دفع للمندوب — ذمّته تُبرَّأ) والخسارة على المكتبة.
      const inv = (await tx.select({ total: invoices.total, paidAmount: invoices.paidAmount, returnedTotal: invoices.returnedTotal, customerId: invoices.customerId }).from(invoices).where(eq(invoices.id, invoiceId)).for("update").limit(1))[0];
      if (!inv) throw new TRPCError({ code: "NOT_FOUND", message: "فاتورة الإرسالية غير موجودة" });
      // «الحزام الثاني» (مراجعة عدائية ٩/٨ — مرآة remittance.ts حرفياً): codAmount لُقط لحظة
      // الإرسال وقد ينحرف عن الفاتورة الحيّة (مرتجع جزئي قبل الإسناد، أو تسديد كاونتري سابق
      // لحارس sales.pay). القيد المالي (paidAmount/ذمّة العميل/الخسارة) يُسقَف بمتبقّي الفاتورة
      // **الحيّ** — والفائض عهدةٌ وهمية تُصفّى بلا قيد فاتورة ولا خسارة (لم تكن مالاً مستحقاً
      // أصلاً). بدونه: paidAmount > الصافي، ذمّة العميل تنقلب سالبة، وخسارةٌ عن دينارٍ لم يوجد.
      const invRemaining = round2(money(inv.total).minus(money(inv.returnedTotal ?? "0")).minus(money(inv.paidAmount)));
      const realPart = amount.lte(invRemaining) ? amount : (invRemaining.gt(0) ? invRemaining : round2(money("0")));
      if (realPart.gt(0)) {
        const newPaid = round2(money(inv.paidAmount).plus(realPart));
        await tx.update(invoices).set({
          paidAmount: toDbMoney(newPaid),
          status: computeInvoiceStatus(String(inv.total), toDbMoney(newPaid), String(inv.returnedTotal ?? "0")),
          paymentDate: new Date(),
          paymentMethod: sql`COALESCE(${invoices.paymentMethod}, 'CASH')`,
        }).where(eq(invoices.id, invoiceId));
        await postEntry(tx, {
          entryType: "PAYMENT_IN", dedupeKey: `PAYMENT_IN:WRITEOFF:CN:${cn.id}`,
          postingIntent: deliveryCustomerCollectionIntent(realPart),
          branchId: input.branchId, invoiceId,
          customerId: inv.customerId != null ? Number(inv.customerId) : null,
          deliveryPartyId: input.partyId,
          amount: realPart, notes: `تسوية شطب عهدة — إرسالية ${cn.consignmentNumber}`,
        });
        if (inv.customerId != null) await adjustCustomerBalance(tx, Number(inv.customerId), realPart.neg());
      }
      await tx.update(deliveryConsignments).set({
        collectedAmount: toDbMoney(round2(money(cn.collectedAmount).plus(realPart))),
        status: "WRITTEN_OFF",
        moneyStatus: "WRITTEN_OFF",
        settledAt: new Date(),
      }).where(eq(deliveryConsignments.id, Number(cn.id)));
      // **الخسارة الحقيقية = ما كان مالاً فعلاً** (٢٢/٨ — كان القيد يمرّر cost=amount كاملاً
      // فيضخّم P&L بالجزء الوهمي، وسقفُ recoverDeliveryWriteOff — المبنيُّ على Σcost — يسمح
      // تبعاً باسترداد نقدٍ لم يوجد). مكوّناها:
      //   ① realPart: ذمّةٌ حيّة تُبرَّأ الآن (الزبون دفع للمندوب) — إسقاطُها خسارة.
      //   ② custodyHeld: نقدٌ مثبتُ التحصيل بدليل دفتر التوصيل (Σ COD_COLLECTED − Σ COD_REMITTED
      //      لهذه الإرسالية) ضاع بيد المندوب — خسارةُ نقدٍ حقيقيّ ولو كانت الفاتورة مسدَّدةً
      //      سلفاً لحظةَ التسليم (المسار الحديث: realPart=0 هناك دائماً والخسارةُ واقعة).
      // وما زاد عنهما انحرافُ codAmount عن الواقع (مرتجع/تسديد سبق الإسناد بلا علم الإرسالية)
      // — يُصفّى بلا خسارةٍ ولا استرداد. وقيد WRITEOFF يبقى بكامل المبلغ (صيغة مطابقة العهدة
      // DISPATCH−REMIT−WRITEOFF في reconcileDeliveryFloat تتطلبه) وcost/profit على الحقيقي وحده.
      const custodyRow = (
        await tx
          .select({
            v: sql<string>`COALESCE(SUM(CASE
              WHEN ${deliveryLedgerEntries.entryType} = 'COD_COLLECTED' THEN ${deliveryLedgerEntries.amount}
              WHEN ${deliveryLedgerEntries.entryType} = 'COD_REMITTED' THEN -${deliveryLedgerEntries.amount}
              ELSE 0 END), 0)`,
          })
          .from(deliveryLedgerEntries)
          .where(eq(deliveryLedgerEntries.consignmentId, Number(cn.id)))
      )[0];
      const custodyHeld = round2(Decimal.max(money(custodyRow?.v ?? "0"), 0));
      const realLoss = round2(Decimal.min(amount, realPart.plus(custodyHeld)));
      const phantomCleared = round2(amount.minus(realLoss));
      await adjustDeliveryBalance(tx, input.partyId, amount.neg());
      await appendDeliveryLedgerEntry(tx, {
        eventKey: `CN:${cn.id}:COD_WRITTEN_OFF`,
        partyId: input.partyId,
        consignmentId: Number(cn.id),
        branchId: input.branchId,
        entryType: "COD_WRITTEN_OFF",
        amount: toDbMoney(amount),
        actorUserId: actor.userId,
        notes: evidence.summary.slice(0, 500),
      });
      await appendDeliveryEvent(tx, {
        eventKey: `CN:${cn.id}:MONEY_WRITTEN_OFF`,
        consignmentId: Number(cn.id),
        eventType: "MONEY_WRITTEN_OFF",
        fromParcelStatus: cn.parcelStatus,
        toParcelStatus: cn.parcelStatus,
        fromMoneyStatus: cn.moneyStatus,
        toMoneyStatus: "WRITTEN_OFF",
        actorUserId: actor.userId,
        payload: {
          amount: toDbMoney(amount),
          reason: evidence.reason,
          evidenceNote: evidence.evidenceNote,
          attachmentUrl: evidence.attachmentUrl,
        },
      });
      await postEntry(tx, {
        entryType: "DELIVERY_WRITEOFF",
        // ٢٢/٨ (Codex P2 #2): الدفتر المزدوج (P2) عمومياً معطَّل الآن (CLAUDE.md §٦)، لكن حين
        // يُفعَّل ستُنشأ عقيدةُ LOSSES=amount بينما `cost=realLoss` — تناقضٌ بين P&L (realLoss)
        // والدفتر (amount). الحلّ الصحيح: تقسيمُ القيد لثلاث ساقين (LOSSES=realLoss +
        // CUSTODY_CLEARING=phantomCleared ⇒ DELIVERY_FLOAT=amount) وإضافة حسابٍ وسيط للتصفية.
        // مؤجَّلٌ لتذكرةٍ منفصلة تُطلَق مع تفعيل P2؛ اليوم الأثر صفريّ خارج ذلك المسار.
        postingIntent: deliveryWriteoffIntent(amount),
        dedupeKey: `DELIVERY_WRITEOFF:CN:${input.consignmentId}`,
        branchId: input.branchId, deliveryPartyId: input.partyId, invoiceId,
        amount, cost: realLoss, profit: realLoss.neg(),
        notes: `شطب عهدة: ${evidence.summary}${phantomCleared.gt(0) ? ` (منها ${phantomCleared.toFixed(2)} تصفية عهدة زائدة عن الحقيقي — بلا خسارة)` : ""}`,
      });
      if (input.clientRequestId) await recordIdempotencyKey(tx, "delivery.writeoff", input.clientRequestId, input.partyId, payloadHash);
      return { partyId: input.partyId, partyBalanceAfter: round2(money(party.currentBalance).minus(amount)).toFixed(2) };
    } else {
      // شطب مجمّع (بلا إرسالية) — على العهدة السائبة فقط، وإلا أُخفي عجز إرساليةٍ حيّة دون
      // إغلاق فاتورتها (نفس حارس settle حرفياً).
      const backed = await consignmentBackedBalance(tx, input.partyId);
      const loose = round2(money(party.currentBalance).minus(backed));
      if (amount.gt(loose)) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `المبلغ يتجاوز العهدة السائبة (${loose.toFixed(2)}) — عجز إرساليةٍ بعينها يُشطَب موجَّهاً باختيار الإرسالية كي تُقفَل وتُقيَّد فاتورتها`,
        });
      }
      await assertWriteOffSegregation(tx, input, actor, null);
    }

    // الشطب المجمّع (السائب): شطبٌ بلا نقد — خسارة فقط (cost-only) ⇒ لا إيصال درج.
    await adjustDeliveryBalance(tx, input.partyId, amount.neg());
    await appendDeliveryLedgerEntry(tx, {
      eventKey: `PARTY:${input.partyId}:COD_WRITTEN_OFF:${input.clientRequestId ?? crypto.randomUUID()}`,
      partyId: input.partyId,
      branchId: input.branchId,
      entryType: "COD_WRITTEN_OFF",
      amount: toDbMoney(amount),
      actorUserId: actor.userId,
      notes: evidence.summary.slice(0, 500),
    });
    await postEntry(tx, {
      entryType: "DELIVERY_WRITEOFF",
      postingIntent: deliveryWriteoffIntent(amount),
      branchId: input.branchId, deliveryPartyId: input.partyId, invoiceId,
      amount, cost: amount, profit: amount.neg(), notes: `شطب عهدة: ${evidence.summary}`,
    });
    if (input.clientRequestId) await recordIdempotencyKey(tx, "delivery.writeoff", input.clientRequestId, input.partyId, payloadHash);
  return { partyId: input.partyId, partyBalanceAfter: round2(money(party.currentBalance).minus(amount)).toFixed(2) };
}

export async function writeOffDeliveryShortfall(input: WriteOffInput, actor: DeliveryTxActor) {
  return withTx((tx) => writeOffDeliveryShortfallInTx(tx, input, actor));
}

/** استرداد عجز مشطوب: المندوب أعاد نقداً سبق شطبُه — يعكس الخسارة ويُدخل النقد الدرج. */
export interface RecoverWriteOffInput {
  branchId: number;
  partyId: number;
  amount: string;
  shiftType?: "RECEPTION" | "RETAIL";
  notes?: string | null;
  clientRequestId?: string | null;
}

/**
 * قبل ٩/٨ لم يكن لهذا النقد أيّ مسار: الرصيد صفر بعد الشطب ⇒ settle يرفض (يتجاوز العهدة)،
 * والتوريد يرفض (الإرسالية WRITTEN_OFF/مغلقة) ⇒ إمّا يُردّ النقد للمندوب (!) أو يدخل الدرج
 * بلا قيد فيكسر إغلاق الوردية. المحاسبة: عكس شطبٍ ثم تسويته فوراً — قيدان متعاكسان على
 * العهدة (رصيد الجهة لا يتغيّر، صيغة مطابقة deliveryFloat تبقى متوازنة: −(−شطب) −توريد = 0)
 * وخسارة الشطب تُعكَس من P&L (cost سالب) والنقد يدخل الدرج بإيصال IN.
 */
export async function recoverDeliveryWriteOff(input: RecoverWriteOffInput, actor: DeliveryTxActor) {
  return withTx(async (tx) => {
    assertBranchAssigned(input.branchId, "استرداد العجز المشطوب");
    const amount = round2(money(input.amount));
    const payloadHash = idempotencyHash({
      branchId: Number(input.branchId),
      partyId: Number(input.partyId),
      amount: toDbMoney(amount),
    });
    if (input.clientRequestId) {
      const existingId = await checkIdempotency(tx, "delivery.recoverWriteoff", input.clientRequestId, payloadHash);
      if (existingId != null) return { receiptId: existingId, idempotentReplay: true as const };
    }
    if (amount.lte(0)) throw new TRPCError({ code: "BAD_REQUEST", message: "المبلغ يجب أن يكون موجباً" });
    const resolvedCash = await shiftIdForCashTx(
      tx,
      { userId: actor.userId, branchId: actor.branchId ?? undefined, role: actor.role },
      input.branchId,
      "استرداد عجز مشطوب",
      input.shiftType ?? "RECEPTION",
    );
    await lockCashSourceForUpdate(tx, {
      branchId: input.branchId,
      cashBucket: resolvedCash.cashBucket,
      shiftId: resolvedCash.shiftId,
    });
    const party = (await tx.select().from(deliveryParties).where(eq(deliveryParties.id, input.partyId)).for("update").limit(1))[0];
    if (!party) throw new TRPCError({ code: "NOT_FOUND", message: "جهة التوصيل غير موجودة" });
    if (input.clientRequestId) {
      const replayAfterLock = await checkIdempotency(tx, "delivery.recoverWriteoff", input.clientRequestId, payloadHash);
      if (replayAfterLock != null) return { receiptId: replayAfterLock, idempotentReplay: true as const };
    }
    if (party.branchId != null && Number(party.branchId) !== Number(input.branchId)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "جهة التوصيل لا تخصّ فرع الاسترداد" });
    }
    // السقف = صافي **الخسارة المشطوبة** تاريخياً (Σ cost − Σ استرداداتها) **على نفس الفرع** — لا
    // يُستردّ ما لم يُشطَب، وعكسُ الخسارة يقع على الفرع الذي حملها أصلاً (مراجعة عدائية ٩/٨: جهة
    // مشتركة branchId=NULL شُطبت على الرئيسي واستُردّت من فرع المبيعات = أرباح الفرعين تكذب
    // بالاتجاهين رغم اتزان مستوى الشركة).
    //
    // ⚠️ السقف بـ`cost` لا `amount` (١٠/٨، واكتمل إنفاذه ٢٢/٨): الشطب الموجَّه يقيّد `amount`
    // بكامل متبقّي العهدة لكنّ `cost` (الخسارة الفعلية) = الذمّةُ الحيّة المُبرَّأة (`realPart`)
    // + النقدُ مثبتُ التحصيل بدفتر التوصيل (`custodyHeld`) — والفائضُ «عهدة زائدة بلا خسارة».
    // الاسترداد يعكس خسارةً + يُدخل نقداً؛ سقفُه بـ`amount` كان يسمح باسترداد نقدٍ/عكسِ ربحٍ
    // يفوق ما خُسِر فعلاً (نقدٌ وهميّ في الدرج + P&L منتفخ). بـ`cost` يُسقَف بالخسارة الحقيقية
    // المتبقّية (الشطب المجمّع cost=amount ⇒ بلا تغيير).
    const woRow = (
      await tx
        .select({ v: sql<string>`COALESCE(SUM(CAST(${accountingEntries.cost} AS DECIMAL(15,2))), 0)` })
        .from(accountingEntries)
        .where(and(
          eq(accountingEntries.entryType, "DELIVERY_WRITEOFF"),
          eq(accountingEntries.deliveryPartyId, input.partyId),
          eq(accountingEntries.branchId, input.branchId),
        ))
    )[0];
    const writtenOffNet = round2(money(woRow?.v ?? "0"));
    if (amount.gt(writtenOffNet)) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: `المبلغ يتجاوز صافي الخسارة المشطوبة لهذه الجهة على هذا الفرع (${writtenOffNet.toFixed(2)}) — الاسترداد يُسجَّل على فرع الشطب الأصلي`,
      });
    }

    const rIn = await tx.insert(receipts).values({
      branchId: input.branchId, shiftId: resolvedCash.shiftId, direction: "IN", amount: toDbMoney(amount),
      paymentMethod: "CASH", cashBucket: resolvedCash.cashBucket, status: "COMPLETED", approvalStatus: "APPROVED", partyType: "OTHER",
      referenceNumber: `DLV-RECOVER-${input.partyId}`,
      description: input.notes ?? `استرداد عجز مشطوب — جهة توصيل #${input.partyId}`, createdBy: actor.userId,
    });
    const receiptId = extractInsertId(rIn);
    await appendDeliveryLedgerEntry(tx, {
      eventKey: `PARTY:${input.partyId}:COD_RECOVERED:RECEIPT:${receiptId}`,
      partyId: input.partyId,
      branchId: input.branchId,
      entryType: "COD_RECOVERED",
      amount: toDbMoney(amount),
      actorUserId: actor.userId,
      notes: input.notes ?? "Recovered written-off delivery custody",
    });
    // قيدان متعاكسان على العهدة (عكس شطب + توريد) — الرصيد صافيه صفر والصيغة متوازنة.
    await postEntry(tx, {
      entryType: "DELIVERY_WRITEOFF", dedupeKey: `DELIVERY_WRITEOFF_RECOVER:${receiptId}`,
      postingIntent: deliveryWriteoffIntent(amount.neg()),
      branchId: input.branchId, deliveryPartyId: input.partyId, receiptId,
      amount: amount.neg(), cost: amount.neg(), profit: amount,
      notes: `عكس شطب — استرداد نقدي${input.notes ? `: ${input.notes}` : ""}`,
    });
    await postEntry(tx, {
      entryType: "DELIVERY_REMIT", dedupeKey: `DELIVERY_RECOVER_SETTLE:${receiptId}`,
      postingIntent: deliveryRemitIntent(amount, resolvedCash.cashBucket),
      postingSourceComponents: {
        roleDebits: { [paymentAccountRole("CASH", resolvedCash.cashBucket)]: amount },
        roleCredits: { DELIVERY_FLOAT: amount },
      },
      branchId: input.branchId, deliveryPartyId: input.partyId, receiptId,
      amount, notes: "تسوية استرداد عجز مشطوب",
    });
    if (input.clientRequestId) await recordIdempotencyKey(tx, "delivery.recoverWriteoff", input.clientRequestId, receiptId, payloadHash);
    return { receiptId, recovered: amount.toFixed(2) };
  });
}
