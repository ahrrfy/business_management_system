import { trpc } from "@/lib/trpc";
import { History } from "lucide-react";
import { Link, useLocation } from "wouter";

/**
 * مدخل ثابت لسجلّ حركات الشاشة الحالية.
 *
 * التصميم (٣٠/٨/٢٦ — إصلاح تراكب): زرٌّ دائريٌّ مضغوطٌ (٤٠px) بلا نصٍّ افتراضاً،
 * يتوسّع عند التحويم/التركيز فيُظهر التسمية. البصمةُ الصغيرة تُلغي تراكبَه مع أزرار
 * البطاقات (خصوصاً واتساب في كانبان أوامر الشغل) الذي كان يبتلع النصّ الأصليّ.
 *
 * الموضع: `end-4 lg:bottom-4` — الحافّة الخلفيّة في RTL (يمين المستعمل، وفي أقصى
 * السطر بمعزلٍ عن سلطة السايدبار على `start`). Z-50 يبقي الزرّ فوق أيّ محتوًى.
 */
export function OperationAuditAccess() {
  const me = trpc.auth.me.useQuery();
  const [location] = useLocation();
  const screenPath = location.split("?", 1)[0] || "/";
  const allowed = me.data?.role === "admin" || me.data?.role === "auditor";

  if (!allowed || screenPath === "/audit") return null;

  return (
    <Link
      href={`/audit?screenPath=${encodeURIComponent(screenPath)}`}
      aria-label="عرض سجل حركات الشاشة الحالية"
      title="سجلّ حركات الشاشة الحالية — من قام بماذا"
      className="
        group fixed z-50 print:hidden
        bottom-[calc(5rem+env(safe-area-inset-bottom))] end-4
        lg:bottom-4
        inline-flex items-center gap-2
        h-10 min-w-10 max-w-10
        overflow-hidden
        rounded-full border border-border bg-background/95 shadow-md backdrop-blur-sm
        text-foreground/85 hover:text-foreground
        pl-2 pr-2
        transition-[max-width,box-shadow,background] duration-200 ease-out
        hover:max-w-[220px] focus-visible:max-w-[220px]
        hover:shadow-lg hover:bg-background
        focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring
      "
    >
      <span className="grid size-6 flex-none place-items-center">
        <History aria-hidden className="size-4" />
      </span>
      <span className="whitespace-nowrap text-xs font-bold opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100">
        سجلّ حركات الشاشة
      </span>
    </Link>
  );
}
