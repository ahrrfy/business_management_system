import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";
import { applyPermissionOverrides, diffFromTemplate, resolvePermissions, type PermissionMap, type RoleKey } from "@shared/permissions";
import {
  resolveAtomicPermissions,
  resolveOperationalCaps,
  resolveSensitiveDataMasking,
  type AtomicPermissionsMap,
  type OperationalCaps,
  type SensitiveDataMasking,
} from "@shared/atomicPermissions";
import type { User } from "../drizzle/schema";
import type { NativeClientId } from "./auth/deviceProof";
import { getSessionContext } from "./auth/session";
import { loadActiveCustomRole } from "./services/roleService";
import { getPlatformAdminFromRequest } from "./tenancy/platformAuth";
import type { PlatformAdmin } from "./tenancy/controlSchema";
import {
  buildOperationPolicyFromLegacy,
  operationPolicySchema,
  resolveOperationPolicy,
  summarizeOperationModules,
  type OperationPolicy,
} from "@shared/operationPermissions";

/** المستخدم المُحلّل: صفّ users + (للأدوار المخصّصة) تسمية/مفتاح الدور للعرض + الصلاحيات والسقوف المحلولة. */
export type AuthUser = User & {
  operationPolicy: OperationPolicy | null;
  customRoleLabel?: string | null;
  customRoleKey?: string | null;
  /** ش٢: دورٌ مخصّص مُسنَد لكنه معطَّل/محذوف ⇒ هبط الحساب فشلاً مغلقاً إلى «user» (لا الفئة الكاملة). */
  roleLockedByInactiveCustomRole?: boolean;
  resolvedAtomicPermissions?: AtomicPermissionsMap;
  resolvedOperationalCaps?: Required<OperationalCaps>;
  resolvedSensitiveDataMasking?: Required<SensitiveDataMasking>;
  operationPolicyEnabled?: boolean;
  resolvedOperationPolicy?: OperationPolicy;
  inheritedOperationPolicy?: OperationPolicy;
  inheritedOperationPolicyRevision?: number;
  roleOperationPolicy?: OperationPolicy | null;
};

export type TrpcContext = {
  req: CreateExpressContextOptions["req"];
  res: CreateExpressContextOptions["res"];
  user: AuthUser | null;
  /** معرّف سطر الجلسة الفردية الحالية (userSessions.id) — null لتوكنات legacy بلا sid
   *  أو حين لا مستخدم. يُستعمل لتمييز «الجلسة الحالية» في شاشة عرض الجلسات ولإبطالها. */
  sessionId: number | null;
  /**
   * A verified device-bound native app identity. This is populated by the
   * session verifier, never by accepting a client-provided header in a router.
   */
  nativeClientId: NativeClientId | null;
  /** مدير منصّة (تعدّد الشركات) — منفصل تماماً عن `user` (لا ينتمي لأي شركة). */
  platformAdmin: PlatformAdmin | null;
};

/** Normalize the one persisted company owner to the effective admin contract. */
export function normalizeOwnerAuthority(user: AuthUser): AuthUser {
  if (!user.isOwner) return user;
  user.role = "admin" as User["role"];
  user.permissionsOverride = null;
  user.operationPolicy = null;
  user.customRoleLabel = null;
  user.customRoleKey = null;
  user.roleLockedByInactiveCustomRole = false;
  user.resolvedAtomicPermissions = resolveAtomicPermissions("admin");
  user.resolvedOperationalCaps = resolveOperationalCaps("admin");
  user.resolvedSensitiveDataMasking = resolveSensitiveDataMasking("admin");
  user.operationPolicyEnabled = false;
  user.roleOperationPolicy = null;
  user.resolvedOperationPolicy = buildOperationPolicyFromLegacy(
    "admin",
    resolvePermissions("admin", null),
  );
  user.inheritedOperationPolicy = user.resolvedOperationPolicy;
  user.inheritedOperationPolicyRevision = 0;
  return user;
}

/**
 * يحلّ الدور المخصّص (إن وُجد) إلى آلية الصلاحيات القائمة:
 *  role ← baseRole (للبوّابات الخشنة + قاعدة requireModule)،
 *  permissionsOverride ← خريطة الدور المخصّص، ثم استثناء المستخدم الفردي إن وُجد.
 * هكذا تعمل كل البوّابات (requireRole/requireModule/canSeeCost) بلا أي تغيير، وتنتشر تعديلات
 * الدور لحظياً (يُقرأ الدور طازجاً كل طلب). إن عُطِّل الدور/حُذف ⇒ نرجع للدور المخزَّن (baseRole) بأمان.
 * كما يحلّ الصلاحيات الذرية والسقوف الرقمية للمستخدم (أدوار افتراضية ومخصصة واستثناءات).
 */
