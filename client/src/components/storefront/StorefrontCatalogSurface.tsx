import { BannerCarousel } from "@/components/store/BannerCarousel";
import { StorefrontCategories } from "@/components/storefront/StorefrontCategories";
import { StorefrontDispatchCountdown } from "@/components/storefront/StorefrontDispatchCountdown";
import { type BannerItem } from "@/components/storefront/StorefrontInlineStrip";
import { StorefrontMilestoneBar } from "@/components/storefront/StorefrontMilestoneBar";
import { type StorefrontProductForCartAction } from "@/components/storefront/StorefrontRecommendations";
import { StorefrontSearchAlternatives } from "@/components/storefront/StorefrontSearch";
import {
  StorefrontThematicStrip,
  type ThematicCollectionCard,
} from "@/components/storefront/StorefrontThematicStrip";
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
}: StorefrontCatalogSurfaceProps) {
  return (
    <main
      id="store-main"
      tabIndex={-1}
      className="mx-auto w-full max-w-[1500px] overflow-x-clip px-2.5 py-4 pb-28 outline-none sm:px-4 sm:py-6 lg:px-8"
    >
      <h1 className="sr-only">مكتبة العربية للتسوق والتوصيل في العراق</h1>
      {announcement && (
        <div className="mb-5 flex items-center gap-2 border border-[#ead8c8] bg-[#fff8f2] px-4 py-3 text-sm font-bold text-[#754f2c]">
          <BadgePercent aria-hidden className="size-4 shrink-0" />
          <span>{announcement}</span>
        </div>
      )}
      {shareFeedback && (
        <div
          role={shareFeedback.tone === "err" ? "alert" : "status"}
          className={`animate__animated animate__fadeIn mb-5 border px-4 py-3 text-center text-xs font-bold ${SHARE_FEEDBACK_TONE_CLASS[shareFeedback.tone]}`}
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

      {!search &&
        categoryId == null &&
        !showWishlist &&
        topBanners.length > 0 && (
          <div className="mb-8 w-full min-w-0">
            <BannerCarousel banners={topBanners} slot={topBannerSlot} />
          </div>
        )}

      {cats.length > 0 && (
        <StorefrontCategories
          id="store-categories"
          categories={cats}
          selectedId={categoryId}
          onSelectCategory={selectCategory}
          categoryCountFn={(c) => storefrontCategoryCount(c, availability)}
          className="mb-8 scroll-mt-28"
        />
      )}

      {((!search && categoryId == null && !showWishlist) ||
        selectedThematicCollection != null) && (
        <StorefrontThematicStrip
          activeCollectionId={selectedThematicCollection?.id ?? null}
          onSelectCollection={handleSelectThematicCollection}
          onClearCollection={handleClearThematicCollection}
          className="mb-8"
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
          <div className="flex flex-col items-center justify-center py-24 text-[#7a817f]">
            <Loader2
              aria-hidden
              className="size-8 animate-spin text-[#1e4a63]"
            />
            <p className="mt-3 text-sm font-bold">جارٍ تحميل المنتجات…</p>
          </div>
        ) : catalogInitialError ? (
          <div
            className="flex flex-col items-center justify-center border border-[#ddd8d1] bg-white py-24 text-center"
            role="alert"
          >
            <AlertTriangle aria-hidden className="size-10 text-[#b87835]" />
            <p className="mt-3 text-sm font-black text-[#30383e]">
              تعذّر تحميل المنتجات
            </p>
            <p className="mt-1 max-w-sm text-xs font-semibold text-[#7a817f]">
              تحقق من الاتصال ثم أعد المحاولة. لم نعرض هذه الحالة كمنتجات فارغة.
            </p>
            <button
              type="button"
              onClick={() => void catalogQ.refetch()}
              className="store-primary-action mt-4 bg-[#e65f4a] px-5 py-2.5 text-xs font-black text-white"
            >
              إعادة المحاولة
            </button>
          </div>
        ) : filteredItems.length === 0 ? (
          <div className="flex flex-col items-center justify-center border border-[#ddd8d1] bg-white py-24 text-center">
            <Package aria-hidden className="size-10 text-[#7a817f]" />
            <p className="mt-3 text-sm font-black text-[#30383e]">
              {isEmptyCatalog
                ? "لا توجد منتجات معروضة حالياً"
                : "لا توجد نتائج مطابقة للبحث أو الفلاتر"}
            </p>
            <p className="mt-1 max-w-sm text-xs font-semibold text-[#7a817f]">
              {isEmptyCatalog
                ? "ستظهر المنتجات هنا عند إضافتها إلى المتجر."
                : "جرّب مسح البحث والفلاتر لعرض المنتجات المتاحة."}
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
                className="mt-4 bg-[#1e4a63] px-5 py-2.5 text-xs font-black text-white"
              >
                مسح البحث والفلاتر
              </button>
            )}
          </div>
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
              <span className="flex items-center gap-2 text-xs font-bold text-[#1e4a63]">
                <Loader2 aria-hidden className="size-4 animate-spin" /> جارٍ
                تحميل منتجات إضافية…
              </span>
            ) : (
              <span className="text-[11px] font-bold text-[#8b9395]">
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
              className="text-xs font-black text-[#1e4a63] underline disabled:opacity-50"
            >
              إعادة المحاولة
            </button>
          </div>
        )}
      </section>
    </main>
  );
}
