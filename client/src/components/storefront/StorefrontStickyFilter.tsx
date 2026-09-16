import React, { useEffect, useState } from "react";
import { ChevronDown, ArrowUp, SlidersHorizontal, Check, Search, Sparkles } from "lucide-react";

interface CategoryOption {
  categoryId: number;
  name: string;
}

interface StorefrontStickyFilterProps {
  categories: CategoryOption[];
  selectedCategoryId: number | null;
  onSelectCategory: (id: number | null) => void;
  availability: "ALL" | "IN_STOCK";
  onToggleAvailability: () => void;
  sort: string;
  onChangeSort: (sort: string) => void;
  totalCount: number;
  onScrollToTop: () => void;
}

export function StorefrontStickyFilter({
  categories,
  selectedCategoryId,
  onSelectCategory,
  availability,
  onToggleAvailability,
  sort,
  onChangeSort,
  totalCount,
  onScrollToTop,
}: StorefrontStickyFilterProps) {
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    let ticking = false;
    const handleScroll = () => {
      if (!ticking) {
        window.requestAnimationFrame(() => {
          // يظهر الشريط بعد تجاوز قسم البطل (تقريباً 750px)
          const shouldShow = window.scrollY > 750;
          setIsVisible(shouldShow);
          ticking = false;
        });
        ticking = true;
      }
    };

    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  if (!isVisible) return null;

  return (
    <nav
      aria-label="تصفية الكتالوج السريعة"
      className="fixed top-0 inset-x-0 z-40 animate__animated animate__fadeInDown animate__faster border-b border-slate-200/80 bg-white/90 shadow-md backdrop-blur-xl transition-all dark:border-slate-800/80 dark:bg-slate-950/90"
    >
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-2.5 sm:px-6">
        {/* زر العودة لأعلى الصفحة والأقسام */}
        <div className="flex items-center gap-2 min-w-0 flex-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <button
            type="button"
            onClick={onScrollToTop}
            title="العودة لأعلى الصفحة"
            aria-label="العودة لأعلى الصفحة"
            className="flex size-8 shrink-0 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-700 transition hover:bg-slate-100 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300"
          >
            <ArrowUp aria-hidden className="size-3.5" />
          </button>

          <span className="h-4 w-px bg-slate-200 dark:bg-slate-800 shrink-0" />

          {/* رقاقة كل الأقسام */}
          <button
            type="button"
            onClick={() => onSelectCategory(null)}
            className={`shrink-0 rounded-xl px-3 py-1.5 text-xs font-black transition ${
              selectedCategoryId === null
                ? "bg-slate-900 text-white shadow-xs dark:bg-white dark:text-slate-900"
                : "bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800"
            }`}
          >
            كل الأقسام
          </button>

          {/* رقاقات الأقسام */}
          {categories.map((cat) => {
            const isSelected = selectedCategoryId === cat.categoryId;
            return (
              <button
                key={cat.categoryId}
                type="button"
                onClick={() => onSelectCategory(cat.categoryId)}
                className={`shrink-0 rounded-xl px-3 py-1.5 text-xs font-black transition ${
                  isSelected
                    ? "bg-slate-900 text-white shadow-xs dark:bg-white dark:text-slate-900"
                    : "bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800"
                }`}
              >
                {cat.name}
              </button>
            );
          })}
        </div>

        {/* أدوات الفرز والحالة */}
        <div className="flex items-center gap-2 shrink-0">
          {/* فلتر المتوفر فقط */}
          <button
            type="button"
            onClick={onToggleAvailability}
            aria-pressed={availability === "IN_STOCK"}
            className={`hidden sm:inline-flex shrink-0 items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-black transition ${
              availability === "IN_STOCK"
                ? "bg-emerald-600 text-white shadow-sm shadow-emerald-500/20"
                : "border border-slate-200 bg-white text-slate-600 hover:border-slate-300 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300"
            }`}
          >
            <span className={`size-1.5 rounded-full ${availability === "IN_STOCK" ? "bg-white" : "bg-emerald-500"}`} />
            <span>متوفر فقط</span>
          </button>

          {/* قائمة الترتيب المدمجة */}
          <div className="relative">
            <select
              value={sort}
              onChange={(e) => onChangeSort(e.target.value)}
              aria-label="ترتيب النتائج"
              className="appearance-none rounded-xl border border-slate-200 bg-white py-1.5 pr-2.5 pl-7 text-xs font-bold text-slate-700 outline-none transition focus:border-blue-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300"
            >
              <option value="RECOMMENDED">المقترح</option>
              <option value="BEST_SELLERS">الأكثر مبيعاً</option>
              <option value="PRICE_ASC">الأقل سعراً</option>
              <option value="PRICE_DESC">الأعلى سعراً</option>
            </select>
            <ChevronDown aria-hidden className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-slate-400" />
          </div>

          {/* عداد المنتجات المطابقة */}
          <span className="hidden md:inline-flex rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-black text-slate-600 dark:bg-slate-800 dark:text-slate-300">
            {totalCount} منتج
          </span>
        </div>
      </div>
    </nav>
  );
}
