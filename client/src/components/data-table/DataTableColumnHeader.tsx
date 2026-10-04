import type { Column } from "@tanstack/react-table";
import { ArrowUpDown, ChevronDown, ChevronUp } from "lucide-react";
import React from "react";
import { cn } from "@/lib/utils";
import { resolveColumnPresentation } from "@/components/data-table/columnContract";

export interface DataTableColumnHeaderProps<TData, TValue = unknown>
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
  column: Column<TData, TValue>;
  title?: React.ReactNode;
  /** هل المكون يدير التفاعل والوصولية مباشرة أم يفوّضها للـ th الحاوي */
  interactive?: boolean;
}

/**
 * مكوّن ترويسة معياري لأعمدة الجداول مع دعم مؤشرات الفرز والتعامد الهندسي RTL.
 *
 * الخصائص:
 * ١. تعامد هندسي 100%: استخدام flex-row-reverse للأعمدة المحاذاة لليسار في RTL (text-end كالأموال والأرقام).
 * ٢. مؤشرات الفرز البصرية:
 *    - غير مرتب: أيقونة ArrowUpDown خفيفة عند التمرير (hover) فقط ومخفية خارج التمرير.
 *    - تصاعدي: أيقونة ChevronUp واضحة بلون الهوية text-primary.
 *    - تنازلي: أيقونة ChevronDown واضحة بلون الهوية text-primary.
 * ٣. إمكانية الوصول (a11y): نصوص قارئات الشاشة (sr-only) مع سمات aria-sort.
 */
export interface DataTableHeaderContextType {
  inTableTh?: boolean;
  isNested?: boolean;
}

export const DataTableHeaderContext = React.createContext<DataTableHeaderContextType>({});

export function DataTableColumnHeader<TData, TValue = unknown>({
  column,
  title,
  children,
  className,
  onClick,
  onKeyDown,
  role,
  tabIndex,
  interactive,
  ...props
}: DataTableColumnHeaderProps<TData, TValue>) {
  const { inTableTh, isNested } = React.useContext(DataTableHeaderContext);
  const presentation = resolveColumnPresentation(column);
  const sortable = column.getCanSort();
  const dir = column.getIsSorted();

  const sortIcon =
    dir === "asc" ? (
      <ChevronUp aria-hidden className="size-3.5 shrink-0 text-primary opacity-100 transition-opacity" />
    ) : dir === "desc" ? (
      <ChevronDown aria-hidden className="size-3.5 shrink-0 text-primary opacity-100 transition-opacity" />
    ) : sortable ? (
      <ArrowUpDown aria-hidden className="size-3.5 shrink-0 opacity-0 group-hover:opacity-50 transition-opacity" />
    ) : null;

  const content = title ?? children;

  if (isNested) {
    return <>{content}</>;
  }

  const isInteractive = interactive ?? !inTableTh;

  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    onClick?.(e);
    if (e.defaultPrevented || !isInteractive) return;
    const th = (e.currentTarget as HTMLElement).closest("th");
    if (th && th.getAttribute("role") === "button") {
      // الـ th الحاوي يدير النقر في DataTable لمنع التفعيل المزدوج
      return;
    }
    if (sortable) {
      column.getToggleSortingHandler()?.(e);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(e);
    if (e.defaultPrevented || !isInteractive) return;
    const th = (e.currentTarget as HTMLElement).closest("th");
    if (th && th.getAttribute("role") === "button") {
      return;
    }
    if (sortable && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      column.getToggleSortingHandler()?.(e);
    }
  };

  const effectiveRole =
    !isInteractive
      ? role
      : (role ?? (sortable ? "button" : undefined));

  const effectiveTabIndex =
    !isInteractive
      ? tabIndex
      : (tabIndex ?? (sortable ? 0 : undefined));

  const effectiveAriaSort =
    !isInteractive
      ? props["aria-sort"]
      : (props["aria-sort"] ?? (effectiveRole === "button" ? (dir === "asc" ? "ascending" : dir === "desc" ? "descending" : "none") : undefined));

  return (
    <DataTableHeaderContext.Provider value={{ inTableTh, isNested: true }}>
      <div
        {...props}
        data-column-header="true"
        role={effectiveRole}
        tabIndex={effectiveTabIndex}
        aria-sort={effectiveAriaSort}
        className={cn(
          "group inline-flex items-center gap-1 select-none",
          sortable && isInteractive && "cursor-pointer",
          presentation.align === "end" && "flex-row-reverse",
          className
        )}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
      >
        <span className="truncate">{content}</span>
        {sortIcon}
        {sortable && (
          <span className="sr-only">
            {dir === "asc"
              ? "مرتب تصاعدياً"
              : dir === "desc"
              ? "مرتب تنازلياً"
              : "غير مرتب"}
          </span>
        )}
      </div>
    </DataTableHeaderContext.Provider>
  );
}
