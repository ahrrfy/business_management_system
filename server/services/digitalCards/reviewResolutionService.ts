/**
 * معالجة عملية بيع رقمية لم تكتمل.
 *
 * لا يُسمح للواجهة بتغيير المال مباشرة. مدير يطابق تقرير جهاز المزوّد ويطلب أحد
 * ثلاثة قرارات، ومدير آخر يعتمد الطلب. عند الاعتماد تُنفّذ النتيجة كاملة داخل
 * المعاملة نفسها: تحرير الحجز، أو إنشاء الفاتورة، أو إثبات الخسارة.
 */
import { TRPCError } from "@trpc/server";
import { assertServiceOperationTx, type ServiceOperationActor } from "../authorization/operationAuthority";
import { appErrorMessage } from "../../../shared/errors";
import { and, asc, eq, notInArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/mysql-core";
import {
  auditLogs,
  branches,
  digitalOfferings,
  digitalSaleIntentItems,
  digitalSaleIntents,
  digitalSaleReviewResolutionItems,
  digitalSaleReviewResolutions,
  digitalWalletReservations,
  digitalWallets,
  externalPaymentAttempts,
  products,
  shifts,
  suppliers,
  digitalProviders,
  users,
} from "../../../drizzle/schema";
import { normalizeDigitalSaleReference } from "../../../shared/digitalSale";
import type { DB, Tx } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { redactAuditValue } from "../auditService";
import { money, toDbMoney } from "../money";
import type { Actor } from "../tx";
import { DIGITAL_SETTLEMENT_FINALIZATION, finalize, recoverNeedsReview } from "./finalizeService";
import { approveWriteoff } from "./writeoffService";
import { resolveApprovalActor } from "../approval/ownerGate";
import { releaseIntentInventory } from "./inventoryReservationService";
import { digitalIntentSettlements, digitalRefundPayments } from "../../../drizzle/digitalSettlementSchema";
import { discardRejectedAllocation, completeDigitalSettlement, controlIntentRefund, materializeDigitalCapture, requestDigitalSettlement, type SettlementOptions } from "./settlementService";
import { assertCaptureResolvedBeforeClosure } from "./captureDisposition";
import type { DigitalCardRefundControl, DigitalRefundTender } from "../../../shared/digitalPaymentSettlement";
import { lockCashSourceForUpdate } from "../cash/cashAvailability";

export type ReviewDecision = "CANCEL_NO_ISSUE" | "FINALIZE_SALE" | "WRITEOFF_LOSS" | "SETTLE_PARTIAL";
export type ReviewItemOutcome = "ISSUED" | "NOT_ISSUED";

export interface ReviewResolutionItemInput {
  intentItemId: number;
  outcome: ReviewItemOutcome;
  providerReference?: string | null;
}

function assertBranch(branchId: number, actor: Actor): void {
  if (actor.role !== "admin" && Number(actor.branchId) !== branchId) {
    throw new TRPCError({ code: "FORBIDDEN", message: "العملية تخص فرعاً آخر" });
  }
}

async function auditLog(tx: Tx, actor: Actor, action: string, intentId: number, details: unknown): Promise<void> {
  // سجل التدقيق جزء من ذرّية قرار المعالجة: إن تعذّر إثبات من فعل ماذا، لا يُنفّذ الأثر المالي.
  await tx.insert(auditLogs).values({
    userId: actor.userId,
    branchId: actor.branchId,
    action,
    entityType: "digitalSaleIntent",
    entityId: String(intentId),
    newValue: redactAuditValue(details),
  });
}

async function lockIntent(tx: Tx, intentId: number) {
  const [intent] = await tx
    .select()
    .from(digitalSaleIntents)
    .where(eq(digitalSaleIntents.id, intentId))
    .for("update");
  if (!intent) throw new TRPCError({ code: "NOT_FOUND", message: "عملية البيع غير موجودة" });
  return intent;
}

async function activeClaimCount(tx: Tx, intentId: number): Promise<number> {
  const result = await tx.execute(sql`
    SELECT COUNT(*) AS n
    FROM digitalSaleExecutionClaims c
    INNER JOIN digitalSaleIntentItems i ON i.id = c.intentItemId
    WHERE i.intentId = ${intentId}
      AND c.completedAt IS NULL
      AND c.expiresAt > CURRENT_TIMESTAMP(3)
  `);
  const raw = Array.isArray(result) ? result[0] : (result as { rows?: unknown }).rows;
  const rows = Array.isArray(raw) ? raw : [];
  return Number((rows[0] as { n?: number } | undefined)?.n ?? 0);
}

async function deleteClaims(tx: Tx, intentId: number): Promise<void> {
  await tx.execute(sql`
    DELETE c FROM digitalSaleExecutionClaims c
    INNER JOIN digitalSaleIntentItems i ON i.id = c.intentItemId
    WHERE i.intentId = ${intentId}
  `);
}

async function releaseReservations(tx: Tx, intentId: number): Promise<void> {
  const reservations = await tx
    .select()
    .from(digitalWalletReservations)
    .where(and(
      eq(digitalWalletReservations.intentId, intentId),
      eq(digitalWalletReservations.status, "ACTIVE"),
    ))
    .orderBy(asc(digitalWalletReservations.walletId))
    .for("update");

  for (const reservation of reservations) {
    const walletId = Number(reservation.walletId);
    const [wallet] = await tx
      .select()
      .from(digitalWallets)
      .where(eq(digitalWallets.id, walletId))
      .for("update");
    if (!wallet) throw new TRPCError({ code: "NOT_FOUND", message: "رصيد جهاز المزوّد غير موجود" });
    const nextReserved = money(wallet.reservedBalance).minus(money(reservation.amount));
    if (nextReserved.lt(0)) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "المبلغ المعلّق أقل من حجز هذه العملية — أوقف المعالجة وراجع حركة الرصيد",
      });
    }
    await tx
      .update(digitalWallets)
      .set({ reservedBalance: toDbMoney(nextReserved) })
      .where(eq(digitalWallets.id, walletId));
    await tx
      .update(digitalWalletReservations)
      .set({ status: "RELEASED", releasedAt: new Date() })
      .where(eq(digitalWalletReservations.id, Number(reservation.id)));
  }
  await releaseIntentInventory(tx, intentId);
}

