import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";
import Decimal from "decimal.js";
import { auditLogs, employeePenalties, payrollPenaltyAllocations, payrollRuns } from "../../drizzle/schema";
import { getDb, type Tx } from "../db";
import { withTx, type Actor, type MaybeScopedActor } from "./tx";
import { money, round2, toDbMoney } from "./money";
import { canCrossBranches } from "../lib/branchAuthority";
import { lockHrEmployeeTx, resolveHrActorTx } from "./hr/resourceScope";
import { readLockedPenaltyBreakdownsTx } from "./payroll/penaltyRead";
import { historicalPenaltyAttestationMatches } from "./payroll/historicalPenaltyAttestation";

function requireDb() {
  const db = getDb();
  if (!db) throw new Error("DATABASE_URL not set");
  return db;
}

function auditObject(value: unknown): Record<string, unknown> | null {
  let parsed = value;
  if (typeof parsed === "string") { try { parsed = JSON.parse(parsed); } catch { return null; } }
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
}

function validHistoricalAttestation(
  entry: { entityId: string | null; branchId: number | null; value: unknown; operation: unknown },
  penalty: typeof employeePenalties.$inferSelect | undefined,
  employeeId: number,
): boolean {
  const operation = auditObject(entry.operation);
  const recorder = auditObject(operation?.actor);
  const value = auditObject(entry.value);
  return !!penalty && !!value && Number(penalty.employeeId) === employeeId &&
    entry.entityId === String(employeeId) && entry.branchId != null && penalty.branchId != null &&
    Number(entry.branchId) === Number(penalty.branchId) && historicalPenaltyAttestationMatches(value, penalty) &&
    operation?.version === "operation.v2" && operation.outcome === "SUCCESS" &&
    recorder?.source === "system" && recorder.label === "External owner confirmation recorded by operator";
}

/** Governance holds an exclusive company gate; writers hold its shared form.
 * Once an attestation is recorded, neither approval nor cancellation may
 * silently turn this historical decision into a new payroll deduction. */
async function assertNoHistoricalAttestationTx(tx: Tx, employeeId: number, penaltyId: number) {
  const records = await tx.select({ entityId: auditLogs.entityId, branchId: auditLogs.branchId, value: auditLogs.newValue, operation: auditLogs.operation }).from(auditLogs).where(and(
    eq(auditLogs.action, "payroll.historicalPenalty.attest"),
    eq(auditLogs.entityType, "payrollHistoricalPenalty"),
    or(eq(auditLogs.entityId, String(employeeId)),
      sql`JSON_UNQUOTE(JSON_EXTRACT(${auditLogs.newValue}, '$.employeeId')) = ${String(employeeId)}`,
      sql`JSON_UNQUOTE(JSON_EXTRACT(${auditLogs.newValue}, '$.penaltyId')) = ${String(penaltyId)}`),
  )).for("share");
  const decisions = records.length ? await tx.select().from(employeePenalties).where(eq(employeePenalties.employeeId, employeeId)).for("share") : [];
  const conflict = records.some((record) => {
    const recordedId = Number(auditObject(record.value)?.penaltyId);
    const decision = decisions.find((candidate) => Number(candidate.id) === recordedId);
    return !validHistoricalAttestation(record, decision, employeeId) || recordedId === penaltyId;
  });
  if (conflict) throw new TRPCError({ code: "PRECONDITION_FAILED", message: appErrorMessage({
    what: "تعذّر تغيير قرار العقوبة", why: "يوجد إقرار تاريخي لهذا القرار أو دليل متعارض يحتاج إلى مطابقة",
    doThis: "راجع المطابقة التاريخية قبل اعتماد القرار أو إلغائه",
  }) });
}

function isNowaitSourceConflict(error: unknown): boolean {
  let current: unknown = error;
  for (
    let depth = 0;
    depth < 5 && current && typeof current === "object";
    depth += 1
  ) {
    const value = current as {
      code?: unknown;
      errno?: unknown;
      cause?: unknown;
    };
    if (value.code === "ER_LOCK_NOWAIT" || Number(value.errno) === 3572)
      return true;
    current = value.cause;
  }
  return false;
}

async function currentPenaltySourceLock<T>(
  lock: PromiseLike<T>,
  action: "اعتماد" | "إلغاء",
): Promise<T> {
  try {
    return await lock;
  } catch (error) {
    if (!isNowaitSourceConflict(error)) throw error;
    throw new TRPCError({
      code: "CONFLICT",
      message: appErrorMessage({
        what: `لم يكتمل ${action} العقوبة`,
        why: "هناك عملية رواتب أخرى تثبّت حالياً مسيّر الشهر أو سجل العقوبة نفسه",
        doThis:
          "انتظر اكتمال العملية الجارية، حدّث بطاقة الموظف، ثم أعد المحاولة",
      }),
    });
  }
}

