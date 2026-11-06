import { TRPCError } from "@trpc/server";
import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { digitalIntentSettlements, digitalRefundItems, digitalRefundPayments } from "../../../drizzle/digitalSettlementSchema";
import { auditLogs, digitalSaleDetails, digitalSaleIntents, externalPaymentAttempts, invoices, receipts } from "../../../drizzle/schema";
import { appErrorMessage } from "../../../shared/errors";
import { digitalRefundMethodAllowed, type DigitalCardRefundControl, type DigitalRefundTender } from "../../../shared/digitalPaymentSettlement";
import type { Tx } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { assertCashOutAvailable, assertTreasuryOutException } from "../cash/cashAvailability";
import { money, sumMoney, toDbMoney } from "../money";
import { resolveApprovalActor } from "../approval/ownerGate";
import { postEntry } from "../ledgerService";
import { createPostingIntent, creditLine, debitLine } from "../accounting/postingEngine";
import type { Actor } from "../tx";
import { loadRefundCaps } from "../returns/refundCaps";
import { digitalInvoiceReturnAmounts } from "../returns/cashRounding";

function refundError(why: string): never {
  throw new TRPCError({ code: "CONFLICT", message: appErrorMessage({
    what: "تعذّر تسوية رد قيمة الكروت", why,
    doThis: "راجع أصل القبض ومبلغ الرد؛ أكّد الرد الفعلي على البطاقة أو اختر صرفاً معتمداً من الخزينة، ولا تكرر دفع المبلغ",
  }) });
}

export type DigitalRefundContext = {
  branchId: number; invoiceId: number | null; intentId: number | null; originalAttemptId: number | null;
  originalMethod: "CASH" | "CARD" | "CREDIT"; operationKey: string; amount: string;
  detailIds: number[]; reason: string; customerId: number | null;
  outcome: "REVERSAL" | "LOSS_REFUND" | null;
  returnAmount?: string; roundingAdjustment?: string; fullyReturned?: boolean;
  replayedZeroReturn?: boolean;
};

function assertBranch(branchId: number, actor: Actor) {
  if (actor.role !== "admin" && actor.branchId !== branchId) refundError("أصل القبض يخص فرعاً آخر");
}

