import { TRPCError } from "@trpc/server";
import { and, desc, eq, ne, sql } from "drizzle-orm";
import {
  accountingEntries,
  accrualCorrectionRequests,
  accrualObligationEvents,
  accrualObligations,
  assetCustodyLog,
  assetDocuments,
  assetMaintenance,
  expenses,
  fixedAssets,
  receipts,
} from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { postEntry } from "../ledgerService";
import { money, toDateStr, toDbMoney } from "../money";
import type { Actor } from "../tx";
import { withTx } from "../tx";
import {
  createSystemReceiptRequestTx,
  parseSystemPaymentRequest,
  type SystemPaymentRequest,
} from "../voucher/create";
import {
  expenseAccrualReversal,
  expenseAccrualSettlement,
  fixedAssetAccrualReversal,
  fixedAssetAccrualSettlement,
} from "./accrualPosting";
import {
  correctionPayloadHash,
  lockAccrualObligationTx,
  transitionAccrualObligationTx,
  type AccrualObligationStatus,
} from "./accrualObligations";
import type { AccountRole } from "./postingEngine";
import { payloadHashMatches } from "../idempotency";

type RefundRequest = Extract<
  SystemPaymentRequest,
  { kind: "ACCRUAL_CORRECTION_REFUND" }
>;

type RefundMethod = "CASH" | "CARD" | "CHECK" | "TRANSFER" | "WALLET";
type RefundCashBucket = "DRAWER" | "TREASURY";

function affectedRowCount(result: unknown): number {
  return Number(
    (result as [{ affectedRows?: number }])?.[0]?.affectedRows ??
      (result as { affectedRows?: number })?.affectedRows ??
      0,
  );
}

function assertOneAffectedRow(result: unknown, message: string) {
  if (affectedRowCount(result) !== 1) {
    throw new TRPCError({ code: "CONFLICT", message });
  }
}

export interface RequestAccrualCorrectionInput {
  obligationId: number;
  expectedAssetId?: number;
  reason: string;
  externalEvidenceReference: string;
  attachmentUrl: string;
  refundPaymentMethod?: RefundMethod | null;
  refundCashBucket?: RefundCashBucket | null;
  refundReferenceNumber?: string | null;
  refundCardLastFour?: string | null;
  clientRequestId: string;
}

function assertExpectedCashAsset(
  obligation: typeof accrualObligations.$inferSelect,
  expectedAssetId: number | undefined,
) {
  if (
    expectedAssetId != null &&
    (obligation.kind !== "ASSET_ACQUISITION_CASH" ||
      Number(obligation.assetId) !== expectedAssetId)
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "طلب التصحيح لا يخص اقتناء الأصل النقدي المحدد",
    });
  }
}

