import { ClipboardList } from "lucide-react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";

/**
 * تنبيهٌ موحّد على شاشات حوكمة المشتريات: الاعتماد/الرفض صار في الصندوق الموحّد
 * «مطلوب منّي الآن» (سطحُ الحسم الواحد لكلّ الوحدات، مبنيٌّ من `shared/decisionRegistry.ts`).
 * تبقى هذه الشاشة لإنشاء الطلبات ومتابعتها وقراءة سياقها؛ والحسمُ في مكانٍ واحد — فلا
 * يُطارَد المعتمِد بين ثمانِ شاشاتٍ متفرّقة. الطابور داخل الصفحة يبقى مساراً احتياطياً.
 */
export function DecideInInboxNotice() {
  return (
    <div
      role="note"
      className="flex flex-wrap items-center gap-2 rounded-md border bg-[var(--sem-info-bg)] px-3 py-2 text-2xs text-[var(--sem-info)]"
    >
      <ClipboardList aria-hidden className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 font-bold">
        الاعتماد والرفض صارا في صندوقٍ واحد لكلّ الوحدات — هذه الشاشة لإنشاء الطلبات ومتابعتها.
      </span>
      <Button size="sm" variant="outline" asChild className="shrink-0">
        <Link href="/my-work">افتح «مطلوب منّي الآن»</Link>
      </Button>
    </div>
  );
}
