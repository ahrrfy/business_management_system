/**
 * RequireRole — حارس وصول على مستوى الواجهة للشاشات الإدارية.
 *
 * مهم: هذا حارس واجهة فقط (UX/تجربة استخدام) — الإنفاذ الحقيقي للأمان
 * يقع في الخادم عبر بوّابات server/trpc.ts.
 *
 * ٦/٧/٢٦: كان يفحص اسم الدور فقط ويتجاهل الصلاحيات الممنوحة (permissionsOverride)
 * تماماً ⇒ منح المالك وحدةً لمستخدم لا يغيّر شيئاً في الواجهة («لا تملك صلاحية» رغم
 * المنح). الآن: عند تمرير `module` تُطبَّق قاعدة الخادم نفسها (moduleAccessAllowed
 * المشتركة): دور القائمة يخضع لخريطته المحلولة، ودور خارجها يمرّ بمنح صريح للوحدة.
 *
 * يعتمد على trpc.auth.me — يُستخدم داخل <Protected> الذي ضمن وجود جلسة،
 * فلا حاجة للتعامل مع حالة "بلا مستخدم" هنا.
 */
import { trpc } from "@/lib/trpc";
import { moduleAccessAllowed, type AccessLevel, type PermissionMap, type RoleKey } from "@shared/permissions";
import { Lock } from "lucide-react";

type Props = {
  /** الأدوار المسموح لها بالوصول. لا تقبل قائمة فارغة. */
  roles: RoleKey[];
  /**
   * مفتاح الوحدة في مصفوفة الصلاحيات (pos/sales/reports/…). عند تمريره يُفتح الوصول
   * أيضاً لمن مُنح الوحدة صراحةً بالمستوى المطلوب، وتُنفَّذ خريطة الدور على أدوار القائمة.
   */
  module?: string;
  /** المستوى الأدنى المطلوب عند تمرير module (الافتراضي READ). */
  level?: AccessLevel;
  children: React.ReactNode;
};

export function RequireRole({ roles, module, level, children }: Props) {
  const me = trpc.auth.me.useQuery();

  // أثناء التحميل: لا نكشف عن المحتوى — تجربة هادئة بلا وميض.
  if (me.isLoading) {
    return (
      <div className="min-h-[40vh] flex items-center justify-center text-muted-foreground">
        جارٍ التحقّق من الصلاحيات…
      </div>
    );
  }

  const role = me.data?.role as RoleKey | undefined;
  const override = (me.data?.permissionsOverride ?? null) as PermissionMap | null;
  const allowed = !!role && (module
    ? moduleAccessAllowed(role, override, module, level ?? "READ", roles)
    : role === "admin" || roles.includes(role));
  if (!allowed) {
    return <Forbidden />;
  }

  return <>{children}</>;
}

function Forbidden() {
  return (
    <div className="min-h-[60vh] flex flex-col items-center justify-center gap-3 text-center px-4">
      <Lock aria-hidden className="size-16 text-muted-foreground" />
      <h1 className="text-xl font-semibold">لا تملك صلاحية للوصول إلى هذه الصفحة</h1>
      <p className="text-sm text-muted-foreground max-w-md">
        هذه الشاشة مخصّصة للإدارة. إن كنت تحتاج إليها فعلاً، تواصل مع مدير النظام لمنحك الصلاحية المناسبة.
      </p>
      <a href="/" className="text-sm text-primary hover:underline mt-2">
        العودة إلى لوحة التحكم
      </a>
    </div>
  );
}
