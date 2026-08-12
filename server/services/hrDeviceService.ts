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
import { onlineDeviceIds } from "./hrDevices/registry";
import { resolveBridgeConfig } from "./hrDevices/types";
import {
  enabledDeviceIdentityFailure,
  isExactHostNetwork,
  resolveBridgeSecurityConfig,
} from "./hrDevices/bridgeSecurity";
import { resolveTargetBranch, type CompanyBranchScope } from "./companyBranchScope";

const COMPANY_SCOPE: CompanyBranchScope = { branchId: null };

function deviceScopeCondition(scope: CompanyBranchScope) {
  return scope.branchId == null ? undefined : eq(hrFingerprintDevices.branchId, scope.branchId);
}

function deviceByIdCondition(id: number, scope: CompanyBranchScope) {
  const branch = deviceScopeCondition(scope);
  return branch ? and(eq(hrFingerprintDevices.id, id), branch) : eq(hrFingerprintDevices.id, id);
}

async function assertDeviceInScope(id: number, scope: CompanyBranchScope): Promise<void> {
  const db = requireDb();
  const [device] = await db
    .select({ id: hrFingerprintDevices.id })
    .from(hrFingerprintDevices)
    .where(deviceByIdCondition(id, scope))
    .limit(1);
  if (!device) throw new TRPCError({ code: "NOT_FOUND", message: "الجهاز غير موجود" });
}

async function assertEmployeeInScope(id: number, scope: CompanyBranchScope): Promise<void> {
  const db = requireDb();
  const branch = scope.branchId == null ? undefined : eq(employees.branchId, scope.branchId);
  const [employee] = await db
    .select({ id: employees.id })
    .from(employees)
    .where(branch ? and(eq(employees.id, id), branch) : eq(employees.id, id))
    .limit(1);
  if (!employee) throw new TRPCError({ code: "NOT_FOUND", message: "الموظف غير موجود" });
}

export async function listScopedDeviceIds(scope: CompanyBranchScope = COMPANY_SCOPE): Promise<number[]> {
  const db = requireDb();
  const rows = await db
    .select({ id: hrFingerprintDevices.id })
    .from(hrFingerprintDevices)
    .where(deviceScopeCondition(scope));
  return rows.map((row) => Number(row.id));
}

/**
 * قائمة الأجهزة مع اسم الفرع. الأحدث أولاً.
 *
 * `usersCount`/`recordsCount` هما ما يقوله **الجهاز عن نفسه** (devInfo) — ثابتان لا يتحرّكان
 * أثناء الرفع، فلا يصلحان مؤشّرَ تقدّم. لذا نُرفق العدّ الحقيقيّ من قاعدتنا:
 * `receivedPunches` (ما استُلم فعلاً) و`pendingPunches` (بلا موظف ⇒ طابور المراجعة).
 * بدونهما كان المستخدم يرى «61 / 36815» جامداً ويظنّ الاستيراد متوقّفاً وهو يعمل.
 */
