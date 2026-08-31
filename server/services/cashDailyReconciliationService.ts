import { createHash } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, gte, like, lt, notInArray, or, sql } from "drizzle-orm";
import {
  accountingEntries,
  cashDailyReconciliations,
  cashVarianceCaseEvents,
  cashVarianceCases,
  receipts,
  shifts,
} from "../../drizzle/schema";
import type { Tx } from "../db";
import type { TrpcContext } from "../context";
import { logAuditTx } from "./auditService";
import { extractInsertId } from "../lib/insertId";
import { todayUtcDate, utcDayRange } from "./businessDay";
import { lockCashSourceForUpdate } from "./cash/cashAvailability";
import { cashEventAtSql } from "./cash/cashEventAt";
import { validateCashBreakdown, type CashBreakdown } from "./cash/countValidation";
import { money, toDbMoney } from "./money";
import { withTx, type Actor } from "./tx";

type AuditContext = Pick<TrpcContext, "user" | "req">;

export type DailyCashBlockerCode =
  | "OPEN_SHIFT"
  | "UNMATCHED_SHIFT"
  | "PENDING_CUSTODY"
  | "STALE_EVIDENCE"
  | "TREASURY_VARIANCE"
  | "SEPARATION_OF_DUTIES";

interface Evidence {
  expectedTreasuryCash: string;
  evidenceHash: string;
  shiftCount: number;
  openShiftCount: number;
  unmatchedShiftCount: number;
  pendingCustodyCount: number;
  custodyVarianceCount: number;
}

function assertBranchScope(actor: Actor, branchId: number) {
  if (actor.role !== "admin" && Number(actor.branchId) !== Number(branchId)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "لا يمكنك مطابقة خزينة فرع آخر" });
  }
}

export async function buildDailyCashEvidenceTx(
  tx: Tx,
  branchId: number,
  businessDate: string,
  options?: { excludeReceiptIds?: number[] },
): Promise<Evidence> {
  const { start, endExclusive } = utcDayRange(businessDate, businessDate);
  const today = businessDate === todayUtcDate();
  const treasuryCashEventAt = cashEventAtSql({
    approvedBy: receipts.approvedBy,
    createdBy: receipts.createdBy,
    approvedAt: receipts.approvedAt,
    createdAt: receipts.createdAt,
  });

  const treasuryRows = await tx
    .select({
      id: receipts.id,
      direction: receipts.direction,
      amount: receipts.amount,
      status: receipts.status,
      createdAt: receipts.createdAt,
    })
    .from(receipts)
    .where(
      and(
        eq(receipts.branchId, branchId),
        eq(receipts.cashBucket, "TREASURY"),
        eq(receipts.paymentMethod, "CASH"),
        eq(receipts.approvalStatus, "APPROVED"),
        or(eq(receipts.status, "COMPLETED"), eq(receipts.status, "REVERSED")),
        lt(treasuryCashEventAt, endExclusive),
        ...(options?.excludeReceiptIds?.length
          ? [notInArray(receipts.id, options.excludeReceiptIds)]
          : []),
      ),
    )
    .orderBy(asc(receipts.id));
  let expected = money(0);
  for (const row of treasuryRows) {
    expected = row.direction === "IN" ? expected.plus(row.amount) : expected.minus(row.amount);
  }

  const dayShifts = await tx
    .select({
      id: shifts.id,
      status: shifts.status,
      expectedCash: shifts.expectedCash,
      countedCash: shifts.countedCash,
      variance: shifts.variance,
      reconciliationStatus: shifts.reconciliationStatus,
    })
    .from(shifts)
    .where(
      and(
        eq(shifts.branchId, branchId),
        gte(shifts.openedAt, start),
        lt(shifts.openedAt, endExclusive),
      ),
    )
    .orderBy(asc(shifts.id));
  const openShiftRows = today
    ? await tx
        .select({ id: shifts.id })
        .from(shifts)
        .where(and(eq(shifts.branchId, branchId), eq(shifts.status, "OPEN")))
    : [];
  const unmatchedShiftCount = dayShifts.filter(
    (row) =>
      row.status !== "CLOSED" ||
      row.reconciliationStatus !== "MATCHED" ||
      row.variance == null ||
      money(row.variance).abs().gt("0.005") ||
      row.expectedCash == null ||
      row.countedCash == null ||
      !money(row.expectedCash).eq(money(row.countedCash)),
  ).length;

  const pendingCustody = await tx
    .select({ id: receipts.id, amount: receipts.amount, referenceNumber: receipts.referenceNumber })
    .from(receipts)
    .where(
      and(
        eq(receipts.branchId, branchId),
        eq(receipts.direction, "IN"),
        eq(receipts.cashBucket, "TREASURY"),
        eq(receipts.paymentMethod, "CASH"),
        eq(receipts.status, "PENDING"),
        eq(receipts.approvalStatus, "APPROVED"),
        or(like(receipts.referenceNumber, "CD-%"), like(receipts.referenceNumber, "CH-%")),
        lt(receipts.createdAt, endExclusive),
      ),
    )
    .orderBy(asc(receipts.id));
  const varianceRows = pendingCustody.length === 0
    ? []
    : await tx.execute(sql`
        SELECT c.treasuryReceiptId AS receiptId
        FROM cashCustodyCounts c
        INNER JOIN (
          SELECT treasuryReceiptId, MAX(id) AS maxId
          FROM cashCustodyCounts
          GROUP BY treasuryReceiptId
        ) latest ON latest.maxId = c.id
        INNER JOIN receipts r ON r.id = c.treasuryReceiptId
        WHERE r.branchId = ${branchId}
          AND r.receiptStatus = 'PENDING'
          AND c.cashCustodyCountStatus = 'VARIANCE_OPEN'
      `);
  const varianceData = ((varianceRows as unknown as [unknown[]])?.[0] ?? []) as unknown[];

  const canonical = JSON.stringify({
    branchId,
    businessDate,
    treasury: treasuryRows.map((row) => [row.id, row.direction, row.amount, row.status]),
    shifts: dayShifts.map((row) => [
      row.id,
      row.status,
      row.expectedCash,
      row.countedCash,
      row.variance,
      row.reconciliationStatus,
    ]),
    pendingCustody: pendingCustody.map((row) => [row.id, row.amount, row.referenceNumber]),
  });

  return {
    expectedTreasuryCash: toDbMoney(expected),
    evidenceHash: createHash("sha256").update(canonical).digest("hex"),
    shiftCount: dayShifts.length,
    openShiftCount: openShiftRows.length,
    unmatchedShiftCount,
    pendingCustodyCount: pendingCustody.length,
    custodyVarianceCount: varianceData.length,
  };
}

