/* ============================================================================
 * فحص جاهزية البصمات لمسيّر الرواتب (server/services/payroll/biometricReadiness.ts)
 * يوفر قراءة استباقية دقيقة لحالة جسر البصمات لشهر محدد:
 *  - عدد البصمات المعلقة بانتظار الطيّ (pendingPunchesCount).
 *  - عدد البصمات غير المربوطة بموظف في الشهر (unmappedPunchesCount).
 *  - عدد الأيام المفتوحة (دخول بلا خروج) للموظفين في الشهر (openDaysCount).
 *  - حالة اتصال أجهزة البصمة (المتصلة / الإجمالي).
 * ========================================================================== */
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import {
  attendance,
  employees,
  hrAttendancePunches,
  hrFingerprintDevices,
} from "../../../drizzle/schema";
import { requireDb } from "../tx";
import { assertPeriod } from "./helpers";
import type { Actor } from "../tx";

export interface BiometricPayrollReadiness {
  period: string;
  pendingPunchesCount: number;
  unmappedPunchesCount: number;
  openDaysCount: number;
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

  // 1. عدد البصمات المعلقة الكلية بانتظار الطيّ
  const [pendingRow] = await db
    .select({ count: sql<string>`COUNT(*)` })
    .from(hrAttendancePunches)
    .where(isNull(hrAttendancePunches.processedAt));
  const pendingPunchesCount = Number(pendingRow?.count ?? 0);

  // 2. عدد البصمات غير المربوطة بموظف خلال الشهر المستهدف
  const [unmappedRow] = await db
    .select({ count: sql<string>`COUNT(*)` })
    .from(hrAttendancePunches)
    .where(
      and(
        isNull(hrAttendancePunches.employeeId),
        sql`${hrAttendancePunches.punchAt} LIKE ${`${p}%`}`,
      ),
    );
  const unmappedPunchesCount = Number(unmappedRow?.count ?? 0);

  // 3. عدد الأيام المفتوحة (دخول بلا انصراف) في الشهر المستهدف
  const openConditions = [
    sql`DATE_FORMAT(${attendance.attendanceDate}, '%Y-%m') = ${p}`,
    isNotNull(attendance.checkIn),
    isNull(attendance.checkOut),
  ];
  if (actor.branchId != null && actor.branchId > 0 && !actor.isOwner && actor.role !== "admin") {
    openConditions.push(eq(employees.branchId, actor.branchId));
  }

  const [openDaysRow] = await db
    .select({ count: sql<string>`COUNT(*)` })
    .from(attendance)
    .innerJoin(employees, eq(attendance.employeeId, employees.id))
    .where(and(...openConditions));
  const openDaysCount = Number(openDaysRow?.count ?? 0);

  // 4. أجهزة البصمة (المتصلة والإجمالي)
  const deviceConditions = [eq(hrFingerprintDevices.enabled, true)];
  if (actor.branchId != null && actor.branchId > 0 && !actor.isOwner && actor.role !== "admin") {
    deviceConditions.push(eq(hrFingerprintDevices.branchId, actor.branchId));
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

  const ready = pendingPunchesCount === 0 && unmappedPunchesCount === 0 && openDaysCount === 0;

  return {
    period: p,
    pendingPunchesCount,
    unmappedPunchesCount,
    openDaysCount,
    connectedDevicesCount,
    totalDevicesCount,
    ready,
  };
}
