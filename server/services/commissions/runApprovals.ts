import { TRPCError } from "@trpc/server";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  commissionRunApprovalRequests,
  commissionRunLines,
  commissionRuns,
  users,
} from "../../../drizzle/schema";
import { isDupEntry } from "@shared/errorMap.ar";
import type { Tx } from "../../db";
import { extractAffectedRows, extractInsertId } from "../../lib/insertId";
import { idempotencyHash } from "../idempotency";
import { requireDb, type Actor, withTx } from "../tx";
import { approveRunInTx, type ApproveResult } from "./runs";

export interface RequestCommissionRunApprovalInput {
  requestKey: string;
  runId: number;
  reason: string;
  /** null = طلب اعتماد الشركة؛ رقم = طلب اعتماد شريحة الفرع فقط. */
  scopeBranchId: number | null;
}

export interface CommissionRunDecisionInput {
  id: number;
  expectedVersion: number;
  decisionKey: string;
  reviewNote?: string | null;
}

function normalizedText(value: string, label: string, min = 3, max = 500): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length < min || normalized.length > max) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `${label} مطلوب (${min}-${max} محرف)` });
  }
  return normalized;
}

function normalizedKey(value: string, label: string): string {
  return normalizedText(value, label, 8, 120);
}

function scopeKey(runId: number, branchId: number | null): string {
  return `RUN:${runId}:${branchId == null ? "COMPANY" : `BRANCH:${branchId}`}`;
}

function assertRequestedScope(inputScope: number | null, authorizedScope: number | null): void {
  if (authorizedScope == null) return;
  if (inputScope !== authorizedScope) {
    throw new TRPCError({ code: "FORBIDDEN", message: "طلب اعتماد العمولة لا يخص فرعك" });
  }
}

function exactRequestReplay(
  row: typeof commissionRunApprovalRequests.$inferSelect,
  payloadHash: string,
  actor: Actor,
): boolean {
  return row.payloadHash === payloadHash && Number(row.requestedBy) === actor.userId;
}

function exactRequestIntentReplay(
  row: typeof commissionRunApprovalRequests.$inferSelect,
  input: RequestCommissionRunApprovalInput,
  reason: string,
  actor: Actor,
): boolean {
  return Number(row.runId) === input.runId
    && (row.scopeBranchId == null ? null : Number(row.scopeBranchId)) === input.scopeBranchId
    && row.reason === reason
    && Number(row.requestedBy) === actor.userId
    && idempotencyHash(row.payload) === row.payloadHash;
}

async function loadRequestByKey(tx: Tx, requestKey: string) {
  return (
    await tx.select().from(commissionRunApprovalRequests)
      .where(eq(commissionRunApprovalRequests.requestKey, requestKey))
      .limit(1)
  )[0];
}

/**
 * Locking read intentionally bypasses MySQL REPEATABLE READ's old consistent snapshot.
 * It is used only after the run row has serialized same-run commands, keeping the lock
 * order run -> request-key and making a waiter observe the winner's committed request.
 */
async function loadRequestByKeyCurrentTx(tx: Tx, requestKey: string) {
  return (
    await tx.select().from(commissionRunApprovalRequests)
      .where(eq(commissionRunApprovalRequests.requestKey, requestKey))
      .for("update")
      .limit(1)
  )[0];
}

function decisionHash(input: CommissionRunDecisionInput, decision: "APPROVE" | "REJECT", note: string | null) {
  return idempotencyHash({
    requestId: input.id,
    expectedVersion: input.expectedVersion,
    decision,
    reviewNote: note,
  });
}

function exactDecisionReplay(
  row: typeof commissionRunApprovalRequests.$inferSelect,
  input: CommissionRunDecisionInput,
  hash: string,
  actor: Actor,
  status: "APPROVED" | "REJECTED",
): boolean {
  return row.status === status
    && row.decisionKey === input.decisionKey
    && row.decisionHash === hash
    && Number(row.reviewedBy) === actor.userId;
}

async function loadScopeTotals(
  tx: Tx,
  runId: number,
  scopeBranchId: number | null,
) {
  const row = (
    await tx.select({
      employeeCount: sql<number>`COUNT(*)`,
      totalBaseSales: sql<string>`CAST(COALESCE(SUM(${commissionRunLines.baseSales}), 0) AS CHAR)`,
      totalBaseReturns: sql<string>`CAST(COALESCE(SUM(${commissionRunLines.baseReturns}), 0) AS CHAR)`,
      totalCommission: sql<string>`CAST(COALESCE(SUM(${commissionRunLines.commissionAmount}), 0) AS CHAR)`,
    }).from(commissionRunLines).where(and(
      eq(commissionRunLines.runId, runId),
      scopeBranchId == null ? undefined : eq(commissionRunLines.branchId, scopeBranchId),
    ))
  )[0];
  return {
    employeeCount: Number(row?.employeeCount ?? 0),
    totalBaseSales: row?.totalBaseSales ?? "0",
    totalBaseReturns: row?.totalBaseReturns ?? "0",
    totalCommission: row?.totalCommission ?? "0",
  };
}

