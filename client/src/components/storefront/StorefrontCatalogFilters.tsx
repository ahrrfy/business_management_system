import {
  type CatalogSort,
  type PriceFilter,
} from "@/components/storefront/storefrontCatalogModel";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { RotateCcw } from "lucide-react";
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
      <div className="mb-4 flex flex-col gap-2 border-b border-slate-900/[0.06] pb-4 sm:flex-row sm:items-end sm:justify-between dark:border-slate-800">
        <div>
          <h2 className="store-display-title text-xl sm:text-2xl font-bold text-slate-900 dark:text-slate-100">
            {showWishlist
              ? "قائمة المفضلة"
              : search
                ? `نتائج «${search}»`
                : activeCatName
                  ? activeCatName
                  : "الكتالوج"}
          </h2>
          <p className="mt-0.5 text-xs font-medium text-slate-500 dark:text-slate-400">
            الأسعار والتوفر محدّثة مباشرة من المخزون
          </p>
        </div>
        <span
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="inline-flex w-fit items-center rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700 tabular-nums dark:bg-slate-800 dark:text-slate-300"
        >
          {filteredItems.length} منتج
        </span>
      </div>

      <div className="mb-5 flex flex-col gap-2.5 rounded-xl border border-slate-900/[0.06] bg-[#f8f8fa] p-2.5 lg:flex-row lg:items-center lg:justify-between dark:border-slate-800 dark:bg-slate-900/60">
        <div className="flex items-center gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <span
            onClick={() => {
              if (availability !== "IN_STOCK") {
                setAvailability("IN_STOCK");
                scrollToResults();
              }
            }}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-[#1d1d1f] px-3 py-1.5 text-xs font-semibold text-white dark:bg-white dark:text-[#1d1d1f]"
          >
            <span aria-hidden className="size-1.5 rounded-full bg-emerald-400 dark:bg-emerald-600" />
            المتوفر بالمخزون فقط
          </span>

          <div className="shrink-0">
            <Select
              dir="rtl"
              value={priceFilter}
              onValueChange={(value) => {
                setPriceFilter(value as PriceFilter);
                scrollToResults();
              }}
            >
              <SelectTrigger
                aria-label="نطاق السعر"
                className="!h-8.5 rounded-lg border-slate-200 bg-white px-3 text-xs font-semibold text-slate-700 shadow-none focus-visible:border-[var(--store-brand)] dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent dir="rtl" align="end">
                <SelectItem value="ALL">كل الأسعار</SelectItem>
                <SelectItem value="ON_SALE">عروض وتخفيضات فقط</SelectItem>
                <SelectItem value="UNDER_5000">أقل من 5,000 د.ع</SelectItem>
                <SelectItem value="FROM_5000_TO_15000">
                  من 5,000 إلى 15,000 د.ع
                </SelectItem>
                <SelectItem value="OVER_15000">أكثر من 15,000 د.ع</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {brands.length > 0 && (
            <div className="shrink-0">
              <Select
                dir="rtl"
                value={brand || "__ALL__"}
                onValueChange={(value) => {
                  setBrand(value === "__ALL__" ? "" : value);
                  scrollToResults();
                }}
              >
                <SelectTrigger
                  aria-label="الماركة"
                  className="!h-8.5 rounded-lg border-slate-200 bg-white px-3 text-xs font-semibold text-slate-700 shadow-none focus-visible:border-[var(--store-brand)] dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent dir="rtl" align="end">
                  <SelectItem value="__ALL__">كل الماركات</SelectItem>
                  {brands.map((name) => (
                    <SelectItem key={name} value={name}>
                      {name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-2.5">
          <div className="flex items-center gap-1.5">
            <div className="shrink-0">
              <Select
                dir="rtl"
                value={sort}
                onValueChange={(value) => {
                  setSort(value as CatalogSort);
                  scrollToResults();
                }}
              >
                <SelectTrigger
                  aria-label="ترتيب النتائج"
                  className="!h-8.5 rounded-lg border-slate-200 bg-white px-3 text-xs font-semibold text-slate-700 shadow-none focus-visible:border-[var(--store-brand)] dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent dir="rtl" align="start">
                  <SelectItem value="RECOMMENDED">الترتيب المقترح</SelectItem>
                  <SelectItem value="BEST_SELLERS">الأكثر مبيعاً</SelectItem>
                  <SelectItem value="PRICE_ASC">السعر: الأقل أولاً</SelectItem>
                  <SelectItem value="PRICE_DESC">السعر: الأعلى أولاً</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {sort === "RECOMMENDED" && !search && (
              <button
                type="button"
                onClick={() =>
                  setCatalogSeed(Math.random().toString(36).slice(2, 10))
                }
                title="تحديث الترتيب"
                aria-label="تحديث الترتيب"
                className="flex size-8 shrink-0 touch-manipulation items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-600 transition-[transform,border-color,color] duration-150 ease-out hover:border-slate-400 hover:text-slate-900 active:scale-[0.94] dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300"
              >
                <RotateCcw aria-hidden className="size-3.5" />
              </button>
            )}
          </div>
          {(hasRefinements || categoryId != null || search) && (
            <button
              type="button"
              onClick={clearCatalogFilters}
              className="text-xs font-semibold text-[var(--store-accent)] hover:underline"
            >
              إعادة ضبط
            </button>
          )}
        </div>
      </div>
    </>
  );
}