interface ApprovedDailyResolution {
  caseId: number;
  adjustmentReceiptId: number;
  accountingEntryId: number;
  advanceId: number | null;
  approvedAt: Date;
}

/**
 * لا تكفي حالة الصف وحدها لإعفاء الفرق. يجب أن يطابق سجل append-only المعتمد
 * شهادة العد التاريخية نفسها (البصمة والمبالغ) وأن يحمل سنداً وقيداً فعليين.
 */
async function findApprovedDailyResolutionTx(
  tx: Tx,
  row: typeof cashDailyReconciliations.$inferSelect,
): Promise<ApprovedDailyResolution | null> {
  const resolution = (
    await tx
      .select({
        caseId: cashVarianceCases.id,
        adjustmentReceiptId: cashVarianceCaseEvents.adjustmentReceiptId,
        accountingEntryId: cashVarianceCaseEvents.accountingEntryId,
        advanceId: cashVarianceCaseEvents.advanceId,
        counterAccountRole: cashVarianceCaseEvents.counterAccountRole,
        approvedAt: cashVarianceCaseEvents.createdAt,
        adjustmentBranchId: receipts.branchId,
        adjustmentDirection: receipts.direction,
        adjustmentAmount: receipts.amount,
        adjustmentPaymentMethod: receipts.paymentMethod,
        adjustmentCashBucket: receipts.cashBucket,
        adjustmentStatus: receipts.status,
        adjustmentApprovalStatus: receipts.approvalStatus,
        adjustmentReference: receipts.referenceNumber,
        entryReceiptId: accountingEntries.receiptId,
        entryBranchId: accountingEntries.branchId,
        entryDedupeKey: accountingEntries.dedupeKey,
      })
      .from(cashVarianceCases)
      .innerJoin(
        cashVarianceCaseEvents,
        and(
          eq(cashVarianceCaseEvents.caseId, cashVarianceCases.id),
          eq(cashVarianceCaseEvents.eventType, "APPROVED"),
        ),
      )
      .innerJoin(receipts, eq(receipts.id, cashVarianceCaseEvents.adjustmentReceiptId))
      .innerJoin(accountingEntries, eq(accountingEntries.id, cashVarianceCaseEvents.accountingEntryId))
      .where(
        and(
          eq(cashVarianceCases.sourceType, "DAILY_TREASURY"),
          eq(cashVarianceCases.dailyReconciliationId, Number(row.id)),
          eq(cashVarianceCases.sourceEvidenceHash, row.evidenceHash),
          eq(cashVarianceCases.expectedAmount, String(row.expectedTreasuryCash)),
          eq(cashVarianceCases.actualAmount, String(row.countedTreasuryCash)),
          eq(cashVarianceCases.variance, String(row.variance)),
        ),
      )
      .orderBy(desc(cashVarianceCaseEvents.id))
      .limit(1)
  )[0];
  if (
    !resolution ||
    resolution.adjustmentReceiptId == null ||
    resolution.accountingEntryId == null ||
    Number(resolution.adjustmentBranchId) !== Number(row.branchId) ||
    Number(resolution.entryBranchId) !== Number(row.branchId) ||
    Number(resolution.entryReceiptId) !== Number(resolution.adjustmentReceiptId) ||
    resolution.entryDedupeKey !== `CASH_VARIANCE:${resolution.caseId}` ||
    resolution.adjustmentPaymentMethod !== "CASH" ||
    resolution.adjustmentCashBucket !== "TREASURY" ||
    resolution.adjustmentStatus !== "COMPLETED" ||
    resolution.adjustmentApprovalStatus !== "APPROVED" ||
    resolution.adjustmentReference !== `CV-${resolution.caseId}` ||
    !money(resolution.adjustmentAmount).eq(money(row.variance).abs()) ||
    (money(row.variance).isNegative()
      ? resolution.adjustmentDirection !== "OUT" ||
        resolution.counterAccountRole !== "LOSSES" ||
        resolution.advanceId != null
      : resolution.adjustmentDirection !== "IN" ||
        resolution.counterAccountRole !== "OTHER_LIABILITY" ||
        resolution.advanceId != null)
  ) {
    return null;
  }
  return {
    caseId: Number(resolution.caseId),
    adjustmentReceiptId: Number(resolution.adjustmentReceiptId),
    accountingEntryId: Number(resolution.accountingEntryId),
    advanceId: resolution.advanceId == null ? null : Number(resolution.advanceId),
    approvedAt: resolution.approvedAt,
  };
}

