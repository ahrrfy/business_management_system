/* ============================================================================
 * خدمة أجهزة البصمة + الهجرة — وحدة الموارد البشرية (server/services/hrDeviceService.ts)
 * هجرة الأجهزة من المزوّد الخارجي المدفوع إلى خادم الرؤية العربية المملوك.
 * القراءة بصلاحية hr/READ والكتابة بـ hr/FULL (في الموجّه). الهجرة عملية ذرّية withTx.
 * ========================================================================== */
import { TRPCError } from "@trpc/server";
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
import { enabledDeviceIdentityRuntimeFailure, onlineDeviceIds } from "./hrDevices/registry";
import { resolveBridgeConfig } from "./hrDevices/types";
import {
  enabledDeviceIdentityFailure,
  isExactHostNetwork,
  resolveBridgeSecurityConfig,
} from "./hrDevices/bridgeSecurity";

/**
 * قائمة الأجهزة مع اسم الفرع. الأحدث أولاً.
 *
 * `usersCount`/`recordsCount` هما ما يقوله **الجهاز عن نفسه** (devInfo) — ثابتان لا يتحرّكان
 * أثناء الرفع، فلا يصلحان مؤشّرَ تقدّم. لذا نُرفق العدّ الحقيقيّ من قاعدتنا:
 * `receivedPunches` (ما استُلم فعلاً) و`pendingPunches` (بلا موظف ⇒ طابور المراجعة).
 * بدونهما كان المستخدم يرى «61 / 36815» جامداً ويظنّ الاستيراد متوقّفاً وهو يعمل.
 */
export async function listDevices() {
  const db = requireDb();
  const rows = await db
    .select({ ...getTableColumns(hrFingerprintDevices), branchName: branches.name })
    .from(hrFingerprintDevices)
    .leftJoin(branches, eq(hrFingerprintDevices.branchId, branches.id))
    .orderBy(desc(hrFingerprintDevices.id));
  if (rows.length === 0) return [];
  const stats = await db
    .select({
      deviceId: hrAttendancePunches.deviceId,
      received: sql<number>`COUNT(*)`,
      pending: sql<number>`SUM(CASE WHEN ${hrAttendancePunches.employeeId} IS NULL THEN 1 ELSE 0 END)`,
    })
    .from(hrAttendancePunches)
    .groupBy(hrAttendancePunches.deviceId);
  const byDevice = new Map(stats.map((s) => [Number(s.deviceId), s]));
  return rows.map((r) => {
    const s = byDevice.get(Number(r.id));
    return { ...r, receivedPunches: Number(s?.received ?? 0), pendingPunches: Number(s?.pending ?? 0) };
  });
}

/**
 * حذف جهاز — **للصفوف الوهمية فقط**: أيّ فحص HTTP على `/iclock/*` بسريال مجهول يُسجّل
 * جهازاً تلقائياً معطَّلاً (بوّابة القبول)، فتتراكم صفوف مثل TEST/PING من اختبارات الاتصال.
 * لم يكن ثمّة مسار حذف إطلاقاً فتبقى أبداً.
 *
 * ثلاثة شروط تجعله غير مدمّر بنيوياً: **غير معتمَد** (لم يُقبل منه شيء قط) + **بلا بصمات**
 * + **بلا مستخدمين مرآة**. الجهاز الحقيقيّ يفشل أوّل شرط دائماً ⇒ يستحيل حذفه من هنا.
 */
export async function deleteDevice(id: number) {
  return withTx(async (tx) => {
    const [d] = await tx
      .select({ id: hrFingerprintDevices.id, name: hrFingerprintDevices.name, enabled: hrFingerprintDevices.enabled, sn: hrFingerprintDevices.serialNumber })
      .from(hrFingerprintDevices)
      .where(eq(hrFingerprintDevices.id, id))
      .for("update")
      .limit(1);
    if (!d) throw new TRPCError({ code: "NOT_FOUND", message: "الجهاز غير موجود" });
    if (d.enabled) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "لا يُحذف جهازٌ معتمَد — بصماته جزء من سجلّ الحضور. عطّله بدل حذفه.",
      });
    }
    const [{ n: punches }] = await tx
      .select({ n: sql<number>`COUNT(*)` })
      .from(hrAttendancePunches)
      .where(eq(hrAttendancePunches.deviceId, id));
    if (Number(punches) > 0) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `لا يُحذف جهازٌ استُلمت منه بصمات (${punches}) — حذفه يُيتّم سجلّ حضور.`,
      });
    }
    const [{ n: users }] = await tx
      .select({ n: sql<number>`COUNT(*)` })
      .from(hrDeviceUsers)
      .where(eq(hrDeviceUsers.deviceId, id));
    if (Number(users) > 0) {
      throw new TRPCError({ code: "BAD_REQUEST", message: `لا يُحذف جهازٌ له مستخدمون مرتبطون (${users}).` });
    }
    await tx.delete(hrDeviceCommands).where(eq(hrDeviceCommands.deviceId, id));
    await tx.delete(hrFingerprintDevices).where(eq(hrFingerprintDevices.id, id));
    return { id, deleted: true, name: d.name, serialNumber: d.sn };
  });
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

function hasSecureIdentityBinding(serialNumber: string | null | undefined, ip: string | null | undefined): boolean {
  const sn = serialNumber?.trim();
  const security = resolveBridgeSecurityConfig();
  const binding = sn ? security.deviceIdentityBindings[sn] : undefined;
  if (binding) {
    return Boolean(binding.sharedSecret) || (
      binding.allowlist.length > 0 && binding.allowlist.every(isExactHostNetwork)
    );
  }
  if (ip?.trim()) return isExactHostNetwork(ip.trim());
  return security.legacyIdentityMigration;
}