async function intentItems(tx: Tx, intentId: number) {
  return tx
    .select({
      id: digitalSaleIntentItems.id,
      providerId: digitalSaleIntentItems.providerId,
      providerBasketKey: digitalSaleIntentItems.providerBasketKey,
      referenceOwnerItemId: digitalSaleIntentItems.referenceOwnerItemId,
      fulfillmentStatus: digitalSaleIntentItems.fulfillmentStatus,
      providerReference: digitalSaleIntentItems.providerReference,
    })
    .from(digitalSaleIntentItems)
    .where(eq(digitalSaleIntentItems.intentId, intentId))
    .orderBy(asc(digitalSaleIntentItems.id))
    .for("update");
}

function validateDecision(decision: ReviewDecision, items: { outcome: ReviewItemOutcome }[]): void {
  const issued = items.filter((item) => item.outcome === "ISSUED").length;
  if (decision === "CANCEL_NO_ISSUE" && issued !== 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "إلغاء العملية متاح فقط عند التأكد أن أي كرت لم يصدر" });
  }
  if (decision === "FINALIZE_SALE" && issued !== items.length) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "إكمال البيع يتطلب التأكد من إصدار جميع الكروت" });
  }
  if (decision === "WRITEOFF_LOSS" && issued === 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "إثبات الخسارة يتطلب وجود كرت صادر واحد على الأقل" });
  }
}

async function normalizeAndValidateItems(
  tx: Tx,
  actualItems: Awaited<ReturnType<typeof intentItems>>,
  requested: ReviewResolutionItemInput[],
): Promise<Array<{ intentItemId: number; providerId: number; outcome: ReviewItemOutcome; providerReference: string | null }>> {
  if (requested.length !== actualItems.length || new Set(requested.map((item) => item.intentItemId)).size !== requested.length) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "يجب تحديد نتيجة واضحة لكل كرت في العملية" });
  }
  const byId = new Map(requested.map((item) => [item.intentItemId, item]));
  const normalized = actualItems.map((actual) => {
    const input = byId.get(Number(actual.id));
    if (!input) throw new TRPCError({ code: "BAD_REQUEST", message: "تفاصيل المعالجة لا تطابق بنود العملية" });
    if (actual.fulfillmentStatus === "SUCCESS" && input.outcome !== "ISSUED") {
      throw new TRPCError({ code: "CONFLICT", message: "كرت مسجّل كمُصدر لا يمكن تحويله إلى غير صادر" });
    }
    const providerReference = input.outcome === "ISSUED"
      ? normalizeDigitalSaleReference(input.providerReference || actual.providerReference)
      : "";
    if (actual.providerBasketKey != null && input.outcome === "ISSUED" && providerReference !== normalizeDigitalSaleReference(actual.providerReference)) {
      throw new TRPCError({ code: "CONFLICT", message: appErrorMessage({ what: "تعذّر تغيير مرجع السلة", why: "رقم عملية المزوّد محفوظ لجميع بطاقاتها", doThis: "طابق العملية بالمرجع المحفوظ قبل طلب المعالجة" }) });
    }
    if (input.outcome === "ISSUED" && !providerReference) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "رقم العملية أو ID الكرت مطلوب لكل كرت صادر" });
    }
    return {
      intentItemId: Number(actual.id),
      providerId: Number(actual.providerId),
      outcome: input.outcome,
      providerReference: providerReference || null,
    };
  });

  // The owner must keep the unique reference even if only another member was issued.
  // All-NOT_ISSUED baskets release the complete operation together.
  for (const owner of actualItems.filter((item) => item.providerBasketKey != null && item.referenceOwnerItemId == null)) {
    const memberIds = new Set(actualItems.filter((item) => item.providerBasketKey === owner.providerBasketKey).map((item) => Number(item.id)));
    if (normalized.some((item) => memberIds.has(item.intentItemId) && item.outcome === "ISSUED")) {
      const normalizedOwner = normalized.find((item) => item.intentItemId === Number(owner.id))!;
      normalizedOwner.providerReference = normalizeDigitalSaleReference(owner.providerReference) || null;
    }
  }

  const actualById = new Map(actualItems.map((item) => [Number(item.id), item]));
  const seen = new Map<string, string | null>();
  for (const item of normalized) {
    if (!item.providerReference) continue;
    const key = `${item.providerId}:${item.providerReference.toLocaleLowerCase("en")}`;
    const basketKey = actualById.get(item.intentItemId)!.providerBasketKey;
    if (seen.has(key) && (basketKey == null || seen.get(key) !== basketKey)) {
      throw new TRPCError({ code: "CONFLICT", message: "رقم العملية مكرر داخل طلب المعالجة للمزوّد نفسه" });
    }
    seen.set(key, basketKey);
  }

  const refs = normalized.filter((item) => item.providerReference != null);
  if (refs.length) {
    const ids = actualItems.map((item) => Number(item.id));
    for (const item of refs) {
      const [duplicate] = await tx
        .select({ id: digitalSaleIntentItems.id })
        .from(digitalSaleIntentItems)
        .where(and(
          eq(digitalSaleIntentItems.providerId, item.providerId),
          eq(digitalSaleIntentItems.providerReference, item.providerReference!),
          notInArray(digitalSaleIntentItems.id, ids),
        ))
        .limit(1);
      if (duplicate) {
        throw new TRPCError({ code: "CONFLICT", message: "رقم العملية مسجّل مسبقاً لدى المزوّد نفسه" });
      }
    }
  }
  return normalized;
}