/** Must follow the owning operation's authorization; this reads the locked persisted source. */
export async function invoiceDigitalRefundContext(tx: Tx, input: {
  invoiceId: number; detailIds: number[]; kind: "REVERSED" | "LOSS_REFUND"; reason: string;
}, actor: Actor, mode: "WRITE" | "PREVIEW" = "WRITE"): Promise<DigitalRefundContext> {
  const ids = Array.from(new Set(input.detailIds)).sort((a, b) => a - b);
  if (!ids.length || ids.length !== input.detailIds.length) refundError("بنود الرد فارغة أو مكررة");
  const [invoice] = await tx.select().from(invoices).where(eq(invoices.id, input.invoiceId)).for("update").limit(1);
  if (!invoice) refundError("الفاتورة غير موجودة");
  assertBranch(Number(invoice.branchId), actor);
  const details = await tx.select().from(digitalSaleDetails)
    .where(and(eq(digitalSaleDetails.invoiceId, input.invoiceId), inArray(digitalSaleDetails.id, ids))).orderBy(digitalSaleDetails.id).for("update");
  if (details.length !== ids.length) refundError("بنود الرد لا تخص الفاتورة المطلوبة");
  const expected = input.kind === "REVERSED" ? "ISSUED" : "LOSS_REFUND_PENDING";
  const operationKey = `DIGITAL_REFUND:${input.invoiceId}:${input.kind}:${createHash("sha256").update(ids.join(",")).digest("hex")}`;
  const [prior] = await tx.select().from(digitalRefundPayments).where(eq(digitalRefundPayments.operationKey, operationKey)).for("update").limit(1);
  const completedItems = await tx.select().from(digitalRefundItems).where(inArray(digitalRefundItems.detailId, ids)).for("update");
  const replayedZeroReturn = !prior && completedItems.length === ids.length && completedItems.every((item) => item.refundId == null
    && item.occurredAt != null && item.outcome === (input.kind === "REVERSED" ? "REVERSAL" : "LOSS_REFUND"));
  if (details.some((d) => d.fulfillmentStatus !== expected) && prior?.status !== "COMPLETED" && !replayedZeroReturn) {
    refundError(input.kind === "LOSS_REFUND" ? "كرت ليس عليه طلب ردّ خسارةٍ معلّق" : "كرت عولِج مسبقاً أو لا يحمل طلب الرد المطلوب");
  }
  const sell = sumMoney(details.map((d) => d.sellPriceSnapshot));
  const financialReturn = prior?.status === "COMPLETED" || replayedZeroReturn ? { returnAmount: toDbMoney(sell), roundingAdjustment: "0.00", fullyReturned: false }
    : await digitalInvoiceReturnAmounts(tx, invoice, toDbMoney(sell), details.map((d) => Number(d.invoiceItemId)), actor, mode);
  const netReturn = money(financialReturn.returnAmount);
  const caps = await loadRefundCaps(tx, input.invoiceId, { lock: true });
  if (!prior && (money(invoice.paidAmount).lt(0) || money(invoice.paidAmount).gt(caps.pool))) refundError("المقبوض في رأس الفاتورة لا تغطيه سندات القبض وتخصيصاتها الفعلية");
  const pending = await tx.select({ amount: digitalRefundPayments.amount }).from(digitalRefundPayments)
    .where(and(eq(digitalRefundPayments.invoiceId, input.invoiceId), inArray(digitalRefundPayments.status, ["RESERVED", "EVIDENCED"]))).for("update");
  const available = money(invoice.paidAmount).minus(sumMoney(pending.map((p) => p.amount)));
  const amount = replayedZeroReturn ? money(0) : prior ? money(prior.amount) : available.lt(netReturn) ? available : netReturn;
  if (!prior && amount.lt(netReturn) && pending.length) refundError("بعض المقبوض محجوز لإثبات رد آخر؛ أكمل تسويته قبل رد بنود جديدة");
  const [attempt] = await tx.select().from(externalPaymentAttempts).where(and(eq(externalPaymentAttempts.invoiceId, input.invoiceId), eq(externalPaymentAttempts.paymentMethod, "CARD")))
    .orderBy(asc(externalPaymentAttempts.id)).limit(1);
  const [heldSource] = attempt ? [] : await tx.select({ attemptId: digitalSaleIntents.externalPaymentAttemptId })
    .from(digitalIntentSettlements).innerJoin(digitalSaleIntents, eq(digitalSaleIntents.id, digitalIntentSettlements.intentId))
    .where(and(eq(digitalIntentSettlements.invoiceId, input.invoiceId), eq(digitalIntentSettlements.status, "COMPLETED"))).limit(1);
  const method = invoice.paymentMethod === "CARD" ? "CARD" : invoice.paidAmount === "0.00" ? "CREDIT" : "CASH";
  return { branchId: Number(invoice.branchId), invoiceId: input.invoiceId, intentId: null,
    originalAttemptId: attempt ? Number(attempt.id) : heldSource?.attemptId ?? null, originalMethod: prior?.originalMethod ?? method,
    operationKey, amount: toDbMoney(amount), detailIds: ids, reason: input.reason, customerId: invoice.customerId ?? null,
    outcome: input.kind === "REVERSED" ? "REVERSAL" : "LOSS_REFUND", replayedZeroReturn, ...financialReturn };
}

export async function intentDigitalRefundContext(tx: Tx, intentId: number, actor: Actor): Promise<DigitalRefundContext> {
  const [intent] = await tx.select().from(digitalSaleIntents).where(eq(digitalSaleIntents.id, intentId)).for("update").limit(1);
  const [settlement] = await tx.select().from(digitalIntentSettlements).where(eq(digitalIntentSettlements.intentId, intentId)).for("update").limit(1);
  if (!intent || !settlement || !["CASH", "CARD"].includes(intent.paymentMethod)) refundError("لا توجد تسوية قبض مثبتة لهذه النيّة");
  assertBranch(Number(intent.branchId), actor);
  return { branchId: Number(intent.branchId), invoiceId: null, intentId, originalAttemptId: intent.externalPaymentAttemptId ?? null,
    originalMethod: intent.paymentMethod as "CASH" | "CARD", operationKey: `DIGITAL_SETTLEMENT_REFUND:${settlement.resolutionId}`,
    amount: settlement.refundAmount, detailIds: [], reason: `تسوية عملية الكروت #${intentId}`, customerId: settlement.customerId ?? null, outcome: null };
}

function referenceOf(tender: DigitalRefundTender) {
  if (tender.method === "CASH") return null;
  const reference = tender.reference.trim().toUpperCase();
  if (!tender.confirmed || !reference || reference.length > 100) refundError("مرجع نجاح رد البطاقة وتأكيده مطلوبان");
  return reference;
}

