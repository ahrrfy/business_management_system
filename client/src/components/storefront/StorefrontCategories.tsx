import React, { useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, LayoutGrid } from "lucide-react";

interface StorefrontCategoryItem {
  id: number;
  name: string;
  productCount?: number;
  availableCount?: number;
}

interface StorefrontCategoriesProps<TCat extends StorefrontCategoryItem = StorefrontCategoryItem> {
  categories: TCat[];
  selectedId: number | null;
  onSelectCategory: (id: number | null) => void;
  categoryCountFn: (cat: TCat) => number;
  className?: string;
  id?: string;
}

export function StorefrontCategories<TCat extends StorefrontCategoryItem = StorefrontCategoryItem>({
  categories,
  selectedId,
  onSelectCategory,
  categoryCountFn,
  className = "",
  id = "store-categories",
}: StorefrontCategoriesProps<TCat>) {
  const [expanded, setExpanded] = useState(false);
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  const visibleCategories = useMemo(() => {
    const withCounts = categories.map((cat) => ({
      cat,
      count: categoryCountFn(cat),
    }));
    const activeOnly = withCounts.filter(
      (entry) => entry.count > 0 || entry.cat.id === selectedId,
    );
    return activeOnly.length > 0 ? activeOnly : withCounts;
  }, [categories, categoryCountFn, selectedId]);

  if (visibleCategories.length === 0) return null;

  const scrollByStep = (dir: -1 | 1) => {
    scrollerRef.current?.scrollBy({ left: dir * 280, behavior: "smooth" });
  };

  return (
    <section
      id={id}
      aria-label="أقسام المتجر"
      className={`w-full ${className}`}
    >
      {expanded ? (
        <div className="rounded-2xl border border-slate-900/[0.08] bg-white p-3 sm:p-4 dark:border-slate-800 dark:bg-slate-900">
          <div className="mb-2.5 flex items-center justify-between gap-2">
            <span className="text-xs font-bold text-[#1d1d1f] dark:text-slate-100">
              الأقسام
            </span>
            <button
              type="button"
              onClick={() => setExpanded(false)}
              className="rounded-full bg-[#f5f5f7] px-3 py-1 text-xs font-semibold text-[#1d1d1f] transition hover:bg-slate-200/70 dark:bg-slate-800 dark:text-slate-200"
            >
              طي القائمة
            </button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              aria-pressed={selectedId === null}
              onClick={() => onSelectCategory(null)}
              className={`rounded-full px-3.5 py-1.5 text-xs font-bold transition ${
                selectedId === null
                  ? "bg-[#1d1d1f] text-white dark:bg-white dark:text-[#1d1d1f]"
                  : "border border-slate-900/[0.08] bg-[#f5f5f7] text-[#1d1d1f] hover:bg-slate-200/70 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
              }`}
            >
              {selectedId != null ? "عرض كل الأقسام" : "كل الأقسام"}
            </button>
            {visibleCategories.map(({ cat }) => {
              const isSelected = selectedId === cat.id;
              return (
                <button
                  key={cat.id}
                  type="button"
                  aria-pressed={isSelected}
                  onClick={() => {
                    onSelectCategory(isSelected ? null : cat.id);
                    setExpanded(false);
                  }}
                  className={`rounded-full px-3.5 py-1.5 text-xs font-semibold transition ${
                    isSelected
                      ? "bg-[#1d1d1f] text-white dark:bg-white dark:text-[#1d1d1f]"
                      : "border border-slate-900/[0.08] bg-[#f5f5f7] text-[#1d1d1f] hover:border-slate-900/20 hover:bg-white dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                  }`}
                >
                  {cat.name}
                </button>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => scrollByStep(1)}
            aria-label="مرر الأقسام إلى اليمين"
            className="hidden size-8 shrink-0 items-center justify-center rounded-full border border-slate-900/[0.08] bg-white text-slate-600 transition hover:border-slate-300 hover:text-[#1d1d1f] sm:flex dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300"
          >
            <ChevronRight aria-hidden className="size-4" />
          </button>

          <div
            ref={scrollerRef}
            className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto py-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            <button
              type="button"
              aria-pressed={selectedId === null}
              onClick={() => onSelectCategory(null)}
              className={`shrink-0 touch-manipulation rounded-full px-3.5 py-2 text-xs font-bold whitespace-nowrap transition active:scale-[0.97] ${
                selectedId === null
                  ? "bg-[#1d1d1f] text-white shadow-2xs dark:bg-white dark:text-[#1d1d1f]"
                  : "border border-slate-900/[0.08] bg-white text-[#1d1d1f] hover:border-slate-900/20 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-100"
              }`}
            >
              {selectedId != null ? "عرض كل الأقسام" : "كل الأقسام"}
            </button>

            {visibleCategories.map(({ cat }) => {
              const isSelected = selectedId === cat.id;
              return (
                <button
                  key={cat.id}
                  type="button"
                  aria-pressed={isSelected}
                  onClick={() => onSelectCategory(isSelected ? null : cat.id)}
                  className={`shrink-0 touch-manipulation rounded-full px-3.5 py-2 text-xs font-semibold whitespace-nowrap transition active:scale-[0.97] ${
                    isSelected
                      ? "bg-[#1d1d1f] text-white shadow-2xs dark:bg-white dark:text-[#1d1d1f]"
                      : "border border-slate-900/[0.08] bg-white text-[#1d1d1f] hover:border-slate-900/20 hover:bg-[#f5f5f7] dark:border-slate-800 dark:bg-slate-900 dark:text-slate-100"
                  }`}
                >
                  {cat.name}
                </button>
              );
            })}
          </div>

          <button
            type="button"
            onClick={() => scrollByStep(-1)}
            aria-label="مرر الأقسام إلى اليسار"
            className="hidden size-8 shrink-0 items-center justify-center rounded-full border border-slate-900/[0.08] bg-white text-slate-600 transition hover:border-slate-300 hover:text-[#1d1d1f] sm:flex dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300"
          >
            <ChevronLeft aria-hidden className="size-4" />
          </button>

          {visibleCategories.length > 8 && (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              aria-label="عرض جميع الأقسام"
              className="inline-flex h-8 shrink-0 touch-manipulation items-center gap-1 rounded-full border border-slate-900/[0.08] bg-white px-2.5 text-xs font-semibold text-slate-700 transition hover:border-slate-300 hover:text-[#1d1d1f] dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200"
            >
              <LayoutGrid aria-hidden className="size-3.5" />
              <span className="hidden sm:inline">الكل</span>
            </button>
          )}
        </div>
      )}
    </section>
  );
}