export async function requestResolution(
  tx: Tx,
  input: { intentId: number; decision: ReviewDecision; reason: string; items: ReviewResolutionItemInput[]; settlement?: SettlementOptions },
  actor: Actor & ServiceOperationActor,
): Promise<{ resolutionId: number; autoApproved: boolean }> {
  await assertServiceOperationTx(tx, actor, "digitalCards.sales.requestReviewResolution");
  const reason = input.reason.trim();
  if (reason.length < 5) throw new TRPCError({ code: "BAD_REQUEST", message: "اكتب نتيجة المطابقة وسبب القرار بوضوح" });

  const intent = await lockIntent(tx, input.intentId);
  assertBranch(Number(intent.branchId), actor);
  if (intent.status !== "NEEDS_REVIEW") {
    throw new TRPCError({ code: "CONFLICT", message: "هذه العملية لم تعد تنتظر معالجة" });
  }
  if (await activeClaimCount(tx, input.intentId)) {
    throw new TRPCError({ code: "CONFLICT", message: "نافذة إصدار الكرت ما زالت نشطة — انتظر انتهاءها قبل طلب المعالجة" });
  }

  const actualItems = await intentItems(tx, input.intentId);
  if (intent.checkoutSnapshot?.unadmittedCapture && (input.decision !== "SETTLE_PARTIAL" || input.settlement?.regularDisposition !== "RELEASE" || actualItems.length || input.items.length)) throw new TRPCError({ code: "CONFLICT", message: appErrorMessage({what:"تعذّر قبول قرار المعالجة",why:"القبض قبل قبول السلة يتيح فقط تسوية رد كامل بلا بيع أو إصدار",doThis:"اختر رد كامل القبض وتحرير البضاعة بعد مطابقة الإثبات الأصلي"}) });
  if (!actualItems.length && !intent.checkoutSnapshot?.unadmittedCapture) throw new TRPCError({ code: "BAD_REQUEST", message: "العملية بلا بنود" });
  const items = await normalizeAndValidateItems(tx, actualItems, input.items);
  validateDecision(input.decision, items);
  if (input.decision === "WRITEOFF_LOSS") await assertCaptureResolvedBeforeClosure(tx, intent);
  if (input.decision === "CANCEL_NO_ISSUE") await assertCaptureResolvedBeforeClosure(tx, intent, "إلغاء");
  if (input.decision !== "SETTLE_PARTIAL" && input.settlement) throw new TRPCError({ code: "BAD_REQUEST", message: appErrorMessage({"what":"تعذّرت تسوية عملية الكروت","why":"تخصيص القبض يخص قرار تسوية المبلغ المحصّل فقط","doThis":"راجع القرار المحفوظ وصلاحية الاعتماد وحالة الإصدار ثم أكمل المعالجة الأصلية دون قبض أو رد جديد"}) });

  const [existing] = await tx
    .select()
    .from(digitalSaleReviewResolutions)
    .where(eq(digitalSaleReviewResolutions.intentId, input.intentId))
    .for("update");
  if (existing?.status === "PENDING") {
    throw new TRPCError({ code: "CONFLICT", message: "يوجد قرار معالجة ينتظر اعتماد مدير آخر" });
  }
  if (existing?.status === "APPROVED") throw new TRPCError({ code: "CONFLICT", message: appErrorMessage({"what":"تعذّرت تسوية عملية الكروت","why":"قرار المعالجة معتمد؛ لا يُستبدل سجل تسويته النهائية","doThis":"راجع القرار المحفوظ وصلاحية الاعتماد وحالة الإصدار ثم أكمل المعالجة الأصلية دون قبض أو رد جديد"}) });

  let resolutionId: number;
  if (existing) {
    resolutionId = Number(existing.id);
    await tx.delete(digitalSaleReviewResolutionItems).where(eq(digitalSaleReviewResolutionItems.resolutionId, resolutionId));
    await tx
      .update(digitalSaleReviewResolutions)
      .set({
        decision: input.decision,
        status: "PENDING",
        reason,
        requestedBy: actor.userId,
        requestedAt: new Date(),
        reviewedBy: null,
        reviewedAt: null,
        reviewReason: null,
      })
      .where(eq(digitalSaleReviewResolutions.id, resolutionId));
  } else {
    const inserted = await tx.insert(digitalSaleReviewResolutions).values({
      intentId: input.intentId,
      decision: input.decision,
      reason,
      requestedBy: actor.userId,
    });
    resolutionId = extractInsertId(inserted);
  }

  if (items.length) await tx.insert(digitalSaleReviewResolutionItems).values(items.map((item) => ({
    resolutionId,
    intentItemId: item.intentItemId,
    outcome: item.outcome,
    providerReference: item.providerReference,
  })));
  if (input.decision === "SETTLE_PARTIAL") await requestDigitalSettlement(tx, intent, resolutionId, items, input.settlement, actor);
  await auditLog(tx, actor, "digitalCards.review.resolutionRequested", input.intentId, {
    resolutionId,
    decision: input.decision,
    reason,
    issued: items.filter((item) => item.outcome === "ISSUED").length,
  });
  const resolvedActor = await resolveApprovalActor(tx, actor, { current: true });
  const autoApproved = resolvedActor.isOwner && input.decision !== "SETTLE_PARTIAL";
  if (autoApproved) {
    await approveResolution(tx, { intentId: input.intentId }, {
      ...resolvedActor,
      role: "admin",
    });
  }
  return { resolutionId, autoApproved };
}