function assertMatches(row: typeof digitalRefundPayments.$inferSelect, context: DigitalRefundContext, tender: DigitalRefundTender, allowReserved = false) {
  if (row.branchId !== context.branchId || row.invoiceId !== context.invoiceId || row.intentId !== context.intentId ||
      row.originalAttemptId !== context.originalAttemptId || row.originalMethod !== context.originalMethod ||
      row.method !== tender.method || (!(allowReserved && row.status === "RESERVED") && row.normalizedReference !== referenceOf(tender)) || !money(row.amount).eq(context.amount) ||
      JSON.stringify(row.detailIds) !== JSON.stringify(context.detailIds)) refundError("إثبات رد سابق مربوط بمبلغ أو بنود أو وسيلة مختلفة");
}

async function reserveRefund(tx: Tx, context: DigitalRefundContext, tender: DigitalRefundTender, actor: Actor, allowCreate: boolean) {
  assertBranch(context.branchId, actor);
  if (!digitalRefundMethodAllowed(context.originalMethod, tender.method) || !money(context.amount).gt(0)) refundError("طريقة الرد أو مبلغه لا يطابقان أصل القبض");
  const reference = referenceOf(tender);
  const [existing] = await tx.select().from(digitalRefundPayments).where(eq(digitalRefundPayments.operationKey, context.operationKey)).for("update").limit(1);
  if (existing) {
    if (existing.status === "RESERVED") refundError("المبلغ محجوز فقط؛ احفظ إثبات نجاح الرد الفعلي قبل الاعتماد المالي");
    assertMatches(existing, context, tender); return existing;
  }
  if (!allowCreate) refundError("لم يُحفظ إثبات نجاح رد البطاقة؛ اضغط تأكيد الرد أولاً ثم أعد الاعتماد بنفس العملية");
  const inserted = await tx.insert(digitalRefundPayments).values({ branchId: context.branchId,
    invoiceId: context.invoiceId, intentId: context.intentId, originalAttemptId: context.originalAttemptId,
    operationKey: context.operationKey, amount: context.amount, detailIds: context.detailIds,
    originalMethod: context.originalMethod, method: tender.method, normalizedReference: reference,
    status: "EVIDENCED", requestedBy: actor.userId, confirmedBy: actor.userId, confirmedAt: new Date(), reason: context.reason.slice(0, 500) });
  const [saved] = await tx.select().from(digitalRefundPayments).where(eq(digitalRefundPayments.id, extractInsertId(inserted))).limit(1);
  await reserveDigitalReturnItems(tx, context, Number(saved!.id));
  return saved!;
}

/** Reserve BEFORE operating a bank terminal, so concurrent windows cannot direct two refunds. */
export async function reserveDigitalCardRefund(tx: Tx, context: DigitalRefundContext, expectedAmount: string, actor: Actor) {
  assertBranch(context.branchId, actor);
  if (context.originalMethod !== "CARD" || !money(context.amount).gt(0) || !money(context.amount).eq(expectedAmount)) refundError("مبلغ الحجز لا يطابق العرض الخادمي الحالي أو أصل القبض بالبطاقة؛ حدّث قيمة الرد قبل تشغيل الجهاز");
  const [existing] = await tx.select().from(digitalRefundPayments).where(eq(digitalRefundPayments.operationKey, context.operationKey)).for("update").limit(1);
  if (existing) {
    assertMatches(existing, context, { method: "CARD", reference: existing.normalizedReference ?? "reserved", confirmed: true }, true);
    return { refundId: Number(existing.id), reserved: true as const, evidenced: existing.status !== "RESERVED",
      newReservation: false, grantToken: null, reservationExpiresAt: existing.reservationExpiresAt };
  }
  const grantToken = randomUUID();
  const reservationExpiresAt = new Date(Date.now() + 120_000);
  const inserted = await tx.insert(digitalRefundPayments).values({ branchId: context.branchId, invoiceId: context.invoiceId,
    intentId: context.intentId, originalAttemptId: context.originalAttemptId, originalMethod: context.originalMethod,
    operationKey: context.operationKey, method: "CARD", amount: context.amount, detailIds: context.detailIds,
    status: "RESERVED", requestedBy: actor.userId, reservationToken: grantToken, reservationExpiresAt, reason: context.reason.slice(0, 500) });
  const refundId = extractInsertId(inserted);
  await reserveDigitalReturnItems(tx, context, refundId);
  return { refundId, reserved: true as const, evidenced: false, newReservation: true, grantToken, reservationExpiresAt };
}

