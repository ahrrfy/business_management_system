import { BannerCarousel } from "@/components/store-admin/BannerCarousel";
import { StorefrontCategories } from "@/components/storefront/StorefrontCategories";
import { type BannerItem } from "@/components/storefront/StorefrontInlineStrip";
import { type StorefrontProductForCartAction } from "@/components/storefront/StorefrontRecommendations";
import { StorefrontSearchAlternatives } from "@/components/storefront/StorefrontSearch";
import {
  StorefrontOffersBar,
  type LiveStoreOffer,
} from "@/components/storefront/StorefrontOffersBar";
import {
  type AvailabilityFilter,
  type CatalogSort,
  type PriceFilter,
  SHARE_FEEDBACK_TONE_CLASS,
  type ShareFeedbackTone,
  storefrontCategoryCount,
} from "@/components/storefront/storefrontCatalogModel";
import { type RouterOutputs, trpc } from "@/lib/trpc";
import { AlertTriangle, BadgePercent, Loader2, Package } from "lucide-react";
import React from "react";
import { StorefrontCatalogFilters } from "./StorefrontCatalogFilters";
import { StorefrontProductGrid } from "./StorefrontProductGrid";

export interface StorefrontCatalogSurfaceProps {
  announcement: string | null;
  shareFeedback: { text: string; tone: ShareFeedbackTone } | null;
  settingsQ: Pick<
    ReturnType<typeof trpc.storefront.settings.useQuery>,
    "isSuccess"
  >;
  storeOpen: boolean;
  search: string;
  categoryId: number | null;
  showWishlist: boolean;
  topBanners: BannerItem[];
  topBannerSlot: "HERO" | "INLINE";
  cats: RouterOutputs["storefront"]["categories"];
  selectCategory: (id: number | null) => void;
  availability: AvailabilityFilter;
  activeCatName: string | null;
  filteredItems: RouterOutputs["storefront"]["catalog"]["items"];
  scrollToResults: () => void;
  priceFilter: PriceFilter;
  setPriceFilter: React.Dispatch<React.SetStateAction<PriceFilter>>;
  brands: string[];
  brand: string;
  setBrand: React.Dispatch<React.SetStateAction<string>>;
  sort: CatalogSort;
  setSort: React.Dispatch<React.SetStateAction<CatalogSort>>;
  hasRefinements: boolean;
  clearCatalogFilters: () => void;
  catalogQ: Pick<
    ReturnType<typeof trpc.storefront.catalog.useInfiniteQuery>,
    | "isLoading"
    | "isError"
    | "hasNextPage"
    | "isFetchingNextPage"
    | "refetch"
    | "fetchNextPage"
  >;
  catalogInitialError: boolean;
  isEmptyCatalog: boolean;
  submitStoreSearch: (
    query: string,
    selectedCategory?: number | undefined,
  ) => void;
  openProduct: (
    productId: number,
    options?:
      | {
          openReview?: boolean | undefined;
          orderNumber?: string | null | undefined;
        }
      | undefined,
  ) => void;
  searchScope: {
    categoryId: number | null;
    categoryIds?: number[] | null;
    promotionId?: number | null;
    availability: AvailabilityFilter;
    brand: string;
    priceFilter: PriceFilter;
    productIds: number[] | undefined;
  };
  wishlistIds: Set<number>;
  recentlyAddedProductId: number | null;
  heartPulseTarget: string | null;
  heartPulseNonce: number;
  sharePulseTarget: string | null;
  sharePulseNonce: number;
  addCatalogProduct: (
    p: StorefrontProductForCartAction,
    event: React.MouseEvent<HTMLButtonElement>,
  ) => boolean;
  toggleWishlist: (productId: number, target?: string) => void;
  shareProduct: (productId: number, productName: string) => void;
  getProductCartQty: (id: number) => number;
  handleProductQuantityDelta: (id: number, delta: number) => void;
  feedStrips: BannerItem[];
  inlineBanners: BannerItem[];
  catalogLoadMoreRef: React.RefObject<HTMLDivElement | null>;
  offers?: LiveStoreOffer[];
  activeOfferId?: number | null;
  onSelectOffer?: (offer: LiveStoreOffer) => void;
  onClearOffer?: () => void;
}