async function applyConfirmedOutcomes(tx: Tx, intentId: number, items: Awaited<ReturnType<typeof normalizeAndValidateItems>>, actor: Actor) {
  for (const item of items) {
    await tx
      .update(digitalSaleIntentItems)
      .set({
        fulfillmentStatus: item.outcome === "ISSUED" ? "SUCCESS" : "FAILED",
        providerReference: item.providerReference,
        confirmedBy: actor.userId,
        confirmedAt: new Date(),
      })
      .where(eq(digitalSaleIntentItems.id, item.intentItemId));
  }
  await deleteClaims(tx, intentId);
}

async function materializeRetainedSale(tx: Tx, intent: Awaited<ReturnType<typeof lockIntent>>, actor: Actor & ServiceOperationActor) {
  const settlement = await materializeDigitalCapture(tx, intent, actor.userId, actor);
  let invoiceId: number | null = null;
  if (settlement.issuedItemIds.length > 0 || (settlement.regularDisposition === "SELL" && (intent.checkoutSnapshot?.regularLines.length ?? 0) > 0)) {
    const [creator] = await tx.select({ role: users.role, isOwner: users.isOwner }).from(users).where(eq(users.id, Number(intent.createdBy))).limit(1);
    if (!creator) throw new TRPCError({ code: "CONFLICT", message: appErrorMessage({"what":"تعذّرت تسوية عملية الكروت","why":"حساب منفّذ العملية الأصلي غير موجود؛ أوقف التسوية","doThis":"راجع القرار المحفوظ وصلاحية الاعتماد وحالة الإصدار ثم أكمل المعالجة الأصلية دون قبض أو رد جديد"}) });
    const sale = await finalize(tx, { intentId: Number(intent.id), clientRequestId: intent.clientRequestId,
      paymentMethod: intent.paymentMethod as "CASH" | "CARD", paymentAmount: intent.expectedTotal,
      externalPaymentAttemptId: intent.externalPaymentAttemptId, deviceId: intent.externalPaymentDeviceId,
      customerId: intent.checkoutSnapshot?.customerId ?? null },
    { userId: Number(intent.createdBy), branchId: Number(intent.branchId), ...creator }, actor,
    { capability: DIGITAL_SETTLEMENT_FINALIZATION, settlementId: Number(settlement.id) });
    invoiceId = sale.invoiceId;
  } else {
    await releaseReservations(tx, Number(intent.id));
    await tx.update(digitalSaleIntents).set({ status: "CANCELLED" }).where(eq(digitalSaleIntents.id, Number(intent.id)));
  }
  return { settlement, invoiceId };
}

