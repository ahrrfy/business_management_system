import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";
import { applyPermissionOverrides, diffFromTemplate, resolvePermissions, type PermissionMap, type RoleKey } from "@shared/permissions";
import type { User } from "../drizzle/schema";
import { getSessionContext } from "./auth/session";
import { loadActiveCustomRole } from "./services/roleService";
import { getPlatformAdminFromRequest } from "./tenancy/platformAuth";
import type { PlatformAdmin } from "./tenancy/controlSchema";

/** المستخدم المُحلّل: صفّ users + (للأدوار المخصّصة) تسمية/مفتاح الدور للعرض. */
export type AuthUser = User & {
  customRoleLabel?: string | null;
  customRoleKey?: string | null;
  /** ش٢: دورٌ مخصّص مُسنَد لكنه معطَّل/محذوف ⇒ هبط الحساب فشلاً مغلقاً إلى «user» (لا الفئة الكاملة). */
  roleLockedByInactiveCustomRole?: boolean;
};

export type TrpcContext = {
  req: CreateExpressContextOptions["req"];
  res: CreateExpressContextOptions["res"];
  user: AuthUser | null;
  /** معرّف سطر الجلسة الفردية الحالية (userSessions.id) — null لتوكنات legacy بلا sid
   *  أو حين لا مستخدم. يُستعمل لتمييز «الجلسة الحالية» في شاشة عرض الجلسات ولإبطالها. */
  sessionId: number | null;
  /** مدير منصّة (تعدّد الشركات) — منفصل تماماً عن `user` (لا ينتمي لأي شركة). */
  platformAdmin: PlatformAdmin | null;
};

/** Normalize the one persisted company owner to the effective admin contract. */
export function normalizeOwnerAuthority(user: AuthUser): AuthUser {
  if (!user.isOwner) return user;
  user.role = "admin" as User["role"];
  user.permissionsOverride = null;
  user.customRoleLabel = null;
  user.customRoleKey = null;
  user.roleLockedByInactiveCustomRole = false;
  return user;
}

/**
 * يحلّ الدور المخصّص (إن وُجد) إلى آلية الصلاحيات القائمة:
 *  role ← baseRole (للبوّابات الخشنة + قاعدة requireModule)،
 *  permissionsOverride ← خريطة الدور المخصّص، ثم استثناء المستخدم الفردي إن وُجد.
 * هكذا تعمل كل البوّابات (requireRole/requireModule/canSeeCost) بلا أي تغيير، وتنتشر تعديلات
 * الدور لحظياً (يُقرأ الدور طازجاً كل طلب). إن عُطِّل الدور/حُذف ⇒ نرجع للدور المخزَّن (baseRole) بأمان.
 */
export async function resolveCustomRole(user: AuthUser): Promise<void> {
  if (!user.customRoleId) return;
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
}

export async function createContext(
  opts: CreateExpressContextOptions
): Promise<TrpcContext> {
  let user: AuthUser | null = null;
  let sessionId: number | null = null;
  try {
    const sessionCtx = await getSessionContext(opts.req);
    user = sessionCtx.user as AuthUser | null;
    sessionId = sessionCtx.sessionId;
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
  return { req: opts.req, res: opts.res, user, sessionId, platformAdmin };
}
