import {
  type CatalogSort,
  type PriceFilter,
} from "@/components/storefront/storefrontCatalogModel";
import { ChevronDown, RotateCcw } from "lucide-react";
import type { StorefrontCatalogSurfaceProps } from "./StorefrontCatalogSurface";
type Props = Pick<
  StorefrontCatalogSurfaceProps,
  | "showWishlist"
  | "search"
  | "activeCatName"
  | "filteredItems"
  | "availability"
  | "setAvailability"
  | "priceFilter"
  | "setPriceFilter"
  | "brands"
  | "brand"
  | "setBrand"
  | "sort"
  | "setSort"
  | "setCatalogSeed"
  | "hasRefinements"
  | "categoryId"
  | "scrollToResults"
  | "clearCatalogFilters"
>;
export function StorefrontCatalogFilters({
  showWishlist,
  search,
  activeCatName,
  filteredItems,
  availability,
  setAvailability,
  priceFilter,
  setPriceFilter,
  brands,
  brand,
  setBrand,
  sort,
  setSort,
  setCatalogSeed,
  hasRefinements,
  categoryId,
  scrollToResults,
  clearCatalogFilters,
}: Props) {
  return (
    <>
      {" "}
      <div className="mb-5 flex flex-col gap-3 border-b border-slate-100 pb-5 sm:flex-row sm:items-end sm:justify-between dark:border-slate-800">
        <div>
          <p className="text-xs font-black uppercase tracking-[0.15em] text-[#0E806A] dark:text-emerald-400">
            كل اللي تحتاجه، وأكثر!
          </p>
          <h2 className="mt-1 text-2xl sm:text-3xl font-black tracking-tight text-slate-900 dark:text-slate-100">
            {showWishlist ? "قائمة أعجبتني" : "المسواك الأكثر طلباً بالعراق"}
          </h2>
          <p className="mt-1 text-xs font-bold text-slate-500 dark:text-slate-400">
            {search
              ? `نتائج البحث عن «${search}»`
              : activeCatName
                ? `منتجات فئة «${activeCatName}»`
                : "تصفح المجموعة الكاملة بالأسعار والمخزون المباشر"}
          </p>
        </div>
        <span
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-3 py-1 text-xs font-black text-slate-700 dark:bg-slate-800 dark:text-slate-300"
        >
          {filteredItems.length} منتج
        </span>
      </div>
      <div className="mb-6 flex flex-col gap-3 rounded-2xl border border-slate-200/80 bg-slate-50/50 p-3 lg:flex-row lg:items-center lg:justify-between dark:border-slate-800 dark:bg-slate-900/50">
        <div className="flex items-center gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <button
            type="button"
            onClick={() => {
              setAvailability((value) =>
                value === "IN_STOCK" ? "ALL" : "IN_STOCK",
              );
              scrollToResults();
            }}
            aria-pressed={availability === "IN_STOCK"}
            className={`shrink-0 rounded-xl px-3.5 py-2 text-xs font-black transition ${availability === "IN_STOCK" ? "bg-blue-600 text-white shadow-sm shadow-blue-500/20" : "bg-white text-slate-600 ring-1 ring-slate-200 hover:ring-slate-300 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700"}`}
          >
            {availability === "IN_STOCK" ? "متوفر الآن فقط" : "كل المنتجات"}
          </button>
          <label className="relative shrink-0">
            <span className="sr-only">نطاق السعر</span>
            <select
              value={priceFilter}
              onChange={(e) => {
                setPriceFilter(e.target.value as PriceFilter);
                scrollToResults();
              }}
              className="appearance-none rounded-xl border border-slate-200 bg-white py-2 pr-3 pl-8 text-xs font-bold text-slate-700 outline-none transition focus:border-blue-600 focus:ring-1 focus:ring-blue-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
            >
              <option value="ALL">كل الأسعار</option>
              <option value="UNDER_5000">أقل من 5,000 د.ع</option>
              <option dir="ltr" value="FROM_5000_TO_15000">
                5,000 – 15,000 د.ع
              </option>
              <option value="OVER_15000">أكثر من 15,000 د.ع</option>
            </select>
            <ChevronDown
              aria-hidden
              className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-slate-400"
            />
          </label>
          {brands.length > 0 && (
            <label className="relative shrink-0">
              <span className="sr-only">الماركة</span>
              <select
                value={brand}
                onChange={(e) => {
                  setBrand(e.target.value);
                  scrollToResults();
                }}
                className="appearance-none rounded-xl border border-slate-200 bg-white py-2 pr-3 pl-8 text-xs font-bold text-slate-700 outline-none transition focus:border-blue-600 focus:ring-1 focus:ring-blue-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
              >
                <option value="">كل الماركات</option>
                {brands.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
              <ChevronDown
                aria-hidden
                className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-slate-400"
              />
            </label>
          )}
        </div>
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-1.5">
            <label className="relative shrink-0">
              <span className="sr-only">ترتيب النتائج</span>
              <select
                value={sort}
                onChange={(e) => {
                  setSort(e.target.value as CatalogSort);
                  scrollToResults();
                }}
                className="appearance-none rounded-xl border border-slate-200 bg-white py-2 pr-3 pl-8 text-xs font-bold text-slate-700 outline-none transition focus:border-blue-600 focus:ring-1 focus:ring-blue-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
              >
                <option value="RECOMMENDED">الترتيب المقترح</option>
                <option value="BEST_SELLERS">الأكثر مبيعاً</option>
                <option value="PRICE_ASC">السعر: الأقل أولاً</option>
                <option value="PRICE_DESC">السعر: الأعلى أولاً</option>
              </select>
              <ChevronDown
                aria-hidden
                className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-slate-400"
              />
            </label>
            {sort === "RECOMMENDED" && !search && (
              <button
                type="button"
                onClick={() =>
                  setCatalogSeed(Math.random().toString(36).slice(2, 10))
                }
                title="تجديد الترتيب المقترح واكتشاف منتجات أخرى"
                aria-label="تجديد الترتيب المقترح واكتشاف منتجات أخرى"
                className="flex size-8 shrink-0 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-600 shadow-xs transition hover:border-[#1e4a63] hover:text-[#1e4a63] active:scale-95 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:border-blue-400 dark:hover:text-blue-400"
              >
                <RotateCcw aria-hidden className="size-3.5" />
              </button>
            )}
          </div>
          {(hasRefinements || categoryId != null || search) && (
            <button
              type="button"
              onClick={clearCatalogFilters}
              className="text-xs font-black text-orange-600 hover:underline dark:text-orange-400"
            >
              مسح الفلاتر
            </button>
          )}
        </div>
      </div>
    </>
  );
}
