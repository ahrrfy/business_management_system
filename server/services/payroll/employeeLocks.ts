import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { employeeAdvances, employees } from "../../../drizzle/schema";
import type { Tx } from "../../db";

export type PayrollEmployeeMember = {
  sourceId: number;
  employeeId: number | null;
};

export type LockedPayrollEmployee = typeof employees.$inferSelect;
export type LockedPayrollEmployees = Map<number, LockedPayrollEmployee>;

export function payrollEmployeeMembership(
  rows: ReadonlyArray<{ id: number; employeeId: number | null }>,
): PayrollEmployeeMember[] {
  return rows
    .map((row) => ({
      sourceId: Number(row.id),
      employeeId: row.employeeId == null ? null : Number(row.employeeId),
    }))
    .sort(compareMembership);
}

function compareMembership(
  left: PayrollEmployeeMember,
  right: PayrollEmployeeMember,
): number {
  const sourceOrder = left.sourceId - right.sourceId;
  if (sourceOrder !== 0) return sourceOrder;
  if (left.employeeId === right.employeeId) return 0;
  if (left.employeeId === null) return -1;
  if (right.employeeId === null) return 1;
  return left.employeeId - right.employeeId;
}

function conflict(operation: string): TRPCError {
  return new TRPCError({
    code: "CONFLICT",
    message: appErrorMessage({
      what: `تغيّرت عضوية موظفي ${operation} أثناء التنفيذ`,
      why: "بنود العملية الحالية لا تطابق لقطة الموظفين المقفلة",
      doThis: "حدّث بيانات المسيّر وراجع الموظفين المشمولين ثم أعد الإجراء",
    }),
  });
}

/**
 * Employee rows are the aggregate lock shared with employee-advance capacity.
 * Lock only identity rows, in primary-key order, before a payroll-run lock.
 * Historical payroll intentionally does not re-apply active/new-loan eligibility.
 */
export async function lockPayrollEmployeesTx(
  tx: Tx,
  memberships: ReadonlyArray<PayrollEmployeeMember>,
  operation: string,
): Promise<LockedPayrollEmployees> {
  const employeeIds = Array.from(
    new Set(
      memberships
        .map((member) => member.employeeId)
        .filter((employeeId): employeeId is number => employeeId != null),
    ),
  ).sort((left, right) => left - right);
  if (employeeIds.length === 0) return new Map();

  const locked = await tx
    .select()
    .from(employees)
    .where(inArray(employees.id, employeeIds))
    .orderBy(asc(employees.id))
    .for("update");
  if (
    locked.length !== employeeIds.length ||
    locked.some((employee, index) => Number(employee.id) !== employeeIds[index])
  ) {
    throw conflict(operation);
  }
  return new Map(locked.map((employee) => [Number(employee.id), employee]));
}

/**
 * A legacy balance has no proven payroll month, so it must never be silently
 * removed from a draft or paid from an already-approved snapshot. Callers must
 * first lock the complete payroll employee membership in ascending id order.
 */
export async function assertNoLegacyUnclassifiedAdvanceTx(
  tx: Tx,
  lockedEmployees: ReadonlyMap<number, LockedPayrollEmployee>,
  operation: string,
): Promise<void> {
  const employeeIds = Array.from(lockedEmployees.keys()).sort(
    (left, right) => left - right,
  );
  if (employeeIds.length === 0) return;

  const blocked = await tx
    .select({
      id: employeeAdvances.id,
      employeeId: employeeAdvances.employeeId,
      remaining: employeeAdvances.remaining,
    })
    .from(employeeAdvances)
    .where(
      and(
        inArray(employeeAdvances.employeeId, employeeIds),
        eq(employeeAdvances.status, "ACTIVE"),
        eq(employeeAdvances.sourceType, "LEGACY_UNCLASSIFIED"),
        sql`${employeeAdvances.remaining} > 0`,
      ),
    )
    .orderBy(asc(employeeAdvances.id))
    .for("update");
  const [first] = blocked;
  if (!first) return;
  throw new TRPCError({
    code: "PRECONDITION_FAILED",
    message: appErrorMessage({
      what: `لا يمكن ${operation} مع وجود سلفة تاريخية غير مصنفة`,
      why: `السلفة #${first.id} للموظف #${first.employeeId} ما زالت نشطة برصيد ${first.remaining} د.ع ولا تحمل شهراً مثبتاً للخصم`,
      doThis:
        "أكمل المطابقة اليدوية للسلفة بمصدرها الصحيح أو أثبت تسويتها التاريخية، ثم أعد المحاولة",
    }),
  });
}

/**
 * A current locking read must still describe exactly the membership preview
 * whose employees were locked before the payroll run. Never acquire a newly
 * discovered employee after the run lock; fail and restart the user action.
 */
export function assertPayrollEmployeeMembershipStable(
  preview: ReadonlyArray<PayrollEmployeeMember>,
  current: ReadonlyArray<PayrollEmployeeMember>,
  lockedEmployees: ReadonlyMap<number, LockedPayrollEmployee>,
  operation: string,
): void {
  const normalizedPreview = [...preview].sort(compareMembership);
  const normalizedCurrent = [...current].sort(compareMembership);
  if (
    normalizedPreview.length !== normalizedCurrent.length ||
    normalizedCurrent.some(
      (member, index) =>
        member.sourceId !== normalizedPreview[index]?.sourceId ||
        member.employeeId !== normalizedPreview[index]?.employeeId ||
        (member.employeeId !== null &&
          !lockedEmployees.has(member.employeeId)),
    )
  ) {
    throw conflict(operation);
  }
}
