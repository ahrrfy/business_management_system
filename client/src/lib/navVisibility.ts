// navVisibility.ts — مصدر RBAC موحَّد للواجهة (تنقّل + تبويبات الـ hubs).
// يكرّر منطق AppLayout الثلاثي (adminOnly / managerOnly / roles) بالضبط في دالة واحدة
// قابلة لإعادة الاستخدام ⇒ لا تكرار بين الشريط الجانبي و PageTabs.
// ⚠️ راحة بصرية فقط — الإنفاذ الأمني الحقيقي خادمي (requireModule في trpc.ts) + RequireRole.
import type { RoleKey } from "@shared/permissions";

/** قيد وصول لعنصر تنقّل/تبويب — أيٌّ من الثلاثة (أو لا شيء = مرئي للكل). */
export type RoleGate = {
  /** مرئي لـ admin فقط. */
  adminOnly?: boolean;
  /** مرئي لـ admin أو manager. */
  managerOnly?: boolean;
  /** مرئي لأحد هذه الأدوار (admin يرى دائماً). */
  roles?: RoleKey[];
};

/**
 * هل يرى المستخدم (بدوره role) عنصراً يحمل القيد gate؟
 * يطابق حرفياً منطق AppLayout السابق:
 *   (!adminOnly || isAdmin) && (!managerOnly || isManager) && (!roles || isAdmin || roles.includes(role))
 */
export function canSeeGate(gate: RoleGate | undefined, role: string | null | undefined): boolean {
  if (!gate) return true;
  const isAdmin = role === "admin";
  const isManager = isAdmin || role === "manager";
  if (gate.adminOnly && !isAdmin) return false;
  if (gate.managerOnly && !isManager) return false;
  if (gate.roles && !isAdmin && !(role != null && gate.roles.includes(role as RoleKey))) return false;
  return true;
}
