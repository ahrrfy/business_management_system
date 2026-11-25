import { CategoryChipStrip } from "@/components/storefront/CategoryChipStrip";
import { StorefrontSearch } from "@/components/storefront/StorefrontSearch";
import {
  type AvailabilityFilter,
  type Panel,
  type PriceFilter,
} from "@/components/storefront/storefrontCatalogModel";
import { type RouterOutputs } from "@/lib/trpc";
import {
  Banknote,
  Heart,
  ShoppingBag,
  ShoppingCart,
  Truck,
} from "lucide-react";
import React from "react";
import { Link } from "wouter";
import { STORE_NAME, STORE_TAGLINE } from "./storefrontCatalogModel";
interface Props {
  categoryId: number | null;
  search: string;
  setCategoryId: React.Dispatch<React.SetStateAction<number | null>>;
  setSearch: React.Dispatch<React.SetStateAction<string>>;
  setRawSearch: (value: string) => void;
  rawSearch: string;
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
  pulseHeart: (target: string) => void;
  setShowWishlist: React.Dispatch<React.SetStateAction<boolean>>;
  showWishlist: boolean;
  heartPulseTarget: string | null;
  heartPulseNonce: number;
  wishlistIds: Set<number>;
  setPanel: React.Dispatch<React.SetStateAction<Panel>>;
  cartCount: number;
  cats: RouterOutputs["storefront"]["categories"];
  selectCategory: (id: number | null) => void;
}
export function StorefrontHeader({
  categoryId,
  search,
  setCategoryId,
  setSearch,
  setRawSearch,
  rawSearch,
  submitStoreSearch,
  openProduct,
  searchScope,
  pulseHeart,
  setShowWishlist,
  showWishlist,
  heartPulseTarget,
  heartPulseNonce,
  wishlistIds,
  setPanel,
  cartCount,
  cats,
  selectCategory,
}: Props) {
  return (
    <header
      className="store-translucent-chrome sticky top-0 z-30 border-b"
      style={{ paddingTop: "env(safe-area-inset-top)" }}
    >
      <div className="hidden border-b border-slate-900/[0.06] bg-white/60 sm:block dark:border-slate-800/80 dark:bg-slate-950/60">
        <div className="mx-auto flex max-w-[1500px] items-center justify-between px-5 py-2 text-[11px] font-bold text-slate-600 lg:px-8 dark:text-slate-400">
          <span className="flex items-center gap-1.5">
            <Truck aria-hidden className="size-3.5 text-[var(--store-brand)]" /> توصيل سريع
            وموثوق إلى جميع المحافظات العراقية
          </span>
          <span className="flex items-center gap-1.5">
            <Banknote aria-hidden className="size-3.5 text-[var(--store-brand)]" /> الدفع
            نقد عند الاستلام متاح على كافة الطلبات
          </span>
        </div>
      </div>
      <div className="mx-auto flex max-w-[1500px] flex-wrap items-center gap-2 px-2.5 py-2.5 sm:flex-nowrap sm:gap-4 sm:px-4 sm:py-3 lg:px-8">
        <Link
          href="/store"
          onClick={() => {
            setCategoryId(null);
            setSearch("");
            setRawSearch("");
            setShowWishlist(false);
          }}
          className="order-1 flex min-w-0 flex-1 items-center gap-3 text-right sm:order-none sm:min-w-[175px] sm:flex-none"
        >
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-[#1d1d1f] text-white shadow-xs dark:bg-white dark:text-[#1d1d1f]">
            <ShoppingBag aria-hidden className="size-5" />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-[15px] font-black tracking-tight text-slate-900 dark:text-slate-100">
              {STORE_NAME}
            </span>
            <span className="block truncate text-[11px] font-bold text-slate-500 dark:text-slate-400">
              {STORE_TAGLINE}
            </span>
          </span>
        </Link>
        <nav
          className="hidden items-center gap-5 text-xs font-black text-slate-600 lg:flex dark:text-slate-300"
          aria-label="التنقل الرئيسي"
        >
          <a
            href="#store-categories"
            onClick={(e) => {
              e.preventDefault();
              if (categoryId != null || search) {
                setCategoryId(null);
                setSearch("");
                setRawSearch("");
              }
              const target =
                document.getElementById("store-categories") ||
                document.getElementById("store-categories-strip");
              target?.scrollIntoView({ behavior: "smooth", block: "start" });
            }}
            className="transition hover:text-[var(--store-brand)]"
          >
            الأقسام
          </a>
          <a
            href="#store-results"
            onClick={(e) => {
              e.preventDefault();
              document
                .getElementById("store-results")
                ?.scrollIntoView({ behavior: "smooth", block: "start" });
            }}
            className="transition hover:text-[var(--store-brand)]"
          >
            المنتجات
          </a>
          <a
            href="#store-deals"
            onClick={(e) => {
              e.preventDefault();
              const target =
                document.getElementById("store-deals") ||
                document.getElementById("store-picks") ||
                document.getElementById("store-results");
              target?.scrollIntoView({ behavior: "smooth", block: "start" });
            }}
            className="transition hover:text-[var(--store-accent)]"
          >
            العروض
          </a>
        </nav>
        <StorefrontSearch
          value={rawSearch}
          onChange={setRawSearch}
          onSearch={submitStoreSearch}
          onSelectProduct={openProduct}
          {...searchScope}
        />
        <button
          onClick={() => {
            pulseHeart("wishlist-header");
            setShowWishlist((current) => !current);
          }}
          aria-label="قائمة أعجبتني"
          aria-pressed={showWishlist}
          className={`store-action-button order-2 relative flex size-11 shrink-0 touch-manipulation items-center justify-center rounded-xl border bg-white/90 transition-[transform,border-color,color,background-color] duration-150 ease-out hover:border-rose-400 active:scale-[0.95] sm:order-none dark:bg-slate-800 ${showWishlist ? "border-rose-500 text-rose-600 bg-rose-50/30" : "border-slate-200/90 text-slate-700 hover:text-rose-600 dark:border-slate-700 dark:text-slate-100"} ${heartPulseTarget === "wishlist-header" ? "store-action-button--active" : ""}`}
        >
          <Heart
            key={`wishlist-header-${heartPulseNonce}`}
            aria-hidden
            className={`size-5 ${showWishlist ? "fill-current" : ""}`}
          />
          {wishlistIds.size > 0 && (
            <span className="absolute -right-2 -top-2 flex min-w-5 items-center justify-center rounded-full bg-rose-600 px-1 text-[10px] font-black text-white shadow-sm tabular-nums">
              {wishlistIds.size}
            </span>
          )}
        </button>
        <button
          onClick={() => setPanel("cart")}
          aria-label="السلة"
          className="order-3 relative flex size-11 shrink-0 touch-manipulation items-center justify-center rounded-xl border border-slate-200/90 bg-white/90 text-slate-700 transition-[transform,border-color,color] duration-150 ease-out hover:border-[var(--store-brand)] hover:text-[var(--store-brand)] active:scale-[0.95] sm:order-none dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
        >
          <ShoppingCart aria-hidden className="size-5" />
          {cartCount > 0 && (
            <span className="absolute -right-2 -top-2 flex min-w-5 items-center justify-center rounded-full bg-[var(--store-brand)] px-1 text-[10px] font-black text-white shadow-xs tabular-nums">
              {cartCount}
            </span>
          )}
        </button>
      </div>
      {cats.length > 0 && (
        <div
          id="store-categories-strip"
          className="border-t border-slate-100 bg-slate-50/50 dark:border-slate-800 dark:bg-slate-900"
        >
          <CategoryChipStrip
            cats={cats}
            selectedId={categoryId}
            onPick={selectCategory}
          />
        </div>
      )}
    </header>
  );
}