export async function approveResolution(
  tx: Tx,
  input: { intentId: number; refund?: DigitalRefundTender },
  actor: Actor & ServiceOperationActor,
): Promise<{ decision: ReviewDecision; invoiceId?: number; loss?: string }> {
  await assertServiceOperationTx(tx, actor, "digitalCards.sales.approveReviewResolution");
  const approvalActor = await resolveApprovalActor(tx, actor, { current: true });
  const intent = await lockIntent(tx, input.intentId);
  assertBranch(Number(intent.branchId), actor);
  const [resolution] = await tx
    .select()
    .from(digitalSaleReviewResolutions)
    .where(eq(digitalSaleReviewResolutions.intentId, input.intentId))
    .for("update");
  if (resolution?.status === "APPROVED") return { decision: resolution.decision, ...(intent.invoiceId ? { invoiceId: Number(intent.invoiceId) } : {}) };
  if (!resolution || resolution.status !== "PENDING" || intent.status !== "NEEDS_REVIEW") {
    throw new TRPCError({ code: "CONFLICT", message: "لا يوجد قرار معالجة ينتظر الاعتماد" });
  }
  if (Number(resolution.requestedBy) === actor.userId && !approvalActor.isOwner) {
    throw new TRPCError({ code: "FORBIDDEN", message: "لا يعتمد القرار من طلبه — يلزم مدير آخر" });
  }
  if (await activeClaimCount(tx, input.intentId)) {
    throw new TRPCError({ code: "CONFLICT", message: "نافذة إصدار الكرت ما زالت نشطة — لا يمكن اعتماد القرار الآن" });
  }

  const actualItems = await intentItems(tx, input.intentId);
  const requestedItems = await tx
    .select()
    .from(digitalSaleReviewResolutionItems)
    .where(eq(digitalSaleReviewResolutionItems.resolutionId, Number(resolution.id)))
    .orderBy(asc(digitalSaleReviewResolutionItems.intentItemId));
  const items = await normalizeAndValidateItems(tx, actualItems, requestedItems.map((item) => ({
    intentItemId: Number(item.intentItemId),
    outcome: item.outcome,
    providerReference: item.providerReference,
  })));
  validateDecision(resolution.decision, items);
  if (resolution.decision === "CANCEL_NO_ISSUE") await assertCaptureResolvedBeforeClosure(tx, intent, "إلغاء");
  if (resolution.decision === "SETTLE_PARTIAL" && (input.refund?.method ?? "CASH") === "CASH") {
    await lockCashSourceForUpdate(tx, { branchId: Number(intent.branchId), cashBucket: "TREASURY" });
  }
  if (
    resolution.decision === "CANCEL_NO_ISSUE" &&
    intent.externalPaymentAttemptId != null
  ) {
    const [attempt] = await tx
      .select({ state: externalPaymentAttempts.state })
      .from(externalPaymentAttempts)
      .where(
        eq(
          externalPaymentAttempts.id,
          Number(intent.externalPaymentAttemptId),
        ),
      )
      .for("update")
      .limit(1);
    if (!attempt || attempt.state !== "REVERSED") {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: appErrorMessage({
          what: "تعذّر إلغاء نيّة البيع الرقمية",
          why: "قبضها الخارجي مؤكّد ولم يُثبت عكس العملية لدى مزوّد الدفع",
          doThis: "اختر تسوية المبلغ المحصّل وحدد طريقة رده بعد المطابقة، ولا تمرّر البطاقة ثانيةً",
        }),
      });
    }
  }

  await applyConfirmedOutcomes(tx, input.intentId, items, actor);

  let result: { decision: ReviewDecision; invoiceId?: number; loss?: string } = { decision: resolution.decision };
  if (resolution.decision === "CANCEL_NO_ISSUE") {
    await releaseReservations(tx, input.intentId);
    await tx.update(digitalSaleIntents).set({ status: "CANCELLED" }).where(eq(digitalSaleIntents.id, input.intentId));
  } else if (resolution.decision === "FINALIZE_SALE") {
    const recovered = await recoverNeedsReview(tx, input.intentId, actor);
    result = { decision: resolution.decision, invoiceId: recovered.invoiceId };
  } else if (resolution.decision === "SETTLE_PARTIAL") {
    const { settlement, invoiceId } = await materializeRetainedSale(tx, intent, actor);
    const refund = input.refund ?? (settlement.refundMethod === "CASH" ? { method: "CASH" as const } : undefined);
    if (!money(settlement.refundAmount).isZero() && settlement.refundMethod !== refund?.method) throw new TRPCError({ code: "CONFLICT", message: appErrorMessage({"what":"تعذّرت تسوية عملية الكروت","why":"طريقة الرد لا تطابق قرار التسوية","doThis":"راجع القرار المحفوظ وصلاحية الاعتماد وحالة الإصدار ثم أكمل المعالجة الأصلية دون قبض أو رد جديد"}) });
    await completeDigitalSettlement(tx, input.intentId, invoiceId, refund, actor);
    result = { decision: resolution.decision, ...(invoiceId ? { invoiceId } : {}) };
  } else {
    await tx
      .update(digitalSaleIntents)
      .set({
        status: "WRITEOFF_PENDING",
        writeoffRequestedBy: resolution.requestedBy,
        writeoffRequestedAt: resolution.requestedAt,
        writeoffReason: resolution.reason,
      })
      .where(eq(digitalSaleIntents.id, input.intentId));
    const writtenOff = await approveWriteoff(tx, { intentId: input.intentId }, actor);
    result = { decision: resolution.decision, loss: writtenOff.loss };
  }

  await tx
    .update(digitalSaleReviewResolutions)
    .set({ status: "APPROVED", reviewedBy: actor.userId, reviewedAt: new Date(), reviewReason: null })
    .where(eq(digitalSaleReviewResolutions.id, Number(resolution.id)));
  await auditLog(tx, actor, "digitalCards.review.resolutionApproved", input.intentId, {
    resolutionId: Number(resolution.id),
    decision: resolution.decision,
    invoiceId: result.invoiceId ?? null,
    loss: result.loss ?? null,
  });
  return result;
}