export async function resolveCustomRole(user: AuthUser): Promise<void> {
  if (!user || typeof user !== "object") return;
  const legacyIndividual = {
    permissionsOverride: user.permissionsOverride as PermissionMap | null,
    atomicPermissions: user.atomicPermissions as AtomicPermissionsMap | null,
  };
  if (!user.customRoleId) {
    const baseRole = user.role ?? "user";
    user.resolvedAtomicPermissions = resolveAtomicPermissions(
      baseRole,
      null,
      user.atomicPermissions as AtomicPermissionsMap | null,
    );
    user.resolvedOperationalCaps = resolveOperationalCaps(
      baseRole,
      null,
      user.operationalCaps as OperationalCaps | null,
    );
    user.resolvedSensitiveDataMasking = resolveSensitiveDataMasking(
    baseRole,
    null,
    null,
  );
    const modules = resolvePermissions(
      baseRole,
      user.permissionsOverride as PermissionMap | null,
    );
    const individualPolicy = user.operationPolicy == null ? null : operationPolicySchema.parse(user.operationPolicy);
    const inherited = buildOperationPolicyFromLegacy(
      baseRole,
      resolvePermissions(baseRole, null),
    );
    const legacyEffective = buildOperationPolicyFromLegacy(
      baseRole,
      modules,
      user.atomicPermissions as AtomicPermissionsMap | null,
      user.permissionsOverride as PermissionMap | null,
    );
    user.operationPolicyEnabled = individualPolicy != null;
    user.roleOperationPolicy = null;
    user.inheritedOperationPolicy = inherited;
    user.inheritedOperationPolicyRevision = 0;
    user.resolvedOperationPolicy = user.operationPolicyEnabled
      ? resolveOperationPolicy(
          baseRole,
          modules,
          inherited,
          individualPolicy,
          user.permissionsOverride as PermissionMap | null,
          legacyIndividual,
        )
      : legacyEffective;
    if (user.operationPolicyEnabled)
      user.permissionsOverride = diffFromTemplate(
        baseRole,
        summarizeOperationModules(user.resolvedOperationPolicy),
      );
    return;
  }
  const role = await loadActiveCustomRole(user.customRoleId);
  if (!role) {
    // ش٢ — إغلاق الفشل المفتوح: كان دورٌ مخصّص معطَّل/محذوف يُبقي baseRole المخزَّن (users.role)
    // ساري المفعول — وقد يكون «cashier» الكامل ⇒ الحساب يستعيد الأقسام الثلاثة صامتاً (تسريب
    // الفصل). نهبط الآن **فشلاً مغلقاً** إلى أضيق دور «user» (قراءة محدودة) ونصفّر الأوفررايد
    // ونوسم الحالة كي تظهر للمالك ويُصحَّح الإسناد. (الحرّاس القائمة تمنع تعطيل/حذف دورٍ عليه
    // مستخدمون، فهذا المسار دفاعٌ في العمق نادر البلوغ — لكنه يفشل بأمان لا باتّساع.)
    user.role = "user" as User["role"];
    user.permissionsOverride = null;
    user.customRoleLabel = null;
    user.customRoleKey = null;
    user.roleLockedByInactiveCustomRole = true;
    user.resolvedAtomicPermissions = resolveAtomicPermissions("user");
    user.resolvedOperationalCaps = resolveOperationalCaps("user");
    user.resolvedSensitiveDataMasking = resolveSensitiveDataMasking("user");
    user.operationPolicyEnabled = true;
    user.roleOperationPolicy = { version: 1, grants: {} };
    user.resolvedOperationPolicy = resolveOperationPolicy(
      "user",
      {},
      user.roleOperationPolicy,
      null,
    );
    user.inheritedOperationPolicy = user.resolvedOperationPolicy;
    user.inheritedOperationPolicyRevision = 0;
    return;
  }
  user.role = role.baseRole as RoleKey as User["role"];
  const baseRole = role.baseRole as RoleKey;
  // الدور المخصّص هو الأساس، وعمود المستخدم يحمل فقط الفروق الفردية عنه. نعيد تحويل
  // النتيجة إلى فرق عن قالب baseRole كي تبقى كل بوابات النظام الحالية كما هي.
  const customPermissions = resolvePermissions(baseRole, diffFromTemplate(baseRole, role.permissions as PermissionMap));
  const effectivePermissions = applyPermissionOverrides(
    customPermissions,
    user.permissionsOverride as PermissionMap | null,
  );
  user.permissionsOverride = diffFromTemplate(baseRole, effectivePermissions);
  user.customRoleLabel = role.label;
  user.customRoleKey = role.key;
  user.resolvedAtomicPermissions = resolveAtomicPermissions(
    baseRole,
    role.atomicPermissions as AtomicPermissionsMap | null,
    user.atomicPermissions as AtomicPermissionsMap | null,
  );
  user.resolvedOperationalCaps = resolveOperationalCaps(
    baseRole,
    role.operationalCaps as OperationalCaps | null,
    user.operationalCaps as OperationalCaps | null,
  );
  user.resolvedSensitiveDataMasking = resolveSensitiveDataMasking(
    baseRole,
    null,
    null,
  );
  const rolePolicy = role.operationPolicy == null ? null : operationPolicySchema.parse(role.operationPolicy);
  const individualPolicy = user.operationPolicy == null ? null : operationPolicySchema.parse(user.operationPolicy);
  const inherited =
    rolePolicy ??
    buildOperationPolicyFromLegacy(
      baseRole,
      customPermissions,
      role.atomicPermissions as AtomicPermissionsMap | null,
      diffFromTemplate(baseRole, customPermissions),
    );
  user.roleOperationPolicy = rolePolicy;
  user.operationPolicyEnabled =
    role.operationPolicy != null || user.operationPolicy != null;
  user.inheritedOperationPolicy = inherited;
  user.inheritedOperationPolicyRevision = role.operationPolicyRevision;
  user.resolvedOperationPolicy = user.operationPolicyEnabled
    ? resolveOperationPolicy(
        baseRole,
        effectivePermissions,
        inherited,
        individualPolicy,
        user.permissionsOverride as PermissionMap | null,
        legacyIndividual,
      )
    : buildOperationPolicyFromLegacy(
        baseRole,
        effectivePermissions,
        {
          ...role.atomicPermissions as AtomicPermissionsMap | null,
          ...user.atomicPermissions as AtomicPermissionsMap | null,
        },
        user.permissionsOverride as PermissionMap | null,
      );
  if (user.operationPolicyEnabled)
    user.permissionsOverride = diffFromTemplate(
      baseRole,
      summarizeOperationModules(user.resolvedOperationPolicy),
    );
}