export function StorefrontCatalogSurface({
  announcement,
  shareFeedback,
  settingsQ,
  storeOpen,
  search,
  categoryId,
  showWishlist,
  topBanners,
  topBannerSlot,
  cats,
  selectCategory,
  availability,
  activeCatName,
  filteredItems,
  scrollToResults,
  priceFilter,
  setPriceFilter,
  brands,
  brand,
  setBrand,
  sort,
  setSort,
  hasRefinements,
  clearCatalogFilters,
  catalogQ,
  catalogInitialError,
  isEmptyCatalog,
  submitStoreSearch,
  openProduct,
  searchScope,
  wishlistIds,
  recentlyAddedProductId,
  heartPulseTarget,
  heartPulseNonce,
  sharePulseTarget,
  sharePulseNonce,
  addCatalogProduct,
  toggleWishlist,
  shareProduct,
  getProductCartQty,
  handleProductQuantityDelta,
  feedStrips,
  inlineBanners,
  catalogLoadMoreRef,
  offers = [],
  activeOfferId = null,
  onSelectOffer,
  onClearOffer,
}: StorefrontCatalogSurfaceProps) {
  const contextualCategoryBanners = React.useMemo(() => {
    if (categoryId == null || search || showWishlist) return [];
    const targetPath = `/store/category/${categoryId}`;
    const targetQuery = `category=${categoryId}`;
    return [...topBanners, ...inlineBanners].filter(
      (b) => b.ctaUrl === targetPath || (b.ctaUrl?.includes(targetQuery) ?? false),
    );
  }, [categoryId, inlineBanners, search, showWishlist, topBanners]);

  const visibleHeroBanners =
    !search && categoryId == null && !showWishlist
      ? topBanners
      : contextualCategoryBanners;

  const isSearching = Boolean(search.trim());
  const closestFallbackQ = trpc.storefront.catalog.useQuery(
    {
      search: search.trim(),
      availability: "IN_STOCK",
      relaxedFallback: true,
      limit: 24,
    },
    {
      enabled:
        isSearching &&
        search.trim().length >= 2 &&
        !catalogQ.isLoading &&
        filteredItems.length === 0,
      staleTime: 15_000,
      refetchOnWindowFocus: false,
    },
  );
  const closestItems = React.useMemo(
    () => (closestFallbackQ.data?.items ?? []).filter((item) => item.inStock !== false),
    [closestFallbackQ.data?.items],
  );

  return (
    <main
      id="store-main"
      tabIndex={-1}
      className="mx-auto w-full max-w-[1360px] overflow-x-clip px-2.5 py-3 pb-24 outline-none sm:px-4 sm:py-4 lg:px-6"
    >
      <h1 className="sr-only">مكتبة العربية للتسوق والتوصيل في العراق</h1>

      {announcement && (
        <div className="mb-3.5 flex items-center gap-2 rounded-xl border border-slate-200/90 bg-white px-3.5 py-2.5 text-xs font-bold text-slate-800 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-100">
          <BadgePercent aria-hidden className="size-4 shrink-0 text-[var(--store-brand)]" />
          <span>{announcement}</span>
        </div>
      )}

      {shareFeedback && (
        <div
          role={shareFeedback.tone === "err" ? "alert" : "status"}
          className={`mb-3.5 rounded-xl border px-4 py-2.5 text-center text-xs font-bold transition-opacity duration-200 ${SHARE_FEEDBACK_TONE_CLASS[shareFeedback.tone]}`}
        >
          {shareFeedback.text}
        </div>
      )}

      {settingsQ.isSuccess && !storeOpen && (
        <div className="mb-3.5 rounded-xl border border-[var(--sem-neg)]/30 bg-[var(--sem-neg-bg)] px-4 py-2.5 text-center text-xs font-bold text-[var(--sem-neg)]">
          المتجر مغلق مؤقتا — يمكنك تصفح المنتجات والعودة لاحقا لإتمام الطلب.
        </div>
      )}

      {!isSearching && visibleHeroBanners.length > 0 && (
        <div className="mb-3.5 w-full min-w-0 sm:mb-4">
          <BannerCarousel
            banners={visibleHeroBanners}
            slot={
              categoryId != null
                ? visibleHeroBanners[0]?.placement === "INLINE"
                  ? "INLINE"
                  : "HERO"
                : topBannerSlot
            }
          />
        </div>
      )}

      {!isSearching && cats.length > 0 && (
        <StorefrontCategories
          id="store-categories"
          categories={cats}
          selectedId={categoryId}
          onSelectCategory={selectCategory}
          categoryCountFn={(c) => storefrontCategoryCount(c, availability)}
          className="mb-3.5 scroll-mt-20 sm:mb-4"
        />
      )}

      {!isSearching &&
        !showWishlist &&
        offers.length > 0 &&
        onSelectOffer &&
        onClearOffer && (
          <StorefrontOffersBar
            offers={offers}
            activeOfferId={activeOfferId}
            onSelectOffer={onSelectOffer}
            onClearOffer={onClearOffer}
            className="mb-3.5 scroll-mt-20"
          />
        )}

      <section
        id="store-results"
        className="scroll-mt-24"
      >
        <StorefrontCatalogFilters
          showWishlist={showWishlist}
          search={search}
          activeCatName={activeCatName}
          filteredItems={filteredItems}
          priceFilter={priceFilter}
          setPriceFilter={setPriceFilter}
          brands={brands}
          brand={brand}
          setBrand={setBrand}
          sort={sort}
          setSort={setSort}
          hasRefinements={hasRefinements}
          categoryId={categoryId}
          scrollToResults={scrollToResults}
          clearCatalogFilters={clearCatalogFilters}
        />

        {catalogQ.isLoading ? (
          <div className="flex flex-col items-center justify-center rounded-2xl border border-slate-900/[0.06] bg-white py-20 text-slate-500 dark:border-slate-800 dark:bg-slate-900">
            <Loader2
              aria-hidden
              className="size-7 animate-spin text-[var(--store-brand)]"
            />
            <p className="mt-2.5 text-xs font-bold">جار تحميل المنتجات...</p>
          </div>
        ) : catalogInitialError ? (
          <div
            className="flex flex-col items-center justify-center rounded-2xl border border-slate-200 bg-white py-20 text-center dark:border-slate-800 dark:bg-slate-900"
            role="alert"
          >
            <AlertTriangle aria-hidden className="size-9 text-[var(--sem-warn)]" />
            <p className="mt-3 text-sm font-black text-slate-900 dark:text-white">
              تعذر تحميل المنتجات
            </p>
            <button
              type="button"
              onClick={() => void catalogQ.refetch()}
              className="store-primary-action mt-3.5 rounded-xl bg-[var(--store-brand)] px-5 py-2 text-xs font-black text-white transition hover:bg-[var(--store-brand-strong)]"
            >
              إعادة المحاولة
            </button>
          </div>
        ) : filteredItems.length === 0 ? (
          isSearching && closestFallbackQ.isLoading ? (
            <div className="flex flex-col items-center justify-center rounded-2xl border border-slate-900/[0.06] bg-white py-16 text-slate-500 dark:border-slate-800 dark:bg-slate-900">
              <Loader2
                aria-hidden
                className="size-6 animate-spin text-[var(--store-brand)]"
              />
              <p className="mt-2.5 text-xs font-bold">جار البحث...</p>
            </div>
          ) : isSearching && closestItems.length > 0 ? (
            <div className="space-y-3.5">
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-900/[0.08] bg-white px-3.5 py-2.5 text-right dark:border-slate-800 dark:bg-slate-900">
                <p className="text-xs font-bold text-[#1d1d1f] dark:text-slate-100">
                  أقرب المنتجات المتوفرة لبحثك «{search}»
                </p>
                <button
                  type="button"
                  onClick={clearCatalogFilters}
                  className="rounded-full bg-[#f5f5f7] px-3 py-1 text-xs font-semibold text-[#1d1d1f] transition hover:bg-slate-200/70 dark:bg-slate-800 dark:text-slate-100"
                >
                  عرض الكل
                </button>
              </div>
              <StorefrontProductGrid
                filteredItems={closestItems}
                wishlistIds={wishlistIds}
                recentlyAddedProductId={recentlyAddedProductId}
                heartPulseTarget={heartPulseTarget}
                heartPulseNonce={heartPulseNonce}
                sharePulseTarget={sharePulseTarget}
                sharePulseNonce={sharePulseNonce}
                openProduct={openProduct}
                addCatalogProduct={addCatalogProduct}
                toggleWishlist={toggleWishlist}
                shareProduct={shareProduct}
                getProductCartQty={getProductCartQty}
                handleProductQuantityDelta={handleProductQuantityDelta}
                search={search}
                feedStrips={feedStrips}
                inlineBanners={inlineBanners}
              />
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center rounded-2xl border border-slate-200 bg-white py-16 text-center dark:border-slate-800 dark:bg-slate-900">
              <Package aria-hidden className="size-9 text-slate-400" />
              <p className="mt-3 text-sm font-black text-slate-900 dark:text-white">
                {isEmptyCatalog
                  ? "لا توجد منتجات معروضة حالياً"
                  : "لا توجد نتائج مطابقة للبحث أو الفلاتر"}
              </p>
              {search && (
                <StorefrontSearchAlternatives
                  query={search}
                  onSearch={submitStoreSearch}
                  onSelectProduct={openProduct}
                  {...searchScope}
                />
              )}
              {!isEmptyCatalog && (
                <button
                  type="button"
                  onClick={clearCatalogFilters}
                  className="mt-3.5 rounded-xl bg-[#1d1d1f] px-4 py-2 text-xs font-bold text-white transition hover:bg-slate-800 dark:bg-white dark:text-[#1d1d1f]"
                >
                  مسح البحث والفلاتر
                </button>
              )}
            </div>
          )
        ) : (
          <StorefrontProductGrid
            filteredItems={filteredItems}
            wishlistIds={wishlistIds}
            recentlyAddedProductId={recentlyAddedProductId}
            heartPulseTarget={heartPulseTarget}
            heartPulseNonce={heartPulseNonce}
            sharePulseTarget={sharePulseTarget}
            sharePulseNonce={sharePulseNonce}
            openProduct={openProduct}
            addCatalogProduct={addCatalogProduct}
            toggleWishlist={toggleWishlist}
            shareProduct={shareProduct}
            getProductCartQty={getProductCartQty}
            handleProductQuantityDelta={handleProductQuantityDelta}
            search={search}
            feedStrips={feedStrips}
            inlineBanners={inlineBanners}
          />
        )}

        {catalogQ.hasNextPage && (
          <div
            ref={catalogLoadMoreRef}
            className="mt-6 flex min-h-8 items-center justify-center"
            aria-live="polite"
          >
            {catalogQ.isFetchingNextPage && (
              <Loader2
                aria-hidden
                className="size-5 animate-spin text-[var(--store-brand)]"
              />
            )}
          </div>
        )}

        {catalogQ.isError && !catalogInitialError && (
          <div
            className="mt-3 flex flex-col items-center gap-1.5 text-center"
            role="alert"
          >
            <button
              type="button"
              onClick={() => void catalogQ.fetchNextPage()}
              disabled={catalogQ.isFetchingNextPage}
              className="text-xs font-bold text-[var(--store-brand)] underline disabled:opacity-50"
            >
              تحميل المزيد
            </button>
          </div>
        )}
      </section>
    </main>
  );
}
