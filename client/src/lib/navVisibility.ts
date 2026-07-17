// navVisibility.ts — مصدر RBAC موحَّد للواجهة (تنقّل + تبويبات الـ hubs).
// يكرّر منطق AppLayout الثلاثي (adminOnly / managerOnly / roles) بالضبط في دالة واحدة
// قابلة لإعادة الاستخدام ⇒ لا تكرار بين الشريط الجانبي و PageTabs.
// ٦/٧/٢٦: أُضيف بُعد الوحدة (module/level): عنصرٌ فشل قيدُ دوره يظهر مع ذلك لمن مُنح
// وحدته صراحةً (permissionsOverride/دور مخصّص) — مرآةُ بوّابة الخادم requireModuleGate.
// ⚠️ راحة بصرية فقط — الإنفاذ الأمني الحقيقي خادمي (server/trpc.ts) + RequireRole.
import { hasModuleAccess, moduleAccessAllowed, type AccessLevel, type PermissionMap, type RoleKey } from "@shared/permissions";

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
  const hasRoleConstraint = !!(gate.adminOnly || gate.managerOnly || gate.roles);
  const isAdmin = role === "admin";
  const isManager = isAdmin || role === "manager";
  const roleOk =
    (!gate.adminOnly || isAdmin) &&
    (!gate.managerOnly || isManager) &&
    (!gate.roles || isAdmin || (role != null && gate.roles.includes(role as RoleKey)));
  // قيد الدور الصريح ناجح ⇒ مرئي فوراً.
  if (hasRoleConstraint && roleOk) return true;
  // adminOnly حصري عمداً (إدارة النظام) — لا يُفتح بمنح وحدة.
  if (gate.adminOnly) return false;
  // بوّابة الوحدة تُحسم بالخريطة المحلولة (قالب الدور + المنح الصريح) — تدقيق ١٧/٧: كان القيد بلا قيود
  // دور يعيد true فراغياً (roleOk صحيح فراغياً) فيُظهر تبويبات module-only لكل الأدوار وإن رفضها الخادم
  // بـ403؛ كما كان يستشير المنح الصريح (override) وحده لا قالب الدور. الآن يطابق الخادم بدقّة:
  //   مع قيد دور ⇒ مرآة requireModuleGate (منح صريح للأدوار خارج القائمة)؛ بلا قيد دور ⇒ مرآة requireModule (القالب).
  if (gate.module) {
    const lvl = gate.level ?? "READ";
    return gate.roles
      ? moduleAccessAllowed(role ?? "", override, gate.module, lvl, gate.roles)
      : hasModuleAccess(role ?? "", override, gate.module, lvl);
  }
  // لا قيد دور ولا وحدة ⇒ مرئي للكل.
  return !hasRoleConstraint;
}
