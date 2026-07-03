import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";
import { diffFromTemplate, type PermissionMap, type RoleKey } from "@shared/permissions";
import type { User } from "../drizzle/schema";
import { getSessionContext } from "./auth/session";
import { loadActiveCustomRole } from "./services/roleService";
import { getPlatformAdminFromRequest } from "./tenancy/platformAuth";
import type { PlatformAdmin } from "./tenancy/controlSchema";

/** المستخدم المُحلّل: صفّ users + (للأدوار المخصّصة) تسمية/مفتاح الدور للعرض. */
export type AuthUser = User & {
  customRoleLabel?: string | null;
  customRoleKey?: string | null;
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

/**
 * يحلّ الدور المخصّص (إن وُجد) إلى آلية الصلاحيات القائمة:
 *  role ← baseRole (للبوّابات الخشنة + قاعدة requireModule)،
 *  permissionsOverride ← فرق خريطة الدور عن قالب baseRole (resolvePermissions يعيد بناء الخريطة).
 * هكذا تعمل كل البوّابات (requireRole/requireModule/canSeeCost) بلا أي تغيير، وتنتشر تعديلات
 * الدور لحظياً (يُقرأ الدور طازجاً كل طلب). إن عُطِّل الدور/حُذف ⇒ نرجع للدور المخزَّن (baseRole) بأمان.
 */
export async function resolveCustomRole(user: AuthUser): Promise<void> {
  if (!user.customRoleId) return;
  const role = await loadActiveCustomRole(user.customRoleId);
  if (!role) return; // الدور معطّل/محذوف ⇒ يبقى baseRole المخزَّن في users.role ساري المفعول
  user.role = role.baseRole as RoleKey as User["role"];
  user.permissionsOverride = diffFromTemplate(role.baseRole as RoleKey, role.permissions as PermissionMap);
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
    if (user) await resolveCustomRole(user);
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
