/* ============================================================================
 * خدمة أجهزة البصمة + الهجرة — وحدة الموارد البشرية (server/services/hrDeviceService.ts)
 * هجرة الأجهزة من المزوّد الخارجي المدفوع إلى خادم الرؤية العربية المملوك.
 * القراءة بصلاحية hr/READ والكتابة بـ hr/FULL (في الموجّه). الهجرة عملية ذرّية withTx.
 * ========================================================================== */
import { and, desc, eq, getTableColumns, isNull, sql, type SQL } from "drizzle-orm";
import { HR_FINGERPRINT_TARGET } from "@shared/hr";
import {
  branches,
  employees,
  hrAttendancePunches,
  hrDeviceCommands,
  hrDeviceUsers,
  hrFingerprintDevices,
  users,
} from "../../drizzle/schema";
import { fullEmployeeName } from "@shared/hr";
import { requireDb, withTx } from "./tx";
import { extractInsertId } from "../lib/insertId";
import { onlineDeviceIds } from "./hrDevices/registry";
import { resolveBridgeConfig } from "./hrDevices/types";

/** قائمة الأجهزة مع اسم الفرع. الأحدث أولاً. */
export async function listDevices() {
  const db = requireDb();
  const rows = await db
    .select({ ...getTableColumns(hrFingerprintDevices), branchName: branches.name })
    .from(hrFingerprintDevices)
    .leftJoin(branches, eq(hrFingerprintDevices.branchId, branches.id))
    .orderBy(desc(hrFingerprintDevices.id));
  return rows;
}

export async function getDevice(id: number) {
  const db = requireDb();
  const [d] = await db
    .select({ ...getTableColumns(hrFingerprintDevices), branchName: branches.name })
    .from(hrFingerprintDevices)
    .leftJoin(branches, eq(hrFingerprintDevices.branchId, branches.id))
    .where(eq(hrFingerprintDevices.id, id))
    .limit(1);
  return d ?? null;
}

export interface DeviceInput {
  name: string;
  model?: string | null;
  location?: string | null;
  branchId?: number | null;
  deviceCode?: string | null;
  ip?: string | null;
  port?: number | null;
  serverHost?: string | null;
  serverPort?: number | null;
  status?: string | null;
  usersCount?: number | null;
  recordsCount?: number | null;
  firmware?: string | null;
  /** الرقم التسلسلي الحقيقي — تسجيله مسبقاً يجعل الجهاز معتمداً لحظة أول اتصال. */
  serialNumber?: string | null;
  protocol?: string | null;
}

function toValues(input: DeviceInput) {
  return {
    name: input.name.trim(),
    model: input.model?.trim() || null,
    location: input.location?.trim() || null,
    branchId: input.branchId ?? null,
    deviceCode: input.deviceCode?.trim() || null,
    ip: input.ip?.trim() || null,
    port: input.port ?? null,
    serverHost: input.serverHost?.trim() || null,
    serverPort: input.serverPort ?? null,
    status: input.status?.trim() || "offline",
    usersCount: input.usersCount ?? 0,
    recordsCount: input.recordsCount ?? 0,
    firmware: input.firmware?.trim() || null,
    ...(input.serialNumber !== undefined ? { serialNumber: input.serialNumber?.trim() || null } : {}),
    ...(input.protocol ? { protocol: input.protocol } : {}),
  };
}

export async function createDevice(input: DeviceInput) {
  const db = requireDb();
  const [res] = await db.insert(hrFingerprintDevices).values({ ...toValues(input), migrated: false });
  return getDevice(extractInsertId(res));
}

export async function updateDevice(id: number, input: DeviceInput) {
  const db = requireDb();
  const [d] = await db.select().from(hrFingerprintDevices).where(eq(hrFingerprintDevices.id, id)).limit(1);
  if (!d) throw new Error("الجهاز غير موجود");
  await db.update(hrFingerprintDevices).set(toValues(input)).where(eq(hrFingerprintDevices.id, id));
  return getDevice(id);
}

