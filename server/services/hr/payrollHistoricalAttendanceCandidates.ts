import { and, eq, inArray, or, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { fullEmployeeName } from "@shared/hr";
import { appErrorMessage } from "@shared/errors";
import { auditLogs, employeeContracts, employeePromotions, employees, payrollRuns } from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { resolveApprovalActor } from "../approval/ownerGate";
import { baghdadToday } from "../businessDay";
import { getActiveLock } from "../periodLockService";
import { requireDb, type Actor } from "../tx";
import { attendanceCorrectionSourceHash, HISTORICAL_ATTENDANCE_CORRECTION } from "./payrollHistoricalAttendanceCorrection";
import { wageProfileDiff, wageProfileOf } from "./wageProfile";

const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;
const WAGE_FIELDS = ["payType", "salary", "allowances", "workSchedule", "dayRates", "attendanceExempt"] as const;

function object(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function completeProfile(value: unknown) {
  const source = object(value);
  if (!source || !WAGE_FIELDS.every((key) => Object.hasOwn(source, key)) ||
      typeof source.attendanceExempt !== "boolean") return null;
  return wageProfileOf(source);
}

export type HistoricalAttendanceCandidate =
  | { kind: "attestable"; employeeId: number; employeeName: string; period: string;
      sourceAuditId: number; sourceHash: string; sourceChangedAt: string;
      beforeExempt: false; afterExempt: true }
  | { kind: "manual_review"; employeeId: number; employeeName: string; period: string; reason: string };

/**
 * An indication of a later change is not proof of the earlier policy. Return
 * unsupported cases for manual review, without authorizing an attestation.
 */
export async function historicalAttendanceCandidatesTx(tx: Tx, period: string, employeeId?: number): Promise<HistoricalAttendanceCandidate[]> {
  if (!PERIOD.test(period) || period < "1000-01" || period >= baghdadToday().slice(0, 7)) return [];
  const [year, month] = period.split("-").map(Number);
  const periodEnd = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  const [run] = await tx.select({ id: payrollRuns.id }).from(payrollRuns)
    .where(eq(payrollRuns.period, period)).limit(1);
  if (run) return [];
  const lock = await getActiveLock(tx);
  if (lock && lock.cutoffDate >= `${period}-01`) return [];
  // Match generatePayroll's period membership; current status alone is not an
  // excuse to hide a potentially relevant historical case.
  const people = await tx.select({
    id: employees.id, firstName: employees.firstName, fatherName: employees.fatherName,
    grandfatherName: employees.grandfatherName, lastName: employees.lastName,
    payType: employees.payType, salary: employees.salary, allowances: employees.allowances,
    workSchedule: employees.workSchedule, dayRates: employees.dayRates,
    attendanceExempt: employees.attendanceExempt, hireDate: employees.hireDate,
    terminationDate: employees.terminationDate, employmentStatus: employees.employmentStatus,
    isActive: employees.isActive,
  }).from(employees).where(and(
    sql`(${employees.hireDate} IS NULL OR ${employees.hireDate} <= ${periodEnd})`,
    sql`(${employees.terminationDate} IS NULL OR ${employees.terminationDate} >= ${`${period}-01`})`,
    sql`(${employees.employmentStatus} <> 'terminated' OR ${employees.terminationDate} IS NOT NULL)`,
    employeeId == null ? undefined : eq(employees.id, employeeId),
  ));
  if (!people.length) return [];
  const ids = people.map((p) => p.id);
  const [contracts, promotions, audits] = await Promise.all([
    tx.select({ employeeId: employeeContracts.employeeId }).from(employeeContracts)
      .where(inArray(employeeContracts.employeeId, ids)),
    tx.select({ employeeId: employeePromotions.employeeId }).from(employeePromotions)
      .where(inArray(employeePromotions.employeeId, ids)),
    tx.select().from(auditLogs).where(and(inArray(auditLogs.entityId, ids.map(String)), or(
      and(eq(auditLogs.action, "employee.update"), eq(auditLogs.entityType, "employee")),
      and(eq(auditLogs.action, HISTORICAL_ATTENDANCE_CORRECTION), eq(auditLogs.entityType, "payrollAttendanceExemption")),
    ))),
  ]);
  const unsupported = new Set([...contracts, ...promotions].map((row) => Number(row.employeeId)));
  const result: HistoricalAttendanceCandidate[] = [];
  for (const person of people) {
    const entries = audits.filter((a) => a.entityId === String(person.id));
    const updates = entries.filter((a) => a.action === "employee.update");
    const signs = updates.filter((source) => {
      const before = object(source.oldValue);
      const after = object(object(source.newValue)?.wage);
      return before?.attendanceExempt === false && after?.attendanceExempt === true &&
        baghdadToday(source.createdAt).slice(0, 7) > period;
    });
    if (!signs.length) continue;
    const corrections = entries.filter((a) => a.action === HISTORICAL_ATTENDANCE_CORRECTION);
    if (corrections.some((a) => object(a.newValue)?.period === period)) continue;
    const manual = (reason: string) => result.push({ kind: "manual_review", employeeId: Number(person.id),
      employeeName: fullEmployeeName(person), period, reason });
    if (corrections.some((a) => {
      const monthValue = object(a.newValue)?.period;
      return typeof monthValue !== "string" || !PERIOD.test(monthValue);
    })) { manual("سجل إقرار سابق غير مكتمل؛ راجع تفاصيله قبل تقرير الإعفاء."); continue; }
    if (unsupported.has(Number(person.id))) {
      manual("توجد عقود أو ترقيات مرتبطة بالموظف؛ راجع سريانها لهذا الشهر.");
      continue;
    }
    if (person.isActive !== true || person.employmentStatus !== "active" ||
        person.payType !== "monthly" || !person.attendanceExempt) {
      manual("حالة الموظف أو طريقة أجره الحالية تحتاج مراجعة لهذه الفترة.");
      continue;
    }
    const wageEvents: Array<{ source: typeof audits[number]; before: NonNullable<ReturnType<typeof completeProfile>>;
      after: NonNullable<ReturnType<typeof completeProfile>> }> = [];
    try {
      let invalid = false;
      for (const source of updates) {
        const afterValue = object(source.newValue)?.wage;
        if (source.oldValue == null && afterValue == null) continue;
        const before = completeProfile(source.oldValue);
        const after = completeProfile(afterValue);
        if (!before || !after) { invalid = true; break; }
        if (wageProfileDiff(before, after).length) wageEvents.push({ source, before, after });
      }
      if (invalid) { manual("سجل تعديل الأجر غير مكتمل؛ راجع ملف الموظف قبل تقرير الإعفاء."); continue; }
      if (wageEvents.length !== 1 || signs.length !== 1) {
        manual("توجد تغييرات أجور أخرى؛ راجع تسلسلها قبل تقرير الإعفاء.");
        continue;
      }
      const { source, before, after } = wageEvents[0];
      const fields = wageProfileDiff(before, after);
      if (source.id !== signs[0].id || fields.length !== 1 || fields[0] !== "attendanceExempt" ||
          before.payType !== "monthly" || after.payType !== "monthly" ||
          JSON.stringify(after) !== JSON.stringify(wageProfileOf(person))) {
        manual("بيانات الأجر الحالية أو سجل التغيير يحتاجان مراجعة قبل تقرير الإعفاء.");
        continue;
      }
      result.push({ kind: "attestable", employeeId: Number(person.id), employeeName: fullEmployeeName(person), period,
        sourceAuditId: Number(source.id), sourceHash: attendanceCorrectionSourceHash(source),
        sourceChangedAt: source.createdAt.toISOString(), beforeExempt: false, afterExempt: true });
    } catch {
      manual("سجل الأجر غير مكتمل أو متعارض؛ راجع ملف الموظف قبل تقرير الإعفاء.");
    }
  }
  return result.sort((a, b) => a.employeeId - b.employeeId);
}

export async function listHistoricalAttendanceCandidates(period: string, actor: Actor) {
  return requireDb().transaction(async (tx) => {
    const owner = await resolveApprovalActor(tx, actor, { current: true });
    if (!owner.isOwner) throw new TRPCError({ code: "FORBIDDEN", message: appErrorMessage({
      what: "تعذّر عرض مرشحي الإقرار التاريخي",
      why: "الحساب الحالي ليس حساب مالك نشطاً",
      doThis: "استعمل حساب المالك النشط لمراجعة الإقرارات",
    }) });
    return historicalAttendanceCandidatesTx(tx, period);
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}