function blockersFor(evidence: Evidence) {
  const blockers: Array<{ code: DailyCashBlockerCode; message: string; count: number; amount?: string }> = [];
  if (evidence.openShiftCount > 0) {
    blockers.push({ code: "OPEN_SHIFT", message: "توجد ورديات مفتوحة في الفرع", count: evidence.openShiftCount });
  }
  if (evidence.unmatchedShiftCount > 0) {
    blockers.push({ code: "UNMATCHED_SHIFT", message: "توجد ورديات غير مطابقة", count: evidence.unmatchedShiftCount });
  }
  if (evidence.pendingCustodyCount > 0) {
    blockers.push({
      code: "PENDING_CUSTODY",
      message: "توجد عهد نقد لم تُعدّ وتُقبل بعد",
      count: evidence.pendingCustodyCount,
    });
  }
  return blockers;
}

export async function getDailyCashReconciliation(
  input: { branchId: number; businessDate: string },
  actor: Actor,
) {
  assertBranchScope(actor, input.branchId);
  return withTx(async (tx) => {
    const currentEvidence = await buildDailyCashEvidenceTx(tx, input.branchId, input.businessDate);
    const row = (
      await tx
        .select()
        .from(cashDailyReconciliations)
        .where(
          and(
            eq(cashDailyReconciliations.branchId, input.branchId),
            eq(cashDailyReconciliations.businessDate, input.businessDate),
          ),
        )
        .limit(1)
    )[0] ?? null;
    const resolution = row == null ? null : await findApprovedDailyResolutionTx(tx, row);
    const evidence = resolution == null
      ? currentEvidence
      : await buildDailyCashEvidenceTx(tx, input.branchId, input.businessDate, {
          excludeReceiptIds: [resolution.adjustmentReceiptId],
        });
    const blockers = blockersFor(evidence);
    const stale = Boolean(row && row.evidenceHash !== evidence.evidenceHash);
    if (stale) blockers.push({ code: "STALE_EVIDENCE", message: "تغيرت الحركات بعد آخر عدّ؛ أعد الجرد", count: 1 });
    if (row && money(row.variance).abs().gt("0.005") && resolution == null) {
      blockers.push({ code: "TREASURY_VARIANCE", message: "الجرد الفعلي لا يطابق رصيد النظام", count: 1, amount: String(row.variance) });
    }
    const separationBlocked = Boolean(
      (row?.status === "MATCHED" || row?.status === "RESOLVED_WITH_ADJUSTMENT") &&
      actor.role !== "admin" &&
      Number(row.countedByUserId) === actor.userId,
    );
    if (separationBlocked) {
      blockers.push({
        code: "SEPARATION_OF_DUTIES",
        message: "اعتماد الإقفال يحتاج مستخدماً مختلفاً عن منفّذ الجرد",
        count: 1,
      });
    }
    return {
      businessDate: input.businessDate,
      branchId: input.branchId,
      expectedTreasuryCash:
        row?.status === "CLOSED" || resolution != null
          ? String(row.expectedTreasuryCash)
          : evidence.expectedTreasuryCash,
      evidence,
      currentEvidence,
      reconciliation: row,
      resolution,
      blockers,
      actions: {
        canCount:
          input.businessDate === todayUtcDate() &&
          row?.status !== "CLOSED" &&
          row?.status !== "RESOLVED_WITH_ADJUSTMENT" &&
          blockersFor(evidence).length === 0,
        canClose:
          (row?.status === "MATCHED" ||
            (row?.status === "RESOLVED_WITH_ADJUSTMENT" && resolution != null)) &&
          !stale &&
          !separationBlocked &&
          blockers.length === 0 &&
          (row.status === "RESOLVED_WITH_ADJUSTMENT" || money(row.variance).abs().lte("0.005")),
        canReopen:
          row?.status === "CLOSED" &&
          input.businessDate === todayUtcDate() &&
          (actor.role === "admin" || Number(row.closedByUserId) !== actor.userId),
      },
    };
  }, { gate: "NONE" });
}

