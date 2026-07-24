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
import {
  POS_STATION_GATES,
  canUseStation,
  type PermissionMap,
  type PosStation,
  type RoleKey,
} from "@shared/permissions";

// طبقة الشفافية (ش١ RBAC): بوّابات أقسام POS صارت مصدرَ حقيقةٍ واحداً في shared/permissions.ts
// (POS_STATION_GATES) يستهلكه الخادم (users.effectivePermissions) والعميل معاً — فلا تعريفان متباينان.
// هذا الملف يُبقي أسماءه القديمة (Mode/MODE_GATES/canSeeMode) غلافاً رقيقاً فوق المصدر الموحَّد
// حفاظاً على مستهلكيه (PointOfSale.tsx واختباراته) بلا تغيير سلوكيّ.
export type Mode = PosStation;

export interface ModeGate {
  module: string;
  allowedRoles: RoleKey[];
}

export const MODE_GATES: Record<Mode, ModeGate> = POS_STATION_GATES;

/** هل يرى هذا المستخدمُ تبويبَ الوضع؟ — موحَّدة مع الخادم عبر canUseStation. */
export function canSeeMode(
  mode: Mode,
  role: RoleKey | undefined,
  override?: PermissionMap | null,
): boolean {
  return canUseStation(mode, role, override);
}