export async function controlResolutionRefund(tx: Tx, input: { intentId: number }, control: DigitalCardRefundControl, actor: Actor & ServiceOperationActor) {
  await assertServiceOperationTx(tx, actor, "digitalCards.sales.approveReviewResolution");
  const approvalActor = await resolveApprovalActor(tx, actor, { current: true });
  const intent = await lockIntent(tx, input.intentId);
  assertBranch(Number(intent.branchId), actor);
  const [resolution] = await tx.select().from(digitalSaleReviewResolutions)
    .where(eq(digitalSaleReviewResolutions.intentId, input.intentId)).for("update").limit(1);
  if (!resolution || resolution.decision !== "SETTLE_PARTIAL" || resolution.status !== "PENDING" || intent.status !== "NEEDS_REVIEW") {
    throw new TRPCError({ code: "CONFLICT", message: appErrorMessage({"what":"تعذّرت تسوية عملية الكروت","why":"لا يوجد قرار تسوية قبض ينتظر الاعتماد","doThis":"راجع القرار المحفوظ وصلاحية الاعتماد وحالة الإصدار ثم أكمل المعالجة الأصلية دون قبض أو رد جديد"}) });
  }
  if (Number(resolution.requestedBy) === actor.userId && !approvalActor.isOwner) throw new TRPCError({ code: "FORBIDDEN", message: appErrorMessage({"what":"تعذّرت تسوية عملية الكروت","why":"يلزم اعتماد مدير آخر لرد القبض","doThis":"راجع القرار المحفوظ وصلاحية الاعتماد وحالة الإصدار ثم أكمل المعالجة الأصلية دون قبض أو رد جديد"}) });
  if (await activeClaimCount(tx, input.intentId)) throw new TRPCError({ code: "CONFLICT", message: appErrorMessage({"what":"تعذّرت تسوية عملية الكروت","why":"نافذة الإصدار ما زالت نشطة","doThis":"راجع القرار المحفوظ وصلاحية الاعتماد وحالة الإصدار ثم أكمل المعالجة الأصلية دون قبض أو رد جديد"}) });
  if (control.stage === "RESERVE") {
    const [existing] = await tx.select({ id: digitalRefundPayments.id }).from(digitalRefundPayments)
      .where(eq(digitalRefundPayments.intentId, input.intentId)).for("update").limit(1);
    if (!existing) {
      // Exercise the real sale, stock, period, rounding and provider postings BEFORE the sole terminal grant.
      // The reserved/evidenced retry path never repeats this preflight or issues another grant.
      const verified = new Error("verified reviewed sale");
      try {
        await tx.transaction(async inner => {
          const pending = await inner.select().from(digitalSaleReviewResolutionItems)
            .where(eq(digitalSaleReviewResolutionItems.resolutionId, resolution.id));
          const confirmed = await normalizeAndValidateItems(inner, await intentItems(inner, input.intentId), pending);
          await applyConfirmedOutcomes(inner, input.intentId, confirmed, actor);
          await materializeRetainedSale(inner, intent, actor);
          throw verified;
        });
      } catch (error) { if (error !== verified) throw error; }
    }
  }
  return controlIntentRefund(tx, input.intentId, control, actor);
}

export async function evidenceForResolution(tx: Tx, input: { intentId: number; refund: DigitalRefundTender }, actor: Actor & ServiceOperationActor) {
  return controlResolutionRefund(tx, input, { stage: "EVIDENCE", tender: input.refund }, actor);
}

