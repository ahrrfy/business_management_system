import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";
import Decimal from "decimal.js";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { fullEmployeeName } from "@shared/hr";
import {
  employees,
  employeeSpotBonuses,
  payrollAccountingEvents,
  payrollObligationAllocations,
  payrollObligations,
  payrollRuns,
  receipts,
  shifts,
  users,
} from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import {
  assertApprovedTreasuryOutAvailable,
  assertCashOutAvailable,
  authorizeExternalTreasuryDisbursement,
  lockMaterializedCashReceiptSourceForWrite,
} from "../cash/cashAvailability";
import { baghdadToday } from "../businessDay";
import { money, round2, toDateStr, toDbMoney } from "../money";
import { type Actor, withTx } from "../tx";
import {
  payrollSettlementPosting,
  postPayrollAccountingEvent,
} from "./accounting";
import { getRun } from "./queries";
import { payrollHash } from "./helpers";
import {
  assertSalaryReceiptEvidence,
  readSalarySettlementEvidence,
  salaryEvidenceComponents,
  type SalarySettlementEvidence,
} from "./settlementEvidence";
import type {
  PayrollPaymentInput,
  PayrollPaymentMethod,
  PayrollReturnInput,
} from "./types";
import { assertCommissionArtifactReadyForPayrollTx } from "../commissions/payrollReadiness";

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