/**
 * هجرة الجهاز إلى خادم الرؤية العربية: يُعاد توجيه serverHost/serverPort إلى الوجهة المملوكة
 * ويُرفع علم migrated. عملية ذرّية: إن فشل أي جزء تُلغى كاملة.
 */
export async function migrateDevice(id: number) {
  return withTx(async (tx) => {
    const [d] = await tx.select().from(hrFingerprintDevices).where(eq(hrFingerprintDevices.id, id)).for("update").limit(1);
    if (!d) throw new Error("الجهاز غير موجود");
    // حارس idempotency: لا تُعاد هجرة جهاز مُهاجَر (تجنّب إعادة كتابة الوجهة بصمت).
    if (d.migrated) throw new Error("الجهاز مُهاجَر إلى خادم الرؤية مسبقاً");
    await tx
      .update(hrFingerprintDevices)
      .set({
        serverHost: HR_FINGERPRINT_TARGET.host,
        serverPort: HR_FINGERPRINT_TARGET.port,
        migrated: true,
      })
      .where(eq(hrFingerprintDevices.id, id));
    const [updated] = await tx
      .select({ ...getTableColumns(hrFingerprintDevices), branchName: branches.name })
      .from(hrFingerprintDevices)
      .leftJoin(branches, eq(hrFingerprintDevices.branchId, branches.id))
      .where(eq(hrFingerprintDevices.id, id))
      .limit(1);
    return updated;
  });
}

/** اعتماد جهاز سجّل نفسه تلقائياً (بوابة القبول): تفعيل + تسمية + إسناد فرع. */
export async function approveDevice(id: number, patch: { name?: string; branchId?: number | null }) {
  const db = requireDb();
  const [d] = await db.select().from(hrFingerprintDevices).where(eq(hrFingerprintDevices.id, id)).limit(1);
  if (!d) throw new Error("الجهاز غير موجود");
  await db
    .update(hrFingerprintDevices)
    .set({
      enabled: true,
      ...(patch.name?.trim() ? { name: patch.name.trim() } : {}),
      ...(patch.branchId !== undefined ? { branchId: patch.branchId } : {}),
    })
    .where(eq(hrFingerprintDevices.id, id));
  return getDevice(id);
}

/** حالة الجسر للشاشة: مفعَّل؟ منفذه (7788 افتراضاً)؟ ومن المتصل الآن فعلاً (وصلات حية بالذاكرة).
 *  يشارك resolveBridgeConfig نفسه مع مسار الإقلاع فلا يتباعد المعروض عن الفعلي. */
export function bridgeStatus() {
  const cfg = resolveBridgeConfig();
  return {
    enabled: cfg.enabled,
    port: cfg.enabled ? cfg.port : null,
    onlineDeviceIds: onlineDeviceIds(),
  };
}

export interface PunchFilters {
  deviceId?: number;
  /** غير المربوطة بموظف فقط (طابور المراجعة). */
  unmatchedOnly?: boolean;
  limit?: number;
  offset?: number;
}

