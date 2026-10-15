/**
 * roleService.ts — إدارة الأدوار المخصّصة (طلب المالك: مرونة في تسمية الأدوار وتحديد صلاحياتها).
 *
 * النموذج: الأدوار المبنية (١١) تبقى ثابتة في الكود (shared/permissions.ts) كقوالب آمنة.
 * هذا الجدول للأدوار **الإضافية** التي يصنعها المالك. كل دور مخصّص يحمل:
 *  - baseRole: الفئة الأساسية للبوّابات الخشنة (requireRole: cashier/warehouse/manager…).
 *  - permissions: خريطة الوحدات الكاملة للبوّابات الدقيقة (requireModule).
 * عند الإسناد لمستخدم: users.role=baseRole + users.customRoleId=id. خريطة الدور هي الأساس،
 * وpermissionsOverride (إن وُجد) هو فرق فردي فوقها؛ يحلّهما context إلى الآلية القائمة،
 * لذلك لا تغيير في requireModule والبوّابات (إضافيّ بالكامل).
 */
import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";
import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import {
  ALL_PERMISSION_MODULE_KEYS,
  ALL_ROLES,
  canSeeCost as builtinCanSeeCost,
  PERMISSION_MODULES,
  ROLE_TEMPLATES,
  ROLES,
  type AccessLevel,
  type PermissionMap,
  type RoleKey,
} from "@shared/permissions";
import {
  type AtomicPermissionsMap,
  type OperationalCaps,
  resolveOperationalCaps,
} from "@shared/atomicPermissions";
import {
  summarizeOperationModules,
  type OperationPolicy,
} from "@shared/operationPermissions";
import {
  buildDefaultRoleOperationPolicy,
  dailyOperationPaths,
} from "@shared/roleOperationPresets";
import { nanoid } from "nanoid";
import { roles, users } from "../../drizzle/schema";
import { getDb } from "../db";
import { withTx, type Actor } from "./tx";
import { extractInsertId } from "../lib/insertId";
import {
  assertOperationPolicyRevision,
  auditOperationPolicyTx,
  lockIdentityAdministrationTx,
  normalizeOperationPolicy,
  sameOperationPolicy,
} from "./operationPolicyStorage";

const ACCESS_VALUES: AccessLevel[] = ["FULL", "READ", "NONE"];
// `customers` and `tasks` remain storage/API compatibility keys for existing custom roles.
// `customers` maps to CRM; `tasks` is an eradicated unit preserved for database backward-compatibility.
const LEGACY_PERMISSION_KEYS = ["customers", "tasks"] as const;
const MODULE_KEYS = new Set<string>(ALL_PERMISSION_MODULE_KEYS);
const BUILTIN_KEYS = new Set<string>(ALL_ROLES);
/** مفاتيح الأدوار المبنية محجوزة — لا يجوز لدور مخصّص أن ينتحلها. */

export interface RolePermissions {
  [moduleKey: string]: AccessLevel;
}

export interface CreateRoleInput {
  label: string;
  key?: string;
  description?: string | null;
  baseRole: RoleKey;
  permissions: RolePermissions;
  atomicPermissions?: AtomicPermissionsMap | null;
  operationalCaps?: OperationalCaps | null;
  operationPolicy?: OperationPolicy | null;
}

export interface UpdateRoleInput {
  id: number;
  label?: string;
  description?: string | null;
  baseRole?: RoleKey;
  permissions?: RolePermissions;
  atomicPermissions?: AtomicPermissionsMap | null;
  operationalCaps?: OperationalCaps | null;
  operationPolicy?: OperationPolicy | null;
  expectedOperationPolicyRevision?: number;
}

/** يطبّع مفتاح الدور: لاتيني صغير + أرقام + شرطة سفلية، يبدأ بحرف. الأسماء العربية (بلا أحرف
 *  لاتينية) ⇒ مفتاح فريد عشوائي بدل `role_` الفارغ (الذي يصطدم عند ثاني اسم عربي). */
function slugifyKey(s: string): string {
  const base = (s ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
  if (base && /^[a-z]/.test(base)) return base;
  // لا جذر لاتيني صالح ⇒ مفتاح فريد (يبدأ بحرف، أحرف صغيرة/أرقام فقط).
  return `role_${nanoid(10)}`.toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 64);
}

function assertBaseRole(baseRole: string): asserts baseRole is RoleKey {
  if (!BUILTIN_KEYS.has(baseRole)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "الفئة الأساسية للدور غير صالحة." });
  }
  // admin محجوب كفئة أساس: requireModule يمنح admin وصولاً كاملاً يتجاوز الخريطة الدقيقة ⇒ يُفرِغ التخصيص.
  if (baseRole === "admin") {
    throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن اتخاذ «مدير النظام» فئةً أساسيةً لدور مخصّص (يمنح وصولاً كاملاً يتجاوز التخصيص). اختر فئةً أدنى." });
  }
}