export type PenaltyType =
  | "ATTENTION"
  | "WARNING"
  | "SALARY_DEDUCTION"
  | "SUSPENSION"
  | "DISMISSAL";

export type PenaltyStatus = "DRAFT" | "APPROVED" | "APPLIED" | "CANCELLED";

export interface CreatePenaltyInput {
  employeeId: number;
  penaltyType: PenaltyType;
  decisionNumber: string;
  decisionDate: string;
  reason: string;
  deductionDays?: number;
  deductionAmount?: string | number;
}

export interface ListPenaltiesFilters {
  employeeId?: number;
  branchId?: number;
  status?: PenaltyStatus;
}

/** إنشاء عقوبة أو إنذار انضباطي (مسودة). */
export async function createEmployeePenalty(
  actor: MaybeScopedActor,
  input: CreatePenaltyInput,
) {
  return withTx(async (tx) => {
    const currentActor = await resolveHrActorTx(tx, actor, "hrEnterprise.penalties.create");
    const emp = await lockHrEmployeeTx(tx, currentActor, input.employeeId);

    let deductionDays = new Decimal(input.deductionDays ?? 0);
    let deductionAmount = money(input.deductionAmount ?? 0);

    if (input.penaltyType === "SALARY_DEDUCTION") {
      // الحد المطبق حالياً في النظام؛ لا يمثل تقريراً للأساس القانوني للقرار.
      if (deductionDays.gt(3)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "تجاوز الحد المطبق للاستقطاع",
            why: "يتجاوز استقطاع الراتب الحد الحالي في النظام وهو 3 أيام",
            doThis: "حدّد مدة الاستقطاع بما لا يتجاوز 3 أيام كحد أقصى في الشهر الواحد",
          }),
        });
      }

      if (deductionDays.gt(0) && deductionAmount.lte(0)) {
        // احتساب المبلغ تلقائياً من الأجر اليومي = (الراتب الأساس + البدلات) ÷ 30
        const gross = money(emp.salary ?? 0).plus(money(emp.allowances ?? 0));
        const dailyRate = round2(gross.div(30));
        deductionAmount = round2(dailyRate.times(deductionDays));
      }
      if (deductionAmount.lte(0)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "تعذّر تسجيل الاستقطاع المالي",
            why: "مبلغ القرار غير موجب وتعذّر اشتقاق مبلغ موثوق من أجر الموظف",
            doThis: "أدخل مبلغ القرار المعتمد صراحةً قبل حفظه",
          }),
        });
      }
    } else {
      deductionDays = new Decimal(0);
      deductionAmount = new Decimal(0);
    }

    const [res] = await tx.insert(employeePenalties).values({
      employeeId: input.employeeId,
      branchId: emp.branchId,
      penaltyType: input.penaltyType,
      decisionNumber: input.decisionNumber.trim(),
      decisionDate: input.decisionDate,
      reason: input.reason.trim(),
      deductionDays: deductionDays.toFixed(2),
      deductionAmount: toDbMoney(deductionAmount),
      status: "DRAFT",
      createdById: actor.userId,
    });

    return { id: res.insertId, status: "DRAFT" };
  });
}

