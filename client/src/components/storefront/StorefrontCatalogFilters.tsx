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
import type { StorefrontCatalogSurfaceProps } from "./StorefrontCatalogSurface";

type Props = Pick<
  StorefrontCatalogSurfaceProps,
  | "showWishlist"
  | "search"
  | "activeCatName"
  | "filteredItems"
  | "priceFilter"
  | "setPriceFilter"
  | "brands"
  | "brand"
  | "setBrand"
  | "sort"
  | "setSort"
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
  priceFilter,
  setPriceFilter,
  brands,
  brand,
  setBrand,
  sort,
  setSort,
  hasRefinements,
  categoryId,
  scrollToResults,
  clearCatalogFilters,
}: Props) {
  const contextTitle = showWishlist
    ? "المفضلة"
    : search
      ? `نتائج «${search}»`
      : activeCatName;

  const isDealsQuick = priceFilter === "ON_SALE";
  const isBestSellersQuick = priceFilter !== "ON_SALE" && sort === "BEST_SELLERS";
  const isAllQuick = !isDealsQuick && !isBestSellersQuick;

  return (
    <div className="mb-3.5 space-y-2.5">
      {contextTitle && (
        <div className="flex items-center justify-between gap-2">
          <h2 className="store-display-title truncate text-base sm:text-lg font-bold text-[#1d1d1f] dark:text-slate-100">
            {contextTitle}
          </h2>
          <span
            role="status"
            aria-live="polite"
            aria-atomic="true"
            className="shrink-0 rounded-full bg-[#f5f5f7] px-2.5 py-0.5 text-[11px] font-semibold text-slate-600 tabular-nums dark:bg-slate-800 dark:text-slate-300"
          >
            {filteredItems.length} منتج
          </span>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="inline-flex items-center rounded-xl bg-[#f5f5f7] p-1 dark:bg-slate-800/80">
          <button
            type="button"
            aria-pressed={isAllQuick}
            onClick={() => {
              setPriceFilter("ALL");
              setSort("RECOMMENDED");
            }}
            className={`rounded-lg px-3 py-1.5 text-xs font-bold transition ${
              isAllQuick
                ? "bg-white text-[#1d1d1f] shadow-2xs dark:bg-slate-900 dark:text-white"
                : "text-slate-600 hover:text-[#1d1d1f] dark:text-slate-300"
            }`}
          >
            الكل
          </button>
          <button
            type="button"
            aria-pressed={isDealsQuick}
            onClick={() => {
              setPriceFilter(isDealsQuick ? "ALL" : "ON_SALE");
            }}
            className={`rounded-lg px-3 py-1.5 text-xs font-bold transition ${
              isDealsQuick
                ? "bg-white text-[var(--store-accent)] shadow-2xs dark:bg-slate-900"
                : "text-slate-600 hover:text-[#1d1d1f] dark:text-slate-300"
            }`}
          >
            العروض
          </button>
          <button
            type="button"
            aria-pressed={isBestSellersQuick}
            onClick={() => {
              if (priceFilter === "ON_SALE") setPriceFilter("ALL");
              setSort(isBestSellersQuick ? "RECOMMENDED" : "BEST_SELLERS");
            }}
            className={`rounded-lg px-3 py-1.5 text-xs font-bold transition ${
              isBestSellersQuick
                ? "bg-white text-[#1d1d1f] shadow-2xs dark:bg-slate-900 dark:text-white"
                : "text-slate-600 hover:text-[#1d1d1f] dark:text-slate-300"
            }`}
          >
            الأكثر طلبا
          </button>
        </div>

        <div className="flex items-center gap-1.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {!contextTitle && (
            <span
              role="status"
              aria-live="polite"
              aria-atomic="true"
              className="sr-only"
            >
              {filteredItems.length} منتج
            </span>
          )}

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
                className="!h-8 rounded-lg border-slate-200/90 bg-white px-2.5 text-xs font-semibold text-slate-700 shadow-none focus-visible:border-[var(--store-brand)] dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent dir="rtl" align="end">
                <SelectItem value="ALL">كل الأسعار</SelectItem>
                <SelectItem value="ON_SALE">عروض وتخفيضات</SelectItem>
                <SelectItem value="UNDER_5000">أقل من 5,000 د.ع</SelectItem>
                <SelectItem value="FROM_5000_TO_15000">
                  5,000 - 15,000 د.ع
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
                  className="!h-8 rounded-lg border-slate-200/90 bg-white px-2.5 text-xs font-semibold text-slate-700 shadow-none focus-visible:border-[var(--store-brand)] dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
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
                className="!h-8 rounded-lg border-slate-200/90 bg-white px-2.5 text-xs font-semibold text-slate-700 shadow-none focus-visible:border-[var(--store-brand)] dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent dir="rtl" align="start">
                <SelectItem value="RECOMMENDED">المقترح</SelectItem>
                <SelectItem value="BEST_SELLERS">الأكثر طلبا</SelectItem>
                <SelectItem value="PRICE_ASC">الأقل سعرا</SelectItem>
                <SelectItem value="PRICE_DESC">الأعلى سعرا</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {(hasRefinements || categoryId != null || search) && (
            <button
              type="button"
              onClick={clearCatalogFilters}
              className="shrink-0 rounded-lg px-2 py-1 text-xs font-semibold text-[var(--store-accent)] hover:underline"
            >
              إعادة ضبط
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