/** يتحقّق من خريطة الصلاحيات ويُطبّعها: كل وحدة معروفة بمستوى صالح، والمفقود = NONE. */
function normalizePermissions(input: RolePermissions | null | undefined): PermissionMap {
  const out: PermissionMap = {};
  for (const m of PERMISSION_MODULES) {
    const v = input?.[m.key];
    out[m.key] = ACCESS_VALUES.includes(v as AccessLevel) ? (v as AccessLevel) : "NONE";
  }
  const legacyCustomers = input?.customers;
  out.customers = ACCESS_VALUES.includes(legacyCustomers as AccessLevel)
    ? (legacyCustomers as AccessLevel)
    : out.crm;
  // Old clients and stored payloads may know only `customers`; carry that level
  // into CRM when no explicit CRM decision exists.
  if (!ACCESS_VALUES.includes(input?.crm as AccessLevel) && ACCESS_VALUES.includes(legacyCustomers as AccessLevel)) {
    out.crm = legacyCustomers as AccessLevel;
  }
  const legacyTasks = input?.tasks;
  if (legacyTasks && ACCESS_VALUES.includes(legacyTasks as AccessLevel)) {
    out.tasks = legacyTasks as AccessLevel;
  }
  // ارفض مفاتيح غير معروفة صراحةً (لا تتجاهلها بصمت — قد تدلّ على خطأ عقد).
  for (const k of Object.keys(input ?? {})) {
    if (!MODULE_KEYS.has(k)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: `وحدة صلاحيات غير معروفة: ${k}` });
    }
  }
  return out;
}

function rethrowDup(e: any): never {
  const code = e?.code ?? e?.cause?.code ?? e?.cause?.cause?.code;
  if (code === "ER_DUP_ENTRY") {
    throw new TRPCError({ code: "CONFLICT", message: "مفتاح الدور مستخدم مسبقاً — اختر اسماً مختلفاً." });
  }
  throw e;
}

/** قوالب الأدوار المبنية للعرض (للقراءة فقط في الواجهة، تُغني عن استعلام DB). */
export function builtinRoles() {
  return ROLES.map((r) => ({
    key: r.key,
    label: r.label,
    description: r.description,
    baseRole: r.key,
    permissions: ROLE_TEMPLATES[r.key],
    canSeeCost: r.canSeeCost === true,
    isSystem: true as const,
    isActive: true as const,
    operationPolicy: buildDefaultRoleOperationPolicy(r.key, r.key, ROLE_TEMPLATES[r.key]),
    operationPolicyRevision: 0,
    operationalCaps: resolveOperationalCaps(r.key),
    dailyOperationPaths: dailyOperationPaths(r.key),
  }));
}

/** قائمة الأدوار المخصّصة من القاعدة. */
export async function listCustomRoles(includeInactive = false) {
  const db = getDb();
  if (!db) return [];
  const where = includeInactive ? undefined : eq(roles.isActive, true);
  const rows = await db.select().from(roles).where(where as any).orderBy(asc(roles.label));
  // ش٣: الأدوار القياسية المبذورة (كاشير تجزئة/طباعة/موظف استقبال) تحمل isSystem=true فعلياً في DB.
  return rows.map((r) => ({ ...r, isSystem: !!r.isSystem }));
}

export async function getRole(id: number) {
  const db = getDb();
  if (!db) return null;
  return (await db.select().from(roles).where(eq(roles.id, id)).limit(1))[0] ?? null;
}

/** يُحمّل دوراً مخصّصاً نشطاً لحلّ الصلاحيات في context (خفيف — يُستدعى للمستخدمين ذوي الدور المخصّص فقط). */
export async function loadActiveCustomRole(id: number) {
  const db = getDb();
  if (!db) return null;
  const r = (await db.select().from(roles).where(and(eq(roles.id, id), eq(roles.isActive, true))).limit(1))[0];
  return r ?? null;
}

