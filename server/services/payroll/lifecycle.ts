import { TRPCError } from "@trpc/server";
import { and, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { appErrorMessage } from "@shared/errors";
import { payrollItemNeedsAttention } from "@shared/hr";
import {
  commissionRuns,
  employeePenalties,
  employeeSpotBonuses,
  employeeTerminations,
  payrollAccountingEvents,
  payrollItems,
  payrollObligations,
  payrollPenaltyAllocations,
  payrollRuns,
} from "../../../drizzle/schema";
import { type Actor, withTx } from "../tx";
import {
  approvePayrollAccrualTx,
  reopenPayrollAccrualTx,
  verifyApprovalSnapshotIfPresentTx,
} from "./obligations";
import { money } from "../money";
import { getRun } from "./queries";
import { assertPayrollActiveOwnerChecker } from "./settlement";
import { decodeTerminationWageCoverage } from "./terminationCoverage";
import { assertCommissionArtifactReadyForPayrollTx } from "../commissions/payrollReadiness";
import { assertPenaltyCapAtApprovalTx, assertRunPenaltyAllocationsTx, assertZeroNetEvidenceIfPaymentExistsTx, assertZeroNetPenaltySettlementTx, readPenaltySourcesTx, refreshPenaltyStatesTx } from "./penaltyAllocations";
import { syncAllAdvancesForDraftRunTx } from "./syncAdvances";
import {
  assertNoLegacyUnclassifiedAdvanceTx,
  assertPayrollEmployeeMembershipStable,
  lockPayrollEmployeesTx,
  payrollEmployeeMembership,
} from "./employeeLocks";

function isNowaitConflict(error: unknown): boolean {
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

async function currentPayrollSourceRead<T>(read: PromiseLike<T>): Promise<T> {
  try {
    return await read;
  } catch (error) {
    if (!isNowaitConflict(error)) throw error;
    throw new TRPCError({
      code: "CONFLICT",
      message: appErrorMessage({
        what: "تعذّر تثبيت مصادر مسيّر الرواتب الآن",
        why: "تتغيّر حالياً مكافأة أو عقوبة تدخل في المسيّر",
        doThis: "انتظر اكتمال التعديل ثم أعد اعتماد المسيّر",
      }),
    });
  }
}

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
    const itemMembershipPreview = payrollEmployeeMembership(
      await tx
        .select({ id: payrollItems.id, employeeId: payrollItems.employeeId })
        .from(payrollItems)
        .where(eq(payrollItems.runId, id))
        .orderBy(payrollItems.id),
    );
    const lockedEmployees = await lockPayrollEmployeesTx(
      tx,
      itemMembershipPreview,
      "اعتماد مسيّر الرواتب",
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
    if (run.status === "paid") {
      await verifyApprovalSnapshotIfPresentTx(tx, run);
      await assertRunPenaltyAllocationsTx(tx, id);
      await assertZeroNetPenaltySettlementTx(tx, run);
      return true;
    }
    if (run.status !== "draft") {
      if (run.status !== "approved") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "يُعتمد المسيّر من حالة المسودة فقط." });
      }
    }
    if (Number(run.employeeCount) === 0) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن اعتماد مسيّر فارغ" });
    }
    await assertCommissionArtifactReadyForPayrollTx(tx, run.period);
    if (run.status === "approved") {
      await verifyApprovalSnapshotIfPresentTx(tx, run);
      await assertRunPenaltyAllocationsTx(tx, id);
      await assertZeroNetEvidenceIfPaymentExistsTx(tx, run);
      return true;
    }
    await assertNoLegacyUnclassifiedAdvanceTx(
      tx,
      lockedEmployees,
      "اعتماد مسيّر الرواتب",
    );
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
    // التوليد يلتقط المكافآت والعقوبات لموظفي بنود المسير فقط؛ ذمم الموظفين
    // المستبعدين تبقى معلّقة بمصادرها ولا تعطل اعتماد رواتب موظفين آخرين.
    const sourceScope = await tx
      .select({ employeeId: payrollItems.employeeId })
      .from(payrollItems)
      .where(eq(payrollItems.runId, id))
      .orderBy(payrollItems.id)
      .for("share");
    const sourceEmployeeIds = sourceScope.map((item) =>
      Number(item.employeeId),
    );
    const [uncapturedBonus] = await currentPayrollSourceRead(
      tx
        .select({ id: employeeSpotBonuses.id })
        .from(employeeSpotBonuses)
        .where(
          and(
            inArray(employeeSpotBonuses.employeeId, sourceEmployeeIds),
            eq(employeeSpotBonuses.status, "APPROVED"),
            eq(employeeSpotBonuses.disbursementType, "PAYROLL_ADDITION"),
            isNull(employeeSpotBonuses.payrollRunId),
            // نفس أهلية التوليد: الالتزام القديم/الإرثي غير الملتقط يمنع اعتماد مسودة
            // لا تحتويه، أما اعتماد شهر مستقبلي فلا يخص مسيّر الفترة الحالية.
            or(
              isNull(employeeSpotBonuses.approvedAt),
              sql`DATE_FORMAT(CONVERT_TZ(${employeeSpotBonuses.approvedAt}, '+00:00', '+03:00'), '%Y-%m') <= ${run.period}`,
            ),
          ),
        )
        .orderBy(employeeSpotBonuses.id)
        .for("update", { noWait: true })
        .limit(1),
    );
    const penaltySources = await readPenaltySourcesTx(tx, sourceEmployeeIds, run.period, true, id);
    const uncapturedPenalty = penaltySources.find((source) => source.remaining.gt(0) && !source.capturedRunIds.includes(id));
    const [unprovenLegacyPenalty] = await tx.select({ id: employeePenalties.id })
      .from(employeePenalties)
      .leftJoin(payrollPenaltyAllocations, and(
        eq(payrollPenaltyAllocations.penaltyId, employeePenalties.id),
        eq(payrollPenaltyAllocations.runId, id),
      ))
      .where(and(eq(employeePenalties.payrollRunId, id), isNull(payrollPenaltyAllocations.id)))
      .limit(1);
    if (unprovenLegacyPenalty) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: appErrorMessage({
        what: "تعذّر اعتماد عقوبة تاريخية ضمن المسودة",
        why: `العقوبة #${unprovenLegacyPenalty.id} مرتبطة بالمسيّر دون تخصيص مبلغ مثبت`,
        doThis: "احذف المسودة غير المعتمدة ثم أعد توليدها لتثبيت تخصيص العقوبة",
      }) });
    }
    if (uncapturedBonus || uncapturedPenalty) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: appErrorMessage({
          what: "لا يمكن اعتماد مسيّر لا يلتقط كل إضافات واستقطاعات الموظفين",
          why: [
            uncapturedBonus ? `مكافأة #${uncapturedBonus.id}` : null,
            uncapturedPenalty ? `عقوبة #${uncapturedPenalty.id}` : null,
          ]
            .filter(Boolean)
            .join(" و "),
          doThis:
            "احذف المسودة غير المعتمدة، ثم ولّد المسيّر مجدداً لالتقاط القيم قبل الاعتماد",
        }),
      });
    }
    // آخر بوابة قبل تجميد اللقطة: التقط كل سلف الشهر وأزل أي خصم أُلغي من المسودة.
    await syncAllAdvancesForDraftRunTx(tx, id);
    await assertRunPenaltyAllocationsTx(tx, id);
    await assertPenaltyCapAtApprovalTx(tx, id, run.period);
    // قراءة حالية بعد القفل والمزامنة؛ لقطة preview قد تسبق تعديلاً متزامناً للبنود.
    const [runToApprove] = await tx
      .select()
      .from(payrollRuns)
      .where(eq(payrollRuns.id, id))
      .for("update")
      .limit(1);
    if (!runToApprove || runToApprove.status !== "draft") {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تعذّر اعتماد مسيّر الرواتب",
          why: "تغيّرت حالة المسيّر أثناء مزامنة سلف الشهر",
          doThis: "حدّث شاشة المسيّر وراجع حالته قبل إعادة المحاولة",
        }),
      });
    }

    const currentItems = await tx
      .select()
      .from(payrollItems)
      .where(eq(payrollItems.runId, id))
      .orderBy(payrollItems.id)
      .for("update");
    assertPayrollEmployeeMembershipStable(
      itemMembershipPreview,
      payrollEmployeeMembership(currentItems),
      lockedEmployees,
      "اعتماد مسيّر الرواتب",
    );
    const items = currentItems.map((item) => ({
      ...item,
      currentBranchId:
        lockedEmployees.get(Number(item.employeeId))?.branchId ?? null,
    }));
    if (items.length !== Number(run.employeeCount)) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "عدد بنود المسيّر لا يطابق رأسه — أعد توليده.",
      });
    }
    const flaggedItem = items.find((item) => payrollItemNeedsAttention(item.note));
    if (flaggedItem) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: appErrorMessage({
          what: "لا يمكن اعتماد المسيّر",
          why: `لوجود بصمات حضور مفتوحة (دخول بلا انصراف) لم تُحسم بعد للموظف #${flaggedItem.employeeId}`,
          doThis: "صحّح أوقات الانصراف وأعد توليد المسودة قبل الاعتماد.",
        }),
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
      run: runToApprove,
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
    const itemMembershipPreview = payrollEmployeeMembership(
      await tx
        .select({ id: payrollItems.id, employeeId: payrollItems.employeeId })
        .from(payrollItems)
        .where(eq(payrollItems.runId, id))
        .orderBy(payrollItems.id),
    );
    const obligationMembershipPreview = payrollEmployeeMembership(
      await tx
        .select({
          id: payrollObligations.id,
          employeeId: payrollObligations.employeeId,
        })
        .from(payrollObligations)
        .where(
          and(
            eq(payrollObligations.runId, id),
            eq(payrollObligations.revisionNo, Number(preview.revisionNo)),
          ),
        )
        .orderBy(payrollObligations.id),
    );
    const lockedEmployees = await lockPayrollEmployeesTx(
      tx,
      [...itemMembershipPreview, ...obligationMembershipPreview],
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
    const currentObligations = await tx
      .select({
        id: payrollObligations.id,
        employeeId: payrollObligations.employeeId,
      })
      .from(payrollObligations)
      .where(
        and(
          eq(payrollObligations.runId, id),
          eq(payrollObligations.revisionNo, Number(run.revisionNo)),
        ),
      )
      .orderBy(payrollObligations.id)
      .for("update");
    assertPayrollEmployeeMembershipStable(
      obligationMembershipPreview,
      payrollEmployeeMembership(currentObligations),
      lockedEmployees,
      "إلغاء أو إعادة فتح مسيّر الرواتب",
    );
    const currentItems = await tx
      .select({ id: payrollItems.id, employeeId: payrollItems.employeeId })
      .from(payrollItems)
      .where(eq(payrollItems.runId, id))
      .orderBy(payrollItems.id)
      .for("update");
    assertPayrollEmployeeMembershipStable(
      itemMembershipPreview,
      payrollEmployeeMembership(currentItems),
      lockedEmployees,
      "إلغاء أو إعادة فتح مسيّر الرواتب",
    );
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
      const penaltyAllocations = await tx.select({ penaltyId: payrollPenaltyAllocations.penaltyId })
        .from(payrollPenaltyAllocations).where(eq(payrollPenaltyAllocations.runId, id)).for("update");
      const penaltyIds = penaltyAllocations.map((row) => Number(row.penaltyId));
      if (penaltyIds.length) {
        const [later] = await tx.select({ period: payrollRuns.period, penaltyId: payrollPenaltyAllocations.penaltyId })
          .from(payrollPenaltyAllocations)
          .innerJoin(payrollRuns, eq(payrollPenaltyAllocations.runId, payrollRuns.id))
          .where(and(inArray(payrollPenaltyAllocations.penaltyId, penaltyIds), sql`${payrollRuns.period} > ${run.period}`))
          .for("share").limit(1);
        if (later) throw new TRPCError({ code: "PRECONDITION_FAILED", message: appErrorMessage({
          what: "تعذّر حذف مسودة الرواتب",
          why: `للعقوبة #${later.penaltyId} تخصيص في مسيّر لاحق (${later.period})`,
          doThis: "راجع المسيّر اللاحق واحذف مسودته أولاً إن كان ذلك مسموحاً",
        }) });
      }
      await tx.delete(payrollPenaltyAllocations).where(eq(payrollPenaltyAllocations.runId, id));
      await tx
        .update(employeePenalties)
        .set({ payrollRunId: null, status: "APPROVED" })
        .where(eq(employeePenalties.payrollRunId, id));
      await tx
        .update(employeeSpotBonuses)
        .set({ payrollRunId: null })
        .where(eq(employeeSpotBonuses.payrollRunId, id));
      await refreshPenaltyStatesTx(tx, penaltyAllocations.map((row) => Number(row.penaltyId)));
      await tx.delete(payrollItems).where(eq(payrollItems.runId, id));
      await tx.delete(payrollRuns).where(eq(payrollRuns.id, id));
      return { id, deleted: true, status: "deleted" as const };
    }
    // The next revision clears the approval hashes. Verify the old revision's
    // zero-net closure first so missing proof cannot silently release a penalty.
    await assertRunPenaltyAllocationsTx(tx, id);
    await assertZeroNetEvidenceIfPaymentExistsTx(tx, run);
    await reopenPayrollAccrualTx(tx, {
      run,
      actorUserId: actor.userId,
      occurredAt: new Date(),
    });
    const reopenedPenalties = await tx.select({ penaltyId: payrollPenaltyAllocations.penaltyId })
      .from(payrollPenaltyAllocations).where(eq(payrollPenaltyAllocations.runId, id)).for("share");
    await refreshPenaltyStatesTx(tx, reopenedPenalties.map((row) => Number(row.penaltyId)));
    // إعادة الفتح لا تعيد توليد البنود؛ إبقاء المصادر مربوطة يمنع التقاط المكافأة/العقوبة
    // مرة ثانية في مسيّر لاحق، ويجعل إعادة الاعتماد/الدفع تسوّي المصدر نفسه.
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
