import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";
import Decimal from "decimal.js";
import { employeePenalties, employees, payrollRuns } from "../../drizzle/schema";
import { getDb } from "../db";
import { withTx, type Actor, type MaybeScopedActor } from "./tx";
import { money, round2, toDbMoney } from "./money";
import { canCrossBranches } from "../lib/branchAuthority";
import { lockHrEmployeeTx, resolveHrActorTx } from "./hr/resourceScope";

function requireDb() {
  const db = getDb();
  if (!db) throw new Error("DATABASE_URL not set");
  return db;
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
      // المادة 139 من قانون العمل العراقي رقم 37 لسنة 2015: قطع الراتب لا يتجاوز 3 أيام شهرياً
      if (deductionDays.gt(3)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "مخالفة السقف القانوني للاستقطاع",
            why: "يتجاوز استقطاع الراتب 3 أيام، بالمخالفة للمادة 139 من قانون العمل العراقي رقم 37 لسنة 2015",
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
    const penaltyPeriod = String(preview.decisionDate).slice(0, 7);
    const [existingRun] = money(preview.deductionAmount).gt(0)
      ? await tx
          .select({ id: payrollRuns.id, status: payrollRuns.status })
          .from(payrollRuns)
          .where(eq(payrollRuns.period, penaltyPeriod))
          .for("update")
          .limit(1)
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
    const [p] = await tx
      .select()
      .from(employeePenalties)
      .where(eq(employeePenalties.id, id))
      .for("update")
      .limit(1);
    if (
      !p || p.status !== preview.status ||
      p.employeeId !== preview.employeeId || p.branchId !== preview.branchId ||
      String(p.decisionDate) !== String(preview.decisionDate) ||
      !money(p.deductionAmount).eq(money(preview.deductionAmount))
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
    const [p] = await tx
      .select()
      .from(employeePenalties)
      .where(eq(employeePenalties.id, id))
      .limit(1)
      .for("update");

    if (!p) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذّر إلغاء العقوبة",
          why: "سجل العقوبة المطلوب غير موجود أو تم إلغاؤه مسبقاً",
          doThis: "تحقّق من رقم القرار من القائمة",
        }),
      });
    }

    await lockHrEmployeeTx(tx, currentActor, p.employeeId, p.branchId);
    if (p.status === "APPLIED") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "لا يمكن إلغاء العقوبة",
          why: "تم تطبيق استقطاع هذه العقوبة بالفعل ضمن مسيّر رواتب معتمد",
          doThis: "إذا كان هناك خطأ، يلزم إصدار مكافأة تعويضية أو تسوية مالية لاحقة",
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
  return db
    .select()
    .from(employeePenalties)
    .where(and(...conds))
    .orderBy(desc(employeePenalties.decisionDate));
}

/** استعلام العقوبات المعتمدة غير المطبقة في الرواتب لموظف. */
export async function getUnappliedPenalties(employeeId: number, conn?: any) {
  const db = conn ?? requireDb();
  return db
    .select()
    .from(employeePenalties)
    .where(
      and(
        eq(employeePenalties.employeeId, employeeId),
        eq(employeePenalties.status, "APPROVED"),
        isNull(employeePenalties.payrollRunId),
        sql`${employeePenalties.deductionAmount} > 0`,
      ),
    );
}

/** ربط العقوبات بمسيّر الرواتب المولد وتحديث حالتها إلى APPLIED. */
export async function applyPenaltiesToPayrollRunTx(
  tx: any,
  payrollRunId: number,
  penaltyIds: number[],
) {
  if (!penaltyIds.length) return;
  await tx
    .update(employeePenalties)
    .set({
      payrollRunId,
      status: "APPLIED",
    })
    .where(inArray(employeePenalties.id, penaltyIds));
}