export async function createRole(input: CreateRoleInput, _actor: Actor) {
  return withTx(async (tx) => {
    const { actor, assertAuthority } = await lockIdentityAdministrationTx(tx, _actor);
    const label = input.label?.trim();
    if (!label) throw new TRPCError({ code: "BAD_REQUEST", message: "اسم الدور مطلوب." });
    if (label.length > 120) throw new TRPCError({ code: "BAD_REQUEST", message: "اسم الدور طويل جداً." });
    assertBaseRole(input.baseRole);
    const key = slugifyKey(input.key?.trim() || label);
    if (BUILTIN_KEYS.has(key)) {
      throw new TRPCError({ code: "CONFLICT", message: "هذا المفتاح محجوز لدور مبني — اختر اسماً مختلفاً." });
    }
    const operationPolicy = normalizeOperationPolicy(input.operationPolicy);
    const permissions = operationPolicy
      ? normalizePermissions(summarizeOperationModules(operationPolicy))
      : normalizePermissions(input.permissions);
    try {
      assertAuthority();
      const res = await tx.insert(roles).values({
        key,
        label,
        description: input.description?.trim() || null,
        baseRole: input.baseRole,
        permissions,
        atomicPermissions: input.atomicPermissions ?? null,
        operationalCaps: input.operationalCaps ?? null,
        operationPolicy,
        operationPolicyRevision: operationPolicy ? 1 : 0,
        // رؤية التكلفة تتبع الفئة الأساسية (المدير/المحاسب يرونها؛ الكاشير/المخزن لا).
        canSeeCost: operationPolicy
          ? operationPolicy.dataVisibility?.purchaseCost === true
          : builtinCanSeeCost(input.baseRole),
        isActive: true,
      });
      const id = extractInsertId(res);
      if (operationPolicy)
        await auditOperationPolicyTx(
          tx,
          actor,
          "role",
          id,
          null,
          operationPolicy,
          0,
          1,
        );
      return { id, key, operationPolicyRevision: operationPolicy ? 1 : 0 };
    } catch (e) {
      rethrowDup(e);
    }
  });
}

export async function updateRole(input: UpdateRoleInput, _actor: Actor) {
  return withTx(async (tx) => {
    const locked = await lockIdentityAdministrationTx(tx, _actor, {
      roleIds: [input.id],
      affectedRoleId: input.id,
    });
    const existing = locked.roles.get(input.id);
    if (!existing) throw new TRPCError({ code: "NOT_FOUND", message: "الدور غير موجود." });
    const patch: Record<string, unknown> = {};
    if (input.label !== undefined) {
      const label = input.label.trim();
      if (!label) throw new TRPCError({ code: "BAD_REQUEST", message: "اسم الدور مطلوب." });
      patch.label = label;
    }
    if (input.description !== undefined) patch.description = input.description?.trim() || null;
    if (input.baseRole !== undefined) {
      // ش٣: الدور القياسيّ (isSystem) محميّ من تغيير فئته الأساس (يقلب معنى الأمان جذرياً) — التسمية
      // والوصف والخريطة قابلة للتحرير المُدقَّق، أمّا الفئة فثابتة. الأدوار المخصّصة بلا قيد.
      if (existing.isSystem && input.baseRole !== existing.baseRole) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن تغيير الفئة الأساسية لدور قياسيّ محميّ. أنشئ دوراً مخصّصاً بدله." });
      }
      assertBaseRole(input.baseRole);
      patch.baseRole = input.baseRole;
      patch.canSeeCost = builtinCanSeeCost(input.baseRole); // التكلفة تتبع الفئة الأساسية
    }
    if (input.permissions !== undefined) patch.permissions = normalizePermissions(input.permissions);
    if (input.atomicPermissions !== undefined) patch.atomicPermissions = input.atomicPermissions;
    if (input.operationalCaps !== undefined) patch.operationalCaps = input.operationalCaps;
    let operationPolicyRevision = existing.operationPolicyRevision;
    let nextOperationPolicy =
      existing.operationPolicy as OperationPolicy | null;
    let policyChanged = false;
    if (input.operationPolicy !== undefined) {
      if (input.operationPolicy === null && existing.operationPolicy != null) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "تعذّر إزالة مصفوفة تفويض الدور",
            why: "إزالتها تعيد بوابات الصلاحيات القديمة وقد توسّع التفويض خارج اختياراتك",
            doThis: "ألغِ تحديد جميع العمليات لحفظ دور بلا تفويض، أو عدّل العمليات المطلوبة",
          }),
        });
      }
      nextOperationPolicy = normalizeOperationPolicy(input.operationPolicy);
      if (nextOperationPolicy && (input.baseRole ?? existing.baseRole) === "admin") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "تعذّر تحويل دور مدير النظام إلى تفويض تشغيلي",
            why: "إدارة الهويات صلاحية إدارية محمية؛ فئة مدير النظام تمنح سلطات خارج المصفوفة",
            doThis: "أنشئ دوراً تشغيلياً بفئة أساسية أدنى وحدّد العمليات المطلوبة له",
          }),
        });
      }
      policyChanged = !sameOperationPolicy(
        existing.operationPolicy,
        nextOperationPolicy,
      );
      if (policyChanged) {
        assertOperationPolicyRevision(
          operationPolicyRevision,
          input.expectedOperationPolicyRevision,
        );
        patch.operationPolicy = nextOperationPolicy;
        patch.operationPolicyRevision = ++operationPolicyRevision;
      }
    }
    if (nextOperationPolicy) {
      patch.permissions = normalizePermissions(
        summarizeOperationModules(nextOperationPolicy),
      );
      patch.canSeeCost =
        nextOperationPolicy.dataVisibility?.purchaseCost === true;
    } else if (policyChanged) {
      patch.canSeeCost = builtinCanSeeCost(
        (input.baseRole ?? existing.baseRole) as RoleKey,
      );
    }
    if (Object.keys(patch).length === 0)
      return { id: input.id, changed: false, operationPolicyRevision };
    locked.assertAuthority();
    await tx.update(roles).set(patch).where(eq(roles.id, input.id));
    if (policyChanged)
      await auditOperationPolicyTx(
        tx,
        locked.actor,
        "role",
        input.id,
        existing.operationPolicy as OperationPolicy | null,
        nextOperationPolicy,
        existing.operationPolicyRevision,
        operationPolicyRevision,
      );
    // تغيير الدور يُبطل جلسات أصحابه (الصلاحيات/الفئة قد تغيّرت) كي يُعاد تحميل السياق.
    const affectedUserIds = Array.from(locked.users.values())
      .filter((user) => user.customRoleId === input.id).map((user) => user.id);
    if (affectedUserIds.length)
      await tx.update(users).set({ sessionsValidFrom: new Date() })
        .where(inArray(users.id, affectedUserIds));
    return { id: input.id, changed: true, operationPolicyRevision };
  });
}

