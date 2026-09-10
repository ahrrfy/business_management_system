import { TRPCError } from "@trpc/server";
import { and, desc, eq, gt, gte, lt, or } from "drizzle-orm";
import { alias } from "drizzle-orm/mysql-core";
import {
  cashDailyReconciliations,
  cashMissedDailyCountExceptionEvents,
  cashMissedDailyCountExceptions,
  receipts,
  users,
} from "../../../drizzle/schema";
import {
  MISSED_DAILY_COUNT_EVIDENCE_MAX,
  MISSED_DAILY_COUNT_EVIDENCE_MIN,
  MISSED_DAILY_COUNT_REASON_MAX,
  MISSED_DAILY_COUNT_REASON_MIN,
  type MissedDailyCountExceptionStatus,
} from "../../../shared/missedDailyCountException";
import { hasCashVariance } from "../../../shared/cashDailyReconciliation";
import type { Tx } from "../../db";
import { canCrossBranches } from "../../lib/branchAuthority";
import { extractInsertId } from "../../lib/insertId";
import { logAuditTx, type AuditMetadata } from "../auditService";
import { todayUtcDate, utcDayRange } from "../businessDay";
import { cashEventAtSql } from "./cashEventAt";
import { buildDailyCashEvidenceTx } from "../cashDailyReconciliationService";
import { idempotencyHash, payloadHashMatches } from "../idempotency";
import { money, toDbMoney } from "../money";
import { canonicalCloseJson, closeSha256 } from "../reports/monthCloseSequence";
import { withTx, type Actor } from "../tx";
import { resolveApprovalActor } from "../approval/ownerGate";

export interface RequestMissedDailyCountExceptionInput {
  branchId: number;
  businessDate: string;
  carryForwardReconciliationId: number;
  reason: string;
  evidenceReference: string;
  clientRequestId: string;
}

export interface DecideMissedDailyCountExceptionInput {
  exceptionId: number;
  expectedVersion: number;
  decision: Extract<MissedDailyCountExceptionStatus, "APPROVED" | "REJECTED">;
  note: string;
  clientRequestId: string;
}

export interface MissingDailyCashEvidence {
  branchId: number;
  businessDate: string;
  required: boolean;
  dayCashReceiptCount: number;
  shiftCount: number;
  endOfDayTreasuryCash: string;
  evidenceHash: string;
}

const requesterUser = alias(users, "missedDailyCountRequester");
const reviewerUser = alias(users, "missedDailyCountReviewer");

function assertBranchScope(actor: Actor, branchId: number): void {
  if (!canCrossBranches(actor) && Number(actor.branchId) !== Number(branchId)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "لا يمكنك إدارة استثناء جرد لفرع آخر",
    });
  }
}

function assertManagerOrAccountant(actor: Actor): void {
  if (!["admin", "manager", "accountant"].includes(actor.role ?? "")) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "استثناء الجرد اليومي محصور بالإدارة أو المحاسبة",
    });
  }
}

