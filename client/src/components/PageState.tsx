import * as React from "react";
import { AlertTriangle, Inbox, FilterX } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { pickEmptyMessage, type EmptyStateReason } from "@shared/emptyStateMessages";

/**
 * حالة تحميل موحّدة — تستبدل «جارٍ التحميل…» المتفرّقة بأنماط مختلفة عبر الشاشات.
 * تُعلن للقارئ الشاشي عبر role="status" + aria-live.
 */
export function LoadingState({ message = "جارٍ التحميل…", className }: { message?: string; className?: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn("flex items-center justify-center gap-2 p-10 text-muted-foreground", className)}
    >
      <Spinner aria-hidden />
      <span>{message}</span>
    </div>
  );
}

/**
 * حالة خطأ موحّدة مع مسار تعافٍ (إعادة محاولة) — تستبدل رسائل الخطأ اليدوية.
 * تُعلن للقارئ الشاشي عبر role="alert".
 */
export function ErrorState({
  message,
  onRetry,
  className,
}: {
  message?: React.ReactNode;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <div role="alert" className={cn("flex flex-col items-center justify-center gap-3 p-10 text-center", className)}>
      <AlertTriangle className="size-6 text-destructive" aria-hidden />
      <p className="text-sm text-destructive">{message ?? "تعذّر تحميل البيانات."}</p>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          إعادة المحاولة
        </Button>
      )}
    </div>
  );
}

/**
 * صفّ «لا بيانات» داخل جدول — يستبدل النمط اليدوي المتكرّر
 * `<tr><td colSpan={n} className="p-6 text-center text-muted-foreground">…`.
 * للحالات الفارغة الكاملة لصفحة (لا داخل جدول) استعمل `<EmptyState>`.
 */
export function TableEmptyRow({
  colSpan,
  message = "لا بيانات.",
  className,
}: {
  colSpan: number;
  message?: React.ReactNode;
  className?: string;
}) {
  return (
    <tr>
      <td colSpan={colSpan} className={cn("p-6 text-center text-sm text-muted-foreground", className)}>
        {message}
      </td>
    </tr>
  );
}

/**
 * حالة فراغ لصفحة كاملة (لا داخل جدول) — تُميّز بصرياً بين:
 *   • **NO_ROWS_YET**: أيقونة `Inbox` + CTA اختياريّة للإنشاء
 *   • **NO_MATCH_FILTER**: أيقونة `FilterX` + CTA اختياريّة لمسح الفلاتر
 *
 * الرسائل مشتقّة من `@shared/emptyStateMessages` بحسب `resourceKey`. أيّ رسالة مخصّصة تُمرَّر
 * تتجاوز الاشتقاق (للحالات النادرة). أُعلنها للقارئ الشاشيّ عبر `role="status"`.
 *
 * ⚠️ استعملها للحالات التي تملأ الصفحة (قوائم رئيسية) — للصفوف داخل جدول قائم استعمل
 * `TableEmptyRow`.
 */
export function EmptyState({
  resourceKey = "generic",
  reason,
  title,
  description,
  action,
  className,
}: {
  /** مفتاح domain (invoices/customers/…) — انظر `emptyStateMessages`. */
  resourceKey?: string;
  /** سبب الفراغ — يحدّد الأيقونة والنصّ الافتراضيّ. */
  reason: EmptyStateReason;
  /** تجاوز عنوان الرسالة المشتقّة. */
  title?: React.ReactNode;
  /** تجاوز وصف الرسالة المشتقّة. */
  description?: React.ReactNode;
  /** زرّ عمل رئيسيّ (مثل «أنشئ الأوّل» أو «امسح الفلاتر»). */
  action?: React.ReactNode;
  className?: string;
}) {
  const defaultMsg = pickEmptyMessage(resourceKey, reason === "NO_MATCH_FILTER");
  const Icon = reason === "NO_MATCH_FILTER" ? FilterX : Inbox;
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn("flex flex-col items-center justify-center gap-3 p-10 text-center", className)}
    >
      <Icon aria-hidden className="size-8 text-muted-foreground" />
      <div className="space-y-1">
        <p className="text-sm font-semibold">{title ?? defaultMsg.title}</p>
        {(description ?? defaultMsg.description) && (
          <p className="text-xs text-muted-foreground max-w-md">{description ?? defaultMsg.description}</p>
        )}
      </div>
      {action}
    </div>
  );
}

/**
 * صفوف هيكلية (skeleton) لتحميل الجداول — إحساس سرعة أفضل من المؤشّر الدوّار،
 * إذ تُبقي بنية الجدول ثابتة فلا «قفزة تخطيط» عند وصول البيانات (CLS).
 * تُعرض داخل `<tbody>` أثناء التحميل بدل صفّ فارغ/نصّ «جارٍ التحميل».
 */
export function TableSkeleton({ rows = 6, cols, className }: { rows?: number; cols: number; className?: string }) {
  return (
    <>
      {Array.from({ length: rows }).map((_, r) => (
        <tr key={r} className="border-t" aria-hidden>
          {Array.from({ length: cols }).map((__, c) => (
            <td key={c} className={cn("p-2", className)}>
              <Skeleton className="h-4 w-full" />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}
