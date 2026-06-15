/**
 * RequireRole — حارس دور على مستوى الواجهة للشاشات الإدارية.
 *
 * مهم: هذا حارس واجهة فقط (UX/تجربة استخدام) — الإنفاذ الحقيقي للأمان
 * يقع في الخادم عبر adminProcedure/managerProcedure في server/trpc.ts.
 * الهدف هنا: منع تركيب شاشة إدارية لدور غير مسموح وعرض رسالة واضحة.
 *
 * يعتمد على trpc.auth.me — يُستخدم داخل <Protected> الذي ضمن وجود جلسة،
 * فلا حاجة للتعامل مع حالة "بلا مستخدم" هنا.
 */
import { trpc } from "@/lib/trpc";
import type { RoleKey } from "@shared/permissions";

type Props = {
  /** الأدوار المسموح لها بالوصول. لا تقبل قائمة فارغة. */
  roles: RoleKey[];
  children: React.ReactNode;
};

export function RequireRole({ roles, children }: Props) {
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
  if (!role || !roles.includes(role)) {
    return <Forbidden />;
  }

  return <>{children}</>;
}

function Forbidden() {
  return (
    <div className="min-h-[60vh] flex flex-col items-center justify-center gap-3 text-center px-4">
      <div className="text-6xl" aria-hidden>🔒</div>
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