/** اعتماد العقوبة (Maker-Checker: المعتمد ليس المنشئ إلا للأدمن). */
export async function approveEmployeePenalty(
  actor: MaybeScopedActor,
  id: number,
) {
  return withTx(async (tx) => {
    const currentActor = await resolveHrActorTx(tx, actor, "hrEnterprise.penalties.approve");
    const [preview] = await tx
      .select()
      .from(employeePenalties)
      .where(eq(employeePenalties.id, id))
      .limit(1);

    if (!preview) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذّر اعتماد العقوبة",
          why: "سجل العقوبة المطلوب غير موجود في سجلات الموظف",
          doThis: "تحقّق من رقم القرار من جدول العقوبات وأعد المحاولة",
        }),
      });
    }
    // نفس قفل التجميع في السلف والمسيّر: الموظف قبل رأس الشهر ثم القرار.
    await lockHrEmployeeTx(tx, currentActor, preview.employeeId, preview.branchId);
    await assertNoHistoricalAttestationTx(tx, Number(preview.employeeId), id);
    const penaltyPeriod = String(preview.decisionDate).slice(0, 7);
    const [existingRun] = money(preview.deductionAmount).gt(0)
      ? await currentPenaltySourceLock(
          tx
            .select({ id: payrollRuns.id, status: payrollRuns.status })
            .from(payrollRuns)
            .where(eq(payrollRuns.period, penaltyPeriod))
            .for("update", { noWait: true })
            .limit(1),
          "اعتماد",
        )
      : [];
    if (existingRun) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: appErrorMessage({
          what: "لا يمكن اعتماد العقوبة بعد إنشاء مسيّر الشهر",
          why: `يوجد مسيّر ${existingRun.status} لشهر القرار ${penaltyPeriod} ولن تُلتقط العقوبة في لقطته الحالية`,
          doThis: existingRun.status === "draft"
            ? "احذف المسودة غير المعتمدة، اعتمد العقوبة، ثم ولّد المسيّر من جديد"
            : "استخدم مسار تصحيح الرواتب الموثق ولا تضف الاستقطاع إلى لقطة معتمدة بصمت",
        }),
      });
    }
    const [p] = await currentPenaltySourceLock(
      tx
        .select()
        .from(employeePenalties)
        .where(eq(employeePenalties.id, id))
        .for("update", { noWait: true })
        .limit(1),
      "اعتماد",
    );
    if (
      !p ||
      p.status !== preview.status ||
      p.employeeId !== preview.employeeId ||
      p.branchId !== preview.branchId ||
      p.penaltyType !== preview.penaltyType ||
      p.decisionNumber !== preview.decisionNumber ||
      String(p.decisionDate) !== String(preview.decisionDate) ||
      p.reason !== preview.reason ||
      !money(p.deductionDays).eq(money(preview.deductionDays)) ||
      !money(p.deductionAmount).eq(money(preview.deductionAmount)) ||
      p.payrollRunId !== preview.payrollRunId
    ) {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "لم يكتمل اعتماد العقوبة",
          why: "تغيّرت العقوبة أثناء الاعتماد",
          doThis: "حدّث بطاقة الموظف وراجع الحالة والمبلغ قبل إعادة الاعتماد",
        }),
      });
    }

    if (p.status !== "DRAFT") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "لا يمكن اعتماد العقوبة",
          why: `حالة القرار الحالية هي (${p.status}) وليست مسودة قيد التدقيق`,
          doThis: "يمكن اعتماد القرارات الانضباطية المسجلة بحالة مسودة فقط",
        }),
      });
    }

    if (p.penaltyType === "SALARY_DEDUCTION" && money(p.deductionAmount).lte(0)) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: appErrorMessage({
          what: "تعذّر اعتماد الاستقطاع المالي",
          why: "مبلغ القرار صفر أو غير صالح ولا يمكن اقتطاعه من الراتب",
          doThis: "ألغِ المسودة وسجّل قراراً بمبلغ موجب موثق",
        }),
      });
    }

    if (p.createdById === currentActor.userId && !canCrossBranches(currentActor)) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: appErrorMessage({
          what: "غير مصرّح باعتماد العقوبة",
          why: "مبدأ فصل المهام (Maker-Checker): لا يجوز لمنشئ القرار اعتماده بنفسه منعاً لتعارض المصالح",
          doThis: "اطلب من مدير آخر أو مدقق إداري اعتماد القرار",
        }),
      });
    }

    await tx
      .update(employeePenalties)
      .set({
        status: "APPROVED",
        approvedById: actor.userId,
        approvedAt: sql`NOW()`,
      })
      .where(eq(employeePenalties.id, id));

    return { id, status: "APPROVED" };
  });
}