export async function recordDailyTreasuryCount(
  input: {
    branchId: number;
    businessDate: string;
    countedCash: string;
    countedBreakdown: CashBreakdown;
    notes?: string | null;
    expectedVersion: number;
    clientRequestId: string;
  },
  actor: Actor,
  auditCtx: AuditContext,
) {
  assertBranchScope(actor, input.branchId);
  if (input.businessDate !== todayUtcDate()) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "الجرد المادي متاح لليوم الحالي فقط" });
  }
  const counted = money(input.countedCash);
  const breakdown = validateCashBreakdown(input.countedBreakdown, counted, { requiredWhenPositive: true });
  const normalizedNotes = input.notes?.trim() || null;
  const canonicalBreakdown = (value: unknown) => JSON.stringify(
    Object.entries((value ?? {}) as Record<string, unknown>)
      .map(([denomination, count]) => [denomination, Number(count)] as const)
      .sort(([left], [right]) => Number(left) - Number(right)),
  );
  return withTx(async (tx) => {
    await lockCashSourceForUpdate(tx, { branchId: input.branchId, cashBucket: "TREASURY", shiftId: null });
    const evidence = await buildDailyCashEvidenceTx(tx, input.branchId, input.businessDate);
    const evidenceBlockers = blockersFor(evidence);
    if (evidenceBlockers.length > 0) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: evidenceBlockers.map((item) => item.message).join("، "),
      });
    }
    const existing = (
      await tx
        .select()
        .from(cashDailyReconciliations)
        .where(
          and(
            eq(cashDailyReconciliations.branchId, input.branchId),
            eq(cashDailyReconciliations.businessDate, input.businessDate),
          ),
        )
        .for("update")
        .limit(1)
    )[0];
    if (existing?.lastClientRequestId === input.clientRequestId) {
      if (
        !money(existing.countedTreasuryCash).eq(counted) ||
        canonicalBreakdown(existing.countedBreakdown) !== canonicalBreakdown(breakdown) ||
        (existing.notes ?? null) !== normalizedNotes
      ) {
        throw new TRPCError({ code: "CONFLICT", message: "مفتاح المحاولة مستعمل لجرد مختلف" });
      }
      return { ...existing, idempotent: true };
    }
    if (existing?.status === "CLOSED") {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "مطابقة اليوم مغلقة؛ أعد فتحها أولاً" });
    }
    if (existing?.status === "RESOLVED_WITH_ADJUSTMENT") {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "فرق الجرد محسوم بسند تصحيح؛ أغلق الشهادة ولا تستبدل دليلها بإعادة عد",
      });
    }
    if (existing ? Number(existing.version) !== input.expectedVersion : input.expectedVersion !== 0) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "تغيرت المطابقة؛ حدّث الشاشة ثم أعد الجرد",
      });
    }
    const variance = counted.minus(evidence.expectedTreasuryCash);
    const status = variance.abs().lte("0.005") ? "MATCHED" : "VARIANCE_OPEN";
    const values = {
      branchId: input.branchId,
      businessDate: input.businessDate,
      expectedTreasuryCash: evidence.expectedTreasuryCash,
      countedTreasuryCash: toDbMoney(counted),
      variance: toDbMoney(variance),
      countedBreakdown: breakdown,
      status,
      notes: normalizedNotes,
      lastClientRequestId: input.clientRequestId,
      evidenceHash: evidence.evidenceHash,
      shiftCount: evidence.shiftCount,
      custodyCount: evidence.pendingCustodyCount,
      countedByUserId: actor.userId,
      countedAt: new Date(),
      closedByUserId: null,
      closedAt: null,
    } as const;
    let id: number;
    if (existing) {
      await tx
        .update(cashDailyReconciliations)
        .set({ ...values, version: sql`${cashDailyReconciliations.version} + 1` })
        .where(eq(cashDailyReconciliations.id, existing.id));
      id = Number(existing.id);
    } else {
      const inserted = await tx.insert(cashDailyReconciliations).values(values);
      id = extractInsertId(inserted);
    }
    await logAuditTx(tx, auditCtx, {
      action: existing ? "treasury.dailyCash.recount" : "treasury.dailyCash.count",
      entityType: "cashDailyReconciliation",
      entityId: id,
      oldValue: existing ?? null,
      newValue: { ...values, id, version: existing ? Number(existing.version) + 1 : 1 },
    });
    return { id, ...values, version: existing ? Number(existing.version) + 1 : 1, idempotent: false };
  });
}

