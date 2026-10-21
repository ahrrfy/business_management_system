import * as React from "react";
import { Link } from "wouter";
import { ArrowRight, ChevronRight, Home } from "lucide-react";
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from "@/components/ui/breadcrumb";
import { cn } from "@/lib/utils";
import { WorkspaceBar } from "@/components/workspace/OperationalWorkspace";

/** عنصر مسار تنقّل — رابط للأصل (href) أو الصفحة الحالية (بلا href). */
export type Crumb = { label: string; href?: string };

type PageHeaderProps = {
  title: React.ReactNode;
  /** وصف موجز تحت العنوان — سياق/إرشاد للمستخدم. */
  description?: React.ReactNode;
  /** أزرار الإجراءات (CTA الصفحة) — تظهر في بداية السطر المقابلة للعنوان. */
  actions?: React.ReactNode;
  /**
   * فئات إضافيّة لحاوية `actions` — لتجاوز الافتراضيّ `sm:w-auto sm:shrink-0` حين يكون
   * عدد الأزرار كبيراً (٧+) بحيث لا تسع سطراً واحداً على تابلت/شاشة ضيّقة.
   * مثال: `actionsClassName="sm:w-full"` يُلغي `shrink-0` ويسمح للأزرار بأخذ سطرها الخاصّ
   * تحت العنوان مع flex-wrap طبيعيّ.
   */
  actionsClassName?: string;
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
  /** رأس مدمج لشاشات البيانات والتقارير؛ يبقي العنوان والإجراءات في شريط 40px واحد. */
  variant?: "default" | "workspace";
  /** عند تضمين الصفحة داخل مركز موحّد (Hub) يملك ترويسة وتبويبات: يكتم العنوان المكرر ويبقي الإجراءات فقط إن وُجدت. */
  embedded?: boolean;
  className?: string;
};

/**
 * رأس صفحة قانوني موحّد — مسار تنقّل اختياري + العنوان (h1) + وصف + منطقة إجراءات.
 *
 * يوحّد ما كان متفاوتاً عبر الشاشات: عناوين h1 بأنماط مختلفة، أو صفحات بلا h1،
 * أو padding/تباعد متباين. ضعه أعلى كل صفحة قائمة/لوحة داخل حاوية `space-y-3`.
 */
export function PageHeader({ title, description, actions, actionsClassName, icon, breadcrumbs, backHref, backLabel, homeHref, variant = "default", embedded = false, className }: PageHeaderProps) {
  if (embedded) {
    if (!actions) return null;
    return (
      <div data-page-header-actions className={cn("flex min-w-0 flex-wrap items-center justify-end gap-1.5", actionsClassName, className)}>
        {actions}
      </div>
    );
  }

  if (variant === "workspace") {
    return (
      <WorkspaceBar variant="command" label="أوامر الصفحة" className={cn("justify-between overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden", className)}>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <div className="flex shrink-0 items-center gap-1">
            {backHref && (
              <Link
                href={backHref}
                className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                title={String(backLabel ?? "رجوع")}
                aria-label={String(backLabel ?? "رجوع")}
              >
                <ArrowRight aria-hidden className="size-3.5" />
              </Link>
            )}
            {homeHref !== null && (
              <Link
                href={homeHref ?? "/"}
                className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                title="الصفحة الرئيسية"
                aria-label="الصفحة الرئيسية"
              >
                <Home aria-hidden className="size-3.5" />
              </Link>
            )}
          </div>
          <h1 className="flex min-w-0 shrink-0 items-center gap-1.5 text-base font-extrabold leading-none">
            {icon}
            <span className="truncate">{title}</span>
          </h1>
          {description && (
            <p className="sr-only min-w-0 truncate border-s ps-2 text-xs text-muted-foreground lg:not-sr-only" title={typeof description === "string" ? description : undefined}>
              {description}
            </p>
          )}
        </div>
        {actions && (
          <div data-page-header-actions className={cn("flex min-w-max shrink-0 items-center gap-1.5 whitespace-nowrap [&>*]:shrink-0", actionsClassName)}>
            {actions}
          </div>
        )}
      </WorkspaceBar>
    );
  }

  return (
    <div className={cn("flex flex-wrap items-center justify-between gap-2 border-b border-border/60 pb-2", className)}>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
        <div className="flex shrink-0 items-center gap-1">
          {backHref && (
            <Link
              href={backHref}
              className="inline-flex h-7 items-center gap-1 rounded-md border border-border/60 bg-card px-2 text-2xs font-semibold text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              title={typeof backLabel === "string" ? backLabel : "رجوع"}
            >
              <ArrowRight aria-hidden className="size-3" />
              <span>{backLabel ?? "رجوع"}</span>
            </Link>
          )}
          {homeHref !== null && (
            <Link
              href={homeHref ?? "/"}
              className="inline-flex size-7 items-center justify-center rounded-md border border-border/60 bg-card text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              title="الصفحة الرئيسية"
              aria-label="الصفحة الرئيسية"
            >
              <Home aria-hidden className="size-3.5" />
            </Link>
          )}
        </div>

        {breadcrumbs && breadcrumbs.length > 0 && (
          <Breadcrumb className="hidden sm:block">
            <BreadcrumbList className="text-2xs">
              {breadcrumbs.map((c, i) => {
                const isLast = i === breadcrumbs.length - 1;
                return (
                  <React.Fragment key={i}>
                    <BreadcrumbItem>
                      {isLast || !c.href ? (
                        <BreadcrumbPage className="text-2xs font-semibold">{c.label}</BreadcrumbPage>
                      ) : (
                        <BreadcrumbLink asChild>
                          <Link href={c.href}>{c.label}</Link>
                        </BreadcrumbLink>
                      )}
                    </BreadcrumbItem>
                    {!isLast && (
                      <BreadcrumbSeparator>
                        <ChevronRight className="size-3" />
                      </BreadcrumbSeparator>
                    )}
                  </React.Fragment>
                );
              })}
            </BreadcrumbList>
          </Breadcrumb>
        )}

        <h1 className="flex min-w-0 items-center gap-1.5 text-lg font-extrabold leading-tight">
          {icon}
          <span className="truncate">{title}</span>
        </h1>

        {description && (
          <p
            className="hidden min-w-0 max-w-xl truncate border-s border-border/70 ps-2 text-xs text-muted-foreground xl:block"
            title={typeof description === "string" ? description : undefined}
          >
            {description}
          </p>
        )}
      </div>

      {actions && (
        <div data-page-header-actions className={cn("flex w-full min-w-0 flex-wrap items-center gap-1.5 sm:w-auto sm:shrink-0", actionsClassName)}>
          {actions}
        </div>
      )}
    </div>
  );
}