export async function rejectResolution(
  tx: Tx,
  input: { intentId: number; reason: string },
  actor: Actor & ServiceOperationActor,
): Promise<void> {
  await assertServiceOperationTx(tx, actor, "digitalCards.sales.rejectReviewResolution");
  const reason = input.reason.trim();
  if (reason.length < 3) throw new TRPCError({ code: "BAD_REQUEST", message: "اكتب سبب رفض القرار" });
  const intent = await lockIntent(tx, input.intentId);
  assertBranch(Number(intent.branchId), actor);
  const [resolution] = await tx
    .select()
    .from(digitalSaleReviewResolutions)
    .where(eq(digitalSaleReviewResolutions.intentId, input.intentId))
    .for("update");
  if (!resolution || resolution.status !== "PENDING") {
    throw new TRPCError({ code: "CONFLICT", message: "لا يوجد قرار معالجة ينتظر الرفض" });
  }
  if (Number(resolution.requestedBy) === actor.userId && !(await resolveApprovalActor(tx, actor, { current: true })).isOwner) {
    throw new TRPCError({ code: "FORBIDDEN", message: "لا يرفض القرار من طلبه — يلزم مدير آخر" });
  }
  await discardRejectedAllocation(tx, input.intentId, Number(resolution.id));
  await tx
    .update(digitalSaleReviewResolutions)
    .set({ status: "REJECTED", reviewedBy: actor.userId, reviewedAt: new Date(), reviewReason: reason })
    .where(eq(digitalSaleReviewResolutions.id, Number(resolution.id)));
  await auditLog(tx, actor, "digitalCards.review.resolutionRejected", input.intentId, {
    resolutionId: Number(resolution.id),
    decision: resolution.decision,
    reason,
  });
}