export async function closeDailyCashReconciliation(
  input: { reconciliationId: number; expectedVersion: number; clientRequestId: string },
  actor: Actor,
  auditCtx: AuditContext,
) {
  return withTx(async (tx) => {
    const candidate = (
      await tx
        .select({ branchId: cashDailyReconciliations.branchId })
        .from(cashDailyReconciliations)
        .where(eq(cashDailyReconciliations.id, input.reconciliationId))
        .limit(1)
    )[0];
    if (!candidate) throw new TRPCError({ code: "NOT_FOUND", message: "مطابقة اليوم غير موجودة" });
    assertBranchScope(actor, Number(candidate.branchId));
    await lockCashSourceForUpdate(tx, {
      branchId: Number(candidate.branchId),
      cashBucket: "TREASURY",
      shiftId: null,
      allowClosedCashDay: true,
    });
    const row = (
      await tx
        .select()
        .from(cashDailyReconciliations)
        .where(eq(cashDailyReconciliations.id, input.reconciliationId))
        .for("update")
        .limit(1)
    )[0];
    if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "مطابقة اليوم غير موجودة" });
    assertBranchScope(actor, Number(row.branchId));
    if (row.status === "CLOSED" && row.closeClientRequestId === input.clientRequestId) {
      return { ...row, idempotent: true };
    }
    if (row.status !== "MATCHED" && row.status !== "RESOLVED_WITH_ADJUSTMENT") {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "يجب أن يكون جرد الخزينة مطابقاً أو محسوم الفرق بسند تصحيح قبل الإقفال",
      });
    }
    if (Number(row.version) !== input.expectedVersion) {
      throw new TRPCError({ code: "CONFLICT", message: "تغيرت المطابقة؛ حدّث الشاشة ثم أعد المحاولة" });
    }
    if (actor.role !== "admin" && Number(row.countedByUserId) === actor.userId) {
      throw new TRPCError({ code: "FORBIDDEN", message: "لا يجوز لمن عدّ الخزينة اعتماد إقفال اليوم نفسه" });
    }
    const resolution = row.status === "RESOLVED_WITH_ADJUSTMENT"
      ? await findApprovedDailyResolutionTx(tx, row)
      : null;
    if (row.status === "RESOLVED_WITH_ADJUSTMENT" && resolution == null) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "حالة التسوية لا ترتبط بقضية فرق نقد معتمدة تطابق دليل الجرد",
      });
    }
    const evidence = await buildDailyCashEvidenceTx(
      tx,
      Number(row.branchId),
      row.businessDate,
      resolution == null
        ? undefined
        : { excludeReceiptIds: [resolution.adjustmentReceiptId] },
    );
    const blockers = blockersFor(evidence);
    if (
      blockers.length > 0 ||
      evidence.evidenceHash !== row.evidenceHash ||
      !money(evidence.expectedTreasuryCash).eq(money(row.expectedTreasuryCash)) ||
      (row.status === "MATCHED" && money(row.variance).abs().gt("0.005"))
    ) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "تغيرت أدلة اليوم أو بقيت عوائق؛ أعد الجرد قبل الإقفال",
      });
    }
    const now = new Date();
    await tx
      .update(cashDailyReconciliations)
      .set({
        status: "CLOSED",
        closeClientRequestId: input.clientRequestId,
        closedByUserId: actor.userId,
        closedAt: now,
        version: sql`${cashDailyReconciliations.version} + 1`,
      })
      .where(eq(cashDailyReconciliations.id, row.id));
    await logAuditTx(tx, auditCtx, {
      action: "treasury.dailyCash.close",
      entityType: "cashDailyReconciliation",
      entityId: Number(row.id),
      oldValue: { status: row.status, version: row.version },
      newValue: {
        status: "CLOSED",
        version: Number(row.version) + 1,
        closedByUserId: actor.userId,
        resolutionCaseId: resolution?.caseId ?? null,
      },
    });
    return {
      ...row,
      status: "CLOSED" as const,
      closedAt: now,
      closedByUserId: actor.userId,
      version: Number(row.version) + 1,
      resolution,
      idempotent: false,
    };
  });
}

