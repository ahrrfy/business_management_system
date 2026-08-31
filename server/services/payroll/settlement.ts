import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { fullEmployeeName } from "@shared/hr";
import {
  employees,
  payrollAccountingEvents,
  payrollObligationAllocations,
  payrollObligations,
  payrollRuns,
  receipts,
  users,
} from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import {
  assertApprovedTreasuryOutAvailable,
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

export async function assertPayrollActiveOwnerChecker(
  tx: Tx,
  actor: Actor,
  forbiddenUserIds: Array<number | null | undefined>,
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
  if (
    forbiddenUserIds
      .filter((id): id is number => id != null)
      .map(Number)
      .includes(Number(owner.id))
  ) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `${operation}: يلزم منفّذ مستقل عن صانع العملية الأصلية.`,
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

export async function payRun(
  id: number,
  actor: Actor,
  payment: PayrollPaymentInput = {},
) {
  const method = payment.paymentMethod ?? "CASH";
  const referenceNumber = assertPayrollPaymentEvidence(method, payment.referenceNumber);
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
          .filter((row) => money(row.remainingAmount).gt(0))
          .map((row) => row.branchId)
          .filter((branchId): branchId is number => branchId != null)
          .map(Number),
      ),
    );
    let approval: Awaited<ReturnType<typeof authorizeExternalTreasuryDisbursement>> | null = null;
    if (branchIds.length > 0 && method === "CASH") {
      approval = await authorizeExternalTreasuryDisbursement(tx, {
        actor,
        makerUserIds: [preview.createdBy],
        branchIds,
        operation: "صرف صافي مسيّر الرواتب",
      });
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
    if (run.createdBy !== preview.createdBy || run.revisionNo !== preview.revisionNo) {
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
      .orderBy(asc(payrollObligations.branchIdSnapshot), asc(payrollObligations.id))
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
      if (money(run.totalNet).isZero()) return true;
      const [latestPayment] = await tx
        .select({
          paymentMethod: receipts.paymentMethod,
          referenceNumber: receipts.referenceNumber,
          voucherYmd: sql<string>`DATE_FORMAT(${receipts.voucherDate}, '%Y-%m-%d')`,
          status: receipts.status,
        })
        .from(payrollAccountingEvents)
        .innerJoin(receipts, eq(payrollAccountingEvents.receiptId, receipts.id))
        .where(and(
          eq(payrollAccountingEvents.runId, id),
          eq(payrollAccountingEvents.revisionNo, Number(run.revisionNo)),
          eq(payrollAccountingEvents.eventKind, "SALARY_PAYMENT"),
        ))
        .orderBy(desc(payrollAccountingEvents.id))
        .for("update")
        .limit(1);
      if (
        !latestPayment || latestPayment.status !== "COMPLETED" ||
        latestPayment.paymentMethod !== method ||
        (latestPayment.referenceNumber?.trim() || null) !== referenceNumber ||
        latestPayment.voucherYmd !== paymentYmd
      ) {
        throw new TRPCError({ code: "CONFLICT", message: "إعادة محاولة دفع المسيّر لا تطابق دليل آخر دفعة محفوظة." });
      }
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
      byBranch.set(
        branchId,
        (byBranch.get(branchId) ?? money(0)).plus(
          money(obligation.remainingAmount),
        ),
      );
    }
    if (method === "CASH") {
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

    const occurredAt = new Date(`${paymentYmd}T12:00:00.000Z`);
    for (const row of payable) {
      const obligation = row.obligation;
      const amount = money(obligation.remainingAmount);
      const branchId = Number(obligation.branchIdSnapshot);
      const employeeName = fullEmployeeName(row as never) || `موظف #${obligation.employeeId}`;
      const receiptResult = await tx.insert(receipts).values({
        branchId,
        shiftId: null,
        cashBucket: method === "CASH" ? "TREASURY" : null,
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
        description: `صافي راتب ${employeeName} — مسيّر ${run.period}`,
        createdBy: actor.userId,
      });
      const receiptId = extractInsertId(receiptResult);
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
      });
      const event = await postPayrollAccountingEvent(tx, {
        runId: id,
        obligationId: Number(obligation.id),
        branchId,
        revisionNo: Number(run.revisionNo),
        eventKind: "SALARY_PAYMENT",
        receiptId,
        sourceKey,
        sourceHashPayload: {
          kind: "SALARY_PAYMENT",
          obligationSourceKey: obligation.sourceKey,
          amount: amount.toFixed(2),
          method,
          referenceNumber,
          paymentYmd,
        },
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
        amount: toDbMoney(amount),
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
        branchId: payrollObligations.branchIdSnapshot,
      })
      .from(payrollAccountingEvents)
      .innerJoin(receipts, eq(payrollAccountingEvents.receiptId, receipts.id))
      .innerJoin(
        payrollObligations,
        eq(payrollAccountingEvents.obligationId, payrollObligations.id),
      )
      .where(eq(payrollAccountingEvents.id, input.accountingEventId))
      .limit(1);
    let prelockedCashBranchId: number | null = null;
    if (!returnPreview && cashPreview?.paymentMethod === "CASH") {
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
      .innerJoin(receipts, eq(payrollAccountingEvents.receiptId, receipts.id))
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
    const method = supportedReceiptMethod(original.receipt.paymentMethod);
    if (
      method === "CASH" &&
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
      input.referenceNumber ?? original.receipt.referenceNumber,
    );
    const replayHash = payrollHash({
      kind: "SALARY_PAYMENT_RETURN",
      originalSourceHash: original.event.sourceHash,
      amount: money(original.receipt.amount).toFixed(2),
      method,
      referenceNumber,
      returnedYmd,
      reason,
    });
    const [existingReturn] = await tx
      .select({ id: payrollAccountingEvents.id, sourceHash: payrollAccountingEvents.sourceHash })
      .from(payrollAccountingEvents)
      .where(eq(payrollAccountingEvents.reversalOfId, Number(original.event.id)))
      .limit(1);
    if (existingReturn) {
      if (existingReturn.sourceHash !== replayHash) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "محاولة إعادة دفع الراتب لا تطابق السبب أو التاريخ أو الدليل المحفوظ.",
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
      if (salaryObligations.some((obligation) => money(obligation.remaining).gt(0))) {
        await tx
          .update(payrollRuns)
          .set({ status: "approved", paidAt: null, paidBy: null })
          .where(eq(payrollRuns.id, Number(original.run.id)));
      }
      return { replayed: true, eventId: Number(existingReturn.id) };
    }
    if (original.receipt.status !== "COMPLETED") {
      throw new TRPCError({
        code: "CONFLICT",
        message: "إيصال دفع الراتب سبق عكسه أو ليس مكتملاً.",
      });
    }
    const originalYmd = original.receipt.voucherDate
      ? toDateStr(new Date(original.receipt.voucherDate))
      : toDateStr(new Date(original.receipt.createdAt));
    if (returnedYmd < originalYmd) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "تاريخ إعادة الراتب لا يسبق تاريخ دفعه.",
      });
    }
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
    const amount = money(allocation.amount);
    const branchId = Number(original.obligation.branchIdSnapshot);
    const receiptResult = await tx.insert(receipts).values({
      branchId,
      shiftId: null,
      cashBucket: method === "CASH" ? "TREASURY" : null,
      direction: "IN",
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
      counterpartyName: original.receipt.counterpartyName,
      voucherDate: new Date(`${returnedYmd}T00:00:00.000Z`),
      description: `إعادة راتب مدفوع — مسيّر ${original.run.period}`,
      createdBy: actor.userId,
    });
    const receiptId = extractInsertId(receiptResult);
    const occurredAt = new Date(`${returnedYmd}T12:00:00.000Z`);
    const posting = payrollSettlementPosting({
      kind: "SALARY",
      direction: "IN",
      paymentMethod: method,
      amount,
    });
    const sourceKey = `PAYROLL:NET-RETURN:${Number(original.event.id)}`;
    const event = await postPayrollAccountingEvent(tx, {
      runId: Number(original.run.id),
      obligationId: Number(original.obligation.id),
      branchId,
      revisionNo: Number(original.event.revisionNo),
      eventKind: "SALARY_PAYMENT_RETURN",
      receiptId,
      reversalOfId: Number(original.event.id),
      sourceKey,
      sourceHashPayload: {
        kind: "SALARY_PAYMENT_RETURN",
        originalSourceHash: original.event.sourceHash,
        amount: amount.toFixed(2),
        method,
        referenceNumber,
        returnedYmd,
        reason,
      },
      occurredAt,
      actorUserId: actor.userId,
      entryType: posting.entryType,
      amount,
      paymentMethod: method,
      postingIntent: posting.intent,
      postingSourceComponents: posting.source,
      notes: `إعادة راتب مدفوع — مسيّر ${original.run.period} — السبب: ${reason}`,
    });
    await tx.insert(payrollObligationAllocations).values({
      obligationId: Number(original.obligation.id),
      accountingEventId: event.eventId,
      direction: "REVERSE",
      amount: toDbMoney(amount),
      reversalOfId: Number(allocation.id),
      sourceKey: `PAYROLL:ALLOC:${sourceKey}`,
      occurredAt,
      createdBy: actor.userId,
    });
    const remaining = round2(
      money(original.obligation.remainingAmount).plus(amount),
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
    await tx
      .update(receipts)
      .set({ status: "REVERSED" })
      .where(eq(receipts.id, Number(original.receipt.id)));

    const salaryObligations = await tx
      .select({ original: payrollObligations.originalAmount, remaining: payrollObligations.remainingAmount })
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