/** الطلب يثبت لقطة التشغيل/الفرع فقط ولا يغيّر status أو payroll أو الأسطر. */
export async function requestCommissionRunApproval(
  input: RequestCommissionRunApprovalInput,
  actor: Actor,
  authorizedScope: number | null,
) {
  const requestKey = normalizedKey(input.requestKey, "مفتاح الطلب");
  const reason = normalizedText(input.reason, "سبب طلب الاعتماد");
  assertRequestedScope(input.scopeBranchId, authorizedScope);
  return withTx(async (tx) => {
    const replay = await loadRequestByKey(tx, requestKey);
    if (replay) {
      if (!exactRequestIntentReplay(replay, input, reason, actor)) {
        throw new TRPCError({ code: "CONFLICT", message: "مفتاح الطلب مستخدم بحمولة مختلفة" });
      }
      return { ...replay, replayed: true as const };
    }

    const run = (
      await tx.select().from(commissionRuns)
        .where(eq(commissionRuns.id, input.runId)).for("update").limit(1)
    )[0];
    if (!run) throw new TRPCError({ code: "NOT_FOUND", message: "تشغيلة العمولات غير موجودة" });
    const replayAfterRunLock = await loadRequestByKeyCurrentTx(tx, requestKey);
    if (replayAfterRunLock) {
      if (!exactRequestIntentReplay(replayAfterRunLock, input, reason, actor)) {
        throw new TRPCError({ code: "CONFLICT", message: "مفتاح الطلب مستخدم بحمولة مختلفة" });
      }
      return { ...replayAfterRunLock, replayed: true as const };
    }
    if (run.status !== "draft") {
      throw new TRPCError({ code: "CONFLICT", message: "التشغيلة ليست مسودة قابلة لطلب الاعتماد" });
    }
    const totals = await loadScopeTotals(tx, input.runId, input.scopeBranchId);
    if (input.scopeBranchId != null && totals.employeeCount === 0) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "لا توجد أسطر عمولة في هذا الفرع ضمن التشغيلة" });
    }
    const payload = {
      runId: input.runId,
      scopeBranchId: input.scopeBranchId,
      period: run.period,
      baseRunVersion: Number(run.version),
      ...totals,
    };
    const payloadHash = idempotencyHash(payload);
    try {
      const inserted = await tx.insert(commissionRunApprovalRequests).values({
        requestKey,
        runId: input.runId,
        scopeBranchId: input.scopeBranchId,
        status: "PENDING",
        baseRunVersion: Number(run.version),
        payload,
        payloadHash,
        reason,
        requestedBy: actor.userId,
        pendingGuard: scopeKey(input.runId, input.scopeBranchId),
      });
      return {
        id: extractInsertId(inserted),
        requestKey,
        runId: input.runId,
        scopeBranchId: input.scopeBranchId,
        status: "PENDING" as const,
        baseRunVersion: Number(run.version),
        payloadHash,
        replayed: false as const,
      };
    } catch (error) {
      if (!isDupEntry(error)) throw error;
      const raced = await loadRequestByKeyCurrentTx(tx, requestKey);
      if (raced && exactRequestReplay(raced, payloadHash, actor)) {
        return { ...raced, replayed: true as const };
      }
      throw new TRPCError({ code: "CONFLICT", message: "يوجد طلب اعتماد معلّق لهذا النطاق أو استُهلك المفتاح" });
    }
  }, { gate: "NONE" });
}

class StaleCommissionRunApproval extends Error {}

async function persistStaleDecision(
  input: CommissionRunDecisionInput,
  actor: Actor,
  decisionKey: string,
  decisionHashValue: string,
) {
  await withTx(async (tx) => {
    const request = (
      await tx.select().from(commissionRunApprovalRequests)
        .where(eq(commissionRunApprovalRequests.id, input.id)).for("update").limit(1)
    )[0];
    if (!request || request.status !== "PENDING") return;
    const reviewedAt = new Date();
    await tx.update(commissionRunApprovalRequests).set({
      status: "STALE",
      pendingGuard: null,
      reviewedBy: actor.userId,
      reviewedAt,
      reviewNote: "تغيّرت تشغيلة العمولات بعد إنشاء الطلب",
      decisionKey,
      decisionHash: decisionHashValue,
    }).where(and(
      eq(commissionRunApprovalRequests.id, input.id),
      eq(commissionRunApprovalRequests.status, "PENDING"),
    ));
  }, { gate: "NONE" });
}