export async function reopenDailyCashReconciliation(
  input: { reconciliationId: number; reason: string },
  actor: Actor,
  auditCtx: AuditContext,
) {
  return withTx(async (tx) => {
    const candidate = (
      await tx
        .select({ branchId: cashDailyReconciliations.branchId })
        .from(cashDailyReconciliations)
        .where(eq(cashDailyReconciliations.id, input.reconciliationId))
        .limit(1)
    )[0];
    if (!candidate) throw new TRPCError({ code: "NOT_FOUND", message: "مطابقة اليوم غير موجودة" });
    assertBranchScope(actor, Number(candidate.branchId));
    await lockCashSourceForUpdate(tx, {
      branchId: Number(candidate.branchId),
      cashBucket: "TREASURY",
      shiftId: null,
      allowClosedCashDay: true,
    });
    const row = (
      await tx
        .select()
        .from(cashDailyReconciliations)
        .where(eq(cashDailyReconciliations.id, input.reconciliationId))
        .for("update")
        .limit(1)
    )[0];
    if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "مطابقة اليوم غير موجودة" });
    assertBranchScope(actor, Number(row.branchId));
    if (row.businessDate !== todayUtcDate()) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "لا يمكن إعادة فتح شهادة يوم سابق؛ المطابقة التاريخية دليل غير قابل لإعادة العد",
      });
    }
    if (row.status !== "CLOSED") {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "المطابقة ليست مغلقة" });
    }
    if (actor.role !== "admin" && Number(row.closedByUserId) === actor.userId) {
      throw new TRPCError({ code: "FORBIDDEN", message: "إعادة الفتح تحتاج مديراً آخر" });
    }
    const reason = input.reason.trim();
    if (reason.length < 10) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "سبب إعادة الفتح التفصيلي مطلوب" });
    }
    const now = new Date();
    await tx
      .update(cashDailyReconciliations)
      .set({
        status: "REOPENED",
        reopenedByUserId: actor.userId,
        reopenedAt: now,
        reopenReason: reason,
        version: sql`${cashDailyReconciliations.version} + 1`,
      })
      .where(eq(cashDailyReconciliations.id, row.id));
    await logAuditTx(tx, auditCtx, {
      action: "treasury.dailyCash.reopen",
      entityType: "cashDailyReconciliation",
      entityId: Number(row.id),
      oldValue: { status: "CLOSED", version: row.version },
      newValue: { status: "REOPENED", reason, reopenedByUserId: actor.userId },
    });
    return { id: Number(row.id), status: "REOPENED" as const, version: Number(row.version) + 1 };
  });
}