async function assertCandidateIdentityReady(candidate: {
  id?: number;
  serialNumber: string | null | undefined;
  ip: string | null | undefined;
}): Promise<void> {
  const db = requireDb();
  const rows = await db
    .select({
      id: hrFingerprintDevices.id,
      serialNumber: hrFingerprintDevices.serialNumber,
      ip: hrFingerprintDevices.ip,
    })
    .from(hrFingerprintDevices)
    .where(eq(hrFingerprintDevices.enabled, true));
  const devices = rows
    .filter((row) => row.id !== candidate.id)
    .concat([{ id: candidate.id ?? -1, serialNumber: candidate.serialNumber ?? null, ip: candidate.ip ?? null }]);
  const failure = enabledDeviceIdentityFailure(devices, resolveBridgeSecurityConfig());
  if (failure) throw new TRPCError({ code: "BAD_REQUEST", message: failure });
}

/** يفشل عامل الجسر قبل listen إذا كانت أي هوية مفعّلة غير مكتملة أو مشتركة. */
export async function assertEnabledDeviceIdentityReadiness(): Promise<void> {
  const failure = await enabledDeviceIdentityRuntimeFailure(resolveBridgeSecurityConfig());
  if (failure) throw new Error(`HR_DEVICE_IDENTITY_NOT_READY:${failure}`);
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
  if (input.serialNumber?.trim() && !hasSecureIdentityBinding(input.serialNumber, input.ip)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "أدخل IP الجهاز أو اضبط ربط SN بمفتاح خاص قبل تفعيله. وضع الهوية القديمة مغلق.",
    });
  }
  const enableOnCreate = Boolean(input.serialNumber?.trim());
  if (enableOnCreate) {
    await assertCandidateIdentityReady({ serialNumber: input.serialNumber, ip: input.ip });
  }
  const db = requireDb();
  const [res] = await db.insert(hrFingerprintDevices).values({
    ...toValues(input),
    migrated: false,
    enabled: enableOnCreate,
  });
  return getDevice(extractInsertId(res));
}

export async function updateDevice(id: number, input: DeviceInput) {
  const db = requireDb();
  const [d] = await db.select().from(hrFingerprintDevices).where(eq(hrFingerprintDevices.id, id)).limit(1);
  if (!d) throw new Error("الجهاز غير موجود");
  const nextSerialNumber = input.serialNumber === undefined ? d.serialNumber : input.serialNumber;
  const nextIp = input.ip === undefined ? d.ip : input.ip;
  if (d.enabled && !hasSecureIdentityBinding(nextSerialNumber, nextIp)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "لا يمكن إزالة ربط الهوية من جهاز مفعّل. ثبّت IP أو مفتاح SN قبل الحفظ.",
    });
  }
  if (d.enabled) {
    await assertCandidateIdentityReady({ id, serialNumber: nextSerialNumber, ip: nextIp });
  }
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
  if (!hasSecureIdentityBinding(d.serialNumber, d.ip)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "لا يمكن اعتماد جهاز بلا IP مرصود أو مفتاح خاص مرتبط برقمه التسلسلي.",
    });
  }
  await assertCandidateIdentityReady({ id, serialNumber: d.serialNumber, ip: d.ip });
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
      effectiveFrom: hrDeviceUsers.effectiveFrom,
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

/**
 * ربوط جهاز الحضور الخاصّة بموظف واحد — مقلوب listDeviceUsers، ليُدار الربط من بطاقة
 * الموظف لا من شاشة الأجهزة وحدها. `hrDeviceUsers` يبقى مصدر الحقيقة الوحيد (لا حقل
 * مكرَّر على employees): علاقةٌ تحتمل جهازين (فرعان) واستبدال جهازٍ تالف بلا فقد تاريخ.
 * pendingPunches = بصماته الخام المعلَّقة بلا موظف على ذلك الجهاز/الرقم (طابور المراجعة).
 */
export async function listEmployeeDeviceLinks(employeeId: number) {
  const db = requireDb();
  return db
    .select({
      id: hrDeviceUsers.id,
      deviceId: hrDeviceUsers.deviceId,
      deviceName: hrFingerprintDevices.name,
      deviceEnabled: hrFingerprintDevices.enabled,
      branchName: branches.name,
      enrollId: hrDeviceUsers.enrollId,
      deviceUserName: hrDeviceUsers.name,
      cardNo: hrDeviceUsers.cardNo,
      effectiveFrom: hrDeviceUsers.effectiveFrom,
      syncedAt: hrDeviceUsers.syncedAt,
    })
    .from(hrDeviceUsers)
    .innerJoin(hrFingerprintDevices, eq(hrDeviceUsers.deviceId, hrFingerprintDevices.id))
    .leftJoin(branches, eq(hrFingerprintDevices.branchId, branches.id))
    .where(eq(hrDeviceUsers.employeeId, employeeId))
    .orderBy(hrDeviceUsers.deviceId);
}

/**
 * أرقام جهازٍ معيّن غير المربوطة بأي موظف — مصدر قائمة الاختيار في بطاقة الموظف.
 * الجهاز يُبلّغ الاسم المكتوب فيه (senduser/getuserlist) فيظهر «٧ — أحمد» ويسهل التطابق.
 */
export async function listUnlinkedDeviceUsers(deviceId: number) {
  const db = requireDb();
  return db
    .select({
      enrollId: hrDeviceUsers.enrollId,
      name: hrDeviceUsers.name,
      cardNo: hrDeviceUsers.cardNo,
    })
    .from(hrDeviceUsers)
    .where(and(eq(hrDeviceUsers.deviceId, deviceId), isNull(hrDeviceUsers.employeeId)))
    .orderBy(hrDeviceUsers.enrollId);
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