function actualDate(value: string | null | undefined, label: string): string {
  const ymd = value?.trim() || baghdadToday();
  const parsed = Date.parse(`${ymd}T00:00:00Z`);
  if (
    !YMD_RE.test(ymd) ||
    Number.isNaN(parsed) ||
    new Date(parsed).toISOString().slice(0, 10) !== ymd
  ) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `${label} غير صالح.` });
  }
  if (ymd > baghdadToday()) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${label} لا يجوز أن يكون مستقبلياً.`,
    });
  }
  return ymd;
}

export function assertPayrollPaymentEvidence(
  method: PayrollPaymentMethod,
  referenceNumber: string | null | undefined,
): string | null {
  const ref = referenceNumber?.trim() || null;
  if (method === "CASH") return null;
  if (method === "CARD" && !/^\d{4}$/.test(ref ?? "")) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Card evidence must be exactly the last four digits.",
    });
  }
  if ((method === "TRANSFER" || method === "WALLET") && !ref) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "رقم مرجع التحويل/البطاقة/المحفظة مطلوب لإثبات دفع الراتب.",
    });
  }
  return ref;
}

/**
 * ⭐ قرار المالك (٣/٩/٢٦): لا اعتماد ثانٍ بعد المالك — أُزيل شرط «مختلفٌ عن صانع العملية»
 * (كان هنا نظيراً مستقلاً لِـauthorizeExternalTreasuryDisbursement في cashAvailability.ts،
 * التفصيل هناك). `forbiddenUserIds` يبقى في التوقيع توثيقاً لهوية الطالب في مواضع الاستدعاء —
 * الأثر التدقيقي (createdBy/executedBy) يبقى مسجَّلاً كما هو.
 */
export async function assertPayrollActiveOwnerChecker(
  tx: Tx,
  actor: Actor,
  _forbiddenUserIds: Array<number | null | undefined>,
  operation: string,
): Promise<void> {
  const [owner] = await tx
    .select({ id: users.id, isOwner: users.isOwner, isActive: users.isActive })
    .from(users)
    .where(eq(users.id, actor.userId))
    .for("share")
    .limit(1);
  if (!owner?.isActive || !owner.isOwner) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `${operation}: التنفيذ محصور بحساب مالك نشط.`,
    });
  }
}

function supportedReceiptMethod(value: string): PayrollPaymentMethod {
  if (
    value === "CASH" ||
    value === "CARD" ||
    value === "TRANSFER" ||
    value === "WALLET"
  ) {
    return value;
  }
  throw new TRPCError({
    code: "PRECONDITION_FAILED",
    message: "طريقة الدفع الأصلية لا يدعمها مسار إعادة الرواتب.",
  });
}

export function payrollSalaryPaymentSourceKey(
  runId: number,
  employeeId: number,
  priorPaymentCount: number,
): string {
  const base = `PAYROLL:${runId}:${employeeId}`;
  return priorPaymentCount === 0 ? base : `${base}:r${priorPaymentCount}`;
}

async function assertSalaryRetry(
  tx: Tx,
  run: typeof payrollRuns.$inferSelect,
  method: PayrollPaymentMethod,
  referenceNumber: string | null,
  paymentYmd: string,
  payment: PayrollPaymentInput,
) {
  const saved = await tx
    .select({
      event: payrollAccountingEvents,
      receipt: receipts,
      obligation: payrollObligations,
      allocation: payrollObligationAllocations,
    })
    .from(payrollAccountingEvents)
    .leftJoin(receipts, eq(payrollAccountingEvents.receiptId, receipts.id))
    .innerJoin(
      payrollObligations,
      eq(payrollAccountingEvents.obligationId, payrollObligations.id),
    )
    .innerJoin(
      payrollObligationAllocations,
      and(
        eq(
          payrollObligationAllocations.accountingEventId,
          payrollAccountingEvents.id,
        ),
        eq(payrollObligationAllocations.direction, "APPLY"),
      ),
    )
    .where(
      and(
        eq(payrollAccountingEvents.runId, run.id),
        eq(payrollAccountingEvents.revisionNo, run.revisionNo),
        eq(payrollAccountingEvents.eventKind, "SALARY_PAYMENT"),
      ),
    )
    .orderBy(asc(payrollAccountingEvents.id))
    .for("update");
  if (!saved.length) {
    if (money(run.totalNet).isZero()) return;
    throw new TRPCError({
      code: "CONFLICT",
      message: appErrorMessage({
        what: "دليل دفع المسيّر المحفوظ مفقود.",
        why: "دليل المصدر المحفوظ لا يحقق عقد تسوية الراتب",
        doThis: "راجع الحدث والتخصيص الأصليين مع المحاسب قبل إعادة المحاولة",
      }),
    });
  }
  const validated = saved.map((row) => {
    const evidence = readSalarySettlementEvidence(
      row.event.settlementEvidence,
      row.event.sourceHash,
    );
    if (evidence) {
      if (
        evidence.sourceKey !== row.event.sourceKey ||
        evidence.runId !== run.id ||
        evidence.obligationId !== row.obligation.id ||
        evidence.obligationSourceKey !== row.obligation.sourceKey ||
        evidence.revisionNo !== row.event.revisionNo ||
        evidence.branchId !== row.obligation.branchIdSnapshot ||
        evidence.employeeId !== row.obligation.employeeId ||
        evidence.approvalSnapshotHash !== run.approvalSnapshotHash ||
        !money(evidence.entitlementSettled).eq(row.allocation.amount)
      ) {
        throw new TRPCError({
          code: "CONFLICT",
          message: appErrorMessage({
            what: "دليل تسوية الراتب لا يطابق الإيصال والتخصيص الأصليين.",
            why: "دليل المصدر المحفوظ لا يحقق عقد تسوية الراتب",
            doThis:
              "راجع الحدث والتخصيص الأصليين مع المحاسب قبل إعادة المحاولة",
          }),
        });
      }
    } else if (
      !row.receipt ||
      payrollHash({
        kind: "SALARY_PAYMENT",
        obligationSourceKey: row.obligation.sourceKey,
        amount: money(row.receipt.amount).toFixed(2),
        method: row.receipt.paymentMethod,
        referenceNumber: row.receipt.referenceNumber?.trim() || null,
        paymentYmd: toDateStr(
          new Date(row.receipt.voucherDate ?? row.receipt.createdAt),
        ),
      }) !== row.event.sourceHash
    ) {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "دليل دفع الراتب التاريخي لا يطابق أصله.",
          why: "دليل المصدر المحفوظ لا يحقق عقد تسوية الراتب",
          doThis: "راجع الحدث والتخصيص الأصليين مع المحاسب قبل إعادة المحاولة",
        }),
      });
    }
    return { ...row, evidence };
  });
  const paymentEvents = await tx
    .select({ id: payrollAccountingEvents.id })
    .from(payrollAccountingEvents)
    .where(
      and(
        eq(payrollAccountingEvents.runId, run.id),
        eq(payrollAccountingEvents.revisionNo, run.revisionNo),
        eq(payrollAccountingEvents.eventKind, "SALARY_PAYMENT"),
      ),
    )
    .for("update");
  if (
    paymentEvents.length !== saved.length ||
    new Set(saved.map((row) => row.event.id)).size !== saved.length
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message: appErrorMessage({
        what: "تخصيص دفع راتب محفوظ مفقود أو مكرر.",
        why: "دليل المصدر المحفوظ لا يحقق عقد تسوية الراتب",
        doThis: "راجع الحدث والتخصيص الأصليين مع المحاسب قبل إعادة المحاولة",
      }),
    });
  }
  const reversedEvents = await tx
    .select({
      event: payrollAccountingEvents,
      receipt: receipts,
      allocation: payrollObligationAllocations,
    })
    .from(payrollAccountingEvents)
    .leftJoin(receipts, eq(payrollAccountingEvents.receiptId, receipts.id))
    .leftJoin(
      payrollObligationAllocations,
      and(
        eq(
          payrollObligationAllocations.accountingEventId,
          payrollAccountingEvents.id,
        ),
        eq(payrollObligationAllocations.direction, "REVERSE"),
      ),
    )
    .where(
      and(
        eq(payrollAccountingEvents.runId, run.id),
        eq(payrollAccountingEvents.revisionNo, run.revisionNo),
        eq(payrollAccountingEvents.eventKind, "SALARY_PAYMENT_RETURN"),
      ),
    )
    .for("update");
  const reversedIds = new Set(
    reversedEvents.map((row) => row.event.reversalOfId),
  );
  const invalidState = () => {
    throw new TRPCError({
      code: "CONFLICT",
      message: appErrorMessage({
        what: "حالة تسوية الراتب لا تطابق تخصيصها أو عكسها المحفوظ",
        why: "إيصال أو رابط عكس أو تخصيص أصلي غير متطابق",
        doThis: "راجع أحداث الموظف وتخصيصاتها مع المحاسب قبل إعادة المحاولة",
      }),
    });
  };
  for (const row of validated) {
    const reversed = reversedIds.has(row.event.id);
    assertSalaryReceiptEvidence(row.evidence, { ...row, reversed });
    if (
      row.receipt &&
      row.receipt.status !== (reversed ? "REVERSED" : "COMPLETED")
    )
      invalidState();
    if (
      row.allocation.obligationId !== row.obligation.id ||
      row.allocation.reversalOfId != null
    )
      invalidState();
    const returns = reversedEvents.filter(
      (returned) => returned.event.reversalOfId === row.event.id,
    );
    if (returns.length > 1) invalidState();
    for (const returned of returns) {
      const returnEvidence = readSalarySettlementEvidence(
        returned.event.settlementEvidence,
        returned.event.sourceHash,
      );
      assertSalaryReceiptEvidence(returnEvidence, {
        ...returned,
        obligation: row.obligation,
        reversed: false,
      });
      if (
        returned.event.obligationId !== row.obligation.id ||
        !returned.allocation ||
        returned.allocation.obligationId !== row.obligation.id ||
        returned.allocation.reversalOfId !== row.allocation.id ||
        !money(returned.allocation.amount).eq(row.allocation.amount) ||
        (returned.receipt && returned.receipt.status !== "COMPLETED") ||
        (row.evidence &&
          (!returnEvidence ||
            returnEvidence.originalSourceHash !== row.event.sourceHash ||
            !money(returnEvidence.entitlementSettled).eq(
              row.allocation.amount,
            ) ||
            !money(returnEvidence.actualPayout).eq(row.evidence.actualPayout)))
      )
        invalidState();
    }
  }
  if (
    reversedEvents.some(
      (returned) =>
        !validated.some((row) => row.event.id === returned.event.reversalOfId),
    )
  )
    invalidState();
  const salaryObligations = await tx
    .select()
    .from(payrollObligations)
    .where(
      and(
        eq(payrollObligations.runId, run.id),
        eq(payrollObligations.revisionNo, run.revisionNo),
        eq(payrollObligations.kind, "SALARY_NET"),
      ),
    )
    .for("update");
  for (const obligation of salaryObligations) {
    const settled = validated
      .filter(
        (row) =>
          row.obligation.id === obligation.id && !reversedIds.has(row.event.id),
      )
      .reduce((sum, row) => sum.plus(row.allocation.amount), money(0));
    if (
      !money(obligation.remainingAmount).isZero() ||
      !settled.eq(obligation.originalAmount)
    ) {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تخصيص دفع راتب محفوظ مفقود أو مكرر.",
          why: "الالتزام المسدد لا يطابق تخصيص أحداثه الأصلية",
          doThis: "راجع تسويات الموظف وعكسها مع المحاسب",
        }),
      });
    }
  }
  const latest = validated[validated.length - 1];
  const batch = latest.evidence
    ? validated.filter(
        (row) => row.evidence?.batchId === latest.evidence!.batchId,
      )
    : [latest];
  for (const row of batch) {
    const evidence = row.evidence;
    if (
      (row.receipt && row.receipt.status !== "COMPLETED") ||
      (evidence?.method ?? row.receipt?.paymentMethod) !== method ||
      (evidence?.referenceNumber ?? row.receipt?.referenceNumber ?? null) !==
        referenceNumber ||
      (evidence?.paymentYmd ??
        toDateStr(
          new Date(row.receipt!.voucherDate ?? row.receipt!.createdAt),
        )) !== paymentYmd ||
      (evidence?.cashBucket ?? row.receipt?.cashBucket ?? null) !==
        (method === "CASH" ? (payment.cashBucket ?? "TREASURY") : null) ||
      (evidence?.shiftId ?? row.receipt?.shiftId ?? null) !==
        (method === "CASH" && payment.cashBucket === "DRAWER"
          ? (payment.shiftId ?? null)
          : null)
    ) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "إعادة محاولة دفع المسيّر لا تطابق دليل آخر دفعة محفوظة.",
      });
    }
  }
}

export async function payRun(
  id: number,
  actor: Actor,
  payment: PayrollPaymentInput = {},
) {
  const method = payment.paymentMethod ?? "CASH";
  const referenceNumber = assertPayrollPaymentEvidence(
    method,
    payment.referenceNumber,
  );
  const paymentYmd = actualDate(payment.paymentDate, "تاريخ الدفع");
  const replayed = await withTx(async (tx) => {
    // ترتيب d83 الحاكم: خزائن الفروع (كلها بترتيب ثابت) → المالك SHARE → رأس المسيّر → الالتزامات.
    const [preview] = await tx
      .select()
      .from(payrollRuns)
      .where(eq(payrollRuns.id, id))
      .limit(1);
    if (!preview) {
      throw new TRPCError({ code: "NOT_FOUND", message: "المسيّر غير موجود" });
    }
    if (preview.status === "paid") {
      await assertPayrollActiveOwnerChecker(
        tx,
        actor,
        [preview.createdBy],
        "التحقق من دفع الراتب المحفوظ",
      );
      const [locked] = await tx
        .select()
        .from(payrollRuns)
        .where(eq(payrollRuns.id, id))
        .for("update")
        .limit(1);
      if (locked?.status === "paid") {
        await assertSalaryRetry(
          tx,
          locked,
          method,
          referenceNumber,
          paymentYmd,
          payment,
        );
        return true;
      }
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تغيّرت حالة المسيّر أثناء التحقق من الدفع المحفوظ",
          why: "أُعيد راتب أو تغيّرت حالة الدفع منذ المعاينة",
          doThis:
            "حدّث المسيّر وراجع المستحق ومصدر الصرف ثم أعد المحاولة صراحةً",
        }),
      });
    }
    const previewObligations = await tx
      .select({
        branchId: payrollObligations.branchIdSnapshot,
        remainingAmount: payrollObligations.remainingAmount,
      })
      .from(payrollObligations)
      .where(
        and(
          eq(payrollObligations.runId, id),
          eq(payrollObligations.revisionNo, Number(preview.revisionNo)),
          eq(payrollObligations.kind, "SALARY_NET"),
        ),
      );
    const branchIds = Array.from(
      new Set(
        previewObligations
          .filter((row) =>
            method === "CASH"
              ? money(row.remainingAmount)
                  .div(250)
                  .toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
                  .mul(250)
                  .gt(0)
              : money(row.remainingAmount).gt(0),
          )
          .map((row) => row.branchId)
          .filter((branchId): branchId is number => branchId != null)
          .map(Number),
      ),
    );
    const cashBucket =
      method === "CASH" ? (payment.cashBucket ?? "TREASURY") : null;
    let shiftRow: typeof shifts.$inferSelect | null = null;
    let approval: Awaited<
      ReturnType<typeof authorizeExternalTreasuryDisbursement>
    > | null = null;
    if (branchIds.length > 0 && method === "CASH") {
      if (cashBucket === "DRAWER") {
        if (payment.shiftId == null) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: appErrorMessage({
              what: "تعذّر صرف الرواتب من الدرج",
              why: "معرّف الوردية (shiftId) إلزامي عند صرف الرواتب من درج نقطة البيع",
              doThis: "اختر وردية مفتوحة حالياً للصرف منها",
            }),
          });
        }
        const [foundShift] = await tx
          .select()
          .from(shifts)
          .where(eq(shifts.id, Number(payment.shiftId)))
          .for("update")
          .limit(1);
        if (!foundShift) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: appErrorMessage({
              what: "تعذّر صرف الرواتب من الدرج",
              why: "وردية الصرف المحددة غير مسجلة في قاعدة البيانات",
              doThis: "تحقّق من رقم الوردية وأعد المحاولة",
            }),
          });
        }
        if (foundShift.status !== "OPEN") {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: appErrorMessage({
              what: "تعذّر صرف الرواتب من الدرج",
              why: "الوردية المحددة مغلقة",
              doThis: "اختر وردية مفتوحة حالياً للصرف منها",
            }),
          });
        }
        if (branchIds.some((b) => b !== Number(foundShift.branchId))) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: appErrorMessage({
              what: "تعذّر صرف الرواتب من درج الوردية",
              why: "المسيّر يضم موظفين من فروع مختلفة عن فرع هذه الوردية",
              doThis:
                "اصرف من الخزينة الرئيسية أو أنشئ مسيّراً منفصلاً لكل فرع",
            }),
          });
        }
        shiftRow = foundShift;
        await assertPayrollActiveOwnerChecker(
          tx,
          actor,
          [preview.createdBy],
          "صرف صافي مسيّر الرواتب من الدرج",
        );
      } else {
        approval = await authorizeExternalTreasuryDisbursement(tx, {
          actor,
          makerUserIds: [preview.createdBy],
          branchIds,
          operation: "صرف صافي مسيّر الرواتب",
        });
      }
    } else {
      // صافي صفر صحيح: لا إيصال ولا قيد دفع، لكن لا نتجاوز فصل المهام.
      await assertPayrollActiveOwnerChecker(
        tx,
        actor,
        [preview.createdBy],
        "إقفال مسيّر راتبه الصافي صفر",
      );
    }

    const [run] = await tx
      .select()
      .from(payrollRuns)
      .where(eq(payrollRuns.id, id))
      .for("update")
      .limit(1);
    if (!run) {
      throw new TRPCError({ code: "NOT_FOUND", message: "المسيّر غير موجود" });
    }
    if (run.status !== "approved" && run.status !== "paid") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "يُدفع المسيّر بعد اعتماده الاستحقاقي فقط.",
      });
    }
    if (run.status === "approved") {
      await assertCommissionArtifactReadyForPayrollTx(tx, run.period);
    }
    if (
      run.createdBy !== preview.createdBy ||
      run.revisionNo !== preview.revisionNo
    ) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "تغيّر المسيّر أثناء اعتماد الدفع — أعد المحاولة.",
      });
    }
    if (!run.accrualDate || paymentYmd < String(run.accrualDate)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "تاريخ الدفع لا يسبق تاريخ استحقاق المسيّر.",
      });
    }
    const obligations = await tx
      .select({
        obligation: payrollObligations,
        firstName: employees.firstName,
        fatherName: employees.fatherName,
        grandfatherName: employees.grandfatherName,
        lastName: employees.lastName,
      })
      .from(payrollObligations)
      .leftJoin(employees, eq(payrollObligations.employeeId, employees.id))
      .where(
        and(
          eq(payrollObligations.runId, id),
          eq(payrollObligations.revisionNo, Number(run.revisionNo)),
          eq(payrollObligations.kind, "SALARY_NET"),
        ),
      )
      .orderBy(
        asc(payrollObligations.branchIdSnapshot),
        asc(payrollObligations.id),
      )
      .for("update");
    const originalTotal = obligations.reduce(
      (sum, row) => sum.plus(money(row.obligation.originalAmount)),
      money(0),
    );
    if (!round2(originalTotal).eq(round2(money(run.totalNet)))) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "رصيد التزامات صافي الرواتب لا يطابق إجمالي المسيّر.",
      });
    }
    for (const { obligation } of obligations) {
      const original = money(obligation.originalAmount);
      const remaining = money(obligation.remainingAmount);
      if (remaining.isNegative() || remaining.gt(original)) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "رصيد التزام الراتب خارج حدود أصله.",
        });
      }
    }
    const payable = obligations.filter(({ obligation }) =>
      money(obligation.remainingAmount).gt(0),
    );
    if (run.status === "paid" && payable.length === 0) {
      await assertSalaryRetry(
        tx,
        run,
        method,
        referenceNumber,
        paymentYmd,
        payment,
      );
      return true;
    }
    const byBranch = new Map<number, Decimal>();
    for (const { obligation } of payable) {
      if (obligation.branchIdSnapshot == null) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "التزام راتب بلا لقطة فرع.",
        });
      }
      const branchId = Number(obligation.branchIdSnapshot);
      const rawAmount = money(obligation.remainingAmount);
      const payableAmount =
        method === "CASH"
          ? rawAmount
              .div(250)
              .toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
              .mul(250)
          : rawAmount;
      if (payableAmount.isZero()) continue;
      byBranch.set(
        branchId,
        (byBranch.get(branchId) ?? money(0)).plus(payableAmount),
      );
    }
    if (method === "CASH") {
      if (cashBucket === "DRAWER") {
        for (const [branchId, amount] of Array.from(byBranch.entries()).sort(
          ([left], [right]) => left - right,
        )) {
          await assertCashOutAvailable(tx, {
            branchId,
            shiftId: shiftRow!.id,
            cashBucket: "DRAWER",
            amount,
            operation: "صرف صافي مسيّر الرواتب من الدرج",
          });
        }
      } else {
        if (!approval && byBranch.size > 0) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "إثبات اعتماد صرف الرواتب مفقود.",
          });
        }
        for (const [branchId, amount] of Array.from(byBranch.entries()).sort(
          ([left], [right]) => left - right,
        )) {
          await assertApprovedTreasuryOutAvailable(
            tx,
            { branchId, amount, operation: "صرف صافي مسيّر الرواتب" },
            approval!,
          );
        }
      }
    }

    const priorEvents = await tx
      .select({ id: payrollAccountingEvents.id })
      .from(payrollAccountingEvents)
      .where(
        and(
          eq(payrollAccountingEvents.runId, id),
          eq(payrollAccountingEvents.eventKind, "SALARY_PAYMENT"),
        ),
      )
      .orderBy(asc(payrollAccountingEvents.id));
    const batchId = payrollHash({
      runId: id,
      revisionNo: run.revisionNo,
      priorEvents: priorEvents.map((row) => row.id),
      obligations: payable.map((row) => row.obligation.id),
    });
    const occurredAt = new Date(`${paymentYmd}T12:00:00.000Z`);
    for (const row of payable) {
      const obligation = row.obligation;
      const rawAmount = money(obligation.remainingAmount);
      const isCash = method === "CASH";
      const amount = isCash
        ? rawAmount.div(250).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).mul(250)
        : rawAmount;
      const variance = amount.minus(rawAmount);
      const branchId = Number(obligation.branchIdSnapshot);
      const employeeName =
        fullEmployeeName(row as never) || `موظف #${obligation.employeeId}`;
      const descVariance =
        isCash && !variance.isZero()
          ? ` (تقريب نقد 250 د.ع: الفرق ${variance.gt(0) ? "+" : ""}${variance.toString()} د.ع عن المستحق ${rawAmount.toString()})`
          : "";
      const noteVariance =
        isCash && !variance.isZero()
          ? `تقريب نقد لأقرب 250 د.ع: المستحق=${rawAmount.toString()}، المدفوع=${amount.toString()}، الفارق=${variance.toString()}`
          : null;
      const receiptResult = amount.gt(0)
        ? await tx.insert(receipts).values({
            branchId,
            shiftId: cashBucket === "DRAWER" ? shiftRow!.id : null,
            cashBucket,
            direction: "OUT",
            amount: toDbMoney(amount),
            paymentMethod: method,
            referenceNumber,
            cardLastFour: method === "CARD" ? referenceNumber : null,
            status: "COMPLETED",
            approvalStatus: "APPROVED",
            approvedBy: actor.userId,
            approvedAt: new Date(),
            partyType: "OTHER",
            partyId: null,
            counterpartyName: employeeName,
            voucherDate: new Date(`${paymentYmd}T00:00:00.000Z`),
            description: `صافي راتب ${employeeName} — مسيّر ${run.period}${descVariance}`,
            internalNote: noteVariance,
            createdBy: actor.userId,
          })
        : null;
      const receiptId = receiptResult ? extractInsertId(receiptResult) : null;
      const attempt = await tx
        .select({ id: payrollAccountingEvents.id })
        .from(payrollAccountingEvents)
        .innerJoin(
          payrollObligations,
          eq(payrollAccountingEvents.obligationId, payrollObligations.id),
        )
        .where(
          and(
            eq(payrollAccountingEvents.runId, id),
            eq(payrollAccountingEvents.eventKind, "SALARY_PAYMENT"),
            eq(payrollObligations.employeeId, Number(obligation.employeeId)),
          ),
        )
        .orderBy(asc(payrollAccountingEvents.id))
        .for("update");
      const sourceKey = payrollSalaryPaymentSourceKey(
        id,
        Number(obligation.employeeId),
        attempt.length,
      );
      const posting = payrollSettlementPosting({
        kind: "SALARY",
        direction: "OUT",
        paymentMethod: method,
        amount,
        entitlementAmount: rawAmount,
        cashBucket,
      });
      const settlementEvidence: SalarySettlementEvidence = {
        version: 2,
        kind: "SALARY_PAYMENT",
        sourceKey,
        batchId,
        obligationId: Number(obligation.id),
        obligationSourceKey: obligation.sourceKey,
        runId: id,
        employeeId: Number(obligation.employeeId),
        branchId,
        revisionNo: Number(run.revisionNo),
        approvalSnapshotHash: run.approvalSnapshotHash!,
        entitlementSettled: rawAmount.toFixed(2),
        actualPayout: amount.toFixed(2),
        signedDifference: variance.toFixed(2),
        roundingRule: method === "CASH" ? "IQD_250_HALF_UP_V1" : "EXACT_V1",
        classification: variance.isZero() ? "EXACT" : "ROUNDING_DIFF",
        method,
        cashBucket,
        shiftId: cashBucket === "DRAWER" ? (payment.shiftId ?? null) : null,
        referenceNumber,
        paymentYmd,
        postingProfile: "PAYMENT_OUT_PAYROLL_NET",
        components: salaryEvidenceComponents(posting.source),
      };
      readSalarySettlementEvidence(settlementEvidence);
      const event = await postPayrollAccountingEvent(tx, {
        runId: id,
        obligationId: Number(obligation.id),
        branchId,
        revisionNo: Number(run.revisionNo),
        eventKind: "SALARY_PAYMENT",
        receiptId,
        sourceKey,
        sourceHashPayload: settlementEvidence,
        settlementEvidence,
        occurredAt,
        actorUserId: actor.userId,
        entryType: posting.entryType,
        amount,
        paymentMethod: method,
        postingIntent: posting.intent,
        postingSourceComponents: posting.source,
        notes: `صرف صافي راتب — مسيّر ${run.period} — ${employeeName}`,
      });
      await tx.insert(payrollObligationAllocations).values({
        obligationId: Number(obligation.id),
        accountingEventId: event.eventId,
        direction: "APPLY",
        amount: toDbMoney(obligation.remainingAmount),
        sourceKey: `PAYROLL:ALLOC:${sourceKey}`,
        occurredAt,
        createdBy: actor.userId,
      });
      await tx
        .update(payrollObligations)
        .set({ remainingAmount: "0.00", status: "SETTLED" })
        .where(eq(payrollObligations.id, Number(obligation.id)));
    }
    await tx
      .update(payrollRuns)
      .set({ status: "paid", paidAt: new Date(), paidBy: actor.userId })
      .where(eq(payrollRuns.id, id));

    // GAP-03: تحديث حالة المكافآت الفورية المرتبطة بالمسير إلى PAID
    await tx
      .update(employeeSpotBonuses)
      .set({ status: "PAID", paidAt: new Date() })
      .where(eq(employeeSpotBonuses.payrollRunId, id));
    return false;
  });
  const run = await getRun(id);
  return { ...run, replayed };
}

