import { TRPCError } from "@trpc/server";
import { and, eq, inArray, or } from "drizzle-orm";
import { appErrorMessage } from "@shared/errors";
import {
  auditLogs,
  employeeContracts,
  employeePromotions,
  employees,
} from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { baghdadToday } from "../businessDay";
import {
  WAGE_FIELD_LABELS,
  wageProfileDiff,
  wageProfileOf,
  type WageProfile,
} from "./wageProfile";
import { findAttendanceCorrection, HISTORICAL_ATTENDANCE_CORRECTION, type AttendanceCorrectionEvidence } from "./payrollHistoricalAttendanceCorrection";

export type PayrollWageRow = Pick<
  typeof employees.$inferSelect,
  | "id"
  | "payType"
  | "salary"
  | "allowances"
  | "workSchedule"
  | "dayRates"
  | "attendanceExempt"
>;
type WageKey = keyof WageProfile;
const WAGE_KEYS: WageKey[] = [
  "payType",
  "salary",
  "allowances",
  "workSchedule",
  "dayRates",
  "attendanceExempt",
];
type Event = {
  day: string;
  id: number;
  source: "contract" | "promotion" | "admin";
  values: Partial<WageProfile>;
  before?: Partial<WageProfile>;
  end?: string | null;
  applied?: boolean;
  pending?: boolean;
};
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
function object(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function contractId(value: unknown): string | undefined {
  if (
    typeof value !== "number" &&
    (typeof value !== "string" || !/^[1-9]\d*$/.test(value))
  )
    return undefined;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? String(id) : undefined;
}
function profile(value: unknown): WageProfile | undefined {
  const row = object(value);
  if (!row || !WAGE_KEYS.every((key) => Object.hasOwn(row, key)))
    return undefined;
  return wageProfileOf(row);
}
function missing(employeeId: number, asOf: string, field: string): never {
  const label =
    WAGE_FIELD_LABELS[field as WageKey] ??
    (field === "contract interval" ? "تواريخ العقد" : "بصمة أجر الترقية");
  throw new TRPCError({
    code: "PRECONDITION_FAILED",
    message: appErrorMessage({
      what: `تعذّر إثبات أساس أجر الموظف #${employeeId} للفترة ${asOf.slice(0, 7)}`,
      why: `السجل التاريخي للحقل (${label}) ناقص أو متعارض مع الأجر المطبق ولا يسمح باحتساب أجر سابق موثوق`,
      doThis:
        "راجع العقود والترقيات وتغييرات الأجر المعتمدة وأكمل دليل الأساس التاريخي قبل توليد المسيّر",
    }),
  });
}
function latest(
  events: Event[],
  field: WageKey,
  employeeId: number,
  asOf: string,
) {
  const sorted = events
    .filter((event) => Object.hasOwn(event.values, field))
    .sort((a, b) => a.day.localeCompare(b.day) || a.id - b.id);
  for (let i = 1; i < sorted.length; i++) {
    if (
      sorted[i].day === sorted[i - 1].day &&
      sorted[i].source !== sorted[i - 1].source &&
      !same(sorted[i].values[field], sorted[i - 1].values[field])
    )
      missing(employeeId, asOf, field);
  }
  return sorted;
}

/** Project only fields displaced by a proven later applied event. Never rewrites employees. */
export async function projectPayrollWageBasisTx<T extends PayrollWageRow>(
  tx: Tx,
  rows: T[],
  asOf: string,
): Promise<Array<T & { payrollAttendanceCorrection?: AttendanceCorrectionEvidence }>> {
  if (!rows.length) return rows;
  const ids = rows.map((row) => row.id);
  const contracts = await tx
    .select()
    .from(employeeContracts)
    .where(inArray(employeeContracts.employeeId, ids));
  const promotions = await tx
    .select()
    .from(employeePromotions)
    .where(
      and(
        inArray(employeePromotions.employeeId, ids),
        eq(employeePromotions.status, "approved"),
      ),
    );
  const contractIds = contracts.map((row) => String(row.id));
  const audits = await tx
    .select()
    .from(auditLogs)
    .where(
      or(
        and(
          eq(auditLogs.action, "employee.update"),
          eq(auditLogs.entityType, "employee"),
          inArray(auditLogs.entityId, ids.map(String)),
        ),
        and(
          eq(auditLogs.action, HISTORICAL_ATTENDANCE_CORRECTION),
          eq(auditLogs.entityType, "payrollAttendanceExemption"),
          inArray(auditLogs.entityId, ids.map(String)),
        ),
        ...(contractIds.length
          ? [
              and(
                inArray(auditLogs.action, [
                  "employeeContract.activate",
                  "employeeContract.terminate",
                ]),
                inArray(auditLogs.entityId, contractIds),
              ),
            ]
          : []),
      ),
    )
    .orderBy(auditLogs.id);
  const activation = new Map(
    audits
      .filter((row) => row.action === "employeeContract.activate")
      .map((row) => [row.entityId, row]),
  );
  const knownContracts = new Map(
    contracts.map((contract) => [String(contract.id), contract]),
  );
  const cancelled = new Set<string>();
  for (const audit of audits.filter(
    (row) => row.action === "employeeContract.terminate",
  )) {
    const parentId = contractId(audit.entityId);
    const parent = parentId == null ? undefined : knownContracts.get(parentId);
    const value = object(audit.newValue);
    if (!parent || !parentId || value?.status !== "TERMINATED") continue;
    if (value.mode === "CANCEL_SCHEDULED") cancelled.add(parentId);
    if (!Array.isArray(value.cancelledPendingContractIds)) continue;
    for (const candidate of value.cancelledPendingContractIds) {
      const id = contractId(candidate);
      const child = id == null ? undefined : knownContracts.get(id);
      if (
        id &&
        id !== parentId &&
        child?.employeeId === parent.employeeId &&
        child.status === "TERMINATED"
      )
        cancelled.add(id);
    }
  }

  return rows.map((row) => {
    const correction = findAttendanceCorrection(audits, row.id, asOf.slice(0, 7));
    const events: Event[] = [];
    for (const c of contracts.filter(
      (c) =>
        c.employeeId === row.id &&
        c.approvedById != null &&
        c.approvedAt != null &&
        !cancelled.has(String(c.id)) &&
        (c.status !== "DRAFT" ||
          (asOf < `${baghdadToday().slice(0, 7)}-01` &&
            c.startDate <= asOf &&
            (c.endDate == null || c.endDate >= asOf))),
    )) {
      if (c.endDate != null && c.endDate < c.startDate) {
        if (
          c.startDate > asOf &&
          (c.status === "ACTIVE" || c.status === "RENEWED")
        )
          missing(row.id, asOf, "contract interval");
        continue;
      }
      const values: Partial<WageProfile> = {};
      if (c.basicSalary != null) values.salary = c.basicSalary;
      if (c.allowances != null) values.allowances = c.allowances;
      const proof = activation.get(String(c.id));
      const before = profile(object(proof?.oldValue)?.wage);
      events.push({
        day: c.startDate,
        end: c.endDate,
        id: c.id,
        source: "contract",
        values,
        before,
        applied:
          proof != null ||
          c.status === "ACTIVE" ||
          c.status === "RENEWED" ||
          c.status === "TERMINATED",
        pending: c.status === "DRAFT",
      });
    }
    for (const p of promotions.filter(
      (p) => p.employeeId === row.id && p.appliedAt != null,
    )) {
      const from = profile(p.fromWage);
      const to = profile(p.toWage);
      const values: Partial<WageProfile> = {};
      if (to) {
        for (const key of from ? wageProfileDiff(from, to) : WAGE_KEYS)
          Object.assign(values, { [key]: to[key] });
      } else if (p.toWage != null) {
        if (p.effectiveDate > asOf) missing(row.id, asOf, "promotion snapshot");
        continue;
      } else if (p.toSalary != null) values.salary = p.toSalary;
      events.push({
        day: p.effectiveDate,
        id: p.id,
        source: "promotion",
        values,
      });
    }
    for (const a of audits.filter(
      (a) => a.action === "employee.update" && a.entityId === String(row.id),
    )) {
      const after = profile(object(a.newValue)?.wage);
      const before = profile(a.oldValue);
      if (!after) continue;
      const values: Partial<WageProfile> = {};
      for (const key of before ? wageProfileDiff(before, after) : WAGE_KEYS)
        Object.assign(values, { [key]: after[key] });
      events.push({
        day: baghdadToday(a.createdAt),
        id: a.id,
        source: "admin",
        values,
        before,
      });
    }

    const current = wageProfileOf(row);
    const patch: Record<string, unknown> = {};
    for (const field of WAGE_KEYS) {
      const future = latest(
        events.filter(
          (event) =>
            event.day > asOf && (event.source !== "contract" || event.applied),
        ),
        field,
        row.id,
        asOf,
      );
      const pending = events.some(
        (event) => event.pending && Object.hasOwn(event.values, field),
      );
      if (!future.length && !pending) {
        if (field === "attendanceExempt" && correction) missing(row.id, asOf, field);
        continue;
      }
      const anchors = latest(
        events.filter(
          (event) =>
            event.day <= asOf &&
            (event.source !== "contract" ||
              event.end == null ||
              event.end >= asOf),
        ),
        field,
        row.id,
        asOf,
      );
      const firstFuture = future[0];
      const attestedCorrectionBridgesFirstFuture =
        anchors.length === 0 &&
        field === "attendanceExempt" &&
        correction != null &&
        firstFuture?.source === "admin" &&
        firstFuture.id === correction.sourceAuditId &&
        firstFuture.before != null &&
        Object.hasOwn(firstFuture.before, field) &&
        future.every((event) => event.source !== "promotion");
      if (!anchors.length && !attestedCorrectionBridgesFirstFuture)
        missing(row.id, asOf, field);
      const basis = anchors.length
        ? anchors.at(-1)!.values[field]
        : firstFuture!.before![field];
      let expected = basis;
      if (anchors.at(-1)?.pending && future.length) {
        const before = future[0].before;
        if (!before || !Object.hasOwn(before, field))
          missing(row.id, asOf, field);
        expected = before[field];
      }
      for (const event of future) {
        if (
          (event.source === "contract" || event.source === "admin") &&
          !event.before
        )
          missing(row.id, asOf, field);
        if (event.before && !same(event.before[field], expected))
          missing(row.id, asOf, field);
        expected = event.values[field];
      }
      if (future.length && !same(expected, current[field]))
        missing(row.id, asOf, field);
      if (field === "attendanceExempt" && correction) {
        if ((patch.payType ?? current.payType) !== "monthly" || anchors.length || firstFuture?.source !== "admin" || firstFuture.id !== correction.sourceAuditId)
          missing(row.id, asOf, field);
        patch[field] = true;
      } else patch[field] = basis;
    }
    return { ...row, ...patch, ...(correction ? { payrollAttendanceCorrection: correction } : {}) } as T & { payrollAttendanceCorrection?: AttendanceCorrectionEvidence };
  });
}