function assertIndependentReviewer(
  request: typeof commissionRunApprovalRequests.$inferSelect,
  run: typeof commissionRuns.$inferSelect,
  actor: Actor,
) {
  if (Number(request.requestedBy) === actor.userId) {
    throw new TRPCError({ code: "FORBIDDEN", message: "لا يراجع منشئ طلب الاعتماد طلبه بنفسه" });
  }
  if (run.createdBy != null && Number(run.createdBy) === actor.userId) {
    throw new TRPCError({ code: "FORBIDDEN", message: "محتسب التشغيلة لا يراجع اعتمادها" });
  }
}

export async function approveCommissionRunRequest(
  input: CommissionRunDecisionInput,
  actor: Actor,
  reviewerScope: number | null,
) {
  if (reviewerScope != null) {
    throw new TRPCError({ code: "FORBIDDEN", message: "مراجعة اعتماد العمولات تتطلب سلطة الشركة" });
  }
  const decisionKey = normalizedKey(input.decisionKey, "مفتاح القرار");
  const note = input.reviewNote?.trim() || null;
  if (note && note.length > 500) throw new TRPCError({ code: "BAD_REQUEST", message: "ملاحظة القرار أطول من 500 محرف" });
  const normalizedInput = { ...input, decisionKey };
  const hash = decisionHash(normalizedInput, "APPROVE", note);

  const previewDb = requireDb();
  const preview = (
    await previewDb.select().from(commissionRunApprovalRequests)
      .where(eq(commissionRunApprovalRequests.id, input.id)).limit(1)
  )[0];
  if (!preview) throw new TRPCError({ code: "NOT_FOUND", message: "طلب اعتماد العمولات غير موجود" });
  if (exactDecisionReplay(preview, normalizedInput, hash, actor, "APPROVED")) {
    return { request: preview, replayed: true as const, runApproval: null as ApproveResult | null };
  }
  if (preview.status !== "PENDING") {
    throw new TRPCError({ code: "CONFLICT", message: `طلب الاعتماد محسوم بالحالة ${preview.status}` });
  }

  try {
    const result = await withTx(async (tx) => {
      let lockedRequest: typeof preview | null = null;
      let runApproval: ApproveResult | null = null;
      if (preview.scopeBranchId == null) {
        runApproval = await approveRunInTx(tx, Number(preview.runId), actor, null, {
          beforeApply: async (run) => {
            const request = (
              await tx.select().from(commissionRunApprovalRequests)
                .where(eq(commissionRunApprovalRequests.id, input.id)).for("update").limit(1)
            )[0];
            if (!request) throw new TRPCError({ code: "NOT_FOUND", message: "طلب اعتماد العمولات غير موجود" });
            if (request.status !== "PENDING") {
              throw new TRPCError({ code: "CONFLICT", message: `طلب الاعتماد محسوم بالحالة ${request.status}` });
            }
            assertIndependentReviewer(request, run, actor);
            if (Number(request.baseRunVersion) !== input.expectedVersion) {
              throw new TRPCError({ code: "CONFLICT", message: "نسخة الطلب المتوقعة لا تطابق النسخة المحفوظة" });
            }
            if (idempotencyHash(request.payload) !== request.payloadHash) {
              throw new TRPCError({ code: "CONFLICT", message: "حمولة طلب الاعتماد لا تطابق بصمتها" });
            }
            if (Number(run.version) !== Number(request.baseRunVersion)) {
              throw new StaleCommissionRunApproval();
            }
            lockedRequest = request;
          },
        });
      } else {
        const run = (
          await tx.select().from(commissionRuns)
            .where(eq(commissionRuns.id, Number(preview.runId))).for("update").limit(1)
        )[0];
        if (!run) throw new TRPCError({ code: "NOT_FOUND", message: "تشغيلة العمولات غير موجودة" });
        const request = (
          await tx.select().from(commissionRunApprovalRequests)
            .where(eq(commissionRunApprovalRequests.id, input.id)).for("update").limit(1)
        )[0];
        if (!request || request.status !== "PENDING") {
          throw new TRPCError({ code: "CONFLICT", message: "تغيّرت حالة طلب اعتماد الفرع أثناء المراجعة" });
        }
        assertIndependentReviewer(request, run, actor);
        if (Number(request.baseRunVersion) !== input.expectedVersion) {
          throw new TRPCError({ code: "CONFLICT", message: "نسخة الطلب المتوقعة لا تطابق النسخة المحفوظة" });
        }
        if (idempotencyHash(request.payload) !== request.payloadHash) {
          throw new TRPCError({ code: "CONFLICT", message: "حمولة طلب الاعتماد لا تطابق بصمتها" });
        }
        if (Number(run.version) !== Number(request.baseRunVersion) || run.status !== "draft") {
          const reviewedAt = new Date();
          await tx.update(commissionRunApprovalRequests).set({
            status: "STALE",
            pendingGuard: null,
            reviewedBy: actor.userId,
            reviewedAt,
            reviewNote: "تغيّرت تشغيلة العمولات بعد إنشاء الطلب",
            decisionKey,
            decisionHash: hash,
          }).where(eq(commissionRunApprovalRequests.id, input.id));
          return { stale: true as const };
        }
        lockedRequest = request;
      }

      if (!lockedRequest) throw new TRPCError({ code: "CONFLICT", message: "تعذر قفل طلب اعتماد العمولات" });
      const reviewedAt = new Date();
      const updated = await tx.update(commissionRunApprovalRequests).set({
        status: "APPROVED",
        pendingGuard: null,
        reviewedBy: actor.userId,
        reviewedAt,
        reviewNote: note,
        decisionKey,
        decisionHash: hash,
        appliedAt: reviewedAt,
      }).where(and(
        eq(commissionRunApprovalRequests.id, input.id),
        eq(commissionRunApprovalRequests.status, "PENDING"),
      ));
      if (extractAffectedRows(updated) !== 1) {
        throw new TRPCError({ code: "CONFLICT", message: "تغيّرت حالة طلب الاعتماد أثناء المراجعة" });
      }
      return { request: { ...lockedRequest, status: "APPROVED" as const }, replayed: false as const, runApproval };
    });
    if ("stale" in result) {
      throw new TRPCError({ code: "CONFLICT", message: "تغيّرت التشغيلة منذ إنشاء الطلب؛ افتح طلباً جديداً" });
    }
    return result;
  } catch (error) {
    if (error instanceof StaleCommissionRunApproval) {
      await persistStaleDecision(input, actor, decisionKey, hash);
      throw new TRPCError({ code: "CONFLICT", message: "تغيّرت التشغيلة منذ إنشاء الطلب؛ افتح طلباً جديداً" });
    }
    // إعادة قرار متزامنة قد ترى التشغيل معتمداً قبل أن تبلغ قفل الطلب؛ نعيد النتيجة
    // فقط إذا تطابق القرار المكتمل حرفياً، وإلا نبقي الخطأ الأصلي.
    const replayDb = requireDb();
    const replay = (
      await replayDb.select().from(commissionRunApprovalRequests)
        .where(eq(commissionRunApprovalRequests.id, input.id)).limit(1)
    )[0];
    if (replay && exactDecisionReplay(replay, normalizedInput, hash, actor, "APPROVED")) {
      return { request: replay, replayed: true as const, runApproval: null as ApproveResult | null };
    }
    throw error;
  }
}

