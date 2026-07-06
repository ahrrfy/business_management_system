// navVisibility.ts — مصدر RBAC موحَّد للواجهة (تنقّل + تبويبات الـ hubs).
// يكرّر منطق AppLayout الثلاثي (adminOnly / managerOnly / roles) بالضبط في دالة واحدة
// قابلة لإعادة الاستخدام ⇒ لا تكرار بين الشريط الجانبي و PageTabs.
// ٦/٧/٢٦: أُضيف بُعد الوحدة (module/level): عنصرٌ فشل قيدُ دوره يظهر مع ذلك لمن مُنح
// وحدته صراحةً (permissionsOverride/دور مخصّص) — مرآةُ بوّابة الخادم requireModuleGate.
// ⚠️ راحة بصرية فقط — الإنفاذ الأمني الحقيقي خادمي (server/trpc.ts) + RequireRole.
import { levelSatisfies, type AccessLevel, type PermissionMap, type RoleKey } from "@shared/permissions";

/** قيد وصول لعنصر تنقّل/تبويب — أيٌّ منها (أو لا شيء = مرئي للكل). */
export type RoleGate = {
  /** مرئي لـ admin فقط. */
  adminOnly?: boolean;
  /** مرئي لـ admin أو manager. */
  managerOnly?: boolean;
  /** مرئي لأحد هذه الأدوار (admin يرى دائماً). */
  roles?: RoleKey[];
  /** مفتاح وحدة الصلاحيات — المنح الصريح لها (بالمستوى level) يُظهر العنصر ولو فشل قيد الدور. */
  module?: string;
  /** المستوى الأدنى المطلوب مع module (الافتراضي READ). */
  level?: AccessLevel;
};

/**
 * هل يرى المستخدم (بدوره role وصلاحياته الممنوحة override) عنصراً يحمل القيد gate؟
 * قيد الدور يطابق حرفياً منطق AppLayout التاريخي، وmodule يفتح مساراً إضافياً بالمنح الصريح.
 */
export function canSeeGate(
  gate: RoleGate | undefined,
  role: string | null | undefined,
  override?: PermissionMap | null
): boolean {
  if (!gate) return true;
  const isAdmin = role === "admin";
  const isManager = isAdmin || role === "manager";
  const roleOk =
    (!gate.adminOnly || isAdmin) &&
    (!gate.managerOnly || isManager) &&
    (!gate.roles || isAdmin || (role != null && gate.roles.includes(role as RoleKey)));
  if (roleOk) return true;
  // adminOnly حصري عمداً (إدارة النظام) — لا يُفتح بمنح وحدة.
  if (gate.adminOnly) return false;
  if (gate.module) return levelSatisfies(override?.[gate.module], gate.level ?? "READ");
  return false;
}
