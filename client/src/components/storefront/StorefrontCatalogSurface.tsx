import { BannerCarousel } from "@/components/store/BannerCarousel";
import { StorefrontCategories } from "@/components/storefront/StorefrontCategories";
import {
  CuratedRow,
  type RowProduct,
} from "@/components/storefront/StorefrontCuratedRows";
import { StorefrontDispatchCountdown } from "@/components/storefront/StorefrontDispatchCountdown";
import { type BannerItem } from "@/components/storefront/StorefrontInlineStrip";
import { StorefrontMilestoneBar } from "@/components/storefront/StorefrontMilestoneBar";
import {
  type StorefrontProductForCartAction,
  storefrontProductCanBeOrdered,
} from "@/components/storefront/StorefrontRecommendations";
import { StorefrontSearchAlternatives } from "@/components/storefront/StorefrontSearch";
import {
  StorefrontThematicStrip,
  type ThematicCollectionCard,
} from "@/components/storefront/StorefrontThematicStrip";
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
  cartSubtotal: number;
  settings: RouterOutputs["storefront"]["settings"] | undefined;
  search: string;
  categoryId: number | null;
  showWishlist: boolean;
  topBanners: BannerItem[];
  topBannerSlot: "HERO" | "INLINE";
  cats: RouterOutputs["storefront"]["categories"];
  selectCategory: (id: number | null) => void;
  availability: AvailabilityFilter;
  selectedThematicCollection: ThematicCollectionCard | null;
  handleSelectThematicCollection: (card: ThematicCollectionCard) => void;
  handleClearThematicCollection: () => void;
  activeCatName: string | null;
  filteredItems: RouterOutputs["storefront"]["catalog"]["items"];
  setAvailability: React.Dispatch<React.SetStateAction<AvailabilityFilter>>;
  scrollToResults: () => void;
  priceFilter: PriceFilter;
  setPriceFilter: React.Dispatch<React.SetStateAction<PriceFilter>>;
  brands: string[];
  brand: string;
  setBrand: React.Dispatch<React.SetStateAction<string>>;
  sort: CatalogSort;
  setSort: React.Dispatch<React.SetStateAction<CatalogSort>>;
  setCatalogSeed: React.Dispatch<React.SetStateAction<string>>;
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
  dealProducts?: RowProduct[];
  addFeaturedToCart?: (
    p: RowProduct,
    event: React.MouseEvent<HTMLButtonElement>,
  ) => boolean;
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
  cartSubtotal,
  settings,
  search,
  categoryId,
  showWishlist,
  topBanners,
  topBannerSlot,
  cats,
  selectCategory,
  availability,
  selectedThematicCollection,
  handleSelectThematicCollection,
  handleClearThematicCollection,
  activeCatName,
  filteredItems,
  setAvailability,
  scrollToResults,
  priceFilter,
  setPriceFilter,
  brands,
  brand,
  setBrand,
  sort,
  setSort,
  setCatalogSeed,
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
  dealProducts,
  addFeaturedToCart,
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
      className="mx-auto w-full max-w-[1500px] overflow-x-clip px-2.5 py-4 pb-28 outline-none sm:px-4 sm:py-6 lg:px-8"
    >
      <h1 className="sr-only">متجر المكتبة العربية — متجر مكتبه العربية للقرطاسية والطباعة والتوصيل في العراق</h1>
      {announcement && (
        <div className="mb-5 flex items-center gap-2 rounded-2xl border border-slate-200/90 bg-white px-4 py-3 text-sm font-bold text-slate-800 shadow-2xs dark:border-slate-800 dark:bg-slate-900 dark:text-slate-100">
          <BadgePercent aria-hidden className="size-4 shrink-0" />
          <span>{announcement}</span>
        </div>
      )}
      {shareFeedback && (
        <div
          role={shareFeedback.tone === "err" ? "alert" : "status"}
          className={`mb-5 rounded-xl border px-4 py-3 text-center text-xs font-bold transition-opacity duration-200 ${SHARE_FEEDBACK_TONE_CLASS[shareFeedback.tone]}`}
        >
          {shareFeedback.text}
        </div>
      )}
      {/* تنبيه — قاعدة الألوان في هذه الصفحة تختلف عن شاشات النظام: أصناف emerald/amber هنا
            **ليست** ألواناً خضراء/كهرمانية — تُعيد قشرةُ المتجر تعريفها في `index.css`
            (نصُّ emerald بدرجاته ⇐ `--store-brand` كحليّ، وخلفيّةُ amber ⇐ `--store-accent`
            طوبيّ…) فهي **مقابضُ هويّةٍ** لا دلالةَ حالة. تحويلُها إلى `--sem-*`
            يُلغي التخصيص فيقلب الهويّة إلى ألوان النظام. لذلك لا يُحوَّل هنا إلا **سطحُ حالةٍ
            صريح** (`role="alert"` أو فعلٌ مُتلِف) — على سابقة `--sem-danger`/`--sem-warn`
            القائمتين أصلاً في لوحَي الدفع والتأكيد. ويبقى هويّةً كلُّ ما عداه: السعرُ والإجماليُّ
            وخصمُ الكوبون وزرُّ الإضافة وشارةُ العرض وبطاقاتُ الأقسام وأخضرُ واتساب. */}
      {settingsQ.isSuccess && !storeOpen && (
        <div className="mb-5 border border-[var(--sem-neg)]/30 bg-[var(--sem-neg-bg)] px-4 py-3 text-center text-sm font-bold text-[var(--sem-neg)]">
          المتجر مغلق مؤقتاً — يمكنك تصفح المنتجات والعودة لاحقاً لإتمام الطلب.
        </div>
      )}

      {!isSearching && (
        <>
          <div className="mb-4">
            <StorefrontDispatchCountdown />
          </div>

          <StorefrontMilestoneBar
            cartSubtotal={cartSubtotal}
            freeShippingThresholdBaghdad={settings?.freeShippingThreshold}
            freeShippingThresholdGovernorates={
              settings?.freeShippingThresholdGovernorates
            }
            className="mb-6"
          />
        </>
      )}

      {!isSearching && visibleHeroBanners.length > 0 && (
        <div className="mb-6 w-full min-w-0">
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
          className="mb-7 scroll-mt-28"
        />
      )}

      {!isSearching &&
        ((categoryId == null && !showWishlist) || activeOfferId != null) &&
        ((dealProducts && dealProducts.length > 0 && addFeaturedToCart) ||
          (offers.length > 0 && onSelectOffer && onClearOffer)) && (
          <section
            id="store-deals"
            aria-label="عروض وتخفيضات المتجر"
            className="mb-7 scroll-mt-28 rounded-2xl border border-slate-900/[0.08] bg-white p-4 shadow-2xs sm:rounded-3xl sm:p-6 dark:border-slate-800 dark:bg-slate-900"
          >
            {offers.length > 0 && onSelectOffer && onClearOffer && (
              <StorefrontOffersBar
                offers={offers}
                activeOfferId={activeOfferId}
                onSelectOffer={onSelectOffer}
                onClearOffer={onClearOffer}
                embedded={Boolean(dealProducts && dealProducts.length > 0)}
                className={dealProducts && dealProducts.length > 0 ? "mb-5 border-b border-slate-900/[0.06] pb-4 dark:border-slate-800" : ""}
              />
            )}
            {dealProducts && dealProducts.length > 0 && addFeaturedToCart && (
              <CuratedRow
                title="الأصناف المشمولة بالعروض والتخفيضات"
                subtitle="منتجات متوفرة بالمخزون بسعر مخفّض وجاهزة للشحن الفوري"
                icon={
                  <BadgePercent
                    aria-hidden
                    className="size-4 text-[var(--store-accent)]"
                  />
                }
                products={dealProducts}
                onSelect={openProduct}
                onAdd={addFeaturedToCart}
                recentlyAddedId={recentlyAddedProductId}
                canBeOrdered={storefrontProductCanBeOrdered}
                getCartQuantity={getProductCartQty}
                onUpdateQuantity={handleProductQuantityDelta}
              />
            )}
          </section>
        )}

      {!isSearching &&
        ((categoryId == null && !showWishlist) ||
          selectedThematicCollection != null) && (
          <StorefrontThematicStrip
            activeCollectionId={selectedThematicCollection?.id ?? null}
            onSelectCollection={handleSelectThematicCollection}
            onClearCollection={handleClearThematicCollection}
            className="mb-7"
          />
        )}

      <section
        id="store-results"
        className="mt-4 sm:mt-6 scroll-mt-36 rounded-2xl sm:rounded-3xl bg-white p-3 sm:p-5 lg:p-7 shadow-xs ring-1 ring-slate-200/70 dark:bg-slate-900 dark:ring-slate-800"
      >
        <StorefrontCatalogFilters
          showWishlist={showWishlist}
          search={search}
          activeCatName={activeCatName}
          filteredItems={filteredItems}
          availability={availability}
          setAvailability={setAvailability}
          priceFilter={priceFilter}
          setPriceFilter={setPriceFilter}
          brands={brands}
          brand={brand}
          setBrand={setBrand}
          sort={sort}
          setSort={setSort}
          setCatalogSeed={setCatalogSeed}
          hasRefinements={hasRefinements}
          categoryId={categoryId}
          scrollToResults={scrollToResults}
          clearCatalogFilters={clearCatalogFilters}
        />
        {catalogQ.isLoading ? (
          <div className="flex flex-col items-center justify-center py-24 text-slate-500">
            <Loader2
              aria-hidden
              className="size-8 animate-spin text-[var(--store-brand)]"
            />
            <p className="mt-3 text-sm font-bold">جارٍ تحميل المنتجات…</p>
          </div>
        ) : catalogInitialError ? (
          <div
            className="flex flex-col items-center justify-center rounded-2xl border border-slate-200 bg-white py-24 text-center dark:border-slate-800 dark:bg-slate-900"
            role="alert"
          >
            <AlertTriangle aria-hidden className="size-10 text-[var(--sem-warn)]" />
            <p className="mt-3 text-sm font-black text-slate-900 dark:text-white">
              تعذّر تحميل المنتجات
            </p>
            <p className="mt-1 max-w-sm text-xs font-semibold text-slate-500">
              تحقق من الاتصال ثم أعد المحاولة. لم نعرض هذه الحالة كمنتجات فارغة.
            </p>
            <button
              type="button"
              onClick={() => void catalogQ.refetch()}
              className="store-primary-action mt-4 rounded-xl bg-[var(--store-brand)] px-5 py-2.5 text-xs font-black text-white transition hover:bg-[var(--store-brand-strong)]"
            >
              إعادة المحاولة
            </button>
          </div>
        ) : filteredItems.length === 0 ? (
          isSearching && closestFallbackQ.isLoading ? (
            <div className="flex flex-col items-center justify-center py-20 text-slate-500">
              <Loader2
                aria-hidden
                className="size-7 animate-spin text-[var(--store-brand)]"
              />
              <p className="mt-3 text-sm font-bold">جارٍ البحث عن أقرب المنتجات المتوفرة…</p>
            </div>
          ) : isSearching && closestItems.length > 0 ? (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-slate-900/[0.08] bg-[#f5f5f7] px-4 py-3 text-right dark:border-slate-800 dark:bg-slate-800/70">
                <div>
                  <p className="text-xs sm:text-sm font-bold text-[#1d1d1f] dark:text-slate-100">
                    نعرض لك أقرب المنتجات المتوفرة لبحثك «{search}»
                  </p>
                  <p className="text-[11px] font-medium text-[#6e6e73] dark:text-slate-400">
                    {categoryId != null
                      ? "وسّعنا البحث ليشمل كافة أقسام المتجر المتوفرة بالمخزون"
                      : "مرتّبة حسب الأقرب للاسم والمنطوق والوصف"}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={clearCatalogFilters}
                  className="rounded-full border border-slate-900/10 bg-white px-3.5 py-1.5 text-xs font-bold text-[#1d1d1f] transition hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                >
                  عرض كل الكتالوج
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
            <div className="flex flex-col items-center justify-center rounded-2xl border border-slate-200 bg-white py-20 text-center dark:border-slate-800 dark:bg-slate-900">
              <Package aria-hidden className="size-10 text-slate-400" />
              <p className="mt-3 text-sm font-black text-slate-900 dark:text-white">
                {isEmptyCatalog
                  ? "لا توجد منتجات معروضة حالياً"
                  : "لا توجد نتائج مطابقة للبحث أو الفلاتر"}
              </p>
              <p className="mt-1 max-w-sm text-xs font-semibold text-slate-500">
                {isEmptyCatalog
                  ? "ستظهر المنتجات هنا عند إضافتها إلى المتجر."
                  : "جرّب كلمات أقصر أو مسح البحث لعرض التشكيلة المتوفرة بالمخزون."}
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
                  className="mt-4 rounded-xl bg-[#1d1d1f] px-5 py-2.5 text-xs font-black text-white transition hover:bg-slate-800 dark:bg-white dark:text-[#1d1d1f]"
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
            className="mt-8 flex min-h-12 items-center justify-center"
            aria-live="polite"
          >
            {catalogQ.isFetchingNextPage ? (
              <span className="flex items-center gap-2 text-xs font-bold text-[var(--store-brand)]">
                <Loader2 aria-hidden className="size-4 animate-spin" /> جارٍ
                تحميل منتجات إضافية…
              </span>
            ) : (
              <span className="text-[11px] font-bold text-slate-400">
                نحمّل المزيد تلقائياً عند الاقتراب
              </span>
            )}
          </div>
        )}
        {catalogQ.isError && (
          <div
            className="mt-3 flex flex-col items-center gap-2 text-center"
            role="alert"
          >
            <p className="text-xs font-bold text-[var(--sem-neg)]">
              تعذّر تحميل المنتجات الإضافية تلقائياً.
            </p>
            <button
              type="button"
              onClick={() => void catalogQ.fetchNextPage()}
              disabled={catalogQ.isFetchingNextPage}
              className="text-xs font-black text-[var(--store-brand)] underline disabled:opacity-50"
            >
              إعادة المحاولة
            </button>
          </div>
        )}
      </section>
    </main>
  );
}