function requiredText(value: string | null | undefined, label: string, max: number): string {
  const normalized = value?.trim() ?? "";
  if (!normalized || normalized.length > max) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${label} إلزامي ويجب ألا يتجاوز ${max} محرفاً`,
    });
  }
  return normalized;
}

function assertOwner(actor: Actor) {
  if (actor.isOwner !== true) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "اعتماد تصحيح مالي أو رفضه محصور بمالك نشط مختلف عن المنشئ",
    });
  }
}

function assertBranchScope(actor: Actor, branchId: number) {
  if (
    actor.isOwner !== true &&
    actor.role !== "admin" &&
    Number(actor.branchId) !== branchId
  ) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "التزام المصروف تابع لفرع آخر",
    });
  }
}

function refundAssetRole(
  method: RefundMethod,
  cashBucket: RefundCashBucket | null,
): AccountRole {
  switch (method) {
    case "CASH":
      if (cashBucket === "DRAWER") return "CASH";
      if (cashBucket === "TREASURY") return "TREASURY_CASH";
      break;
    case "CARD":
    case "TRANSFER":
      return "CARD_BANK";
    case "CHECK":
      return "CHECKS_RECEIVABLE";
    case "WALLET":
      return "PAYMENT_WALLET";
  }
  throw new TRPCError({
    code: "CONFLICT",
    message: "دلو النقد الفعلي إلزامي لاسترداد نقدي معتمد",
  });
}

function validateRefundShape(
  status: AccrualObligationStatus,
  input: RequestAccrualCorrectionInput,
) {
  const paid = status === "PAID";
  if (!paid) {
    if (
      input.refundPaymentMethod != null ||
      input.refundCashBucket != null ||
      input.refundReferenceNumber?.trim() ||
      input.refundCardLastFour?.trim()
    ) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "التصحيح غير المدفوع لا ينشئ قبضاً أو دليلاً مصطنعاً للاسترداد",
      });
    }
    return;
  }

  const method = input.refundPaymentMethod;
  if (!method) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "طريقة الاسترداد الفعلية إلزامية" });
  }
  const reference = input.refundReferenceNumber?.trim() ?? "";
  const cardTail = input.refundCardLastFour?.trim() ?? "";
  if (method === "CASH") {
    if (!input.refundCashBucket || reference || cardTail) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "الاسترداد النقدي يتطلب دلو النقد فقط" });
    }
  } else if (method === "CARD") {
    if (input.refundCashBucket != null || !/^\d{4}$/.test(cardTail) || !reference) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "استرداد البطاقة يتطلب مرجع المزود وآخر أربعة أرقام" });
    }
  } else if (input.refundCashBucket != null || !reference || cardTail) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "مرجع مزود الاسترداد إلزامي للصك أو التحويل أو المحفظة",
    });
  }
}

async function setSourceCorrectionStatusTx(
  tx: Tx,
  obligation: typeof accrualObligations.$inferSelect,
  status: "ACTIVE" | "CORRECTION_PENDING" | "CORRECTED",
) {
  const expectedStatus =
    status === "CORRECTION_PENDING" ? "ACTIVE" : "CORRECTION_PENDING";
  if (obligation.kind === "ASSET_MAINTENANCE") {
    const result = await tx
      .update(assetMaintenance)
      .set({ financialStatus: status })
      .where(
        and(
          eq(assetMaintenance.id, Number(obligation.maintenanceId)),
          eq(assetMaintenance.financialStatus, expectedStatus),
        ),
      );
    assertOneAffectedRow(result, "تغيرت حالة صيانة الأصل أثناء التصحيح");
  } else if (obligation.kind === "ASSET_ACQUISITION_CASH") {
    const result = await tx
      .update(fixedAssets)
      .set({ recognitionStatus: status })
      .where(
        and(
          eq(fixedAssets.id, Number(obligation.assetId)),
          eq(fixedAssets.recognitionStatus, expectedStatus),
        ),
      );
    assertOneAffectedRow(result, "تغيرت حالة اعتراف الأصل أثناء التصحيح");
  }
}

async function assertCashAssetHasNoDownstreamUseTx(
  tx: Tx,
  obligation: typeof accrualObligations.$inferSelect,
) {
  if (obligation.kind !== "ASSET_ACQUISITION_CASH" || obligation.assetId == null) return;
  const assetId = Number(obligation.assetId);
  const [asset] = await tx
    .select()
    .from(fixedAssets)
    .where(eq(fixedAssets.id, assetId))
    .for("update")
    .limit(1);
  if (!asset) throw new TRPCError({ code: "NOT_FOUND", message: "الأصل المرتبط بالتصحيح غير موجود" });

  const [[maintenance], [custody], [document]] = await Promise.all([
    tx.select({ id: assetMaintenance.id }).from(assetMaintenance).where(eq(assetMaintenance.assetId, assetId)).limit(1),
    tx.select({ id: assetCustodyLog.id }).from(assetCustodyLog).where(eq(assetCustodyLog.assetId, assetId)).limit(1),
    tx.select({ id: assetDocuments.id }).from(assetDocuments).where(eq(assetDocuments.assetId, assetId)).limit(1),
  ]);
  const used =
    money(asset.accumulatedDepreciation ?? "0").gt(0) ||
    asset.status !== "active" ||
    asset.disposalDate != null ||
    asset.disposalValue != null ||
    asset.disposalReason != null ||
    asset.linkedDeviceId != null ||
    asset.custodianId != null ||
    maintenance != null ||
    custody != null ||
    document != null;
  if (used) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "لا يمكن تصحيح اقتناء أصل استُعمل أو أُهلك أو صين أو نُقل أو سُلّم كعهدة؛ استخدم مسار الاستبعاد/الإشعار الدائن",
    });
  }
}

async function latestSettlementTx(tx: Tx, obligationId: number) {
  const [event] = await tx
    .select()
    .from(accrualObligationEvents)
    .where(
      and(
        eq(accrualObligationEvents.obligationId, obligationId),
        eq(accrualObligationEvents.eventType, "PAYMENT_SETTLED"),
      ),
    )
    .orderBy(desc(accrualObligationEvents.id))
    .limit(1);
  if (!event?.receiptId || !event.accountingEntryId) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "لا يوجد أثر تسوية كامل يمكن إثبات استرداده",
    });
  }
  return event;
}

async function cancelPendingSettlementTx(
  tx: Tx,
  obligation: typeof accrualObligations.$inferSelect,
  reviewerId: number,
  evidenceReference: string,
  occurredAt: Date,
) {
  const [pendingEvent] = await tx
    .select({ receiptId: accrualObligationEvents.receiptId })
    .from(accrualObligationEvents)
    .where(
      and(
        eq(accrualObligationEvents.obligationId, Number(obligation.id)),
        eq(accrualObligationEvents.eventType, "PAYMENT_REQUESTED"),
      ),
    )
    .orderBy(desc(accrualObligationEvents.id))
    .limit(1);
  if (pendingEvent?.receiptId == null) return;
  const [pendingReceipt] = await tx
    .select({ id: receipts.id, status: receipts.status, approvalStatus: receipts.approvalStatus })
    .from(receipts)
    .where(eq(receipts.id, Number(pendingEvent.receiptId)))
    .for("update")
    .limit(1);
  if (
    pendingReceipt?.status === "PENDING" &&
    pendingReceipt.approvalStatus === "PENDING_APPROVAL"
  ) {
    const result = await tx
      .update(receipts)
      .set({ status: "FAILED", approvalStatus: "REJECTED", approvedBy: reviewerId, approvedAt: occurredAt })
      .where(
        and(
          eq(receipts.id, Number(pendingReceipt.id)),
          eq(receipts.status, "PENDING"),
          eq(receipts.approvalStatus, "PENDING_APPROVAL"),
        ),
      );
    assertOneAffectedRow(result, "تغير طلب دفع الاستحقاق أثناء إلغائه بالتصحيح");
    await transitionAccrualObligationTx(tx, {
      obligationId: Number(obligation.id),
      expectedStatus: "CORRECTION_PENDING",
      nextStatus: "CORRECTION_PENDING",
      eventType: "PAYMENT_REJECTED",
      actorId: reviewerId,
      receiptId: Number(pendingReceipt.id),
      evidenceReference,
      dedupeKey: `ACCRUAL:PAYMENT_REJECTED:CORRECTION:${obligation.id}:${pendingReceipt.id}`,
    });
  }
}

async function markSourceCorrectedTx(
  tx: Tx,
  obligation: typeof accrualObligations.$inferSelect,
) {
  if (obligation.expenseId != null) {
    const result = await tx
      .update(expenses)
      .set({ status: "CANCELLED" })
      .where(and(eq(expenses.id, Number(obligation.expenseId)), eq(expenses.status, "ACTIVE")));
    assertOneAffectedRow(result, "تغير المصروف المصدر أثناء اعتماد التصحيح");
  }
  if (obligation.kind === "ASSET_MAINTENANCE") {
    await setSourceCorrectionStatusTx(tx, obligation, "CORRECTED");
    const assetId = Number(obligation.assetId);
    const [otherActive] = await tx
      .select({ id: assetMaintenance.id })
      .from(assetMaintenance)
      .where(
        and(
          eq(assetMaintenance.assetId, assetId),
          ne(assetMaintenance.id, Number(obligation.maintenanceId)),
          ne(assetMaintenance.financialStatus, "CORRECTED"),
        ),
      )
      .limit(1);
    if (!otherActive) {
      const [asset] = await tx
        .select({ status: fixedAssets.status })
        .from(fixedAssets)
        .where(eq(fixedAssets.id, assetId))
        .for("update")
        .limit(1);
      if (!asset) {
        throw new TRPCError({ code: "NOT_FOUND", message: "الأصل المرتبط بالصيانة المصححة غير موجود" });
      }
      if (asset.status === "maintenance") {
        const result = await tx
          .update(fixedAssets)
          .set({ status: "active" })
          .where(and(eq(fixedAssets.id, assetId), eq(fixedAssets.status, "maintenance")));
        assertOneAffectedRow(result, "تغيرت حالة الأصل أثناء إغلاق صيانته المصححة");
      }
    }
  } else if (obligation.kind === "ASSET_ACQUISITION_CASH") {
    await setSourceCorrectionStatusTx(tx, obligation, "CORRECTED");
    const result = await tx
      .update(fixedAssets)
      .set({ isActive: false, status: "retired" })
      .where(
        and(
          eq(fixedAssets.id, Number(obligation.assetId)),
          eq(fixedAssets.recognitionStatus, "CORRECTED"),
          eq(fixedAssets.isActive, true),
          eq(fixedAssets.status, "active"),
        ),
      );
    assertOneAffectedRow(result, "تغير الأصل أثناء إتمام تصحيح الاقتناء");
  }
}

async function postRecognitionReversalTx(
  tx: Tx,
  obligation: typeof accrualObligations.$inferSelect,
  actorId: number,
  occurredAt: Date,
) {
  const amount = money(obligation.recognizedAmount);
  const plan = obligation.kind === "ASSET_ACQUISITION_CASH"
    ? fixedAssetAccrualReversal(amount)
    : expenseAccrualReversal(
        obligation.kind === "PURCHASE_SHIPPING" ? "DELIVERY_EXPENSE" : "OPERATING_EXPENSE",
        amount,
      );
  const dedupeKey = `ACCRUAL:RECOGNITION_REVERSAL:${obligation.id}`;
  await postEntry(tx, {
    entryType: "ADJUST",
    branchId: Number(obligation.branchId),
    purchaseOrderId: obligation.purchaseOrderId == null ? null : Number(obligation.purchaseOrderId),
    amount: amount.neg(),
    entryDate: occurredAt,
    postingIntent: plan.intent,
    postingSourceComponents: plan.sourceComponents,
    dedupeKey,
    createdBy: actorId,
    notes: `عكس اعتراف استحقاق ${obligation.sourceKey}`,
  });
  const [entry] = await tx
    .select({ id: accountingEntries.id })
    .from(accountingEntries)
    .where(eq(accountingEntries.dedupeKey, dedupeKey))
    .limit(1);
  if (!entry) throw new Error("قيد عكس الاعتراف بالاستحقاق مفقود");
  return Number(entry.id);
}

async function completeRecognitionCorrectionTx(
  tx: Tx,
  obligation: typeof accrualObligations.$inferSelect,
  input: {
    expectedStatus: AccrualObligationStatus;
    actorId: number;
    reviewerId: number;
    evidenceReference: string;
    occurredAt: Date;
  },
) {
  await assertCashAssetHasNoDownstreamUseTx(tx, obligation);
  if (input.expectedStatus === "CORRECTION_PENDING") {
    await cancelPendingSettlementTx(
      tx,
      obligation,
      input.reviewerId,
      input.evidenceReference,
      input.occurredAt,
    );
  }
  const reversalEntryId = await postRecognitionReversalTx(
    tx,
    obligation,
    input.reviewerId,
    input.occurredAt,
  );
  await markSourceCorrectedTx(tx, obligation);
  await transitionAccrualObligationTx(tx, {
    obligationId: Number(obligation.id),
    expectedStatus: input.expectedStatus,
    nextStatus: "RECOGNITION_REVERSED",
    eventType: "RECOGNITION_REVERSED",
    actorId: input.actorId,
    reviewerId: input.reviewerId,
    accountingEntryId: reversalEntryId,
    evidenceReference: input.evidenceReference,
    dedupeKey: `ACCRUAL:RECOGNITION_REVERSED:${obligation.id}`,
  });
  return reversalEntryId;
}

export async function requestAccrualCorrection(
  input: RequestAccrualCorrectionInput,
  actor: Actor,
) {
  const reason = requiredText(input.reason, "سبب التصحيح", 2000);
  const externalEvidenceReference = requiredText(
    input.externalEvidenceReference,
    "مرجع الدليل الخارجي",
    191,
  );
  const attachmentUrl = requiredText(input.attachmentUrl, "مرفق الدليل", 8_000_000);
  const clientRequestId = requiredText(input.clientRequestId, "مفتاح منع التكرار", 64);
  const payloadHash = correctionPayloadHash({
    ...input,
    reason,
    externalEvidenceReference,
    attachmentUrl,
    clientRequestId,
  });

  return withTx(async (tx) => {
    const [replay] = await tx
      .select()
      .from(accrualCorrectionRequests)
      .where(eq(accrualCorrectionRequests.clientRequestId, clientRequestId))
      .for("update")
      .limit(1);
    if (replay) {
      if (!payloadHashMatches(payloadHash, replay.payloadHash)) {
        throw new TRPCError({ code: "CONFLICT", message: "تعارض idempotency في طلب التصحيح" });
      }
      if (
        Number(replay.requestedBy) !== actor.userId ||
        Number(replay.obligationId) !== input.obligationId
      ) {
        throw new TRPCError({ code: "FORBIDDEN", message: "مفتاح إعادة التصحيح مملوك لفاعل أو مصدر آخر" });
      }
      const replayObligation = await lockAccrualObligationTx(
        tx,
        Number(replay.obligationId),
      );
      assertBranchScope(actor, Number(replayObligation.branchId));
      assertExpectedCashAsset(replayObligation, input.expectedAssetId);
      return { correctionRequestId: Number(replay.id), refundRequestReceiptId: replay.refundRequestReceiptId == null ? null : Number(replay.refundRequestReceiptId), replayed: true as const };
    }

    const obligation = await lockAccrualObligationTx(tx, input.obligationId);
    assertBranchScope(actor, Number(obligation.branchId));
    assertExpectedCashAsset(obligation, input.expectedAssetId);
    const beneficiaryName = requiredText(
      obligation.beneficiaryName,
      "اسم مستفيد الاستحقاق المثبت",
      200,
    );
    if (obligation.kind === "ASSET_ACQUISITION_SUPPLIER") {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "تصحيح أصل ممول من المورد يحتاج إشعاراً دائناً/تخصيص AP مستقلاً، لا مسار الاستحقاق النقدي",
      });
    }
    if (!["ACCRUED_UNPAID", "PAYMENT_PENDING", "PAID"].includes(obligation.status)) {
      throw new TRPCError({ code: "CONFLICT", message: `حالة الالتزام ${obligation.status} لا تسمح بطلب تصحيح جديد` });
    }
    await assertCashAssetHasNoDownstreamUseTx(tx, obligation);
    validateRefundShape(obligation.status as AccrualObligationStatus, input);

    const inserted = await tx.insert(accrualCorrectionRequests).values({
      obligationId: Number(obligation.id),
      status: "PENDING",
      previousObligationStatus: obligation.status,
      reason,
      externalEvidenceReference,
      attachmentUrl,
      refundPaymentMethod: input.refundPaymentMethod ?? null,
      refundCashBucket: input.refundCashBucket ?? null,
      refundReferenceNumber: input.refundReferenceNumber?.trim() || null,
      refundCardLastFour: input.refundCardLastFour?.trim() || null,
      clientRequestId,
      payloadHash,
      requestedBy: actor.userId,
    });
    const correctionRequestId = extractInsertId(inserted);
    const nextStatus = obligation.status === "PAID" ? "REFUND_PENDING" : "CORRECTION_PENDING";
    await transitionAccrualObligationTx(tx, {
      obligationId: Number(obligation.id),
      expectedStatus: obligation.status as AccrualObligationStatus,
      nextStatus,
      eventType: "CORRECTION_REQUESTED",
      actorId: actor.userId,
      evidenceReference: externalEvidenceReference,
      dedupeKey: `ACCRUAL:CORRECTION_REQUESTED:${correctionRequestId}`,
    });
    await setSourceCorrectionStatusTx(tx, obligation, "CORRECTION_PENDING");

    let refundRequestReceiptId: number | null = null;
    if (obligation.status === "PAID") {
      const settlement = await latestSettlementTx(tx, Number(obligation.id));
      const method = input.refundPaymentMethod!;
      const request: RefundRequest = {
        kind: "ACCRUAL_CORRECTION_REFUND",
        correctionRequestId,
        obligationId: Number(obligation.id),
        obligationSourceHash: obligation.sourceHash,
        expectedAmount: toDbMoney(obligation.recognizedAmount),
        originalSettlementReceiptId: Number(settlement.receiptId),
        providerEvidenceReference:
          method === "CASH"
            ? externalEvidenceReference
            : requiredText(input.refundReferenceNumber, "مرجع مزود الاسترداد", 100),
      };
      const refund = await createSystemReceiptRequestTx(tx, {
        branchId: Number(obligation.branchId),
        amount: toDbMoney(obligation.recognizedAmount),
        paymentMethod: method,
        partyType: "OTHER",
        partyId: null,
        counterpartyName: beneficiaryName,
        description: `استرداد تصحيح ${obligation.sourceKey}`,
        referenceNumber: `ACCRUAL-REFUND-${correctionRequestId}`,
        checkNumber: method === "CHECK" ? input.refundReferenceNumber?.trim() : null,
        cardLastFour: method === "CARD" ? input.refundCardLastFour?.trim() : null,
        attachmentUrl,
        clientRequestId: `accrual-refund-${clientRequestId}`,
      }, actor, request);
      refundRequestReceiptId = refund.receiptId;
      const linkResult = await tx
        .update(accrualCorrectionRequests)
        .set({ refundRequestReceiptId })
        .where(
          and(
            eq(accrualCorrectionRequests.id, correctionRequestId),
            eq(accrualCorrectionRequests.status, "PENDING"),
          ),
        );
      assertOneAffectedRow(linkResult, "تغير طلب التصحيح أثناء ربط سند الاسترداد");
    }

    return { correctionRequestId, refundRequestReceiptId, replayed: false as const };
  });
}

export async function approveAccrualCorrection(
  correctionRequestId: number,
  actor: Actor,
  occurredAt = new Date(),
  expectedAssetId?: number,
) {
  assertOwner(actor);
  return withTx(async (tx) => {
    const [correction] = await tx
      .select()
      .from(accrualCorrectionRequests)
      .where(eq(accrualCorrectionRequests.id, correctionRequestId))
      .for("update")
      .limit(1);
    if (!correction) throw new TRPCError({ code: "NOT_FOUND", message: "طلب التصحيح غير موجود" });
    if (correction.status !== "PENDING") {
      if (correction.status === "APPROVED") return { correctionRequestId, replayed: true as const };
      throw new TRPCError({ code: "CONFLICT", message: "طلب التصحيح مرفوض ولا يمكن اعتماده" });
    }
    if (Number(correction.requestedBy) === actor.userId) {
      throw new TRPCError({ code: "FORBIDDEN", message: "لا يجوز لمنشئ التصحيح اعتماده" });
    }
    const obligation = await lockAccrualObligationTx(tx, Number(correction.obligationId));
    assertBranchScope(actor, Number(obligation.branchId));
    assertExpectedCashAsset(obligation, expectedAssetId);
    if (correction.previousObligationStatus === "PAID") {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "التصحيح المدفوع يعتمد حصراً من سند قبض الاسترداد المثبت",
      });
    }
    if (obligation.status !== "CORRECTION_PENDING") {
      throw new TRPCError({ code: "CONFLICT", message: "إسقاط/تلاعب في حالة التزام التصحيح" });
    }
    await completeRecognitionCorrectionTx(tx, obligation, {
      expectedStatus: "CORRECTION_PENDING",
      actorId: Number(correction.requestedBy),
      reviewerId: actor.userId,
      evidenceReference: correction.externalEvidenceReference,
      occurredAt,
    });
    const approvalResult = await tx
      .update(accrualCorrectionRequests)
      .set({ status: "APPROVED", reviewedBy: actor.userId, reviewedAt: occurredAt })
      .where(and(eq(accrualCorrectionRequests.id, correctionRequestId), eq(accrualCorrectionRequests.status, "PENDING")));
    assertOneAffectedRow(approvalResult, "تغير طلب التصحيح أثناء الاعتماد");
    return { correctionRequestId, replayed: false as const };
  });
}

async function rejectCorrectionTx(
  tx: Tx,
  input: {
    correction: typeof accrualCorrectionRequests.$inferSelect;
    obligation: typeof accrualObligations.$inferSelect;
    reviewer: Actor;
    rejectionReason: string;
    occurredAt: Date;
  },
) {
  if (Number(input.correction.requestedBy) === input.reviewer.userId) {
    throw new TRPCError({ code: "FORBIDDEN", message: "لا يجوز لمنشئ التصحيح رفضه" });
  }
  const restore = input.correction.previousObligationStatus as AccrualObligationStatus;
  const current = restore === "PAID" ? "REFUND_PENDING" : "CORRECTION_PENDING";
  await transitionAccrualObligationTx(tx, {
    obligationId: Number(input.obligation.id),
    expectedStatus: current,
    nextStatus: restore,
    eventType: "CORRECTION_REJECTED",
    actorId: Number(input.correction.requestedBy),
    reviewerId: input.reviewer.userId,
    evidenceReference: input.rejectionReason,
    dedupeKey: `ACCRUAL:CORRECTION_REJECTED:${input.correction.id}:${Date.now()}`,
  });
  await setSourceCorrectionStatusTx(tx, input.obligation, "ACTIVE");
  const rejectionResult = await tx
    .update(accrualCorrectionRequests)
    .set({
      status: "REJECTED",
      reviewedBy: input.reviewer.userId,
      reviewedAt: input.occurredAt,
      rejectionReason: input.rejectionReason,
    })
    .where(
      and(
        eq(accrualCorrectionRequests.id, Number(input.correction.id)),
        eq(accrualCorrectionRequests.status, "PENDING"),
      ),
    );
  assertOneAffectedRow(rejectionResult, "تغير طلب التصحيح أثناء الرفض");
}

export async function rejectAccrualCorrection(
  correctionRequestId: number,
  rejectionReason: string,
  actor: Actor,
  occurredAt = new Date(),
  expectedAssetId?: number,
) {
  assertOwner(actor);
  const reason = requiredText(rejectionReason, "سبب الرفض", 255);
  return withTx(async (tx) => {
    const [correction] = await tx
      .select()
      .from(accrualCorrectionRequests)
      .where(eq(accrualCorrectionRequests.id, correctionRequestId))
      .for("update")
      .limit(1);
    if (!correction) throw new TRPCError({ code: "NOT_FOUND", message: "طلب التصحيح غير موجود" });
    if (correction.status !== "PENDING") {
      if (correction.status === "REJECTED") return { correctionRequestId, replayed: true as const };
      throw new TRPCError({ code: "CONFLICT", message: "طلب التصحيح المعتمد لا يمكن رفضه" });
    }
    if (correction.previousObligationStatus === "PAID") {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "ارفض سند قبض الاسترداد من شاشة الاعتماد لإبقاء أثر الدفع الأصلي",
      });
    }
    const obligation = await lockAccrualObligationTx(tx, Number(correction.obligationId));
    assertExpectedCashAsset(obligation, expectedAssetId);
    await rejectCorrectionTx(tx, { correction, obligation, reviewer: actor, rejectionReason: reason, occurredAt });
    return { correctionRequestId, replayed: false as const };
  });
}

export async function settleAccrualCorrectionRefundTx(
  tx: Tx,
  input: {
    receipt: typeof receipts.$inferSelect;
    request: RefundRequest;
    approver: Actor;
    occurredAt: Date;
  },
) {
  assertOwner(input.approver);
  const [correction] = await tx
    .select()
    .from(accrualCorrectionRequests)
    .where(eq(accrualCorrectionRequests.id, input.request.correctionRequestId))
    .for("update")
    .limit(1);
  if (!correction || correction.status !== "PENDING" || correction.previousObligationStatus !== "PAID") {
    throw new TRPCError({ code: "CONFLICT", message: "طلب استرداد التصحيح غير صالح للاعتماد" });
  }
  if (Number(correction.requestedBy) === input.approver.userId) {
    throw new TRPCError({ code: "FORBIDDEN", message: "لا يجوز لمنشئ طلب الاسترداد اعتماده" });
  }
  const obligation = await lockAccrualObligationTx(tx, input.request.obligationId);
  assertBranchScope(input.approver, Number(obligation.branchId));
  if (
    Number(correction.obligationId) !== Number(obligation.id) ||
    correction.refundRequestReceiptId == null ||
    Number(correction.refundRequestReceiptId) !== Number(input.receipt.id) ||
    obligation.status !== "REFUND_PENDING" ||
    obligation.sourceHash !== input.request.obligationSourceHash ||
    !money(obligation.recognizedAmount).eq(money(input.request.expectedAmount)) ||
    correction.attachmentUrl !== input.receipt.attachmentUrl ||
    Number(input.receipt.branchId) !== Number(obligation.branchId) ||
    input.receipt.direction !== "IN" ||
    input.receipt.partyType !== "OTHER" ||
    input.receipt.partyId != null ||
    !money(input.receipt.amount).eq(money(obligation.recognizedAmount)) ||
    input.receipt.referenceNumber !== `ACCRUAL-REFUND-${correction.id}`
  ) {
    throw new TRPCError({ code: "CONFLICT", message: "سند الاسترداد لا يطابق طلب التصحيح/الالتزام المثبت" });
  }
  const settlement = await latestSettlementTx(tx, Number(obligation.id));
  if (Number(settlement.receiptId) !== input.request.originalSettlementReceiptId) {
    throw new TRPCError({ code: "CONFLICT", message: "مرجع التسوية الأصلية في طلب الاسترداد غير مطابق" });
  }
  const [originalReceipt] = await tx
    .select({ id: receipts.id, status: receipts.status, approvalStatus: receipts.approvalStatus, amount: receipts.amount })
    .from(receipts)
    .where(eq(receipts.id, input.request.originalSettlementReceiptId))
    .for("update")
    .limit(1);
  if (
    !originalReceipt ||
    originalReceipt.status !== "COMPLETED" ||
    originalReceipt.approvalStatus !== "APPROVED" ||
    !money(originalReceipt.amount).eq(money(obligation.recognizedAmount))
  ) {
    throw new TRPCError({ code: "CONFLICT", message: "التسوية الأصلية ليست دفعة كاملة نافذة" });
  }
  await assertCashAssetHasNoDownstreamUseTx(tx, obligation);

  const method = input.receipt.paymentMethod as RefundMethod;
  if (method !== correction.refundPaymentMethod) {
    throw new TRPCError({ code: "CONFLICT", message: "طريقة الاسترداد تغيرت بعد إنشاء طلب التصحيح" });
  }
  const expectedProviderEvidence = method === "CASH"
    ? correction.externalEvidenceReference
    : correction.refundReferenceNumber;
  if (!expectedProviderEvidence || input.request.providerEvidenceReference !== expectedProviderEvidence) {
    throw new TRPCError({ code: "CONFLICT", message: "دليل مزود الاسترداد لا يطابق الطلب الموقّع" });
  }
  if (
    method === "CASH" &&
    input.receipt.cashBucket !== correction.refundCashBucket
  ) {
    throw new TRPCError({ code: "CONFLICT", message: "دلو الاسترداد النقدي لا يطابق الطلب المعتمد" });
  }
  if (method === "CARD" && input.receipt.cardLastFour !== correction.refundCardLastFour) {
    throw new TRPCError({ code: "CONFLICT", message: "دليل بطاقة الاسترداد لا يطابق الطلب" });
  }
  if (method === "CHECK" && input.receipt.checkNumber !== correction.refundReferenceNumber) {
    throw new TRPCError({ code: "CONFLICT", message: "رقم صك الاسترداد لا يطابق الطلب" });
  }
  const assetRole = refundAssetRole(method, input.receipt.cashBucket as RefundCashBucket | null);
  const amount = money(obligation.recognizedAmount);
  const settlementPlan = obligation.kind === "ASSET_ACQUISITION_CASH"
    ? fixedAssetAccrualSettlement(assetRole, amount.neg())
    : expenseAccrualSettlement(assetRole, amount.neg());
  const settlementDedupe = `ACCRUAL:SETTLEMENT_REVERSAL:${obligation.id}`;
  await postEntry(tx, {
    entryType: "PAYMENT_OUT",
    branchId: Number(obligation.branchId),
    purchaseOrderId: obligation.purchaseOrderId == null ? null : Number(obligation.purchaseOrderId),
    receiptId: Number(input.receipt.id),
    amount: amount.neg(),
    entryDate: input.occurredAt,
    paymentMethod: method,
    postingIntent: settlementPlan.intent,
    postingSourceComponents: settlementPlan.sourceComponents,
    dedupeKey: settlementDedupe,
    createdBy: input.approver.userId,
    notes: `استرداد فعلي لتسوية ${obligation.sourceKey}`,
  });
  const [settlementReversal] = await tx
    .select({ id: accountingEntries.id })
    .from(accountingEntries)
    .where(eq(accountingEntries.dedupeKey, settlementDedupe))
    .limit(1);
  if (!settlementReversal) throw new Error("قيد عكس تسوية الاستحقاق مفقود");
  await transitionAccrualObligationTx(tx, {
    obligationId: Number(obligation.id),
    expectedStatus: "REFUND_PENDING",
    nextStatus: "REFUNDED",
    eventType: "SETTLEMENT_REVERSED",
    actorId: Number(correction.requestedBy),
    reviewerId: input.approver.userId,
    receiptId: Number(input.receipt.id),
    accountingEntryId: Number(settlementReversal.id),
    evidenceReference: correction.externalEvidenceReference,
    dedupeKey: `ACCRUAL:SETTLEMENT_REVERSED:${obligation.id}`,
  });
  const refreshed = await lockAccrualObligationTx(tx, Number(obligation.id));
  await completeRecognitionCorrectionTx(tx, refreshed, {
    expectedStatus: "REFUNDED",
    actorId: Number(correction.requestedBy),
    reviewerId: input.approver.userId,
    evidenceReference: correction.externalEvidenceReference,
    occurredAt: input.occurredAt,
  });
  const approvalResult = await tx
    .update(accrualCorrectionRequests)
    .set({ status: "APPROVED", reviewedBy: input.approver.userId, reviewedAt: input.occurredAt })
    .where(and(eq(accrualCorrectionRequests.id, Number(correction.id)), eq(accrualCorrectionRequests.status, "PENDING")));
  assertOneAffectedRow(approvalResult, "تغير طلب تصحيح الاسترداد أثناء الاعتماد");
  return { correctionRequestId: Number(correction.id), obligationId: Number(obligation.id) };
}

export async function rejectAccrualCorrectionRefundTx(
  tx: Tx,
  input: {
    receipt: typeof receipts.$inferSelect;
    request: RefundRequest;
    reviewer: Actor;
    rejectionReason: string;
    occurredAt: Date;
  },
) {
  assertOwner(input.reviewer);
  const reason = requiredText(input.rejectionReason, "سبب الرفض", 255);
  const [correction] = await tx
    .select()
    .from(accrualCorrectionRequests)
    .where(eq(accrualCorrectionRequests.id, input.request.correctionRequestId))
    .for("update")
    .limit(1);
  if (!correction || correction.status !== "PENDING" || correction.previousObligationStatus !== "PAID") {
    throw new TRPCError({ code: "CONFLICT", message: "طلب استرداد التصحيح غير صالح للرفض" });
  }
  if (
    Number(correction.refundRequestReceiptId) !== Number(input.receipt.id) ||
    Number(correction.obligationId) !== input.request.obligationId ||
    correction.attachmentUrl !== input.receipt.attachmentUrl ||
    input.receipt.referenceNumber !== `ACCRUAL-REFUND-${correction.id}` ||
    input.receipt.direction !== "IN" ||
    input.receipt.partyType !== "OTHER" ||
    input.receipt.partyId != null
  ) {
    throw new TRPCError({ code: "CONFLICT", message: "سند الاسترداد لا يطابق طلب التصحيح" });
  }
  const obligation = await lockAccrualObligationTx(tx, input.request.obligationId);
  const method = input.receipt.paymentMethod as RefundMethod;
  const expectedProviderEvidence = method === "CASH"
    ? correction.externalEvidenceReference
    : correction.refundReferenceNumber;
  if (
    obligation.sourceHash !== input.request.obligationSourceHash ||
    !money(obligation.recognizedAmount).eq(money(input.request.expectedAmount)) ||
    !money(input.receipt.amount).eq(money(obligation.recognizedAmount)) ||
    input.receipt.paymentMethod !== correction.refundPaymentMethod ||
    !expectedProviderEvidence ||
    input.request.providerEvidenceReference !== expectedProviderEvidence
  ) {
    throw new TRPCError({ code: "CONFLICT", message: "طلب رفض الاسترداد لا يطابق مصدر الالتزام المثبت" });
  }
  await rejectCorrectionTx(tx, { correction, obligation, reviewer: input.reviewer, rejectionReason: reason, occurredAt: input.occurredAt });
  return { correctionRequestId: Number(correction.id), obligationId: Number(obligation.id) };
}

export async function bindAccrualCorrectionRefundReplacementTx(
  tx: Tx,
  input: {
    correctionRequestId: number;
    replacementReceiptId: number;
    actorId: number;
  },
) {
  const [correction] = await tx
    .select()
    .from(accrualCorrectionRequests)
    .where(eq(accrualCorrectionRequests.id, input.correctionRequestId))
    .for("update")
    .limit(1);
  if (!correction || correction.status !== "REJECTED" || correction.previousObligationStatus !== "PAID") {
    throw new TRPCError({ code: "CONFLICT", message: "طلب التصحيح لا يقبل إعادة تقديم استرداد" });
  }
  if (Number(correction.requestedBy) !== input.actorId) {
    throw new TRPCError({ code: "FORBIDDEN", message: "إعادة التقديم محصورة بمنشئ طلب التصحيح" });
  }
  const obligation = await lockAccrualObligationTx(tx, Number(correction.obligationId));
  const beneficiaryName = requiredText(
    obligation.beneficiaryName,
    "اسم مستفيد الاستحقاق المثبت",
    200,
  );
  const settlement = await latestSettlementTx(tx, Number(obligation.id));
  const expectedProviderEvidence = correction.refundPaymentMethod === "CASH"
    ? correction.externalEvidenceReference
    : correction.refundReferenceNumber;
  const [replacement] = await tx
    .select()
    .from(receipts)
    .where(eq(receipts.id, input.replacementReceiptId))
    .for("update")
    .limit(1);
  const replacementRequest = parseSystemPaymentRequest(replacement?.internalNote);
  if (
    !replacement ||
    replacement.direction !== "IN" ||
    replacement.status !== "PENDING" ||
    replacement.approvalStatus !== "PENDING_APPROVAL" ||
    replacementRequest?.kind !== "ACCRUAL_CORRECTION_REFUND" ||
    replacementRequest.correctionRequestId !== Number(correction.id) ||
    replacementRequest.obligationId !== Number(correction.obligationId) ||
    replacementRequest.obligationSourceHash !== obligation.sourceHash ||
    !money(replacementRequest.expectedAmount).eq(money(obligation.recognizedAmount)) ||
    replacementRequest.originalSettlementReceiptId !== Number(settlement.receiptId) ||
    !expectedProviderEvidence ||
    replacementRequest.providerEvidenceReference !== expectedProviderEvidence ||
    Number(replacement.branchId) !== Number(obligation.branchId) ||
    !money(replacement.amount).eq(money(obligation.recognizedAmount)) ||
    replacement.counterpartyName?.trim() !== beneficiaryName ||
    replacement.referenceNumber !== `ACCRUAL-REFUND-${correction.id}` ||
    replacement.partyType !== "OTHER" ||
    replacement.partyId != null ||
    Number(replacement.createdBy) !== input.actorId ||
    replacement.attachmentUrl !== correction.attachmentUrl ||
    replacement.paymentMethod !== correction.refundPaymentMethod ||
    (replacement.paymentMethod === "CARD" && replacement.cardLastFour !== correction.refundCardLastFour) ||
    (replacement.paymentMethod === "CHECK" && replacement.checkNumber !== correction.refundReferenceNumber)
  ) {
    throw new TRPCError({ code: "CONFLICT", message: "سند الاسترداد البديل ليس طلب قبض معلقاً" });
  }
  await transitionAccrualObligationTx(tx, {
    obligationId: Number(obligation.id),
    expectedStatus: "PAID",
    nextStatus: "REFUND_PENDING",
    eventType: "CORRECTION_REQUESTED",
    actorId: input.actorId,
    evidenceReference: correction.externalEvidenceReference,
    dedupeKey: `ACCRUAL:CORRECTION_RESUBMITTED:${correction.id}:${replacement.id}`,
  });
  await setSourceCorrectionStatusTx(tx, obligation, "CORRECTION_PENDING");
  const resetResult = await tx
    .update(accrualCorrectionRequests)
    .set({
      status: "PENDING",
      reviewedBy: null,
      reviewedAt: null,
      rejectionReason: null,
      refundRequestReceiptId: Number(replacement.id),
    })
    .where(
      and(
        eq(accrualCorrectionRequests.id, Number(correction.id)),
        eq(accrualCorrectionRequests.status, "REJECTED"),
      ),
    );
  assertOneAffectedRow(resetResult, "تغير طلب التصحيح أثناء إعادة تقديم الاسترداد");
}

export async function retryAccrualCorrectionRefund(
  correctionRequestId: number,
  clientRequestIdInput: string,
  actor: Actor,
) {
  const clientRequestId = requiredText(clientRequestIdInput, "مفتاح إعادة التقديم", 64);
  return withTx(async (tx) => {
    const [correction] = await tx
      .select()
      .from(accrualCorrectionRequests)
      .where(eq(accrualCorrectionRequests.id, correctionRequestId))
      .for("update")
      .limit(1);
    if (!correction || correction.status !== "REJECTED" || correction.previousObligationStatus !== "PAID") {
      throw new TRPCError({ code: "CONFLICT", message: "طلب التصحيح لا يقبل إعادة تقديم استرداد" });
    }
    if (Number(correction.requestedBy) !== actor.userId) {
      throw new TRPCError({ code: "FORBIDDEN", message: "إعادة التقديم محصورة بمنشئ طلب التصحيح" });
    }
    const obligation = await lockAccrualObligationTx(tx, Number(correction.obligationId));
    assertBranchScope(actor, Number(obligation.branchId));
    const beneficiaryName = requiredText(
      obligation.beneficiaryName,
      "اسم مستفيد الاستحقاق المثبت",
      200,
    );
    const settlement = await latestSettlementTx(tx, Number(obligation.id));
    const method = correction.refundPaymentMethod;
    if (!method) throw new TRPCError({ code: "CONFLICT", message: "طريقة الاسترداد الأصلية مفقودة" });
    const providerEvidence = method === "CASH"
      ? correction.externalEvidenceReference
      : requiredText(correction.refundReferenceNumber, "مرجع مزود الاسترداد", 100);
    const request: RefundRequest = {
      kind: "ACCRUAL_CORRECTION_REFUND",
      correctionRequestId,
      obligationId: Number(obligation.id),
      obligationSourceHash: obligation.sourceHash,
      expectedAmount: toDbMoney(obligation.recognizedAmount),
      originalSettlementReceiptId: Number(settlement.receiptId),
      providerEvidenceReference: providerEvidence,
    };
    const replacement = await createSystemReceiptRequestTx(tx, {
      branchId: Number(obligation.branchId),
      amount: toDbMoney(obligation.recognizedAmount),
      paymentMethod: method,
      partyType: "OTHER",
      partyId: null,
      counterpartyName: beneficiaryName,
      description: `إعادة تقديم استرداد تصحيح ${obligation.sourceKey}`,
      referenceNumber: `ACCRUAL-REFUND-${correctionRequestId}`,
      checkNumber: method === "CHECK" ? correction.refundReferenceNumber : null,
      cardLastFour: method === "CARD" ? correction.refundCardLastFour : null,
      attachmentUrl: correction.attachmentUrl,
      clientRequestId,
    }, actor, request);
    await bindAccrualCorrectionRefundReplacementTx(tx, {
      correctionRequestId,
      replacementReceiptId: replacement.receiptId,
      actorId: actor.userId,
    });
    return { correctionRequestId, refundRequestReceiptId: replacement.receiptId };
  });
}

export async function listAccrualCorrections(
  obligationId: number,
  actor: Actor,
  expectedAssetId?: number,
) {
  return withTx(async (tx) => {
    const obligation = await lockAccrualObligationTx(tx, obligationId);
    assertBranchScope(actor, Number(obligation.branchId));
    assertExpectedCashAsset(obligation, expectedAssetId);
    return tx
      .select()
      .from(accrualCorrectionRequests)
      .where(eq(accrualCorrectionRequests.obligationId, obligationId))
      .orderBy(desc(accrualCorrectionRequests.id));
  });
}