export async function returnSalaryPayment(
  input: PayrollReturnInput,
  actor: Actor,
) {
  const returnedYmd = actualDate(input.returnedAt, "تاريخ إعادة الراتب");
  const reason = input.reason.trim();
  if (reason.length < 5 || reason.length > 255) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "سبب إعادة الراتب مطلوب (من 5 إلى 255 حرفاً).",
    });
  }
  return withTx(async (tx) => {
    const [returnPreview] = await tx
      .select({ id: payrollAccountingEvents.id })
      .from(payrollAccountingEvents)
      .where(eq(payrollAccountingEvents.reversalOfId, input.accountingEventId))
      .limit(1);
    const [cashPreview] = await tx
      .select({
        paymentMethod: receipts.paymentMethod,
        amount: receipts.amount,
        branchId: payrollObligations.branchIdSnapshot,
      })
      .from(payrollAccountingEvents)
      .leftJoin(receipts, eq(payrollAccountingEvents.receiptId, receipts.id))
      .innerJoin(
        payrollObligations,
        eq(payrollAccountingEvents.obligationId, payrollObligations.id),
      )
      .where(eq(payrollAccountingEvents.id, input.accountingEventId))
      .limit(1);
    let prelockedCashBranchId: number | null = null;
    if (
      !returnPreview &&
      cashPreview?.paymentMethod === "CASH" &&
      money(cashPreview.amount ?? 0).gt(0)
    ) {
      prelockedCashBranchId = Number(cashPreview.branchId);
      await lockMaterializedCashReceiptSourceForWrite(tx, {
        branchId: prelockedCashBranchId,
        shiftId: null,
        cashBucket: "TREASURY",
        paymentMethod: "CASH",
        status: "COMPLETED",
        approvalStatus: "APPROVED",
      });
    }
    const [original] = await tx
      .select({
        event: payrollAccountingEvents,
        receipt: receipts,
        obligation: payrollObligations,
        run: payrollRuns,
      })
      .from(payrollAccountingEvents)
      .leftJoin(receipts, eq(payrollAccountingEvents.receiptId, receipts.id))
      .innerJoin(
        payrollObligations,
        eq(payrollAccountingEvents.obligationId, payrollObligations.id),
      )
      .innerJoin(payrollRuns, eq(payrollAccountingEvents.runId, payrollRuns.id))
      .where(eq(payrollAccountingEvents.id, input.accountingEventId))
      .for("update")
      .limit(1);
    if (!original || original.event.eventKind !== "SALARY_PAYMENT") {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "حدث دفع الراتب غير موجود.",
      });
    }
    await assertPayrollActiveOwnerChecker(
      tx,
      actor,
      [original.event.createdBy],
      "إعادة راتب مدفوع",
    );
    const savedEvidence = readSalarySettlementEvidence(
      original.event.settlementEvidence,
      original.event.sourceHash,
    );
    if (!savedEvidence && !original.receipt)
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "دليل دفع الراتب التاريخي مفقود.",
          why: "دليل المصدر المحفوظ لا يحقق عقد تسوية الراتب",
          doThis: "راجع الحدث والتخصيص الأصليين مع المحاسب قبل إعادة المحاولة",
        }),
      });
    const actualPayout =
      savedEvidence?.actualPayout ?? original.receipt!.amount;
    if (
      !savedEvidence &&
      (money(actualPayout).isZero() ||
        payrollHash({
          kind: "SALARY_PAYMENT",
          obligationSourceKey: original.obligation.sourceKey,
          amount: money(actualPayout).toFixed(2),
          method: original.receipt!.paymentMethod,
          referenceNumber: original.receipt!.referenceNumber?.trim() || null,
          paymentYmd: toDateStr(
            new Date(
              original.receipt!.voucherDate ?? original.receipt!.createdAt,
            ),
          ),
        }) !== original.event.sourceHash)
    ) {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "دليل دفع الراتب التاريخي لا يدعم عكساً آمناً؛ راجع الأصل والتخصيص دون إنشاء صرف جديد.",
          why: "دليل المصدر المحفوظ لا يحقق عقد تسوية الراتب",
          doThis: "راجع الحدث والتخصيص الأصليين مع المحاسب قبل إعادة المحاولة",
        }),
      });
    }
    if (
      savedEvidence &&
      (savedEvidence.kind !== "SALARY_PAYMENT" ||
        savedEvidence.sourceKey !== original.event.sourceKey ||
        savedEvidence.obligationId !== original.obligation.id ||
        savedEvidence.obligationSourceKey !== original.obligation.sourceKey ||
        savedEvidence.runId !== original.run.id ||
        savedEvidence.revisionNo !== original.event.revisionNo ||
        savedEvidence.approvalSnapshotHash !==
          original.run.approvalSnapshotHash)
    ) {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "دليل تسوية الراتب لا يطابق المستند الأصلي.",
          why: "دليل المصدر المحفوظ لا يحقق عقد تسوية الراتب",
          doThis: "راجع الحدث والتخصيص الأصليين مع المحاسب قبل إعادة المحاولة",
        }),
      });
    }
    const method = supportedReceiptMethod(
      savedEvidence?.method ?? original.receipt!.paymentMethod,
    );
    if (
      method === "CASH" &&
      money(actualPayout).gt(0) &&
      prelockedCashBranchId !== Number(original.obligation.branchIdSnapshot) &&
      !returnPreview
    ) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "تغيّر مصدر إعادة الراتب أثناء قفل النقد؛ أعد المحاولة.",
      });
    }
    const referenceNumber = assertPayrollPaymentEvidence(
      method,
      input.referenceNumber ??
        savedEvidence?.referenceNumber ??
        original.receipt?.referenceNumber,
    );
    const [allocation] = await tx
      .select()
      .from(payrollObligationAllocations)
      .where(
        and(
          eq(
            payrollObligationAllocations.accountingEventId,
            Number(original.event.id),
          ),
          eq(payrollObligationAllocations.direction, "APPLY"),
        ),
      )
      .for("update")
      .limit(1);
    if (!allocation) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "تخصيص دفع الراتب مفقود؛ لا يمكن عكسه.",
      });
    }
    if (
      savedEvidence &&
      !money(savedEvidence.entitlementSettled).eq(allocation.amount)
    ) {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تخصيص تسوية الراتب لا يطابق المستحق المحفوظ.",
          why: "دليل المصدر المحفوظ لا يحقق عقد تسوية الراتب",
          doThis: "راجع الحدث والتخصيص الأصليين مع المحاسب قبل إعادة المحاولة",
        }),
      });
    }
    const legacyReturnPayload = {
      kind: "SALARY_PAYMENT_RETURN",
      originalSourceHash: original.event.sourceHash,
      amount: money(actualPayout).toFixed(2),
      method,
      referenceNumber,
      returnedYmd,
      reason,
    };
    const posting = payrollSettlementPosting({
      kind: "SALARY",
      direction: "IN",
      paymentMethod: method,
      amount: money(actualPayout),
      entitlementAmount: savedEvidence
        ? money(savedEvidence.entitlementSettled)
        : undefined,
    });
    const sourceKey = `PAYROLL:NET-RETURN:${Number(original.event.id)}`;
    const returnEvidence: SalarySettlementEvidence | null = savedEvidence
      ? {
          ...savedEvidence,
          kind: "SALARY_PAYMENT_RETURN",
          sourceKey,
          reason,
          originalSourceHash: original.event.sourceHash,
          cashBucket: method === "CASH" ? "TREASURY" : null,
          shiftId: null,
          referenceNumber,
          paymentYmd: returnedYmd,
          postingProfile: "PAYMENT_IN_PAYROLL_NET_RETURN",
          components: salaryEvidenceComponents(posting.source),
        }
      : null;
    const replayHash = payrollHash(returnEvidence ?? legacyReturnPayload);
    if (returnEvidence)
      readSalarySettlementEvidence(returnEvidence, replayHash);
    const [existingReturn] = await tx
      .select({
        id: payrollAccountingEvents.id,
        sourceHash: payrollAccountingEvents.sourceHash,
        settlementEvidence: payrollAccountingEvents.settlementEvidence,
        event: payrollAccountingEvents,
        receipt: receipts,
        allocation: payrollObligationAllocations,
      })
      .from(payrollAccountingEvents)
      .leftJoin(receipts, eq(payrollAccountingEvents.receiptId, receipts.id))
      .leftJoin(
        payrollObligationAllocations,
        and(
          eq(
            payrollObligationAllocations.accountingEventId,
            payrollAccountingEvents.id,
          ),
          eq(payrollObligationAllocations.direction, "REVERSE"),
        ),
      )
      .where(
        eq(payrollAccountingEvents.reversalOfId, Number(original.event.id)),
      )
      .for("update")
      .limit(1);
    assertSalaryReceiptEvidence(savedEvidence, {
      ...original,
      reversed: existingReturn != null,
    });
    if (existingReturn) {
      const existingEvidence = readSalarySettlementEvidence(
        existingReturn.settlementEvidence,
        existingReturn.sourceHash,
      );
      assertSalaryReceiptEvidence(existingEvidence, {
        ...existingReturn,
        obligation: original.obligation,
        reversed: false,
      });
      if (
        !existingReturn.allocation ||
        existingReturn.allocation.reversalOfId !== allocation.id ||
        existingReturn.allocation.obligationId !== allocation.obligationId ||
        !money(existingReturn.allocation.amount).eq(allocation.amount)
      ) {
        throw new TRPCError({
          code: "CONFLICT",
          message: appErrorMessage({
            what: "تخصيص إعادة الراتب لا يطابق الأصل",
            why: "رابط العكس أو المبلغ المحفوظ غير متطابق",
            doThis: "راجع التخصيص الأصلي مع المحاسب",
          }),
        });
      }
      if (existingReturn.sourceHash !== replayHash) {
        throw new TRPCError({
          code: "CONFLICT",
          message:
            "محاولة إعادة دفع الراتب لا تطابق السبب أو التاريخ أو الدليل المحفوظ.",
        });
      }
      const salaryObligations = await tx
        .select({ remaining: payrollObligations.remainingAmount })
        .from(payrollObligations)
        .where(
          and(
            eq(payrollObligations.runId, Number(original.run.id)),
            eq(payrollObligations.revisionNo, Number(original.run.revisionNo)),
            eq(payrollObligations.kind, "SALARY_NET"),
          ),
        );
      if (
        salaryObligations.some((obligation) =>
          money(obligation.remaining).gt(0),
        )
      ) {
        await tx
          .update(payrollRuns)
          .set({ status: "approved", paidAt: null, paidBy: null })
          .where(eq(payrollRuns.id, Number(original.run.id)));
      }
      return { replayed: true, eventId: Number(existingReturn.id) };
    }
    if (original.receipt && original.receipt.status !== "COMPLETED") {
      throw new TRPCError({
        code: "CONFLICT",
        message: "إيصال دفع الراتب سبق عكسه أو ليس مكتملاً.",
      });
    }
    const originalYmd =
      savedEvidence?.paymentYmd ??
      toDateStr(
        new Date(original.receipt!.voucherDate ?? original.receipt!.createdAt),
      );
    if (returnedYmd < originalYmd) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "تاريخ إعادة الراتب لا يسبق تاريخ دفعه.",
      });
    }
    const receiptAmount = money(actualPayout);
    const branchId = Number(original.obligation.branchIdSnapshot);
    const receiptResult = receiptAmount.gt(0)
      ? await tx.insert(receipts).values({
          branchId,
          shiftId: null,
          cashBucket: method === "CASH" ? "TREASURY" : null,
          direction: "IN",
          amount: toDbMoney(receiptAmount),
          paymentMethod: method,
          referenceNumber,
          cardLastFour: method === "CARD" ? referenceNumber : null,
          status: "COMPLETED",
          approvalStatus: "APPROVED",
          approvedBy: actor.userId,
          approvedAt: new Date(),
          partyType: "OTHER",
          partyId: null,
          counterpartyName:
            original.receipt?.counterpartyName ??
            `موظف #${original.obligation.employeeId}`,
          voucherDate: new Date(`${returnedYmd}T00:00:00.000Z`),
          description: `إعادة راتب مدفوع — مسيّر ${original.run.period}`,
          createdBy: actor.userId,
        })
      : null;
    const receiptId = receiptResult ? extractInsertId(receiptResult) : null;
    const occurredAt = new Date(`${returnedYmd}T12:00:00.000Z`);
    const event = await postPayrollAccountingEvent(tx, {
      runId: Number(original.run.id),
      obligationId: Number(original.obligation.id),
      branchId,
      revisionNo: Number(original.event.revisionNo),
      eventKind: "SALARY_PAYMENT_RETURN",
      receiptId,
      reversalOfId: Number(original.event.id),
      sourceKey,
      settlementEvidence: returnEvidence,
      sourceHashPayload: returnEvidence ?? legacyReturnPayload,
      occurredAt,
      actorUserId: actor.userId,
      entryType: posting.entryType,
      amount: receiptAmount,
      paymentMethod: method,
      postingIntent: posting.intent,
      postingSourceComponents: posting.source,
      notes: `إعادة راتب مدفوع — مسيّر ${original.run.period} — السبب: ${reason}`,
    });
    const obligationRestoredAmount = money(allocation.amount);
    await tx.insert(payrollObligationAllocations).values({
      obligationId: Number(original.obligation.id),
      accountingEventId: event.eventId,
      direction: "REVERSE",
      amount: toDbMoney(obligationRestoredAmount),
      reversalOfId: Number(allocation.id),
      sourceKey: `PAYROLL:ALLOC:${sourceKey}`,
      occurredAt,
      createdBy: actor.userId,
    });
    const remaining = round2(
      money(original.obligation.remainingAmount).plus(obligationRestoredAmount),
    );
    if (remaining.gt(money(original.obligation.originalAmount))) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "إعادة الراتب تتجاوز أصل الالتزام.",
      });
    }
    await tx
      .update(payrollObligations)
      .set({
        remainingAmount: toDbMoney(remaining),
        status: remaining.eq(money(original.obligation.originalAmount))
          ? "OPEN"
          : "PARTIAL",
      })
      .where(eq(payrollObligations.id, Number(original.obligation.id)));
    if (original.receipt)
      await tx
        .update(receipts)
        .set({ status: "REVERSED" })
        .where(eq(receipts.id, original.receipt.id));

    const salaryObligations = await tx
      .select({
        original: payrollObligations.originalAmount,
        remaining: payrollObligations.remainingAmount,
      })
      .from(payrollObligations)
      .where(
        and(
          eq(payrollObligations.runId, Number(original.run.id)),
          eq(payrollObligations.revisionNo, Number(original.run.revisionNo)),
          eq(payrollObligations.kind, "SALARY_NET"),
        ),
      );
    const allReturned = salaryObligations.every((obligation) =>
      money(obligation.original).eq(money(obligation.remaining)),
    );
    // A run is paid only while every current salary obligation is settled.
    // Returning one employee's payment therefore reopens the run immediately.
    await tx
      .update(payrollRuns)
      .set({ status: "approved", paidAt: null, paidBy: null })
      .where(eq(payrollRuns.id, Number(original.run.id)));
    return {
      replayed: false,
      eventId: event.eventId,
      receiptId,
      runId: Number(original.run.id),
      allReturned,
    };
  });
}
