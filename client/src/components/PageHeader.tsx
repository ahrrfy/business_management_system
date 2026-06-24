import * as React from "react";
import { cn } from "@/lib/utils";

type PageHeaderProps = {
  title: React.ReactNode;
  /** وصف موجز تحت العنوان — سياق/إرشاد للمستخدم. */
  description?: React.ReactNode;
  /** أزرار الإجراءات (CTA الصفحة) — تظهر في بداية السطر المقابلة للعنوان. */
  actions?: React.ReactNode;
  /** أيقونة اختيارية بجانب العنوان. */
  icon?: React.ReactNode;
  className?: string;
};

/**
 * رأس صفحة قانوني موحّد — العنوان (h1) + وصف اختياري + منطقة إجراءات.
 *
 * يوحّد ما كان متفاوتاً عبر الشاشات: عناوين h1 بأنماط مختلفة، أو صفحات بلا h1،
 * أو padding/تباعد متباين. ضعه أعلى كل صفحة قائمة/لوحة داخل حاوية `space-y-4`.
 *
 * @example
 * <div className="space-y-4">
 *   <PageHeader title="العملاء" description="إدارة العملاء وأرصدتهم"
 *     actions={<Button size="sm">+ عميل جديد</Button>} />
 *   …
 * </div>
 */
export function PageHeader({ title, description, actions, icon, className }: PageHeaderProps) {
  return (
    <div className={cn("flex items-start justify-between gap-3 flex-wrap", className)}>
      <div className="min-w-0 space-y-1">
        <h1 className="flex items-center gap-2 text-2xl font-bold leading-tight">
          {icon}
          <span className="truncate">{title}</span>
        </h1>
        {description && (
          <p className="max-w-2xl text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {actions && (
        <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
      )}
    </div>
  );
}
