import { createHash } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";
import { and, desc, eq } from "drizzle-orm";
import {
  auditLogs,
  employees,
  payrollRuns,
  type AuditLog,
} from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { resolveApprovalActor } from "../approval/ownerGate";
import { logAuditTx } from "../auditService";
import { baghdadToday } from "../businessDay";
import { assertPeriodOpen } from "../periodLockService";
import { assertGovernanceGateHeld, withTx, type Actor } from "../tx";
import { wageProfileOf } from "./wageProfile";

export const HISTORICAL_ATTENDANCE_CORRECTION =
  "payroll.attendanceExemption.attest";
const ENTITY = "payrollAttendanceExemption";
const VERSION = "payroll-attendance-exemption-attestation.v1";
const RECORDER_LABEL = "External owner confirmation recorded by operator";
const CORRECTION_KEYS = [
  "version",
  "employeeId",
  "period",
  "attendanceExempt",
  "sourceAuditId",
  "sourceHash",
  "evidenceKind",
  "evidenceStatement",
  "evidenceReference",
  "evidenceHash",
];
const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;
const HASH = /^[0-9a-f]{64}$/;
const WAGE_FIELDS = [
  "payType",
  "salary",
  "allowances",
  "workSchedule",
  "dayRates",
  "attendanceExempt",
] as const;
const sha256 = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");
const obj = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

function fail(message: string): never {
  throw new TRPCError({ code: "PRECONDITION_FAILED", message });
}

function snapshot(value: unknown) {
  const row = obj(value);
  if (!row || !WAGE_FIELDS.every((key) => Object.hasOwn(row, key))) return null;
  if (typeof row.attendanceExempt !== "boolean") return null;
  return wageProfileOf(row);
}

/** Fingerprint the original change, not the subsequent owner attestation. */
export function attendanceCorrectionSourceHash(source: AuditLog): string {
  const before = snapshot(source.oldValue);
  const after = snapshot(obj(source.newValue)?.wage);
  if (
    !before ||
    !after ||
    source.action !== "employee.update" ||
    source.entityType !== "employee"
  )
    return fail("سجل أساس الأجر الأصلي غير مكتمل");
  return sha256(
    JSON.stringify({
      id: Number(source.id),
      entityId: source.entityId,
      createdAt: source.createdAt.toISOString(),
      before,
      after,
    }),
  );
}

export type AttendanceCorrectionEvidence = {
  auditId: number;
  sourceAuditId: number;
  sourceHash: string;
  evidenceHash: string;
  correctionHash: string;
};

/** Read only valid, unambiguous attestations for the selected employee and month. */
export function findAttendanceCorrection(
  audits: AuditLog[],
  employeeId: number,
  period: string,
): AttendanceCorrectionEvidence | undefined {
  const candidates = audits.filter(
    (a) =>
      a.action === HISTORICAL_ATTENDANCE_CORRECTION &&
      a.entityType === ENTITY &&
      a.entityId === String(employeeId),
  );
  let found: AttendanceCorrectionEvidence | undefined;
  for (const audit of candidates) {
    const value = obj(audit.newValue);
    if (
      !value ||
      typeof value.period !== "string" ||
      !PERIOD.test(value.period)
    )
      return fail("إقرار الإعفاء التاريخي غير مكتمل");
    if (value.period !== period) continue;
    const operation = obj(audit.operation);
    const recorder = obj(operation?.actor);
    if (
      found ||
      Object.keys(value).length !== CORRECTION_KEYS.length ||
      CORRECTION_KEYS.some((key) => !Object.hasOwn(value, key)) ||
      !Number.isSafeInteger(audit.userId) ||
      Number(audit.userId) <= 0 ||
      operation?.version !== "operation.v2" ||
      operation.outcome !== "SUCCESS" ||
      recorder?.source !== "system" ||
      recorder.label !== RECORDER_LABEL ||
      value.version !== VERSION ||
      value.employeeId !== employeeId ||
      value.attendanceExempt !== true ||
      !Number.isSafeInteger(value.sourceAuditId) ||
      typeof value.sourceHash !== "string" ||
      !HASH.test(value.sourceHash) ||
      typeof value.evidenceStatement !== "string" ||
      !value.evidenceStatement.trim() ||
      value.evidenceStatement.length > 500 ||
      typeof value.evidenceReference !== "string" ||
      !value.evidenceReference.trim() ||
      value.evidenceReference.length > 500 ||
      typeof value.evidenceHash !== "string" ||
      !HASH.test(value.evidenceHash) ||
      sha256(value.evidenceStatement) !== value.evidenceHash ||
      value.evidenceKind !== "EXTERNAL_OWNER_CONFIRMATION"
    )
      return fail("إقرار الإعفاء التاريخي ناقص أو مكرر أو متعارض");
    const source = audits.find(
      (a) =>
        Number(a.id) === value.sourceAuditId &&
        a.entityId === String(employeeId),
    );
    if (
      !source ||
      attendanceCorrectionSourceHash(source) !== value.sourceHash ||
      baghdadToday(source.createdAt).slice(0, 7) <= period
    )
      return fail("تغيّر مصدر إقرار الإعفاء التاريخي أو فُقد");
    const before = snapshot(source.oldValue);
    const after = snapshot(obj(source.newValue)?.wage);
    if (
      !before ||
      !after ||
      before.payType !== "monthly" ||
      after.payType !== "monthly" ||
      before.attendanceExempt !== false ||
      after.attendanceExempt !== true
    )
      return fail("مصدر إقرار الإعفاء التاريخي لا يطابق التغيير المسجل");
    const canonical = {
      version: VERSION,
      employeeId,
      period,
      attendanceExempt: true,
      sourceAuditId: Number(source.id),
      sourceHash: value.sourceHash,
      evidenceKind: value.evidenceKind,
      evidenceStatement: value.evidenceStatement,
      evidenceReference: value.evidenceReference,
      evidenceHash: value.evidenceHash,
    };
    found = {
      auditId: Number(audit.id),
      sourceAuditId: Number(source.id),
      sourceHash: value.sourceHash,
      evidenceHash: value.evidenceHash,
      correctionHash: sha256(
        JSON.stringify({
          auditId: Number(audit.id),
          recordedBy: audit.userId,
          recordedAt: audit.createdAt.toISOString(),
          payload: canonical,
        }),
      ),
    };
  }
  return found;
}

