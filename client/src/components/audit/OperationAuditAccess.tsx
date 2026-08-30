import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";
import { History } from "lucide-react";
import { Link, useLocation } from "wouter";

/**
 * مدخل ثابت لسجلّ حركات الشاشة الحالية. تركيبه مرةً في Shell يجعل التتبّع متاحاً من كل
 * شاشة محمية، بما فيها الشاشات ذات الجداول الخام القديمة، من دون نسخ زر مختلف في كل صفحة.
 */
export function OperationAuditAccess() {
  const me = trpc.auth.me.useQuery();
  const [location] = useLocation();
  const screenPath = location.split("?", 1)[0] || "/";
  const allowed = me.data?.role === "admin" || me.data?.role === "auditor";

  if (!allowed || screenPath === "/audit") return null;

  return (
    <Button
      asChild
      variant="outline"
      size="sm"
      className="fixed bottom-[calc(5rem+env(safe-area-inset-bottom))] left-4 z-50 border-border bg-background/95 shadow-sm backdrop-blur-sm print:hidden lg:bottom-4"
    >
      <Link
        href={`/audit?screenPath=${encodeURIComponent(screenPath)}`}
        aria-label="عرض سجل حركات الشاشة الحالية"
        title="من قام بماذا في هذه الشاشة"
      >
        <History aria-hidden className="size-4" />
        <span className="hidden sm:inline">سجلّ حركات الشاشة</span>
      </Link>
    </Button>
  );
}