export async function listDevices(scope: CompanyBranchScope = COMPANY_SCOPE) {
  const db = requireDb();
  const rows = await db
    .select({ ...getTableColumns(hrFingerprintDevices), branchName: branches.name })
    .from(hrFingerprintDevices)
    .leftJoin(branches, eq(hrFingerprintDevices.branchId, branches.id))
    .where(deviceScopeCondition(scope))
    .orderBy(desc(hrFingerprintDevices.id));
  if (rows.length === 0) return [];
  const stats = await db
    .select({
      deviceId: hrAttendancePunches.deviceId,
      received: sql<number>`COUNT(*)`,
      pending: sql<number>`SUM(CASE WHEN ${hrAttendancePunches.employeeId} IS NULL THEN 1 ELSE 0 END)`,
    })
    .from(hrAttendancePunches)
    .innerJoin(hrFingerprintDevices, eq(hrAttendancePunches.deviceId, hrFingerprintDevices.id))
    .where(deviceScopeCondition(scope))
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
export async function deleteDevice(id: number, scope: CompanyBranchScope = COMPANY_SCOPE) {
  return withTx(async (tx) => {
    const [d] = await tx
      .select({ id: hrFingerprintDevices.id, name: hrFingerprintDevices.name, enabled: hrFingerprintDevices.enabled, sn: hrFingerprintDevices.serialNumber })
      .from(hrFingerprintDevices)
      .where(deviceByIdCondition(id, scope))
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

export async function getDevice(id: number, scope: CompanyBranchScope = COMPANY_SCOPE) {
  const db = requireDb();
  const [d] = await db
    .select({ ...getTableColumns(hrFingerprintDevices), branchName: branches.name })
    .from(hrFingerprintDevices)
    .leftJoin(branches, eq(hrFingerprintDevices.branchId, branches.id))
    .where(deviceByIdCondition(id, scope))
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

export { assertEnabledDeviceIdentityReadiness } from "./hrDevices/readiness";

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

/**
 * تعديلٌ جزئيّ: يُبقي كل حقلٍ لم يُرسَل كما هو في القاعدة. مقصودٌ أن يختلف عن `toValues`
 * (المستعمل في الإنشاء حيث الغياب = «بلا قيمة» فعلاً) — الشاشة تُرسل حقول التعريف فقط،
 * وبقيّة الأعمدة يكتبها الجهاز نفسه عند المصافحة فلا يجوز لتعديلٍ بشريّ أن يدهسها.
 */
function toPatch(input: DeviceInput) {
  const all = toValues(input) as Record<string, unknown>;
  const provided = input as unknown as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  for (const key of Object.keys(all)) {
    // `name` إلزاميّ في العقد ويُرسَل دائماً؛ البقيّة تُكتب فقط إن حملها الطلب صراحةً.
    if (key === "name" || provided[key] !== undefined) patch[key] = all[key];
  }
  return patch;
}

export async function createDevice(input: DeviceInput, scope: CompanyBranchScope = COMPANY_SCOPE) {
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
  const branchId = resolveTargetBranch(scope, input.branchId, { required: false });
  const [res] = await db.insert(hrFingerprintDevices).values({
    ...toValues({ ...input, branchId }),
    migrated: false,
    enabled: enableOnCreate,
  });
  return getDevice(extractInsertId(res), scope);
}

export async function updateDevice(id: number, input: DeviceInput, scope: CompanyBranchScope = COMPANY_SCOPE) {
  const db = requireDb();
  const [d] = await db.select().from(hrFingerprintDevices).where(deviceByIdCondition(id, scope)).limit(1);
  if (!d) throw new TRPCError({ code: "NOT_FOUND", message: "الجهاز غير موجود" });
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
  // ⚠️ دمجٌ لا استبدال (مراجعة عادية): `toValues` يحوّل الحقول الغائبة إلى null/0/"offline"،
  // فتعديلُ الاسم وحده كان يمسح `serverHost`/`serverPort` (بيانات الهجرة) ويصفّر العدّادات
  // الحيّة (`usersCount`/`recordsCount`/`firmware`) ويعيد الحالة «منقطع». نكتب المُرسَل فقط.
  const branchId = input.branchId === undefined
    ? undefined
    : resolveTargetBranch(scope, input.branchId, { required: false });
  const scopedInput = branchId === undefined ? input : { ...input, branchId };
  await db
    .update(hrFingerprintDevices)
    .set(toPatch(scopedInput))
    .where(deviceByIdCondition(id, scope));
  return getDevice(id, scope);
}

/**
 * هجرة الجهاز إلى خادم الرؤية العربية: يُعاد توجيه serverHost/serverPort إلى الوجهة المملوكة
 * ويُرفع علم migrated. عملية ذرّية: إن فشل أي جزء تُلغى كاملة.
 */
export async function migrateDevice(id: number, scope: CompanyBranchScope = COMPANY_SCOPE) {
  return withTx(async (tx) => {
    const [d] = await tx.select().from(hrFingerprintDevices).where(deviceByIdCondition(id, scope)).for("update").limit(1);
    if (!d) throw new TRPCError({ code: "NOT_FOUND", message: "الجهاز غير موجود" });
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
export async function approveDevice(
  id: number,
  patch: { name?: string; branchId?: number | null },
  scope: CompanyBranchScope = COMPANY_SCOPE,
) {
  const db = requireDb();
  const [d] = await db.select().from(hrFingerprintDevices).where(deviceByIdCondition(id, scope)).limit(1);
  if (!d) throw new TRPCError({ code: "NOT_FOUND", message: "الجهاز غير موجود" });
  if (!hasSecureIdentityBinding(d.serialNumber, d.ip)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "لا يمكن اعتماد جهاز بلا IP مرصود أو مفتاح خاص مرتبط برقمه التسلسلي.",
    });
  }
  await assertCandidateIdentityReady({ id, serialNumber: d.serialNumber, ip: d.ip });
  const branchId = patch.branchId === undefined
    ? undefined
    : resolveTargetBranch(scope, patch.branchId, { required: false });
  await db
    .update(hrFingerprintDevices)
    .set({
      enabled: true,
      ...(patch.name?.trim() ? { name: patch.name.trim() } : {}),
      ...(branchId !== undefined ? { branchId } : {}),
    })
    .where(deviceByIdCondition(id, scope));
  return getDevice(id, scope);
}

/** حالة الجسر للشاشة: مفعَّل؟ منفذه (7788 افتراضاً)؟ ومن المتصل الآن فعلاً (وصلات حية بالذاكرة).
 *  يشارك resolveBridgeConfig نفسه مع مسار الإقلاع فلا يتباعد المعروض عن الفعلي. */
export async function bridgeStatus(scope: CompanyBranchScope = COMPANY_SCOPE) {
  const cfg = resolveBridgeConfig();
  const visibleDeviceIds = scope.branchId == null ? null : new Set(await listScopedDeviceIds(scope));
  return {
    enabled: cfg.enabled,
    port: cfg.enabled ? cfg.port : null,
    onlineDeviceIds: visibleDeviceIds == null
      ? onlineDeviceIds()
      : onlineDeviceIds().filter((id) => visibleDeviceIds.has(Number(id))),
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
export async function listPunches(filters: PunchFilters = {}, scope: CompanyBranchScope = COMPANY_SCOPE) {
  const db = requireDb();
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
  const offset = Math.max(filters.offset ?? 0, 0);
  const conds: SQL[] = [];
  const branch = deviceScopeCondition(scope);
  if (branch) conds.push(branch);
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
export async function listDeviceUsers(deviceId: number, scope: CompanyBranchScope = COMPANY_SCOPE) {
  const db = requireDb();
  await assertDeviceInScope(deviceId, scope);
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
    .innerJoin(hrFingerprintDevices, eq(hrDeviceUsers.deviceId, hrFingerprintDevices.id))
    .leftJoin(employees, eq(hrDeviceUsers.employeeId, employees.id))
    .where(
      deviceScopeCondition(scope)
        ? and(eq(hrDeviceUsers.deviceId, deviceId), deviceScopeCondition(scope)!)
        : eq(hrDeviceUsers.deviceId, deviceId),
    )
    .orderBy(hrDeviceUsers.enrollId);
  return rows.map((r) => ({ ...r, employeeName: r.firstName ? fullEmployeeName(r) : null }));
}

/**
 * ربوط جهاز الحضور الخاصّة بموظف واحد — مقلوب listDeviceUsers، ليُدار الربط من بطاقة
 * الموظف لا من شاشة الأجهزة وحدها. `hrDeviceUsers` يبقى مصدر الحقيقة الوحيد (لا حقل
 * مكرَّر على employees): علاقةٌ تحتمل جهازين (فرعان) واستبدال جهازٍ تالف بلا فقد تاريخ.
 * pendingPunches = بصماته الخام المعلَّقة بلا موظف على ذلك الجهاز/الرقم (طابور المراجعة).
 */
export async function listEmployeeDeviceLinks(employeeId: number, scope: CompanyBranchScope = COMPANY_SCOPE) {
  const db = requireDb();
  await assertEmployeeInScope(employeeId, scope);
  const branch = deviceScopeCondition(scope);
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
    .where(branch ? and(eq(hrDeviceUsers.employeeId, employeeId), branch) : eq(hrDeviceUsers.employeeId, employeeId))
    .orderBy(hrDeviceUsers.deviceId);
}

/**
 * أرقام جهازٍ معيّن غير المربوطة بأي موظف — مصدر قائمة الاختيار في بطاقة الموظف.
 * الجهاز يُبلّغ الاسم المكتوب فيه (senduser/getuserlist) فيظهر «٧ — أحمد» ويسهل التطابق.
 */
export async function listUnlinkedDeviceUsers(deviceId: number, scope: CompanyBranchScope = COMPANY_SCOPE) {
  const db = requireDb();
  await assertDeviceInScope(deviceId, scope);
  return db
    .select({
      enrollId: hrDeviceUsers.enrollId,
      name: hrDeviceUsers.name,
      cardNo: hrDeviceUsers.cardNo,
    })
    .from(hrDeviceUsers)
    .innerJoin(hrFingerprintDevices, eq(hrDeviceUsers.deviceId, hrFingerprintDevices.id))
    .where(
      deviceScopeCondition(scope)
        ? and(eq(hrDeviceUsers.deviceId, deviceId), isNull(hrDeviceUsers.employeeId), deviceScopeCondition(scope)!)
        : and(eq(hrDeviceUsers.deviceId, deviceId), isNull(hrDeviceUsers.employeeId)),
    )
    .orderBy(hrDeviceUsers.enrollId);
}

/** آخر أوامر جهاز (الأحدث أولاً) مع اسم مُصدرها — تتبع صادق لا ادعاء. */
export async function listCommands(deviceId: number, limit = 30, scope: CompanyBranchScope = COMPANY_SCOPE) {
  const db = requireDb();
  await assertDeviceInScope(deviceId, scope);
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
    .innerJoin(hrFingerprintDevices, eq(hrDeviceCommands.deviceId, hrFingerprintDevices.id))
    .leftJoin(users, eq(hrDeviceCommands.createdBy, users.id))
    .where(
      deviceScopeCondition(scope)
        ? and(eq(hrDeviceCommands.deviceId, deviceId), deviceScopeCondition(scope)!)
        : eq(hrDeviceCommands.deviceId, deviceId),
    )
    .orderBy(desc(hrDeviceCommands.id))
    .limit(Math.min(Math.max(limit, 1), 100));
}

/** عدّادات الهجرة: الإجمالي / المُهاجَر / المتبقّي. */
export async function migrationStatus(scope: CompanyBranchScope = COMPANY_SCOPE) {
  const db = requireDb();
  const [r] = await db
    .select({
      total: sql<number>`count(*)`,
      migrated: sql<number>`sum(case when ${hrFingerprintDevices.migrated} = 1 then 1 else 0 end)`,
    })
    .from(hrFingerprintDevices)
    .where(deviceScopeCondition(scope));
  const total = Number(r?.total ?? 0);
  const migrated = Number(r?.migrated ?? 0);
  return { total, migrated, pending: total - migrated };
}