export async function createContext(
  opts: Pick<CreateExpressContextOptions, "req" | "res">
): Promise<TrpcContext> {
  let user: AuthUser | null = null;
  let sessionId: number | null = null;
  let nativeClientId: NativeClientId | null = null;
  try {
    const sessionCtx = await getSessionContext(opts.req);
    user = sessionCtx.user as AuthUser | null;
    sessionId = sessionCtx.sessionId;
    nativeClientId = sessionCtx.nativeClientId;
    if (user?.isOwner) {
      // The persisted owner flag is the system authority invariant. Normalize
      // the request context before any router/middleware sees it so a stale
      // base/custom role or restrictive override cannot split owner access
      // between the mobile BFF and the underlying operational APIs.
      normalizeOwnerAuthority(user);
    } else if (user) {
      await resolveCustomRole(user);
    }
  } catch {
    user = null;
    sessionId = null;
    nativeClientId = null;
  }
  // مدير المنصّة: كوكي/JWT منفصلان تماماً (platformAuth.ts) — لا علاقة بجلسة الشركة أعلاه.
  // معظم الطلبات لا تحمل كوكي مدير المنصّة إطلاقاً ⇒ verifyPlatformSession يعود null فوراً
  // بلا لمس قاعدة التحكّم (تكلفة مهملة على المسار الشائع).
  let platformAdmin: PlatformAdmin | null = null;
  try {
    platformAdmin = await getPlatformAdminFromRequest(opts.req);
  } catch {
    platformAdmin = null;
  }
  return {
    req: opts.req,
    res: opts.res,
    user,
    sessionId,
    nativeClientId,
    platformAdmin,
  };
}