export interface HistoricalAttendanceCorrectionInput {
  employeeId: number;
  period: string;
  sourceAuditId: number;
  sourceHash: string;
  evidenceStatement: string;
  evidenceReference: string;
}

export async function recordHistoricalAttendanceCorrectionTx(
  tx: Tx,
  input: HistoricalAttendanceCorrectionInput,
  actor: Actor,
) {
  assertGovernanceGateHeld(tx);
  if (
    !Number.isSafeInteger(input.employeeId) ||
    input.employeeId <= 0 ||
    !Number.isSafeInteger(input.sourceAuditId) ||
    input.sourceAuditId <= 0 ||
    typeof input.period !== "string" ||
    !PERIOD.test(input.period) ||
    input.period >= baghdadToday().slice(0, 7) ||
    typeof input.sourceHash !== "string" ||
    !HASH.test(input.sourceHash) ||
    typeof input.evidenceStatement !== "string" ||
    !input.evidenceStatement.trim() ||
    input.evidenceStatement.length > 500 ||
    typeof input.evidenceReference !== "string" ||
    !input.evidenceReference.trim() ||
    input.evidenceReference.length > 500
  )
    return fail("بيانات إقرار الإعفاء التاريخي غير صالحة");
  const resolved = await resolveApprovalActor(tx, actor, { current: true });
  if (!resolved.isOwner)
    throw new TRPCError({
      code: "FORBIDDEN",
      message: appErrorMessage({
        what: "تعذّر تسجيل إقرار الإعفاء التاريخي",
        why: "الحساب المنفّذ ليس حساب مالك نشطاً",
        doThis: "استعمل حساب المالك النشط لتسجيل الإقرار",
      }),
    });
  const [run] = await tx
    .select({ id: payrollRuns.id })
    .from(payrollRuns)
    .where(eq(payrollRuns.period, input.period))
    .for("update")
    .limit(1);
  const [employee] = await tx
    .select()
    .from(employees)
    .where(eq(employees.id, input.employeeId))
    .for("update")
    .limit(1);
  if (!employee) return fail("الموظف غير موجود");
  // A payroll may have committed while this transaction waited on the employee.
  const [runAfterEmployeeLock] = await tx
    .select({ id: payrollRuns.id })
    .from(payrollRuns)
    .where(eq(payrollRuns.period, input.period))
    .for("update")
    .limit(1);
  const sourceRows = await tx
    .select()
    .from(auditLogs)
    .where(eq(auditLogs.id, input.sourceAuditId))
    .for("share");
  const source = sourceRows.find((a) => a.entityId === String(input.employeeId));
  if (
    !source ||
    attendanceCorrectionSourceHash(source) !== input.sourceHash ||
    baghdadToday(source.createdAt).slice(0, 7) <= input.period
  )
    return fail("تغيّر سجل الأجر الأصلي منذ المراجعة");
  const existing = await tx
    .select()
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.action, HISTORICAL_ATTENDANCE_CORRECTION),
        eq(auditLogs.entityType, ENTITY),
        eq(auditLogs.entityId, String(input.employeeId)),
      ),
    );
  const evidenceHash = sha256(input.evidenceStatement);
  const payload = {
    version: VERSION,
    employeeId: input.employeeId,
    period: input.period,
    attendanceExempt: true,
    sourceAuditId: input.sourceAuditId,
    sourceHash: input.sourceHash,
    evidenceKind: "EXTERNAL_OWNER_CONFIRMATION",
    evidenceStatement: input.evidenceStatement,
    evidenceReference: input.evidenceReference,
    evidenceHash,
  };
  const matches = existing.filter(
    (a) => obj(a.newValue)?.period === input.period,
  );
  if (matches.length) {
    const saved = obj(matches[0].newValue);
    if (
      matches.length !== 1 ||
      !saved ||
      Object.keys(saved).length !== Object.keys(payload).length ||
      Object.entries(payload).some(([key, value]) => saved[key] !== value)
    )
      return fail("يوجد إقرار مختلف أو مكرر لهذا الموظف والشهر");
    if (
      findAttendanceCorrection(
        [...sourceRows, ...existing],
        input.employeeId,
        input.period,
      )?.auditId !== Number(matches[0].id)
    )
      return fail("تعذّر إثبات الإقرار السابق");
    return {
      mode: "REPLAY_VERIFIED" as const,
      auditId: Number(matches[0].id),
      evidenceHash,
    };
  }
  if (run || runAfterEmployeeLock)
    return fail("يوجد مسير للشهر؛ لا يمكن تسجيل تصحيح أساسه بهذه الطريقة");
  await assertPeriodOpen(tx, new Date(`${input.period}-01T00:00:00Z`));
  const before = snapshot(source.oldValue);
  const after = snapshot(obj(source.newValue)?.wage);
  if (
    employee.payType !== "monthly" ||
    !employee.attendanceExempt ||
    !before ||
    !after ||
    before.payType !== "monthly" ||
    after.payType !== "monthly" ||
    before.attendanceExempt !== false ||
    after.attendanceExempt !== true ||
    JSON.stringify(after) !== JSON.stringify(wageProfileOf(employee))
  )
    return fail("لم يعد سجل الإعفاء الأصلي مطابقاً لبطاقة الموظف");
  await logAuditTx(
    tx,
    { userId: actor.userId, branchId: employee.branchId },
    {
      action: HISTORICAL_ATTENDANCE_CORRECTION,
      entityType: ENTITY,
      entityId: input.employeeId,
      actor: { source: "system", label: RECORDER_LABEL },
      newValue: payload,
    },
  );
  const createdRows = await tx
    .select()
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.action, HISTORICAL_ATTENDANCE_CORRECTION),
        eq(auditLogs.entityType, ENTITY),
        eq(auditLogs.entityId, String(input.employeeId)),
      ),
    )
    .orderBy(desc(auditLogs.id));
  const created = createdRows.find(
    (a) => obj(a.newValue)?.period === input.period,
  );
  if (
    !created ||
    findAttendanceCorrection(
      [...sourceRows, ...createdRows],
      input.employeeId,
      input.period,
    )?.auditId !== Number(created.id)
  )
    return fail("تعذّر إثبات تسجيل الإقرار");
  const [year, month] = input.period.split("-").map(Number);
  const periodEnd = new Date(Date.UTC(year, month, 0))
    .toISOString()
    .slice(0, 10);
  const { projectPayrollWageBasisTx } = await import("./payrollWageBasis");
  const [projected] = await projectPayrollWageBasisTx(
    tx,
    [employee],
    periodEnd,
  );
  if (
    projected?.attendanceExempt !== true ||
    projected.payrollAttendanceCorrection?.auditId !== Number(created.id)
  )
    return fail("تعذّر إثبات تطبيق الإقرار على أساس أجر الشهر");
  return {
    mode: "APPLIED" as const,
    auditId: Number(created.id),
    evidenceHash,
  };
}

export function recordHistoricalAttendanceCorrection(
  input: HistoricalAttendanceCorrectionInput,
  actor: Actor,
) {
  return withTx(
    (tx) => recordHistoricalAttendanceCorrectionTx(tx, input, actor),
    { gate: "GOVERNANCE", bootstrapMissingGate: false },
  );
}
