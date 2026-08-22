import * as React from "react";
import { Link } from "wouter";
import { ArrowRight, ChevronRight, Home } from "lucide-react";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { cn } from "@/lib/utils";

/** عنصر مسار تنقّل — رابط للأصل (href) أو الصفحة الحالية (بلا href). */
export type Crumb = { label: string; href?: string };

type PageHeaderProps = {
  title: React.ReactNode;
  /** وصف موجز تحت العنوان — سياق/إرشاد للمستخدم. */
  description?: React.ReactNode;
  /** أزرار الإجراءات (CTA الصفحة) — تظهر في بداية السطر المقابلة للعنوان. */
  actions?: React.ReactNode;
  /** أيقونة اختيارية بجانب العنوان. */
  icon?: React.ReactNode;
  /**
   * مسار التنقّل فوق العنوان (توجيه «أين أنا / الرجوع للأصل») — للشاشات التفصيلية/المتفرّعة.
   * آخر عنصر = الصفحة الحالية (بلا href). مثال: `[{label:"العملاء", href:"/customers"}, {label:"كشف حساب"}]`.
   */
  breadcrumbs?: Crumb[];
  /** رابط رجوع صغير أعلى العنوان (نمط «← مركز التقارير») — بديلٌ خفيف عن breadcrumbs لشاشةٍ ذات أصلٍ واحد. */
  backHref?: string;
  /** نصّ رابط الرجوع (افتراضي «رجوع»). */
  backLabel?: React.ReactNode;
  /** وجهةُ «الرئيسية» — الافتراضي `/`. مرّر `null` لإخفائها (شاشةٌ هي الرئيسية نفسها). */
  homeHref?: string | null;
  className?: string;
};

/**
 * رأس صفحة قانوني موحّد — مسار تنقّل اختياري + العنوان (h1) + وصف + منطقة إجراءات.
 *
 * يوحّد ما كان متفاوتاً عبر الشاشات: عناوين h1 بأنماط مختلفة، أو صفحات بلا h1،
 * أو padding/تباعد متباين. ضعه أعلى كل صفحة قائمة/لوحة داخل حاوية `space-y-4`.
 *
 * @example
 * <PageHeader title="العملاء" description="إدارة العملاء وأرصدتهم"
 *   actions={<Button size="sm">+ عميل جديد</Button>} />
 *
 * @example شاشة تفصيلية بمسار تنقّل:
 * <PageHeader title="كشف حساب — أحمد" breadcrumbs={[{label:"العملاء", href:"/customers"}, {label:"كشف حساب"}]} />
 */
export function PageHeader({ title, description, actions, icon, breadcrumbs, backHref, backLabel, homeHref, className }: PageHeaderProps) {
  const headerRow = (
    <div className={cn("flex items-start justify-between gap-3 flex-wrap", className)}>
      <div className="min-w-0 space-y-1">
        {/* ١٩/٨ (طلب المالك): **رجوعٌ ورئيسيّة في كل شاشة**. الرئيسيّة تظهر دائماً — محطّة
            الاستقبال تُركَّب بلا شريطٍ جانبيّ، وموظّفُها كان بلا مخرجٍ إلّا كتابة العنوان
            يدوياً. والرجوعُ يظهر حين يكون للشاشة أصلٌ معروف. */}
        <div className="flex items-center gap-2">
          {backHref && (
            <Link
              href={backHref}
              className="inline-flex items-center gap-0.5 text-2xs text-muted-foreground transition-colors hover:text-foreground hover:underline"
            >
              {/* ١٩/٨: كان محرفًا خامّاً `←` — وهو يشير **إلى الأمام** في RTL لا إلى الخلف. */}
              <ArrowRight aria-hidden className="size-3.5" />
              {backLabel ?? "رجوع"}
            </Link>
          )}
          {homeHref !== null && (
            <Link
              href={homeHref ?? "/"}
              className="inline-flex items-center gap-1 text-2xs text-muted-foreground transition-colors hover:text-foreground hover:underline"
              title="الصفحة الرئيسية"
            >
              <Home aria-hidden className="size-3.5" />
              الرئيسية
            </Link>
          )}
        </div>
        <h1 className="flex items-center gap-2 text-2xl font-bold leading-tight">
          {icon}
          <span className="truncate">{title}</span>
        </h1>
        {description && (
          <p className="max-w-2xl text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {actions && (
        <div className="flex w-full min-w-0 flex-wrap items-center gap-2 sm:w-auto sm:shrink-0">{actions}</div>
      )}
    </div>
  );

  if (!breadcrumbs || breadcrumbs.length === 0) return headerRow;

  return (
    <div className="space-y-1.5">
      <Breadcrumb>
        <BreadcrumbList>
          {breadcrumbs.map((c, i) => {
            const isLast = i === breadcrumbs.length - 1;
            return (
              <React.Fragment key={i}>
                <BreadcrumbItem>
                  {isLast || !c.href ? (
                    <BreadcrumbPage>{c.label}</BreadcrumbPage>
                  ) : (
                    <BreadcrumbLink asChild>
                      <Link href={c.href}>{c.label}</Link>
                    </BreadcrumbLink>
                  )}
                </BreadcrumbItem>
                {!isLast && (
                  <BreadcrumbSeparator>
                    {/* ١٩/٨: `ChevronLeft` مع `rtl:rotate-180` في `breadcrumb.tsx:75` = قلبان
                        يتعاندان ⤇ الفاصل يشير عكس تدفّق القراءة العربيّ. */}
                    <ChevronRight className="size-3.5" />
                  </BreadcrumbSeparator>
                )}
              </React.Fragment>
            );
          })}
        </BreadcrumbList>
      </Breadcrumb>
      {headerRow}
    </div>
  );
}
