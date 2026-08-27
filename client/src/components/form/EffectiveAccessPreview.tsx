import {
  POS_STATION_LABEL,
  applyPermissionOverrides,
  deriveEffectiveAccess,
  diffFromTemplate,
  type EffectiveAccessSummary,
  type PermissionMap,
  type PosStation,
  type RoleKey,
} from "@shared/permissions";
import { ShoppingCart, Printer, Palette, Eye, EyeOff, Lock } from "lucide-react";

/**
 * معاينة «الأثر الفعليّ» (طبقة الشفافية — ش١ RBAC): تُظهر **ما سيراه/يفعله الحساب فعلاً** محسوباً
 * من الخريطة المحلولة (لا من الـdiff الخام) — «هذا الحساب سيرى: تجزئة فقط». تُستعمل لحظة الإسناد في
 * شاشتَي إضافة/تعديل المستخدم فيُلتقط خطأ اختيار الدور (السبب الأرجح لالتباس الكاشير) قبل الحفظ.
 *
 * للدور المبنيّ: مرّر (role, override الفرديّ). للدور المخصّص: مرّر (baseRole, diffFromTemplate(baseRole,
 * roleMap)) — كما يفعل السياق تماماً؛ الغلاف أدناه يحسبها من صفّ الدور المخصّص.
 */

const STATION_ICON: Record<PosStation, typeof ShoppingCart> = {
  RETAIL: ShoppingCart,
  PRINT_SERVICES: Printer,
  RECEPTION: Palette,
};
const STATION_CLS: Record<PosStation, string> = {
  RETAIL: "border-[var(--sem-pos)] bg-[var(--sem-pos-bg)] text-[var(--sem-pos)]",
  PRINT_SERVICES: "border-[var(--sem-info)] bg-[var(--sem-info-bg)] text-[var(--sem-info)]",
  RECEPTION: "border-violet-500 bg-violet-50 text-violet-700",
};

export function EffectiveAccessPreview({
  role,
  override,
  summary,
  title = "الأثر الفعليّ لهذا الحساب",
}: {
  role: RoleKey | string | undefined;
  override?: PermissionMap | null;
  /** ملخّصٌ محسوبٌ مسبقاً (خادمياً) — يُستعمل مباشرةً بدل إعادة الاشتقاق (يصدق على الأدوار المخصّصة). */
  summary?: EffectiveAccessSummary;
  title?: string;
}) {
  const eff = summary ?? deriveEffectiveAccess(role, override ?? null);
  const isAdmin = role === "admin";

  return (
    <div className="rounded-lg border bg-muted/20 p-3 space-y-2" role="status" aria-live="polite">
      <div className="text-xs font-semibold text-muted-foreground">{title}</div>
      {/* أقسام نقطة البيع التي سيفتحها فعلاً */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs text-muted-foreground">أقسام نقطة البيع:</span>
        {isAdmin ? (
          <span className="text-xs font-medium">كل الأقسام (مدير النظام)</span>
        ) : eff.stations.length === 0 ? (
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <Lock aria-hidden className="size-3" /> لا قسم بيع
          </span>
        ) : (
          eff.stations.map((s) => {
            const Icon = STATION_ICON[s];
            return (
              <span key={s} className={`inline-flex items-center gap-1 rounded-md border-2 px-2 py-0.5 text-xs font-bold ${STATION_CLS[s]}`}>
                <Icon aria-hidden className="size-3" />
                {POS_STATION_LABEL[s]} فقط
              </span>
            );
          })
        )}
      </div>
      {/* رؤية التكلفة/الربح */}
      <div className="flex items-center gap-1.5 text-xs">
        {eff.canSeeCost ? (
          <span className="inline-flex items-center gap-1 text-[var(--sem-warn)]"><Eye aria-hidden className="size-3" /> يرى التكلفة والربح</span>
        ) : (
          <span className="inline-flex items-center gap-1 text-muted-foreground"><EyeOff aria-hidden className="size-3" /> لا يرى التكلفة</span>
        )}
      </div>
    </div>
  );
}

/**
 * غلافٌ يحسب الأثر الفعليّ من حالة نموذج الإسناد (دور مبنيّ أو مخصّص). للدور المخصّص يحلّه إلى
 * baseRole + diff من خريطة الدور المخزَّنة (تماماً كالسياق) فتصدق المعاينة على أصحاب الأدوار المخصّصة.
 */
export function EffectiveAccessForAssignment({
  role,
  permsOverride,
  customRoleId,
  customRoles,
  title,
}: {
  role: RoleKey | string;
  permsOverride: PermissionMap | null | undefined;
  customRoleId: number | null;
  customRoles: { id: number | string; baseRole?: string; permissions?: unknown }[];
  title?: string;
}) {
  if (customRoleId != null) {
    const cr = customRoles.find((r) => Number(r.id) === customRoleId);
    if (!cr || !cr.baseRole) {
      return null;
    }
    const base = cr.baseRole as RoleKey;
    const customPermissions = (cr.permissions as PermissionMap) ?? {};
    const effectivePermissions = applyPermissionOverrides(customPermissions, permsOverride ?? null);
    const override = diffFromTemplate(base, effectivePermissions);
    return <EffectiveAccessPreview role={base} override={override} title={title} />;
  }
  return <EffectiveAccessPreview role={role} override={permsOverride ?? null} title={title} />;
}