/** Only a positively unexecuted reservation is releasable; external evidence is never deleted. */
export async function releaseDigitalCardRefund(tx: Tx, context: DigitalRefundContext, input: { noRefundConfirmed: true; reason: string; grantToken?: string }, actor: Actor) {
  assertBranch(context.branchId, actor);
  const [row] = await tx.select().from(digitalRefundPayments).where(eq(digitalRefundPayments.operationKey, context.operationKey)).for("update").limit(1);
  if (!input.noRefundConfirmed || input.reason.trim().length < 5 || !row || row.status !== "RESERVED" || row.method !== "CARD"
    || row.normalizedReference != null || row.confirmedAt != null || row.receiptId != null) refundError("لا يمكن تحرير رد مؤكد أو غير محسوم؛ يلزم إثبات أن الرد لم يُنفّذ مطلقاً أو فشل يقيناً");
  assertMatches(row, context, { method: "CARD", reference: "reserved", confirmed: true }, true);
  if (Number(row.requestedBy) !== actor.userId && !(await resolveApprovalActor(tx, actor, { current: true })).isOwner) refundError("يلزم الموظف الذي حجز الرد أو المالك لتأكيد عدم تنفيذه");
  if (row.reservationExpiresAt != null && row.reservationExpiresAt.getTime() > Date.now() && input.grantToken !== row.reservationToken) {
    refundError("نافذة تنفيذ الرد الأصلية ما زالت نشطة؛ انتظر انتهاء مهلة الحجز ثم طابق الجهاز قبل تحريره");
  }
  const claims = await tx.select().from(digitalRefundItems).where(eq(digitalRefundItems.refundId, row.id)).for("update");
  if (claims.some((item) => item.occurredAt != null)) refundError("الحجز مرتبط برد مالي مكتمل");
  await tx.insert(auditLogs).values({ userId: actor.userId, branchId: context.branchId, action: "digitalCards.refund.reservationReleased",
    entityType: context.intentId == null ? "digitalSaleDetail" : "digitalSaleIntent", entityId: String(context.intentId ?? context.invoiceId),
    oldValue: JSON.stringify({ refundId: row.id, amount: row.amount, detailIds: row.detailIds, status: row.status }),
    newValue: JSON.stringify({ noRefundConfirmed: true, reason: input.reason.trim() }) });
  await tx.delete(digitalRefundItems).where(eq(digitalRefundItems.refundId, row.id));
  await tx.delete(digitalRefundPayments).where(and(eq(digitalRefundPayments.id, row.id), eq(digitalRefundPayments.status, "RESERVED")));
  return { released: true as const };
}

async function reserveDigitalReturnItems(tx: Tx, context: DigitalRefundContext, refundId: number | null) {
  if (!context.detailIds.length || !context.outcome) return;
  const existing = await tx.select().from(digitalRefundItems).where(inArray(digitalRefundItems.detailId, context.detailIds)).for("update");
  if (existing.some((row) => row.refundId !== refundId || row.outcome !== context.outcome)) refundError("بند مرتبط بإثبات رد آخر؛ أكمل عمليته الأصلية دون رد ثانٍ");
  const reserved = new Set(existing.map((row) => Number(row.detailId)));
  const details = await tx.select().from(digitalSaleDetails).where(inArray(digitalSaleDetails.id, context.detailIds));
  const missing = details.filter((row) => !reserved.has(Number(row.id)));
  if (missing.length) await tx.insert(digitalRefundItems).values(missing.map((detail) => ({ refundId,
    detailId: Number(detail.id), outcome: context.outcome!, revenue: toDbMoney(money(detail.sellPriceSnapshot).neg()),
    cost: context.outcome === "REVERSAL" ? toDbMoney(money(detail.providerShareSnapshot).neg()) : "0.00" })));
}

/** Immutable line events also cover credit-only returns with no cash payout. */
export async function completeDigitalReturnItems(tx: Tx, context: DigitalRefundContext, refundId: number | null, occurredAt: Date) {
  await reserveDigitalReturnItems(tx, context, refundId);
  if (context.detailIds.length) await tx.update(digitalRefundItems).set({ occurredAt })
    .where(and(inArray(digitalRefundItems.detailId, context.detailIds), isNull(digitalRefundItems.occurredAt)));
}