/** إلغاء عقوبة غير منفذة. */
export async function cancelEmployeePenalty(
  actor: MaybeScopedActor,
  id: number,
  reason: string,
) {
  return withTx(async (tx) => {
    const currentActor = await resolveHrActorTx(tx, actor, "hrEnterprise.penalties.cancel");
    const [preview] = await tx
      .select()
      .from(employeePenalties)
      .where(eq(employeePenalties.id, id))
      .limit(1);

    if (!preview) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذّر إلغاء العقوبة",
          why: "سجل العقوبة المطلوب غير موجود أو تم إلغاؤه مسبقاً",
          doThis: "تحقّق من رقم القرار من القائمة",
        }),
      });
    }

    // الموظف ثم رأس المسيّر ثم المصدر؛ NOWAIT يمنع الانتظار العكسي أمام التوليد.
    await lockHrEmployeeTx(tx, currentActor, preview.employeeId, preview.branchId);
    await assertNoHistoricalAttestationTx(tx, Number(preview.employeeId), id);
    if (money(preview.deductionAmount).gt(0) || preview.payrollRunId != null) {
      const runPredicate =
        preview.payrollRunId != null
          ? eq(payrollRuns.id, preview.payrollRunId)
          : eq(payrollRuns.period, String(preview.decisionDate).slice(0, 7));
      await currentPenaltySourceLock(
        tx
          .select({ id: payrollRuns.id })
          .from(payrollRuns)
          .where(runPredicate)
          .for("update", { noWait: true })
          .limit(1),
        "إلغاء",
      );
    }
    const [p] = await currentPenaltySourceLock(
      tx
        .select()
        .from(employeePenalties)
        .where(eq(employeePenalties.id, id))
        .for("update", { noWait: true })
        .limit(1),
      "إلغاء",
    );
    if (
      !p ||
      p.status !== preview.status ||
      p.employeeId !== preview.employeeId ||
      p.branchId !== preview.branchId ||
      p.penaltyType !== preview.penaltyType ||
      p.decisionNumber !== preview.decisionNumber ||
      String(p.decisionDate) !== String(preview.decisionDate) ||
      p.reason !== preview.reason ||
      !money(p.deductionDays).eq(money(preview.deductionDays)) ||
      !money(p.deductionAmount).eq(money(preview.deductionAmount)) ||
      p.payrollRunId !== preview.payrollRunId
    ) {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "لم يكتمل إلغاء العقوبة",
          why: "تغيّرت العقوبة أو صلتها بمسيّر الرواتب أثناء الإلغاء",
          doThis: "حدّث بطاقة الموظف وراجع الحالة والمبلغ قبل إعادة الإلغاء",
        }),
      });
    }
    const [allocation] = await tx.select({ id: payrollPenaltyAllocations.id })
      .from(payrollPenaltyAllocations)
      .where(eq(payrollPenaltyAllocations.penaltyId, id))
      .for("share").limit(1);
    if (p.status === "APPLIED" || p.payrollRunId != null || allocation) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "لا يمكن إلغاء العقوبة",
          why: "للقرار تخصيص محفوظ ضمن مسيّر رواتب أو استقطاع سابق",
          doThis:
            "إذا كان مسودة جديدة فاحذفها أولاً، وإلا راجع مسار التصحيح المالي الموثق",
        }),
      });
    }

    await tx
      .update(employeePenalties)
      .set({
        status: "CANCELLED",
        reason: `${p.reason}\n[سبب الإلغاء: ${reason.trim()}]`,
      })
      .where(eq(employeePenalties.id, id));

    return { id, status: "CANCELLED" };
  });
}