/** البصمات الخام (الأحدث أولاً) مع اسم الموظف المربوط والجهاز — شاشة المراجعة والتشخيص. */
export async function listPunches(filters: PunchFilters = {}) {
  const db = requireDb();
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
  const offset = Math.max(filters.offset ?? 0, 0);
  const conds: SQL[] = [];
  if (filters.deviceId) conds.push(eq(hrAttendancePunches.deviceId, filters.deviceId));
  if (filters.unmatchedOnly) conds.push(isNull(hrAttendancePunches.employeeId));
  const where = conds.length ? and(...conds) : undefined;
  const rows = await db
    .select({
      id: hrAttendancePunches.id,
      deviceId: hrAttendancePunches.deviceId,
      serialNumber: hrAttendancePunches.serialNumber,
      enrollId: hrAttendancePunches.enrollId,
      punchAt: hrAttendancePunches.punchAt,
      mode: hrAttendancePunches.mode,
      inOut: hrAttendancePunches.inOut,
      employeeId: hrAttendancePunches.employeeId,
      processedAt: hrAttendancePunches.processedAt,
      processNote: hrAttendancePunches.processNote,
      deviceName: hrFingerprintDevices.name,
      firstName: employees.firstName,
      fatherName: employees.fatherName,
      grandfatherName: employees.grandfatherName,
      lastName: employees.lastName,
    })
    .from(hrAttendancePunches)
    .leftJoin(hrFingerprintDevices, eq(hrAttendancePunches.deviceId, hrFingerprintDevices.id))
    .leftJoin(employees, eq(hrAttendancePunches.employeeId, employees.id))
    .where(where)
    .orderBy(desc(hrAttendancePunches.id))
    .limit(limit + 1)
    .offset(offset);
  const hasMore = rows.length > limit;
  return {
    rows: rows.slice(0, limit).map((r) => ({
      ...r,
      employeeName: r.firstName ? fullEmployeeName(r) : null,
    })),
    hasMore,
  };
}

/** مستخدمو جهاز (مرآة) مع اسم الموظف المربوط — شاشة الربط. */
export async function listDeviceUsers(deviceId: number) {
  const db = requireDb();
  const rows = await db
    .select({
      id: hrDeviceUsers.id,
      enrollId: hrDeviceUsers.enrollId,
      name: hrDeviceUsers.name,
      isAdmin: hrDeviceUsers.isAdmin,
      cardNo: hrDeviceUsers.cardNo,
      employeeId: hrDeviceUsers.employeeId,
      syncedAt: hrDeviceUsers.syncedAt,
      hasBackup: sql<number>`CASE WHEN ${hrDeviceUsers.backupData} IS NOT NULL THEN 1 ELSE 0 END`,
      firstName: employees.firstName,
      fatherName: employees.fatherName,
      grandfatherName: employees.grandfatherName,
      lastName: employees.lastName,
    })
    .from(hrDeviceUsers)
    .leftJoin(employees, eq(hrDeviceUsers.employeeId, employees.id))
    .where(eq(hrDeviceUsers.deviceId, deviceId))
    .orderBy(hrDeviceUsers.enrollId);
  return rows.map((r) => ({ ...r, employeeName: r.firstName ? fullEmployeeName(r) : null }));
}

/** آخر أوامر جهاز (الأحدث أولاً) مع اسم مُصدرها — تتبع صادق لا ادعاء. */
export async function listCommands(deviceId: number, limit = 30) {
  const db = requireDb();
  return db
    .select({
      id: hrDeviceCommands.id,
      cmd: hrDeviceCommands.cmd,
      status: hrDeviceCommands.status,
      error: hrDeviceCommands.error,
      createdAt: hrDeviceCommands.createdAt,
      sentAt: hrDeviceCommands.sentAt,
      doneAt: hrDeviceCommands.doneAt,
      createdByName: users.name,
    })
    .from(hrDeviceCommands)
    .leftJoin(users, eq(hrDeviceCommands.createdBy, users.id))
    .where(eq(hrDeviceCommands.deviceId, deviceId))
    .orderBy(desc(hrDeviceCommands.id))
    .limit(Math.min(Math.max(limit, 1), 100));
}

/** عدّادات الهجرة: الإجمالي / المُهاجَر / المتبقّي. */
export async function migrationStatus() {
  const db = requireDb();
  const [r] = await db
    .select({
      total: sql<number>`count(*)`,
      migrated: sql<number>`sum(case when ${hrFingerprintDevices.migrated} = 1 then 1 else 0 end)`,
    })
    .from(hrFingerprintDevices);
  const total = Number(r?.total ?? 0);
  const migrated = Number(r?.migrated ?? 0);
  return { total, migrated, pending: total - migrated };
}