function normalizeText(
  value: string,
  label: string,
  minimum: number,
  maximum: number,
): string {
  const normalized = value.trim();
  if (normalized.length < minimum || normalized.length > maximum) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${label} مطلوب بطول من ${minimum} إلى ${maximum} محرفاً`,
    });
  }
  return normalized;
}

function exactSecond(value: Date): Date {
  return new Date(Math.floor(value.getTime() / 1_000) * 1_000);
}

function activeBusinessDateKey(branchId: number, businessDate: string): string {
  return `${branchId}:${businessDate}`;
}

function assertHistoricalDay(businessDate: string): void {
  if (businessDate >= todayUtcDate()) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "الاستثناء متاح ليوم تاريخي فائت فقط؛ جرد اليوم يُسجّل فعلياً من شاشة الإقفال",
    });
  }
}

export async function buildMissingDailyCashEvidenceTx(
  tx: Tx,
  branchId: number,
  businessDate: string,
): Promise<MissingDailyCashEvidence> {
  const { start, endExclusive } = utcDayRange(businessDate, businessDate);
  const cashEventAt = cashEventAtSql({
    approvedBy: receipts.approvedBy,
    createdBy: receipts.createdBy,
    approvedAt: receipts.approvedAt,
    createdAt: receipts.createdAt,
  });
  const dayCashReceipts = await tx
    .select({
      id: receipts.id,
      direction: receipts.direction,
      amount: receipts.amount,
      cashBucket: receipts.cashBucket,
      status: receipts.status,
      approvalStatus: receipts.approvalStatus,
      referenceNumber: receipts.referenceNumber,
    })
    .from(receipts)
    .where(
      and(
        eq(receipts.branchId, branchId),
        eq(receipts.paymentMethod, "CASH"),
        eq(receipts.approvalStatus, "APPROVED"),
        or(eq(receipts.status, "COMPLETED"), eq(receipts.status, "REVERSED")),
        gte(cashEventAt, start),
        lt(cashEventAt, endExclusive),
      ),
    )
    .orderBy(receipts.id);
  const daily = await buildDailyCashEvidenceTx(tx, branchId, businessDate);
  const required =
    dayCashReceipts.length > 0 ||
    daily.shiftCount > 0 ||
    hasCashVariance(daily.expectedTreasuryCash);
  const canonical = canonicalCloseJson({
    version: "missed-daily-count-evidence/v1",
    branchId,
    businessDate,
    dayCashReceipts: dayCashReceipts.map((row) => ({
      id: Number(row.id),
      direction: row.direction,
      amount: toDbMoney(row.amount),
      cashBucket: row.cashBucket,
      status: row.status,
      approvalStatus: row.approvalStatus,
      referenceNumber: row.referenceNumber,
    })),
    dailyEvidenceHash: daily.evidenceHash,
    shiftCount: daily.shiftCount,
    endOfDayTreasuryCash: daily.expectedTreasuryCash,
    required,
  });
  return {
    branchId,
    businessDate,
    required,
    dayCashReceiptCount: dayCashReceipts.length,
    shiftCount: daily.shiftCount,
    endOfDayTreasuryCash: daily.expectedTreasuryCash,
    evidenceHash: closeSha256(canonical),
  };
}

async function assertNoHistoricalReconciliationTx(
  tx: Tx,
  branchId: number,
  businessDate: string,
): Promise<void> {
  const [existing] = await tx
    .select({ id: cashDailyReconciliations.id })
    .from(cashDailyReconciliations)
    .where(
      and(
        eq(cashDailyReconciliations.branchId, branchId),
        eq(cashDailyReconciliations.businessDate, businessDate),
      ),
    )
    .for("update")
    .limit(1);
  if (existing) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "اليوم يملك مطابقة فعلية؛ لا يجوز استبدالها باستثناء جرد مفقود",
    });
  }
}

async function loadCurrentCarryForwardTx(
  tx: Tx,
  branchId: number,
  businessDate: string,
  lock: boolean,
) {
  const query = tx
    .select()
    .from(cashDailyReconciliations)
    .where(
      and(
        eq(cashDailyReconciliations.branchId, branchId),
        gt(cashDailyReconciliations.businessDate, businessDate),
        // جرد اليوم المغلق قابل لإعادة الفتح حتى نهاية اليوم. لا يصلح دليلاً immutable
        // لاستثناءٍ معتمد؛ نختار آخر مطابقة لاحقة أصبحت تاريخيةً وغير قابلة لإعادة الفتح.
        lt(cashDailyReconciliations.businessDate, todayUtcDate()),
        eq(cashDailyReconciliations.status, "CLOSED"),
      ),
    )
    .orderBy(
      desc(cashDailyReconciliations.businessDate),
      desc(cashDailyReconciliations.id),
    )
    .limit(1);
  const rows = lock ? await query.for("update") : await query;
  return rows[0] ?? null;
}

async function listExceptionRowsTx(
  tx: Tx,
  branchId: number,
  businessDate: string,
) {
  return tx
    .select({
      id: cashMissedDailyCountExceptions.id,
      branchId: cashMissedDailyCountExceptions.branchId,
      businessDate: cashMissedDailyCountExceptions.businessDate,
      carryForwardReconciliationId:
        cashMissedDailyCountExceptions.carryForwardReconciliationId,
      carryForwardBusinessDate:
        cashMissedDailyCountExceptions.carryForwardBusinessDate,
      carryForwardVersion: cashMissedDailyCountExceptions.carryForwardVersion,
      carryForwardEvidenceHash:
        cashMissedDailyCountExceptions.carryForwardEvidenceHash,
      missingDayEvidenceHash:
        cashMissedDailyCountExceptions.missingDayEvidenceHash,
      reason: cashMissedDailyCountExceptions.reason,
      evidenceReference: cashMissedDailyCountExceptions.evidenceReference,
      status: cashMissedDailyCountExceptions.status,
      immutableEvidenceHash:
        cashMissedDailyCountExceptions.immutableEvidenceHash,
      requestedByUserId: cashMissedDailyCountExceptions.requestedByUserId,
      requestedByName: requesterUser.name,
      requestedAt: cashMissedDailyCountExceptions.requestedAt,
      version: cashMissedDailyCountExceptions.version,
      reviewedByUserId: cashMissedDailyCountExceptions.reviewedByUserId,
      reviewedByName: reviewerUser.name,
      reviewedAt: cashMissedDailyCountExceptions.reviewedAt,
      decisionNote: cashMissedDailyCountExceptions.decisionNote,
      decisionHash: cashMissedDailyCountExceptions.decisionHash,
    })
    .from(cashMissedDailyCountExceptions)
    .leftJoin(
      requesterUser,
      eq(requesterUser.id, cashMissedDailyCountExceptions.requestedByUserId),
    )
    .leftJoin(
      reviewerUser,
      eq(reviewerUser.id, cashMissedDailyCountExceptions.reviewedByUserId),
    )
    .where(
      and(
        eq(cashMissedDailyCountExceptions.branchId, branchId),
        eq(cashMissedDailyCountExceptions.businessDate, businessDate),
      ),
    )
    .orderBy(desc(cashMissedDailyCountExceptions.id));
}

export async function getMissedDailyCountExceptionContext(
  input: { branchId: number; businessDate: string },
  actor: Actor,
) {
  assertBranchScope(actor, input.branchId);
  return withTx(
    async (tx) => {
      const [existingReconciliation] = await tx
        .select({ id: cashDailyReconciliations.id })
        .from(cashDailyReconciliations)
        .where(
          and(
            eq(cashDailyReconciliations.branchId, input.branchId),
            eq(cashDailyReconciliations.businessDate, input.businessDate),
          ),
        )
        .limit(1);
      const evidence = await buildMissingDailyCashEvidenceTx(
        tx,
        input.branchId,
        input.businessDate,
      );
      const carryForward = await loadCurrentCarryForwardTx(
        tx,
        input.branchId,
        input.businessDate,
        false,
      );
      const requests = await listExceptionRowsTx(
        tx,
        input.branchId,
        input.businessDate,
      );
      const active = requests.find(
        (row) => row.status === "PENDING" || row.status === "APPROVED",
      );
      const approvedCarry =
        active?.status === "APPROVED"
          ? (
              await tx
                .select({ id: cashDailyReconciliations.id })
                .from(cashDailyReconciliations)
                .where(
                  and(
                    eq(
                      cashDailyReconciliations.id,
                      Number(active.carryForwardReconciliationId),
                    ),
                    eq(cashDailyReconciliations.branchId, input.branchId),
                    eq(
                      cashDailyReconciliations.businessDate,
                      active.carryForwardBusinessDate,
                    ),
                    eq(cashDailyReconciliations.status, "CLOSED"),
                    eq(
                      cashDailyReconciliations.version,
                      Number(active.carryForwardVersion),
                    ),
                    eq(
                      cashDailyReconciliations.evidenceHash,
                      active.carryForwardEvidenceHash,
                    ),
                  ),
                )
                .limit(1)
            )[0]
          : null;
      const historical = input.businessDate < todayUtcDate();
      return {
        evidence,
        carryForward,
        requests,
        approvedExemptionValid:
          active?.status === "APPROVED" ? approvedCarry != null : null,
        actions: {
          canRequest:
            historical &&
            existingReconciliation == null &&
            evidence.required &&
            carryForward != null &&
            active == null &&
            ["admin", "manager", "accountant"].includes(actor.role ?? ""),
          canDecide:
            active?.status === "PENDING" &&
            Number(active.requestedByUserId) !== actor.userId &&
            ["admin", "manager", "accountant"].includes(actor.role ?? ""),
        },
      };
    },
    { gate: "NONE" },
  );
}

export async function requestMissedDailyCountException(
  input: RequestMissedDailyCountExceptionInput,
  actor: Actor,
  auditCtx: AuditMetadata,
) {
  assertManagerOrAccountant(actor);
  assertBranchScope(actor, input.branchId);
  assertHistoricalDay(input.businessDate);
  const reason = normalizeText(
    input.reason,
    "سبب فقدان الجرد",
    MISSED_DAILY_COUNT_REASON_MIN,
    MISSED_DAILY_COUNT_REASON_MAX,
  );
  const evidenceReference = normalizeText(
    input.evidenceReference,
    "مرجع الدليل",
    MISSED_DAILY_COUNT_EVIDENCE_MIN,
    MISSED_DAILY_COUNT_EVIDENCE_MAX,
  );
  const requestHash = idempotencyHash({
    operation: "MISSED_DAILY_COUNT_REQUEST",
    actorUserId: actor.userId,
    branchId: input.branchId,
    businessDate: input.businessDate,
    carryForwardReconciliationId: input.carryForwardReconciliationId,
    reason,
    evidenceReference,
  });

  const result = await withTx(async (tx) => {
    const [replay] = await tx
      .select()
      .from(cashMissedDailyCountExceptions)
      .where(
        eq(
          cashMissedDailyCountExceptions.requestClientRequestId,
          input.clientRequestId,
        ),
      )
      .limit(1);
    if (replay) {
      if (!payloadHashMatches(requestHash, replay.requestHash)) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "مفتاح الطلب مستعمل لاستثناء جرد مختلف",
        });
      }
      return { ...replay, idempotent: true };
    }

    await assertNoHistoricalReconciliationTx(
      tx,
      input.branchId,
      input.businessDate,
    );
    const missingEvidence = await buildMissingDailyCashEvidenceTx(
      tx,
      input.branchId,
      input.businessDate,
    );
    if (!missingEvidence.required) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message:
          "اليوم لا يملك نشاطاً نقدياً ولا رصيد خزينة مرحّلاً يتطلب استثناءً",
      });
    }
    const carryForward = await loadCurrentCarryForwardTx(
      tx,
      input.branchId,
      input.businessDate,
      true,
    );
    if (
      !carryForward ||
      Number(carryForward.id) !== input.carryForwardReconciliationId
    ) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "تغيّرت أحدث مطابقة مرحّلة مغلقة؛ حدّث الشاشة ثم أعد الطلب",
      });
    }
    const requestedAt = exactSecond(new Date());
    const immutablePayload = {
      version: "missed-daily-count-request/v1",
      branchId: input.branchId,
      businessDate: input.businessDate,
      carryForwardReconciliationId: Number(carryForward.id),
      carryForwardBusinessDate: carryForward.businessDate,
      carryForwardVersion: Number(carryForward.version),
      carryForwardEvidenceHash: carryForward.evidenceHash,
      missingDayEvidenceHash: missingEvidence.evidenceHash,
      missingDayEvidence: missingEvidence,
      reason,
      evidenceReference,
      requestClientRequestId: input.clientRequestId,
      requestHash,
      requestedByUserId: actor.userId,
      requestedAt: requestedAt.toISOString(),
    };
    const payloadCanonical = canonicalCloseJson(immutablePayload);
    const immutableEvidenceHash = closeSha256(payloadCanonical);
    const inserted = await tx.insert(cashMissedDailyCountExceptions).values({
      branchId: input.branchId,
      businessDate: input.businessDate,
      carryForwardReconciliationId: Number(carryForward.id),
      carryForwardBusinessDate: carryForward.businessDate,
      carryForwardVersion: Number(carryForward.version),
      carryForwardEvidenceHash: carryForward.evidenceHash,
      missingDayEvidenceHash: missingEvidence.evidenceHash,
      reason,
      evidenceReference,
      status: "PENDING",
      activeBusinessDateKey: activeBusinessDateKey(
        input.branchId,
        input.businessDate,
      ),
      requestClientRequestId: input.clientRequestId,
      requestHash,
      immutableEvidenceHash,
      requestedByUserId: actor.userId,
      requestedAt,
      version: 1,
    });
    const id = extractInsertId(inserted);
    await tx.insert(cashMissedDailyCountExceptionEvents).values({
      exceptionId: id,
      version: 1,
      eventType: "PROPOSED",
      clientRequestId: input.clientRequestId,
      requestHash,
      actorUserId: actor.userId,
      payloadCanonical,
      payloadHash: immutableEvidenceHash,
      createdAt: requestedAt,
    });
    await logAuditTx(tx, auditCtx, {
      action: "treasury.missedDailyCount.request",
      entityType: "cashMissedDailyCountException",
      entityId: id,
      branchId: input.branchId,
      newValue: {
        id,
        ...immutablePayload,
        immutableEvidenceHash,
        zeroFinancialEffect: true,
      },
    });
    return {
      id,
      ...immutablePayload,
      status: "PENDING" as const,
      immutableEvidenceHash,
      version: 1,
      idempotent: false,
    };
  });
  const resolvedActor = await withTx((tx) => resolveApprovalActor(tx, actor));
  if (resolvedActor.isOwner && result.status === "PENDING") {
    return decideMissedDailyCountException(
      {
        exceptionId: Number(result.id),
        expectedVersion: Number(result.version),
        decision: "APPROVED",
        note: "اعتماد تلقائي لأن منفذ العملية هو المالك",
        clientRequestId: `owner-auto-${input.clientRequestId}`,
      },
      resolvedActor,
      auditCtx,
    );
  }
  return result;
}

export async function decideMissedDailyCountException(
  input: DecideMissedDailyCountExceptionInput,
  actor: Actor,
  auditCtx: AuditMetadata,
) {
  assertManagerOrAccountant(actor);
  const note = normalizeText(input.note, "ملاحظة القرار", 10, 500);
  const requestHash = idempotencyHash({
    operation: "MISSED_DAILY_COUNT_DECISION",
    actorUserId: actor.userId,
    exceptionId: input.exceptionId,
    expectedVersion: input.expectedVersion,
    decision: input.decision,
    note,
  });

  return withTx(async (tx) => {
    const [candidate] = await tx
      .select({ branchId: cashMissedDailyCountExceptions.branchId })
      .from(cashMissedDailyCountExceptions)
      .where(eq(cashMissedDailyCountExceptions.id, input.exceptionId))
      .limit(1);
    if (!candidate) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "طلب الاستثناء غير موجود",
      });
    }
    assertBranchScope(actor, Number(candidate.branchId));
    const [replayEvent] = await tx
      .select()
      .from(cashMissedDailyCountExceptionEvents)
      .where(
        eq(
          cashMissedDailyCountExceptionEvents.clientRequestId,
          input.clientRequestId,
        ),
      )
      .limit(1);
    if (replayEvent) {
      if (
        !payloadHashMatches(requestHash, replayEvent.requestHash) ||
        replayEvent.eventType !== input.decision
      ) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "مفتاح القرار مستعمل لقرار مختلف",
        });
      }
      const [replay] = await tx
        .select()
        .from(cashMissedDailyCountExceptions)
        .where(eq(cashMissedDailyCountExceptions.id, input.exceptionId))
        .limit(1);
      return { ...replay, idempotent: true };
    }

    const [row] = await tx
      .select()
      .from(cashMissedDailyCountExceptions)
      .where(eq(cashMissedDailyCountExceptions.id, input.exceptionId))
      .for("update")
      .limit(1);
    if (!row) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "طلب الاستثناء غير موجود",
      });
    }
    if (!actor.isOwner && Number(row.requestedByUserId) === actor.userId) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message:
          "طالب الاستثناء لا يمكنه اعتماد طلبه أو رفضه، بلا استثناء للدور",
      });
    }
    if (row.status !== "PENDING") {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "طلب الاستثناء محسوم مسبقاً",
      });
    }
    if (Number(row.version) !== input.expectedVersion) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "تغيّر طلب الاستثناء؛ حدّث الشاشة ثم أعد القرار",
      });
    }

    if (input.decision === "APPROVED") {
      assertHistoricalDay(row.businessDate);
      await assertNoHistoricalReconciliationTx(
        tx,
        Number(row.branchId),
        row.businessDate,
      );
      const currentEvidence = await buildMissingDailyCashEvidenceTx(
        tx,
        Number(row.branchId),
        row.businessDate,
      );
      if (
        !currentEvidence.required ||
        currentEvidence.evidenceHash !== row.missingDayEvidenceHash
      ) {
        throw new TRPCError({
          code: "CONFLICT",
          message:
            "تغيّر دليل اليوم المفقود؛ ارفض الطلب وأنشئ طلباً جديداً من لقطة حالية",
        });
      }
      const currentCarry = await loadCurrentCarryForwardTx(
        tx,
        Number(row.branchId),
        row.businessDate,
        true,
      );
      if (
        !currentCarry ||
        Number(currentCarry.id) !== Number(row.carryForwardReconciliationId) ||
        currentCarry.status !== "CLOSED" ||
        currentCarry.businessDate !== row.carryForwardBusinessDate ||
        Number(currentCarry.version) !== Number(row.carryForwardVersion) ||
        currentCarry.evidenceHash !== row.carryForwardEvidenceHash
      ) {
        throw new TRPCError({
          code: "CONFLICT",
          message:
            "مطابقة الترحيل تغيّرت أو لم تعد مغلقة؛ لا يمكن اعتماد دليل قديم",
        });
      }
    }

    const reviewedAt = exactSecond(new Date());
    const decisionPayload = {
      version: "missed-daily-count-decision/v1",
      exceptionId: Number(row.id),
      exceptionImmutableEvidenceHash: row.immutableEvidenceHash,
      branchId: Number(row.branchId),
      businessDate: row.businessDate,
      carryForwardReconciliationId: Number(row.carryForwardReconciliationId),
      carryForwardVersion: Number(row.carryForwardVersion),
      carryForwardEvidenceHash: row.carryForwardEvidenceHash,
      missingDayEvidenceHash: row.missingDayEvidenceHash,
      decision: input.decision,
      note,
      decisionClientRequestId: input.clientRequestId,
      requestHash,
      reviewedByUserId: actor.userId,
      reviewedAt: reviewedAt.toISOString(),
      zeroFinancialEffect: true,
    };
    const payloadCanonical = canonicalCloseJson(decisionPayload);
    const decisionHash = closeSha256(payloadCanonical);
    await tx
      .update(cashMissedDailyCountExceptions)
      .set({
        status: input.decision,
        activeBusinessDateKey:
          input.decision === "APPROVED"
            ? activeBusinessDateKey(Number(row.branchId), row.businessDate)
            : null,
        version: 2,
        decisionClientRequestId: input.clientRequestId,
        decisionHash,
        reviewedByUserId: actor.userId,
        reviewedAt,
        decisionNote: note,
      })
      .where(
        and(
          eq(cashMissedDailyCountExceptions.id, input.exceptionId),
          eq(cashMissedDailyCountExceptions.version, input.expectedVersion),
          eq(cashMissedDailyCountExceptions.status, "PENDING"),
        ),
      );
    await tx.insert(cashMissedDailyCountExceptionEvents).values({
      exceptionId: input.exceptionId,
      version: 2,
      eventType: input.decision,
      clientRequestId: input.clientRequestId,
      requestHash,
      actorUserId: actor.userId,
      payloadCanonical,
      payloadHash: decisionHash,
      createdAt: reviewedAt,
    });
    await logAuditTx(tx, auditCtx, {
      action:
        input.decision === "APPROVED"
          ? "treasury.missedDailyCount.approve"
          : "treasury.missedDailyCount.reject",
      entityType: "cashMissedDailyCountException",
      entityId: input.exceptionId,
      branchId: Number(row.branchId),
      oldValue: row,
      newValue: { ...decisionPayload, decisionHash },
    });
    return {
      ...row,
      status: input.decision,
      version: 2,
      reviewedByUserId: actor.userId,
      reviewedAt,
      decisionNote: note,
      decisionHash,
      idempotent: false,
    };
  });
}