/** استعلام العقوبات لموظف محدد مع دعم عزل الفروع. */
export async function listEmployeePenalties(
  employeeId: number,
  scopedBranchId?: number | null,
) {
  const db = requireDb();
  const conds = [eq(employeePenalties.employeeId, employeeId)];
  if (scopedBranchId != null) {
    conds.push(eq(employeePenalties.branchId, scopedBranchId));
  }
  // Preview only identifies which run heads to lock; every returned value is re-read afterwards.
  const previewPenalties = await db.select({ id: employeePenalties.id }).from(employeePenalties).where(and(...conds));
  if (!previewPenalties.length) return [];
  const previewAllocations = await db.select({ runId: payrollPenaltyAllocations.runId }).from(payrollPenaltyAllocations)
    .where(inArray(payrollPenaltyAllocations.penaltyId, previewPenalties.map((p) => Number(p.id))));
  const runIds = Array.from(new Set(previewAllocations.map((row) => Number(row.runId)))).sort((a, b) => a - b);
  return db.transaction(async (tx) => {
    const runs = runIds.length ? await tx.select().from(payrollRuns).where(inArray(payrollRuns.id, runIds)).orderBy(payrollRuns.id).for("share") : [];
    if (runs.length !== runIds.length) throw new TRPCError({ code: "CONFLICT", message: appErrorMessage({
      what: "تعذّر عرض تخصيصات العقوبة", why: "تغيّرت مسيّرات الرواتب المرتبطة أثناء القراءة",
      doThis: "حدّث بطاقة الموظف وراجع تخصيصات القرار من جديد",
    }) });
    const penalties = await tx
      .select()
      .from(employeePenalties)
      .where(and(...conds))
      .orderBy(desc(employeePenalties.decisionDate)).for("share");
    if (!penalties.length) return [];
    const allocations = await tx.select({
      penaltyId: payrollPenaltyAllocations.penaltyId,
      runId: payrollPenaltyAllocations.runId,
      itemId: payrollPenaltyAllocations.itemId,
      amount: payrollPenaltyAllocations.amount,
    }).from(payrollPenaltyAllocations)
      .where(inArray(payrollPenaltyAllocations.penaltyId, penalties.map((p) => Number(p.id))))
      .orderBy(payrollPenaltyAllocations.id).for("share");
    const currentRunIds = Array.from(new Set(allocations.map((row) => Number(row.runId)))).sort((a, b) => a - b);
    if (currentRunIds.length !== runIds.length || currentRunIds.some((id, index) => id !== runIds[index])) {
      throw new TRPCError({ code: "CONFLICT", message: appErrorMessage({
        what: "تعذّر عرض تخصيصات العقوبة", why: "تغيّرت مسيّرات التخصيص أثناء قراءة القرار",
        doThis: "حدّث بطاقة الموظف وراجع فترات الاستقطاع من جديد",
      }) });
    }
    await readLockedPenaltyBreakdownsTx(tx, runs, allocations.map((row) => Number(row.itemId)));
    const runById = new Map(runs.map((run) => [Number(run.id), run]));
    const allDecisions = scopedBranchId == null ? penalties : await tx.select().from(employeePenalties)
      .where(eq(employeePenalties.employeeId, employeeId)).for("share");
    const attestations = await tx.select({ entityId: auditLogs.entityId, branchId: auditLogs.branchId, value: auditLogs.newValue, operation: auditLogs.operation })
      .from(auditLogs).where(and(eq(auditLogs.action, "payroll.historicalPenalty.attest"),
        eq(auditLogs.entityType, "payrollHistoricalPenalty"), or(
          eq(auditLogs.entityId, String(employeeId)),
          sql`JSON_UNQUOTE(JSON_EXTRACT(${auditLogs.newValue}, '$.employeeId')) = ${String(employeeId)}`,
          inArray(sql<string>`JSON_UNQUOTE(JSON_EXTRACT(${auditLogs.newValue}, '$.penaltyId'))`, allDecisions.map((decision) => String(decision.id))),
        )));
    // Validate every employee attestation before trusting its penaltyId for filtering.
    // A corrupted id must never hide evidence of an already-deducted decision.
    for (const entry of attestations) {
      const value = auditObject(entry.value);
      const decision = allDecisions.find((candidate) => Number(candidate.id) === Number(value?.penaltyId));
      if (!validHistoricalAttestation(entry, decision, employeeId)) throw new TRPCError({ code: "CONFLICT", message: appErrorMessage({
        what: "تعذّر عرض إقرار القرار التاريخي", why: "دليل الإقرار المحفوظ متعارض أو لا يطابق القرار", doThis: "راجع سجل التدقيق قبل متابعة المعالجة",
      }) });
    }
    return penalties.map((penalty) => {
      const matches = allocations.filter((row) => Number(row.penaltyId) === Number(penalty.id));
      const related = attestations.filter((entry) => {
        const value = auditObject(entry.value);
        return value && entry.branchId != null && penalty.branchId != null && Number(value.penaltyId) === Number(penalty.id) && Number(entry.branchId) === Number(penalty.branchId);
      });
      if (related.length > 1) throw new TRPCError({ code: "CONFLICT", message: appErrorMessage({
        what: "تعذّر عرض إقرار القرار التاريخي", why: "وجد أكثر من إقرار للقرار نفسه", doThis: "راجع سجل التدقيق قبل متابعة المعالجة",
      }) });
      let historicalAttestation: { status: "NEEDS_RECONCILIATION"; period: string } | null = null;
      if (related.length) {
        const value = auditObject(related[0].value)!;
        if (typeof value.period !== "string") {
          throw new TRPCError({ code: "CONFLICT", message: appErrorMessage({
            what: "تعذّر عرض إقرار القرار التاريخي", why: "دليل الإقرار المحفوظ غير مكتمل أو لا يطابق القرار", doThis: "راجع سجل التدقيق قبل متابعة المعالجة",
          }) });
        }
        historicalAttestation = { status: "NEEDS_RECONCILIATION", period: value.period };
      }
      return { ...penalty, payrollAllocations: matches.length ? matches.map((row) => ({
        runId: Number(row.runId), period: runById.get(Number(row.runId))!.period,
        runStatus: runById.get(Number(row.runId))!.status, amount: toDbMoney(row.amount),
      })) : null, historicalAttestation };
    });
  });
}
