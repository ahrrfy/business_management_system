import React, { useState } from "react";
import { ChevronDown } from "lucide-react";

interface StorefrontCategoriesProps {
  categories: any[];
  selectedId: number | null;
  onSelectCategory: (id: number | null) => void;
  categoryCountFn: (cat: any) => number;
  className?: string;
  id?: string;
}

export function StorefrontCategories({
  categories,
  selectedId,
  onSelectCategory,
  categoryCountFn,
  className = "",
  id = "store-categories",
}: StorefrontCategoriesProps) {
  const [showAll, setShowAll] = useState(false);
  if (categories.length === 0) return null;

  const isSelectedOutsideTop12 =
    selectedId != null && categories.findIndex((c) => c.id === selectedId) >= 12;
  const displayedCategories =
    showAll || isSelectedOutsideTop12 ? categories : categories.slice(0, 12);

  return (
    <section
      id={id}
      aria-labelledby="store-category-title"
      className={`rounded-2xl border border-slate-900/[0.08] bg-white p-4 sm:p-6 dark:border-slate-800 dark:bg-slate-900 ${className}`}
    >
      <div className="mb-4 sm:mb-5 flex flex-wrap items-end justify-between gap-2">
        <div>
          <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
            تصفح حسب اهتمامك
          </span>
          <h2
            id="store-category-title"
            className="store-display-title mt-0.5 text-xl sm:text-2xl font-bold text-slate-900 dark:text-slate-100"
          >
            الأقسام الرئيسية
          </h2>
        </div>
        <div className="flex items-center gap-2">
          {selectedId != null && (
            <button
              type="button"
              onClick={() => onSelectCategory(null)}
              className="touch-manipulation rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-semibold text-slate-700 transition-[transform,border-color,color] duration-150 ease-out hover:border-slate-400 hover:text-slate-900 active:scale-[0.97] dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300"
            >
              عرض كل الأقسام
            </button>
          )}
          <span className="text-xs font-medium text-slate-500 tabular-nums dark:text-slate-400">
            {categories.length} قسم
          </span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:gap-2.5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
        {displayedCategories.map((cat) => {
          const isSelected = selectedId === cat.id;
          const count = categoryCountFn(cat);

          return (
            <button
              key={cat.id}
              type="button"
              onClick={() => onSelectCategory(cat.id)}
              aria-pressed={isSelected}
              className={`group flex min-h-[4.75rem] touch-manipulation flex-col justify-between rounded-xl border p-3.5 text-right transition-[transform,border-color,background-color] duration-150 ease-out active:scale-[0.98] ${
                isSelected
                  ? "border-[var(--store-brand)] bg-[var(--store-brand)] text-white shadow-xs"
                  : "border-slate-900/[0.08] bg-[#f8f8fa] text-slate-900 hover:border-slate-900/20 hover:bg-white dark:border-slate-800 dark:bg-slate-800/50 dark:text-slate-100 dark:hover:border-slate-700"
              }`}
            >
              <span className="line-clamp-2 text-xs sm:text-[13px] font-semibold leading-snug">
                {cat.name}
              </span>
              {count > 0 && (
                <span
                  className={`mt-2 text-[11px] font-medium tabular-nums ${
                    isSelected
                      ? "text-white/80"
                      : "text-slate-500 dark:text-slate-400"
                  }`}
                >
                  {count} منتج
                </span>
              )}
            </button>
          );
        })}
      </div>

      {categories.length > 12 && (
        <div className="mt-4 text-center">
          <button
            type="button"
            onClick={() => setShowAll((prev) => !prev)}
            className="inline-flex touch-manipulation items-center gap-1.5 rounded-full border border-slate-200 bg-white px-4 py-1.5 text-xs font-semibold text-slate-700 transition-[transform,border-color,color] duration-150 ease-out hover:border-slate-400 hover:text-slate-900 active:scale-[0.97] dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300"
          >
            <span>{showAll ? "عرض أقسام أقل" : `عرض جميع الأقسام (${categories.length})`}</span>
            <ChevronDown
              aria-hidden
              className={`size-3.5 transition-transform duration-200 ${showAll ? "rotate-180" : ""}`}
            />
          </button>
        </div>
      )}
    </section>
  );
}
