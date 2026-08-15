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
 * التقارير التشخيصية وإجراءات قطع/تفعيل الدفتر تشارك سطحاً واحداً؛ القراءة
 * خادميّاً adminProcedure والكتابة تضيف FULL + 2FA، لذلك لا يظهر التبويب لمدير.
 */
export const RECONCILE_CONTROL_GATE = Object.freeze({
  adminOnly: true,
}) satisfies RoleGate;

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
  // adminOnly حصري عمداً (إدارة النظام) — لا يُفتح بمنح وحدة.
  if (gate.adminOnly) return isAdmin;
  // بوّابة الوحدة تُحسم بالخريطة المحلولة (قالب الدور + المنح الصريح) — تدقيق ١٧/٧: كان القيد بلا قيود
  // دور يعيد true فراغياً (roleOk صحيح فراغياً) فيُظهر تبويبات module-only لكل الأدوار وإن رفضها الخادم
  // بـ403؛ كما كان يستشير المنح الصريح (override) وحده لا قالب الدور. الآن يطابق الخادم بدقّة:
  //   مع قيد دور ⇒ مرآة requireModuleGate (منح صريح للأدوار خارج القائمة)؛ بلا قيد دور ⇒ مرآة requireModule (القالب).
  if (gate.module) {
    const lvl = gate.level ?? "READ";
    if (gate.roles) {
      return moduleAccessAllowed(role ?? "", override, gate.module, lvl, gate.roles);
    }
    if (gate.managerOnly) {
      return moduleAccessAllowed(role ?? "", override, gate.module, lvl, ["manager"]);
    }
    return hasModuleAccess(role ?? "", override, gate.module, lvl);
  }
  if (gate.managerOnly) return isAdmin || role === "manager";
  if (gate.roles) return isAdmin || (role != null && gate.roles.includes(role as RoleKey));
  // لا قيد دور ولا وحدة ⇒ مرئي للكل.
  return true;
}
