/**
 * سياسة عزل أوضاع نقطة البيع (٢٣/٧/٢٦) — منفصلةٌ عن مكوّن العرض كي تكون **قابلة للاختبار** حتمياً.
 *
 * قرار المالك: فصلٌ كامل بين أقسام نقطة البيع الثلاثة (تجزئة / خدمات طباعة / استقبال) — صلاحيةً
 * ودرجاً. هذا الملف يحرس الصلاحية على الواجهة: كل وضعٍ محروسٌ **بوحدته الخادمية بالضبط** عبر
 * moduleAccessAllowed (نفس دلالة الخادم) فلا يرى الموظّفُ المخصّصُ لقسمٍ تبويبَ القسم الآخر:
 *   - RETAIL         → وحدة sales     (مرآة salesCashierProcedure)
 *   - PRINT_SERVICES → وحدة pos       (مرآة posCashierProcedure)
 *   - RECEPTION      → وحدة workorders (مرآة workordersCashierProcedure)
 *
 * الدلالة (moduleAccessAllowed): admin يمرّ دائماً؛ الدور ضمن allowedRoles يمرّ إن حقّقت خريطته
 * المحلولة FULL؛ أيّ دور آخر يمرّ **بمنحٍ صريح** للوحدة (permissionsOverride) — فلا مِنحةَ ميتة
 * ولا تبويبٌ يُرى بلا صلاحية بيعٍ فعلية. الفصل النقديّ (درج مستقلّ لكل وضع) في طبقة الوردية.
 */
import { moduleAccessAllowed, type PermissionMap, type RoleKey } from "@shared/permissions";

export type Mode = "RETAIL" | "PRINT_SERVICES" | "RECEPTION";

export interface ModeGate {
  /** وحدة الصلاحيات الحارسة — مرآة بوّابة الخادم للوضع. */
  module: string;
  /** الأدوار القالبية المسموح لها (خارجها: منحٌ صريح فقط). */
  allowedRoles: RoleKey[];
}

export const MODE_GATES: Record<Mode, ModeGate> = {
  RETAIL: { module: "sales", allowedRoles: ["cashier", "manager"] },
  PRINT_SERVICES: { module: "pos", allowedRoles: ["cashier", "manager"] },
  RECEPTION: { module: "workorders", allowedRoles: ["cashier", "manager"] },
};

/** هل يرى هذا المستخدمُ تبويبَ الوضع؟ — موحَّدة مع الخادم عبر moduleAccessAllowed. */
export function canSeeMode(
  mode: Mode,
  role: RoleKey | undefined,
  override?: PermissionMap | null,
): boolean {
  if (!role) return false;
  const gate = MODE_GATES[mode];
  return moduleAccessAllowed(role, override ?? null, gate.module, "FULL", gate.allowedRoles);
}