export async function rejectCommissionRunRequest(
  input: CommissionRunDecisionInput & { reason: string },
  actor: Actor,
  reviewerScope: number | null,
) {
  if (reviewerScope != null) {
    throw new TRPCError({ code: "FORBIDDEN", message: "مراجعة اعتماد العمولات تتطلب سلطة الشركة" });
  }
  const decisionKey = normalizedKey(input.decisionKey, "مفتاح القرار");
  const note = normalizedText(input.reason, "سبب الرفض");
  const normalizedInput = { ...input, decisionKey };
  const hash = decisionHash(normalizedInput, "REJECT", note);
  const result = await withTx(async (tx) => {
    const preview = (
      await tx.select().from(commissionRunApprovalRequests)
        .where(eq(commissionRunApprovalRequests.id, input.id)).limit(1)
    )[0];
    if (!preview) throw new TRPCError({ code: "NOT_FOUND", message: "طلب اعتماد العمولات غير موجود" });
    const run = (
      await tx.select().from(commissionRuns)
        .where(eq(commissionRuns.id, Number(preview.runId))).for("update").limit(1)
    )[0];
    if (!run) throw new TRPCError({ code: "NOT_FOUND", message: "تشغيلة العمولات غير موجودة" });
    const request = (
      await tx.select().from(commissionRunApprovalRequests)
        .where(eq(commissionRunApprovalRequests.id, input.id)).for("update").limit(1)
    )[0];
    if (!request) throw new TRPCError({ code: "NOT_FOUND", message: "طلب اعتماد العمولات غير موجود" });
    if (exactDecisionReplay(request, normalizedInput, hash, actor, "REJECTED")) {
      return { request, replayed: true as const };
    }
    if (request.status !== "PENDING") {
      throw new TRPCError({ code: "CONFLICT", message: `طلب الاعتماد محسوم بالحالة ${request.status}` });
    }
    assertIndependentReviewer(request, run, actor);
    if (Number(request.baseRunVersion) !== input.expectedVersion) {
      throw new TRPCError({ code: "CONFLICT", message: "نسخة الطلب المتوقعة لا تطابق النسخة المحفوظة" });
    }
    if (idempotencyHash(request.payload) !== request.payloadHash) {
      throw new TRPCError({ code: "CONFLICT", message: "حمولة طلب الاعتماد لا تطابق بصمتها" });
    }
    const reviewedAt = new Date();
    if (Number(run.version) !== Number(request.baseRunVersion) || run.status !== "draft") {
      const stale = await tx.update(commissionRunApprovalRequests).set({
        status: "STALE",
        pendingGuard: null,
        reviewedBy: actor.userId,
        reviewedAt,
        reviewNote: "تغيّرت تشغيلة العمولات بعد إنشاء الطلب",
        decisionKey,
        decisionHash: hash,
      }).where(and(
        eq(commissionRunApprovalRequests.id, input.id),
        eq(commissionRunApprovalRequests.status, "PENDING"),
      ));
      if (extractAffectedRows(stale) !== 1) {
        throw new TRPCError({ code: "CONFLICT", message: "تغيّرت حالة طلب الاعتماد أثناء الرفض" });
      }
      return { stale: true as const };
    }
    const rejected = await tx.update(commissionRunApprovalRequests).set({
      status: "REJECTED",
      pendingGuard: null,
      reviewedBy: actor.userId,
      reviewedAt,
      reviewNote: note,
      decisionKey,
      decisionHash: hash,
    }).where(and(
      eq(commissionRunApprovalRequests.id, input.id),
      eq(commissionRunApprovalRequests.status, "PENDING"),
    ));
    if (extractAffectedRows(rejected) !== 1) {
      throw new TRPCError({ code: "CONFLICT", message: "تغيّرت حالة طلب الاعتماد أثناء الرفض" });
    }
    return { request: { ...request, status: "REJECTED" as const }, replayed: false as const };
  }, { gate: "NONE" });
  if ("stale" in result) {
    throw new TRPCError({ code: "CONFLICT", message: "تغيّرت التشغيلة منذ إنشاء الطلب؛ افتح طلباً جديداً" });
  }
  return result;
}

