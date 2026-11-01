/* ============================================================================
 * فحص جاهزية البصمات لمسيّر الرواتب (server/services/payroll/biometricReadiness.ts)
 * يوفر قراءة استباقية دقيقة لحالة جسر البصمات لشهر محدد:
 *  - عدد البصمات المعلقة بانتظار الطيّ (pendingPunchesCount).
 *  - عدد البصمات غير المربوطة بموظف في الشهر (unmappedPunchesCount).
 *  - عدد الأيام المفتوحة (دخول بلا خروج) للموظفين في الشهر (openDaysCount).
 *  - حالة اتصال أجهزة البصمة (المتصلة / الإجمالي).
 * ========================================================================== */
import {
  and,
  asc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm";
import { hasUnclosedAttendancePunch } from "@shared/attendanceHours";
import { fullEmployeeName } from "@shared/hr";
import {
  attendance,
  employees,
  hrAttendancePunches,
  hrFingerprintDevices,
} from "../../../drizzle/schema";
import { requireDb } from "../tx";
import {
  canCrossBranches,
  resolveActorBranchId,
} from "../../lib/branchAuthority";
import { utcDayRange } from "../businessDay";
import { assertPeriod } from "./helpers";
import type { Actor } from "../tx";

export interface BiometricPayrollReadiness {
  period: string;
  pendingPunchesCount: number;
  unmappedPunchesCount: number;
  openDaysCount: number;
  openEmployeesCount: number;
  openDays: Array<{
    attendanceId: number;
    employeeId: number;
    employeeName: string;
    date: string;
    reason: string;
  }>;
  connectedDevicesCount: number;
  totalDevicesCount: number;
  ready: boolean;
}

export async function getBiometricPayrollReadiness(
  period: string,
  actor: Actor,
): Promise<BiometricPayrollReadiness> {
  const p = assertPeriod(period);
  const db = requireDb();
  const [year, month] = p.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  const range = utcDayRange(`${p}-01`, lastDay);
  const fromDate = range.start.toISOString().slice(0, 10);
  const untilDate = range.endExclusive.toISOString().slice(0, 10);
  const branchId = canCrossBranches(actor)
    ? null
    : resolveActorBranchId({
        user: {
          ...actor,
          branchId:
            actor.branchId != null && actor.branchId > 0
              ? actor.branchId
              : null,
        },
      });

  // punchAt is device wall-clock DATETIME, not a UTC timestamp. Compare its
  // calendar month directly, and scope unmapped punches by their source device.
  const punchConditions = [
    gte(hrAttendancePunches.punchAt, `${fromDate} 00:00:00`),
    lt(hrAttendancePunches.punchAt, `${untilDate} 00:00:00`),
  ];
  if (branchId != null) {
    punchConditions.push(
      or(
        eq(employees.branchId, branchId),
        and(
          isNull(hrAttendancePunches.employeeId),
          eq(hrFingerprintDevices.branchId, branchId),
        ),
      )!,
    );
  }
  const [punchCounts] = await db
    .select({
      pending: sql<string>`COALESCE(SUM(CASE WHEN ${hrAttendancePunches.processedAt} IS NULL THEN 1 ELSE 0 END), 0)`,
      unmapped: sql<string>`COALESCE(SUM(CASE WHEN ${hrAttendancePunches.employeeId} IS NULL THEN 1 ELSE 0 END), 0)`,
    })
    .from(hrAttendancePunches)
    .leftJoin(employees, eq(hrAttendancePunches.employeeId, employees.id))
    .leftJoin(
      hrFingerprintDevices,
      eq(hrAttendancePunches.deviceId, hrFingerprintDevices.id),
    )
    .where(and(...punchConditions));
  const pendingPunchesCount = Number(punchCounts?.pending ?? 0);
  const unmappedPunchesCount = Number(punchCounts?.unmapped ?? 0);

  // 3. عدد الأيام المفتوحة (دخول بلا انصراف) في الشهر المستهدف
  const openConditions = [
    gte(attendance.attendanceDate, fromDate),
    lt(attendance.attendanceDate, untilDate),
    inArray(attendance.status, ["PRESENT", "LATE"]),
    or(
      and(isNotNull(attendance.checkIn), isNull(attendance.checkOut)),
      eq(attendance.needsReview, true),
    ),
  ];
  if (branchId != null) {
    openConditions.push(eq(employees.branchId, branchId));
  }

  const openRows = await db
    .select({
      attendanceId: attendance.id,
      employeeId: employees.id,
      firstName: employees.firstName,
      fatherName: employees.fatherName,
      grandfatherName: employees.grandfatherName,
      lastName: employees.lastName,
      date: attendance.attendanceDate,
      checkIn: attendance.checkIn,
      checkOut: attendance.checkOut,
      hours: attendance.hours,
      needsReview: attendance.needsReview,
      reviewReason: attendance.reviewReason,
      notes: attendance.notes,
    })
    .from(attendance)
    .innerJoin(employees, eq(attendance.employeeId, employees.id))
    .where(and(...openConditions))
    .orderBy(asc(attendance.attendanceDate), asc(employees.id));
  // Reuse the payroll engine's definition, including a second unclosed session.
  const openDays = openRows.filter(hasUnclosedAttendancePunch).map((row) => ({
    attendanceId: Number(row.attendanceId),
    employeeId: Number(row.employeeId),
    employeeName: fullEmployeeName(row),
    date: row.date,
    reason:
      row.checkOut == null ? "دخول بلا انصراف" : "فترة دوام مفتوحة بلا انصراف",
  }));
  const openDaysCount = openDays.length;
  const openEmployeesCount = new Set(openDays.map((row) => row.employeeId))
    .size;

  // 4. أجهزة البصمة (المتصلة والإجمالي)
  const deviceConditions = [eq(hrFingerprintDevices.enabled, true)];
  if (branchId != null) {
    deviceConditions.push(eq(hrFingerprintDevices.branchId, branchId));
  }

  const deviceRows = await db
    .select({
      id: hrFingerprintDevices.id,
      status: hrFingerprintDevices.status,
      lastSeenAt: hrFingerprintDevices.lastSeenAt,
    })
    .from(hrFingerprintDevices)
    .where(and(...deviceConditions));

  const totalDevicesCount = deviceRows.length;
  const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
  const connectedDevicesCount = deviceRows.filter((d) => {
    if (d.status === "online") return true;
    if (d.lastSeenAt && new Date(d.lastSeenAt) >= tenMinutesAgo) return true;
    return false;
  }).length;

  const ready =
    pendingPunchesCount === 0 &&
    unmappedPunchesCount === 0 &&
    openDaysCount === 0;

  return {
    period: p,
    pendingPunchesCount,
    unmappedPunchesCount,
    openDaysCount,
    openEmployeesCount,
    openDays,
    connectedDevicesCount,
    totalDevicesCount,
    ready,
  };
}
