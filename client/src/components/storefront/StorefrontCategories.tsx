import React from "react";
import { Store, BookOpen, Gift, Layers, PenTool } from "lucide-react";

interface CategoryItem {
  id: number;
  name: string;
  productCount?: number;
  availableCount?: number;
  [key: string]: any;
}

interface StorefrontCategoriesProps {
  categories: any[];
  selectedId: number | null;
  onSelectCategory: (id: number) => void;
  categoryCountFn: (cat: any) => number;
  className?: string;
}

const CATEGORY_THEMES = [
  {
    bg: "from-blue-50/80 to-slate-50",
    border: "border-blue-100 hover:border-blue-300",
    iconBg: "bg-blue-600 text-white",
    hoverGlow: "group-hover:shadow-blue-500/10",
    icon: <BookOpen aria-hidden className="size-4" />,
  },
  {
    bg: "from-amber-50/80 to-orange-50/40",
    border: "border-amber-100 hover:border-amber-300",
    iconBg: "bg-orange-500 text-white",
    hoverGlow: "group-hover:shadow-orange-500/10",
    icon: <Gift aria-hidden className="size-4" />,
  },
  {
    bg: "from-emerald-50/80 to-teal-50/40",
    border: "border-emerald-100 hover:border-emerald-300",
    iconBg: "bg-emerald-600 text-white",
    hoverGlow: "group-hover:shadow-emerald-500/10",
    icon: <PenTool aria-hidden className="size-4" />,
  },
  {
    bg: "from-slate-50 to-zinc-100/60",
    border: "border-slate-200 hover:border-slate-400",
    iconBg: "bg-slate-800 text-white",
    hoverGlow: "group-hover:shadow-slate-500/10",
    icon: <Layers aria-hidden className="size-4" />,
  },
];

export function StorefrontCategories({
  categories,
  selectedId,
  onSelectCategory,
  categoryCountFn,
  className = "",
}: StorefrontCategoriesProps) {
  if (categories.length === 0) return null;

  return (
    <section
      aria-labelledby="store-category-title"
      className={`rounded-3xl border border-slate-200/80 bg-white p-5 shadow-sm sm:p-7 dark:border-slate-800 dark:bg-slate-900 ${className}`}
    >
      <div className="mb-5 flex items-end justify-between">
        <div>
          <span className="text-[11px] font-black uppercase tracking-wider text-orange-600 dark:text-orange-400">
            تصفح حسب اهتمامك
          </span>
          <h2
            id="store-category-title"
            className="mt-1 text-2xl font-black tracking-tight text-slate-900 dark:text-slate-100 sm:text-3xl"
          >
            الأقسام الرئيسية
          </h2>
        </div>
        <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-bold text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300">
          {categories.length} أقسام متاحة
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
        {categories.slice(0, 12).map((cat, index) => {
          const theme = CATEGORY_THEMES[index % CATEGORY_THEMES.length];
          const isSelected = selectedId === cat.id;
          const count = categoryCountFn(cat);

          return (
            <button
              key={cat.id}
              type="button"
              onClick={() => onSelectCategory(cat.id)}
              className={`group relative flex flex-col justify-between overflow-hidden rounded-2xl border bg-gradient-to-br p-4 text-right transition-all duration-300 hover:-translate-y-1 hover:shadow-lg active:scale-95 ${
                isSelected
                  ? "border-blue-600 bg-blue-50/90 shadow-md ring-2 ring-blue-600/20 dark:bg-blue-950/40"
                  : `${theme.bg} ${theme.border} ${theme.hoverGlow}`
              }`}
            >
              {/* الدائرة الجمالية الخلفية */}
              <div
                aria-hidden="true"
                className="pointer-events-none absolute -left-4 -top-4 size-16 rounded-full bg-white/40 blur-sm dark:bg-white/5"
              />

              <div className="mb-6 flex items-center justify-between">
                <div
                  className={`flex size-10 items-center justify-center rounded-xl shadow-sm transition-transform duration-300 group-hover:scale-110 ${theme.iconBg}`}
                >
                  {theme.icon}
                </div>
                {count > 0 && (
                  <span className="rounded-full bg-white/80 px-2 py-0.5 text-[10px] font-black text-slate-600 shadow-2xs backdrop-blur-xs dark:bg-slate-800/80 dark:text-slate-300">
                    {count} منتج
                  </span>
                )}
              </div>

              <div>
                <span className="block text-sm font-black text-slate-800 transition-colors group-hover:text-blue-700 dark:text-slate-100 dark:group-hover:text-blue-400">
                  {cat.name}
                </span>
                <span className="mt-1 block text-[11px] font-semibold text-slate-400 dark:text-slate-500">
                  تصفح المنتجات ←
                </span>
              </div>
            </button>
          );
        })}
      </div>
    </section>
  );
}
