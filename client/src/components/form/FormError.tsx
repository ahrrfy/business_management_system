import { AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * صندوق خطأ نموذج موحّد — بديل عن `<p className="text-destructive">{error}</p>` المتناثر.
 *
 * - `role="alert"` + `aria-live="assertive"` ⇒ يُعلنه قارئ الشاشة فور ظهوره.
 * - أيقونة + حدود/خلفية destructive ⇒ أبرز بصرياً من سطر نصّ أصمّ.
 * - `whitespace-pre-wrap` ⇒ يحفظ الأسطر في الرسائل متعدّدة السطور.
 * - يُخفى تماماً حين لا رسالة (يعيد null).
 */
export function FormError({
  message,
  id,
  className,
}: {
  message?: string | null;
  id?: string;
  className?: string;
}) {
  if (!message) return null;
  return (
    <div
      id={id}
      role="alert"
      aria-live="assertive"
      className={cn(
        "flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive",
        className,
      )}
    >
      <AlertCircle aria-hidden className="size-4 shrink-0 mt-0.5" />
      <span className="whitespace-pre-wrap">{message}</span>
    </div>
  );
}
