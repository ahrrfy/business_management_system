import { TRPCError } from "@trpc/server";
import { and, eq, getTableColumns, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import {
  commissionRuns,
  employeeTerminations,
  employees,
  payrollAccountingEvents,
  payrollItems,
  payrollRuns,
} from "../../../drizzle/schema";
import { type Actor, withTx } from "../tx";
import {
  approvePayrollAccrualTx,
  reopenPayrollAccrualTx,
} from "./obligations";
import { money } from "../money";
import { getRun } from "./queries";
import { assertPayrollActiveOwnerChecker } from "./settlement";
import { decodeTerminationWageCoverage } from "./terminationCoverage";

/** اعتماد الاستحقاق الشهري؛ لا نقد ولا إيصال في هذه المرحلة. */
export async function approveRun(id: number, actor: Actor) {
  const replayed = await withTx(async (tx) => {
    const [preview] = await tx
      .select()
      .from(payrollRuns)
      .where(eq(payrollRuns.id, id))
      .limit(1);
    if (!preview) throw new TRPCError({ code: "NOT_FOUND", message: "المسيّر غير موجود" });
    await assertPayrollActiveOwnerChecker(
      tx,
      actor,
      [preview.createdBy],
      "اعتماد استحقاق مسيّر الرواتب",
    );
    const [run] = await tx
      .select()
      .from(payrollRuns)
      .where(eq(payrollRuns.id, id))
      .for("update")
      .limit(1);
    if (!run) throw new TRPCError({ code: "NOT_FOUND", message: "المسيّر غير موجود" });
    if (
      run.createdBy !== preview.createdBy ||
      Number(run.revisionNo) !== Number(preview.revisionNo)
    ) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "تغيّر المسيّر أثناء التحقق من الاعتماد — أعد المحاولة.",
      });
    }
    if (run.status === "approved" || run.status === "paid") return true;
    if (run.status !== "draft") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "يُعتمد المسيّر من حالة المسودة فقط." });
    }
    if (Number(run.employeeCount) === 0) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن اعتماد مسيّر فارغ" });
    }
    const [uncaptured] = await tx
      .select({ id: commissionRuns.id, period: commissionRuns.period })
      .from(commissionRuns)
      .where(
        and(
          eq(commissionRuns.period, run.period),
          eq(commissionRuns.status, "approved"),
          isNull(commissionRuns.payrollRunId),
        ),
      )
      .orderBy(commissionRuns.id)
      .for("update")
      .limit(1);
    if (uncaptured) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: `تشغيلة عمولات معتمدة (#${uncaptured.id}) لشهر ${uncaptured.period} غير ملتقطة — أعد توليد المسيّر.`,
      });
    }
    const items = await tx
      .select({
        ...getTableColumns(payrollItems),
        currentBranchId: employees.branchId,
      })
      .from(payrollItems)
      .leftJoin(employees, eq(payrollItems.employeeId, employees.id))
      .where(eq(payrollItems.runId, id))
      .orderBy(payrollItems.id)
      .for("update");
    if (items.length !== Number(run.employeeCount)) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "عدد بنود المسيّر لا يطابق رأسه — أعد توليده.",
      });
    }
    const terminationCoverage = decodeTerminationWageCoverage(run.notes, run.period);
    if (terminationCoverage.length > 0) {
      const coveredRows = await tx
        .select({
          terminationId: employeeTerminations.id,
          employeeId: employeeTerminations.employeeId,
          earnedGrossWages: employeeTerminations.earnedGrossWages,
          settlementSnapshotHash: employeeTerminations.settlementSnapshotHash,
          lastDay: employeeTerminations.lastDay,
          status: employeeTerminations.status,
          recognizedAt: employeeTerminations.recognizedAt,
          recognitionReversedAt: employeeTerminations.recognitionReversedAt,
        })
        .from(employeeTerminations)
        .where(
          inArray(
            employeeTerminations.id,
            terminationCoverage.map((item) => item.terminationId),
          ),
        )
        .for("share");
      const byId = new Map(coveredRows.map((row) => [Number(row.terminationId), row]));
      for (const coverage of terminationCoverage) {
        const row = byId.get(coverage.terminationId);
        const commissionItem = items.find(
          (item) => Number(item.employeeId) === coverage.employeeId,
        );
        if (
          !row ||
          Number(row.employeeId) !== coverage.employeeId ||
          row.status !== "completed" ||
          row.recognizedAt == null ||
          row.recognitionReversedAt != null ||
          money(row.earnedGrossWages).toFixed(2) !== coverage.earnedGrossWages ||
          row.settlementSnapshotHash !== coverage.settlementSnapshotHash ||
          String(row.lastDay).slice(0, 7) !== run.period ||
          (money(coverage.payrollCommission).gt(0) &&
            (!commissionItem ||
              !money(commissionItem.gross).isZero() ||
              !money(commissionItem.overtime).isZero() ||
              !money(commissionItem.commission).eq(coverage.payrollCommission))) ||
          (money(coverage.payrollCommission).isZero() && commissionItem != null)
        ) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message:
              `تغيّرت تغطية أجر إنهاء خدمة الموظف #${coverage.employeeId} بعد توليد المسيّر؛ ` +
              "احذف المسودة وأعد توليدها قبل الاعتماد.",
          });
        }
      }
    }
    const employeeIds = items.map((item) => Number(item.employeeId));
    const [recognizedTerminationWages] = await tx
      .select({
        terminationId: employeeTerminations.id,
        employeeId: employeeTerminations.employeeId,
      })
      .from(employeeTerminations)
      .where(
        and(
          inArray(employeeTerminations.employeeId, employeeIds),
          eq(employeeTerminations.status, "completed"),
          isNotNull(employeeTerminations.recognizedAt),
          isNull(employeeTerminations.recognitionReversedAt),
          sql`DATE_FORMAT(${employeeTerminations.lastDay}, '%Y-%m') = ${run.period}`,
        ),
      )
      .for("share")
      .limit(1);
    if (recognizedTerminationWages) {
      const coveredItem = items.find(
        (item) => Number(item.employeeId) === Number(recognizedTerminationWages.employeeId),
      );
      const isCommissionOnly =
        coveredItem != null &&
        money(coveredItem.gross).isZero() &&
        money(coveredItem.overtime).isZero() &&
        money(coveredItem.commission).gt(0);
      if (!isCommissionOnly) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            `أجور الموظف #${recognizedTerminationWages.employeeId} للفترة ${run.period} مثبتة ضمن تسوية نهاية الخدمة ` +
            `(#${recognizedTerminationWages.terminationId}) — لا يجوز اعتمادها مرة ثانية ضمن المسيّر.`,
        });
      }
    }
    await approvePayrollAccrualTx(tx, {
      run,
      items,
      actorUserId: actor.userId,
      approvedAt: new Date(),
    });
    return false;
  });
  const run = await getRun(id);
  return { ...run, replayed };
}