/** Run in its own transaction BEFORE financial execution, so a later rollback cannot erase external success. */
export async function recordDigitalRefundEvidence(tx: Tx, context: DigitalRefundContext, tender: DigitalRefundTender, actor: Actor) {
  assertBranch(context.branchId, actor);
  if (tender.method !== "CARD") refundError("إثبات الجهاز خاص برد البطاقة؛ صرف الخزينة يُنفذ داخل الاعتماد المالي");
  if (context.originalMethod !== "CARD") refundError("القبض النقدي لا يُرد بالبطاقة؛ اعتمد الصرف النقدي من خزينة الفرع");
  const [row] = await tx.select().from(digitalRefundPayments).where(eq(digitalRefundPayments.operationKey, context.operationKey)).for("update").limit(1);
  if (!row) refundError("احجز مبلغ الرد أولاً قبل تشغيل جهاز الدفع؛ لا تكرر الرد إذا تم فعلاً وأبق العملية للمراجعة");
  assertMatches(row, context, tender, true);
  if (Number(row.requestedBy) !== actor.userId && !(await resolveApprovalActor(tx, actor, { current: true })).isOwner) refundError("أكمل إثبات الرد بحساب الموظف الذي حجزه أو بمعالجة المالك");
  if (row.status === "RESERVED") await tx.update(digitalRefundPayments).set({ status: "EVIDENCED",
    normalizedReference: referenceOf(tender), confirmedBy: actor.userId, confirmedAt: new Date() })
    .where(and(eq(digitalRefundPayments.id, row.id), eq(digitalRefundPayments.status, "RESERVED")));
  return { refundId: Number(row.id), evidenced: true as const, completed: row.status === "COMPLETED" };
}

/** Caller has locked its source and computed the amount. Does not post RETURN or change invoice balances. */
export async function executeDigitalRefund(tx: Tx, context: DigitalRefundContext, tender: DigitalRefundTender, actor: Actor,
  liabilityRole: "AR" | "OTHER_LIABILITY" = "AR") {
  if (money(context.amount).isZero()) return null;
  const row = await reserveRefund(tx, context, tender, actor, tender.method === "CASH");
  if (row.status === "COMPLETED") return { refundId: Number(row.id), receiptId: Number(row.receiptId), replay: true };
  if (tender.method === "CARD" && Number(row.confirmedBy) !== actor.userId && !(await resolveApprovalActor(tx, actor, { current: true })).isOwner) refundError("اعتمد رد البطاقة بحساب الموظف الذي أكد نجاحه أو بمعالجة المالك");
  if (tender.method === "CASH") {
    assertTreasuryOutException("DIGITAL_CARD_REVERSAL_COMPENSATION");
    await assertCashOutAvailable(tx, { branchId: context.branchId, cashBucket: "TREASURY", amount: money(context.amount), operation: "رد قيمة كروت رقمية" });
  }
  const inserted = await tx.insert(receipts).values({ invoiceId: context.invoiceId, branchId: context.branchId, shiftId: null,
    direction: "OUT", amount: context.amount, paymentMethod: tender.method, cashBucket: tender.method === "CASH" ? "TREASURY" : null,
    referenceNumber: row.normalizedReference, status: "COMPLETED", partyType: context.customerId != null ? "CUSTOMER" : "OTHER",
    partyId: context.customerId, description: context.reason, createdBy: actor.userId });
  const receiptId = extractInsertId(inserted);
  const asset = tender.method === "CASH" ? "TREASURY_CASH" : "CARD_BANK";
  const amount = money(context.amount);
  const components = { roleDebits: { [liabilityRole]: amount }, roleCredits: { [asset]: amount } };
  await postEntry(tx, { entryType: "PAYMENT_OUT", branchId: context.branchId, invoiceId: context.invoiceId,
    customerId: liabilityRole === "AR" ? context.customerId : null, receiptId, amount,
    dedupeKey: `DIGITAL:REFUND_PAYMENT:${row.id}`, notes: context.reason, createdBy: actor.userId,
    postingIntent: createPostingIntent(liabilityRole === "AR" ? "PAYMENT_OUT_DIGITAL_REFUND" : "PAYMENT_OUT_OTHER", "PAYMENT_OUT",
      [debitLine(liabilityRole, amount), creditLine(asset, amount)], components), postingSourceComponents: components });
  await tx.update(digitalRefundPayments).set({ status: "COMPLETED", receiptId, completedAt: new Date() })
    .where(and(eq(digitalRefundPayments.id, row.id), eq(digitalRefundPayments.status, "EVIDENCED")));
  return { refundId: Number(row.id), receiptId, replay: false };
}

export async function digitalRefundReplay(tx: Tx, operationKey: string) {
  const [row] = await tx.select().from(digitalRefundPayments).where(eq(digitalRefundPayments.operationKey, operationKey)).for("update").limit(1);
  return row?.status === "COMPLETED" ? row : null;
}

export async function controlDigitalCardRefund(tx: Tx, context: DigitalRefundContext, input: DigitalCardRefundControl, actor: Actor) {
  if (input.stage === "RESERVE") return reserveDigitalCardRefund(tx, context, input.expectedAmount, actor);
  if (input.stage === "RELEASE") return releaseDigitalCardRefund(tx, context, input, actor);
  return recordDigitalRefundEvidence(tx, context, input.tender, actor);
}