export async function listCommissionRunApprovalRequests(
  actor: Actor,
  readableScope: number | null,
  options?: { status?: "PENDING" | "APPROVED" | "REJECTED" | "STALE"; runId?: number },
) {
  void actor;
  const db = requireDb();
  return db.select({
    id: commissionRunApprovalRequests.id,
    requestKey: commissionRunApprovalRequests.requestKey,
    runId: commissionRunApprovalRequests.runId,
    period: commissionRuns.period,
    scopeBranchId: commissionRunApprovalRequests.scopeBranchId,
    status: commissionRunApprovalRequests.status,
    baseRunVersion: commissionRunApprovalRequests.baseRunVersion,
    reason: commissionRunApprovalRequests.reason,
    payload: commissionRunApprovalRequests.payload,
    requestedBy: commissionRunApprovalRequests.requestedBy,
    requesterName: users.name,
    reviewedBy: commissionRunApprovalRequests.reviewedBy,
    reviewedAt: commissionRunApprovalRequests.reviewedAt,
    reviewNote: commissionRunApprovalRequests.reviewNote,
    appliedAt: commissionRunApprovalRequests.appliedAt,
    createdAt: commissionRunApprovalRequests.createdAt,
  }).from(commissionRunApprovalRequests)
    .innerJoin(commissionRuns, eq(commissionRuns.id, commissionRunApprovalRequests.runId))
    .innerJoin(users, eq(users.id, commissionRunApprovalRequests.requestedBy))
    .where(and(
      options?.status ? eq(commissionRunApprovalRequests.status, options.status) : undefined,
      options?.runId ? eq(commissionRunApprovalRequests.runId, options.runId) : undefined,
      readableScope == null
        ? undefined
        : eq(commissionRunApprovalRequests.scopeBranchId, readableScope),
    ))
    .orderBy(desc(commissionRunApprovalRequests.id))
    .limit(300);
}