export async function setRoleActive(id: number, isActive: boolean, _actor: Actor) {
  return withTx(async (tx) => {
    const r = (await tx.select().from(roles).where(eq(roles.id, id)).for("update").limit(1))[0];
    if (!r) throw new TRPCError({ code: "NOT_FOUND", message: "الدور غير موجود." });
    if (!isActive) {
      const inUse = (await tx.select({ n: sql<number>`COUNT(*)` }).from(users).where(and(eq(users.customRoleId, id), eq(users.isActive, true))))[0];
      if (Number(inUse?.n ?? 0) > 0) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن تعطيل دور مُسنَد لمستخدمين نشطين — غيّر أدوارهم أولاً." });
      }
    }
    await tx.update(roles).set({ isActive }).where(eq(roles.id, id));
    // ش٢: تغيير حالة الدور يُبطل جلسات أصحابه (تناظرٌ مع updateRole:201 الذي يُبطلها عند تعديل الخريطة).
    // تعطيلٌ ⇒ يُعاد تحميل السياق فيهبطون فشلاً مغلقاً؛ تفعيلٌ ⇒ يستعيدون صلاحيات الدور فوراً بلا كاش قديم.
    await tx.update(users).set({ sessionsValidFrom: new Date() }).where(eq(users.customRoleId, id));
    return { id, isActive };
  });
}

/** حذف دور مخصّص — ممنوع إن كان مُسنَداً لأي مستخدم (نشط أو معطّل) لحفظ سلامة المراجع. */
export async function deleteRole(id: number, _actor: Actor) {
  return withTx(async (tx) => {
    const r = (await tx.select().from(roles).where(eq(roles.id, id)).for("update").limit(1))[0];
    if (!r) throw new TRPCError({ code: "NOT_FOUND", message: "الدور غير موجود." });
    // ش٣: الأدوار القياسية المبذورة محميّة من الحذف (تُعطَّل عند عدم الحاجة، لا تُحذف).
    if (r.isSystem) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن حذف دور قياسيّ محميّ — عطّله بدل حذفه." });
    }
    const inUse = (await tx.select({ n: sql<number>`COUNT(*)` }).from(users).where(eq(users.customRoleId, id)))[0];
    if (Number(inUse?.n ?? 0) > 0) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن حذف دور مُسنَد لمستخدمين — عطّله أو غيّر أدوارهم أولاً." });
    }
    await tx.delete(roles).where(eq(roles.id, id));
    return { id, deleted: true };
  });
}

/** عدد المستخدمين لكل دور مخصّص (للعرض في القائمة). */
export async function roleUserCounts(): Promise<Record<number, number>> {
  const db = getDb();
  if (!db) return {};
  const rows = await db
    .select({ id: users.customRoleId, n: sql<number>`COUNT(*)` })
    .from(users)
    .where(isNotNull(users.customRoleId))
    .groupBy(users.customRoleId);
  const out: Record<number, number> = {};
  for (const r of rows) if (r.id != null) out[Number(r.id)] = Number(r.n);
  return out;
}