/**
 * مسودة جديدة تُحذف؛ المعتمد يُعكس append-only ثم يعود مسودةً بمراجعة جديدة.
 * المدفوع لا يُفتح قبل تسجيل عودة كل دفعة راتب بإيصال فعلي.
 */
export async function cancelRun(
  id: number,
  actor: Actor & { enforceCashReturnEvidence?: boolean },
  reason = "إعادة المسيّر للمراجعة",
) {
  return withTx(async (tx) => {
    const [preview] = await tx
      .select()
      .from(payrollRuns)
      .where(eq(payrollRuns.id, id))
      .limit(1);
    if (!preview) throw new TRPCError({ code: "NOT_FOUND", message: "المسيّر غير موجود" });
    await assertPayrollActiveOwnerChecker(
      tx,
      actor,
      [preview.createdBy],
      "إلغاء أو إعادة فتح مسيّر الرواتب",
    );
    const [run] = await tx
      .select()
      .from(payrollRuns)
      .where(eq(payrollRuns.id, id))
      .for("update")
      .limit(1);
    if (!run) throw new TRPCError({ code: "NOT_FOUND", message: "المسيّر غير موجود" });
    if (
      run.createdBy !== preview.createdBy ||
      Number(run.revisionNo) !== Number(preview.revisionNo)
    ) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "تغيّر المسيّر أثناء التحقق من الإلغاء — أعد المحاولة.",
      });
    }
    if (run.status === "cancelled") {
      return { id, deleted: false, status: "cancelled" as const };
    }
    if (run.status === "paid") {
      const [salaryPayment] = await tx
        .select({ id: payrollAccountingEvents.id })
        .from(payrollAccountingEvents)
        .where(and(
          eq(payrollAccountingEvents.runId, id),
          eq(payrollAccountingEvents.revisionNo, Number(run.revisionNo)),
          eq(payrollAccountingEvents.eventKind, "SALARY_PAYMENT"),
        ))
        .limit(1);
      // A zero-net run is marked paid only to preserve who closed the payroll;
      // it has no cash receipt/payment event and may therefore be reopened like
      // an approved accrual. Any actual or inconsistent payment stays fail-closed.
      if (!money(run.totalNet).isZero() || salaryPayment) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "لا يمكن إعادة مسيّر مدفوع قبل تسجيل عودة كل راتب فعلياً من مسار إعادة الدفعة.",
        });
      }
    }
    if (run.status === "draft") {
      const [history] = await tx
        .select({ id: payrollAccountingEvents.id })
        .from(payrollAccountingEvents)
        .where(eq(payrollAccountingEvents.runId, id))
        .limit(1);
      if (history) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "هذه مسودة معادة من اعتماد سابق؛ تبقى محفوظة للأثر التدقيقي ولا تُحذف.",
        });
      }
      await tx.delete(payrollItems).where(eq(payrollItems.runId, id));
      await tx.delete(payrollRuns).where(eq(payrollRuns.id, id));
      return { id, deleted: true, status: "deleted" as const };
    }
    await reopenPayrollAccrualTx(tx, {
      run,
      actorUserId: actor.userId,
      occurredAt: new Date(),
    });
    await tx
      .update(payrollRuns)
      .set({
        cancelledBy: actor.userId,
        cancelledAt: new Date(),
        cancelReason: reason.trim().slice(0, 255),
      })
      .where(eq(payrollRuns.id, id));
    return {
      id,
      deleted: false,
      status: "draft" as const,
      revisionNo: Number(run.revisionNo) + 1,
    };
  });
}