export async function getReviewDetails(db: DB, intentId: number, branchId: number | null) {
  const confirmer = alias(users, "digitalReviewConfirmer");
  const requester = alias(users, "digitalReviewRequester");
  const reviewer = alias(users, "digitalReviewReviewer");
  const [intent] = await db
    .select({
      id: digitalSaleIntents.id,
      branchId: digitalSaleIntents.branchId,
      branchName: branches.name,
      createdBy: digitalSaleIntents.createdBy,
      createdByName: users.name,
      createdByUsername: users.username,
      shiftId: digitalSaleIntents.shiftId,
      capturedRequestId: digitalSaleIntents.clientRequestId,
      capturedAttemptId: digitalSaleIntents.externalPaymentAttemptId,
      capturedReference: externalPaymentAttempts.externalReference,
      capturedAt: externalPaymentAttempts.confirmedAt,
      recoveryPostingShiftId: sql<number | null>`JSON_EXTRACT(${digitalSaleIntents.checkoutSnapshot}, '$.captureRecovery.postingShiftId')`,
      recoveryCustodyReceiptId: sql<number | null>`JSON_EXTRACT(${digitalSaleIntents.checkoutSnapshot}, '$.captureRecovery.cashCustodyReceiptId')`,
      recoveryReason: sql<string | null>`JSON_UNQUOTE(JSON_EXTRACT(${digitalSaleIntents.checkoutSnapshot}, '$.captureRecovery.reason'))`,
      capturedDevice: sql<string | null>`JSON_UNQUOTE(JSON_EXTRACT(${digitalSaleIntents.checkoutSnapshot}, '$.unadmittedCapture.deviceId'))`,
      admissionFailure: sql<string | null>`JSON_UNQUOTE(JSON_EXTRACT(${digitalSaleIntents.checkoutSnapshot}, '$.unadmittedCapture.reason'))`,
      shiftStatus: shifts.status,
      shiftOpenedAt: shifts.openedAt,
      shiftClosedAt: shifts.closedAt,
      status: digitalSaleIntents.status,
      expectedTotal: digitalSaleIntents.expectedTotal,
      paymentMethod: digitalSaleIntents.paymentMethod,
      createdAt: digitalSaleIntents.createdAt,
      expiresAt: digitalSaleIntents.expiresAt,
    })
    .from(digitalSaleIntents)
    .innerJoin(branches, eq(digitalSaleIntents.branchId, branches.id))
    .innerJoin(shifts, eq(digitalSaleIntents.shiftId, shifts.id))
    .leftJoin(users, eq(digitalSaleIntents.createdBy, users.id))
    .leftJoin(externalPaymentAttempts, eq(digitalSaleIntents.externalPaymentAttemptId, externalPaymentAttempts.id))
    .where(eq(digitalSaleIntents.id, intentId))
    .limit(1);
  if (!intent) throw new TRPCError({ code: "NOT_FOUND", message: "عملية البيع غير موجودة" });
  if (branchId != null && Number(intent.branchId) !== branchId) {
    throw new TRPCError({ code: "FORBIDDEN", message: "العملية تخص فرعاً آخر" });
  }

  const items = await db
    .select({
      id: digitalSaleIntentItems.id,
      offeringName: products.name,
      offeringType: digitalOfferings.offeringType,
      providerName: suppliers.name,
      sellPrice: digitalSaleIntentItems.sellPriceSnapshot,
      providerShare: digitalSaleIntentItems.providerShareSnapshot,
      fulfillmentStatus: digitalSaleIntentItems.fulfillmentStatus,
      providerReference: digitalSaleIntentItems.providerReference,
      studentName: digitalSaleIntentItems.studentNameSnapshot,
      studentPhone: digitalSaleIntentItems.studentPhoneSnapshot,
      confirmedBy: digitalSaleIntentItems.confirmedBy,
      confirmedByName: confirmer.name,
      confirmedByUsername: confirmer.username,
      hasOpenClaim: sql<number>`EXISTS(
        SELECT 1 FROM digitalSaleExecutionClaims c
        WHERE c.intentItemId = digitalSaleIntentItems.id AND c.completedAt IS NULL
      )`,
      hasActiveClaim: sql<number>`EXISTS(
        SELECT 1 FROM digitalSaleExecutionClaims c
        WHERE c.intentItemId = digitalSaleIntentItems.id
          AND c.completedAt IS NULL AND c.expiresAt > CURRENT_TIMESTAMP(3)
      )`,
    })
    .from(digitalSaleIntentItems)
    .innerJoin(digitalOfferings, eq(digitalSaleIntentItems.offeringId, digitalOfferings.id))
    .innerJoin(products, eq(digitalOfferings.productId, products.id))
    .innerJoin(digitalProviders, eq(digitalSaleIntentItems.providerId, digitalProviders.id))
    .innerJoin(suppliers, eq(digitalProviders.supplierId, suppliers.id))
    .leftJoin(confirmer, eq(digitalSaleIntentItems.confirmedBy, confirmer.id))
    .where(eq(digitalSaleIntentItems.intentId, intentId))
    .orderBy(asc(digitalSaleIntentItems.id));

  const [resolution] = await db
    .select({
      id: digitalSaleReviewResolutions.id,
      intentId: digitalSaleReviewResolutions.intentId,
      decision: digitalSaleReviewResolutions.decision,
      status: digitalSaleReviewResolutions.status,
      reason: digitalSaleReviewResolutions.reason,
      requestedBy: digitalSaleReviewResolutions.requestedBy,
      requestedByName: requester.name,
      requestedByUsername: requester.username,
      requestedAt: digitalSaleReviewResolutions.requestedAt,
      reviewedBy: digitalSaleReviewResolutions.reviewedBy,
      reviewedByName: reviewer.name,
      reviewedByUsername: reviewer.username,
      reviewedAt: digitalSaleReviewResolutions.reviewedAt,
      reviewReason: digitalSaleReviewResolutions.reviewReason,
      createdAt: digitalSaleReviewResolutions.createdAt,
      updatedAt: digitalSaleReviewResolutions.updatedAt,
    })
    .from(digitalSaleReviewResolutions)
    .leftJoin(requester, eq(digitalSaleReviewResolutions.requestedBy, requester.id))
    .leftJoin(reviewer, eq(digitalSaleReviewResolutions.reviewedBy, reviewer.id))
    .where(eq(digitalSaleReviewResolutions.intentId, intentId))
    .limit(1);
  const resolutionItems = resolution
    ? await db
        .select()
        .from(digitalSaleReviewResolutionItems)
        .where(eq(digitalSaleReviewResolutionItems.resolutionId, Number(resolution.id)))
        .orderBy(asc(digitalSaleReviewResolutionItems.intentItemId))
    : [];
  const timeline = await db
    .select({
      action: auditLogs.action,
      userId: auditLogs.userId,
      userName: users.name,
      createdAt: auditLogs.createdAt,
    })
    .from(auditLogs)
    .leftJoin(users, eq(auditLogs.userId, users.id))
    .where(and(eq(auditLogs.entityType, "digitalSaleIntent"), eq(auditLogs.entityId, String(intentId))))
    .orderBy(asc(auditLogs.id));
  const [settlement] = await db.select({ id: digitalIntentSettlements.id, capturedAmount: digitalIntentSettlements.capturedAmount,
    saleAmount: digitalIntentSettlements.saleAmount, refundAmount: digitalIntentSettlements.refundAmount,
    regularDisposition: digitalIntentSettlements.regularDisposition, refundMethod: digitalIntentSettlements.refundMethod,
    status: digitalIntentSettlements.status }).from(digitalIntentSettlements).where(eq(digitalIntentSettlements.intentId, intentId)).limit(1);
  const [refundEvidence] = await db.select({ refundId: digitalRefundPayments.id, method: digitalRefundPayments.method, reference: digitalRefundPayments.normalizedReference,
    status: digitalRefundPayments.status, reservationExpiresAt: digitalRefundPayments.reservationExpiresAt }).from(digitalRefundPayments).where(eq(digitalRefundPayments.intentId, intentId)).limit(1);
  return { intent, items, timeline, settlement: settlement ? { ...settlement, refundEvidence: refundEvidence ?? null } : null, resolution: resolution ? { ...resolution, items: resolutionItems } : null };
}
