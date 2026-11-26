import { StorefrontSearch } from "@/components/storefront/StorefrontSearch";
import {
  type AvailabilityFilter,
  type Panel,
  type PriceFilter,
} from "@/components/storefront/storefrontCatalogModel";
import { Heart, ShoppingBag, ShoppingCart } from "lucide-react";
import React from "react";
import { Link } from "wouter";
import { STORE_NAME } from "./storefrontCatalogModel";

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
  onSelectDeals?: () => void;
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
  onSelectDeals,
}: Props) {
  return (
    <header
      className="store-translucent-chrome sticky top-0 z-30 border-b"
      style={{ paddingTop: "env(safe-area-inset-top)" }}
    >
      <div className="mx-auto flex max-w-[1360px] flex-wrap items-center gap-2 px-2.5 py-2 sm:flex-nowrap sm:gap-3.5 sm:px-4 sm:py-2.5 lg:px-6">
        <Link
          href="/store"
          onClick={() => {
            setCategoryId(null);
            setSearch("");
            setRawSearch("");
            setShowWishlist(false);
          }}
          className="order-1 flex min-w-0 flex-1 items-center gap-2.5 text-right sm:order-none sm:flex-none"
        >
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-[#1d1d1f] text-white shadow-2xs dark:bg-white dark:text-[#1d1d1f]">
            <ShoppingBag aria-hidden className="size-4.5" />
          </span>
          <span className="truncate text-[15px] font-black tracking-tight text-[#1d1d1f] dark:text-slate-100">
            {STORE_NAME}
          </span>
        </Link>

        <nav
          className="hidden items-center gap-4 text-xs font-bold text-slate-600 lg:flex dark:text-slate-300"
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
              document
                .getElementById("store-categories")
                ?.scrollIntoView({ behavior: "smooth", block: "start" });
            }}
            className="transition hover:text-[#1d1d1f] dark:hover:text-white"
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
            className="transition hover:text-[#1d1d1f] dark:hover:text-white"
          >
            المنتجات
          </a>
          <a
            href="#store-deals"
            onClick={(e) => {
              e.preventDefault();
              if (onSelectDeals) {
                onSelectDeals();
                return;
              }
              const target =
                document.getElementById("store-deals") ||
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
          type="button"
          onClick={() => {
            pulseHeart("wishlist-header");
            setShowWishlist((current) => !current);
          }}
          aria-label="قائمة أعجبتني"
          aria-pressed={showWishlist}
          className={`store-action-button order-2 relative flex size-10 shrink-0 touch-manipulation items-center justify-center rounded-xl border bg-white/90 transition-[transform,border-color,color,background-color] duration-150 ease-out active:scale-[0.95] sm:order-none dark:bg-slate-800 ${
            showWishlist
              ? "border-[#1d1d1f] bg-[#1d1d1f] text-white dark:border-white dark:bg-white dark:text-[#1d1d1f]"
              : "border-slate-200/90 text-slate-700 hover:border-slate-400 dark:border-slate-700 dark:text-slate-100"
          } ${heartPulseTarget === "wishlist-header" ? "store-action-button--active" : ""}`}
        >
          <Heart
            key={`wishlist-header-${heartPulseNonce}`}
            aria-hidden
            className={`size-4.5 ${showWishlist ? "fill-current" : ""}`}
          />
          {wishlistIds.size > 0 && (
            <span className="absolute -right-1.5 -top-1.5 flex min-w-4.5 items-center justify-center rounded-full bg-[var(--store-accent)] px-1 text-[10px] font-black text-white shadow-2xs tabular-nums">
              {wishlistIds.size}
            </span>
          )}
        </button>

        <button
          type="button"
          onClick={() => setPanel("cart")}
          aria-label="السلة"
          className="order-3 relative flex size-10 shrink-0 touch-manipulation items-center justify-center rounded-xl border border-slate-200/90 bg-white/90 text-slate-700 transition-[transform,border-color,color] duration-150 ease-out hover:border-[var(--store-brand)] hover:text-[var(--store-brand)] active:scale-[0.95] sm:order-none dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
        >
          <ShoppingCart aria-hidden className="size-4.5" />
          {cartCount > 0 && (
            <span className="absolute -right-1.5 -top-1.5 flex min-w-4.5 items-center justify-center rounded-full bg-[var(--store-brand)] px-1 text-[10px] font-black text-white shadow-2xs tabular-nums">
              {cartCount}
            </span>
          )}
        </button>
      </div>
    </header>
  );
}
