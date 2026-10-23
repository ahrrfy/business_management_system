import { CategoryChipStrip } from "@/components/storefront/CategoryChipStrip";
import { StorefrontSearch } from "@/components/storefront/StorefrontSearch";
import {
  type AvailabilityFilter,
  type Panel,
  type PriceFilter,
} from "@/components/storefront/storefrontCatalogModel";
import { isPublicHost } from "@/lib/siteHosts";
import { type RouterOutputs } from "@/lib/trpc";
import {
  Banknote,
  Heart,
  ShoppingBag,
  ShoppingCart,
  Truck,
  User,
} from "lucide-react";
import React from "react";
import { Link } from "wouter";
import { STORE_NAME, STORE_TAGLINE } from "./storefrontCatalogModel";
interface Props {
  categoryId: number | null;
  search: string;
  setCategoryId: React.Dispatch<React.SetStateAction<number | null>>;
  setSearch: React.Dispatch<React.SetStateAction<string>>;
  setRawSearch: React.Dispatch<React.SetStateAction<string>>;
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
      className="sticky top-0 z-30 border-b border-amber-900/10 bg-white/95 backdrop-blur-md dark:border-slate-800 dark:bg-slate-900/95"
      style={{ paddingTop: "env(safe-area-inset-top)" }}
    >
      <div className="hidden border-b border-amber-100/60 bg-amber-50/40 sm:block dark:border-slate-800/80 dark:bg-slate-950">
        <div className="mx-auto flex max-w-[1500px] items-center justify-between px-5 py-2 text-[11px] font-bold text-slate-600 lg:px-8 dark:text-slate-400">
          <span className="flex items-center gap-1.5">
            <Truck aria-hidden className="size-3.5 text-blue-600" /> توصيل سريع
            وموثوق إلى جميع المحافظات العراقية
          </span>
          <span className="flex items-center gap-1.5">
            <Banknote aria-hidden className="size-3.5 text-emerald-600" /> الدفع
            نقد عند الاستلام متاح على كافة الطلبات
          </span>
        </div>
      </div>
      <div className="mx-auto flex max-w-[1500px] flex-wrap items-center gap-2 px-2.5 py-2.5 sm:flex-nowrap sm:gap-4 sm:px-4 sm:py-3 lg:px-8">
        <a
          href="/store"
          className="order-1 flex min-w-0 flex-1 items-center gap-3 text-right sm:order-none sm:min-w-[175px] sm:flex-none"
        >
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-emerald-600 text-white shadow-sm shadow-emerald-600/20">
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
        </a>
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
            className="transition hover:text-emerald-700 dark:hover:text-emerald-400"
          >
            الأقسام
          </a>
          <a
            href="#store-results"
            className="transition hover:text-emerald-700 dark:hover:text-emerald-400"
          >
            المنتجات
          </a>
          <a
            href="#store-deals"
            className="transition hover:text-orange-600 dark:hover:text-orange-400"
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
          className={`store-action-button order-2 relative flex size-11 shrink-0 items-center justify-center rounded-xl border bg-white transition hover:border-rose-400 sm:order-none dark:bg-slate-800 ${showWishlist ? "border-rose-500 text-rose-600 bg-rose-50/30" : "border-slate-200 text-slate-700 hover:text-rose-600 dark:border-slate-700 dark:text-slate-100"} ${heartPulseTarget === "wishlist-header" ? "store-action-button--active" : ""}`}
        >
          <Heart
            key={`wishlist-header-${heartPulseNonce}`}
            aria-hidden
            className={`size-5 ${showWishlist ? "fill-current" : ""} ${heartPulseTarget === "wishlist-header" ? "animate__animated animate__heartBeat animate__faster" : ""}`}
          />
          {wishlistIds.size > 0 && (
            <span className="absolute -right-2 -top-2 flex min-w-5 items-center justify-center rounded-full bg-rose-600 px-1 text-[10px] font-black text-white shadow-sm">
              {wishlistIds.size}
            </span>
          )}
        </button>
        <button
          onClick={() => setPanel("cart")}
          aria-label="السلة"
          className="order-3 relative flex size-11 shrink-0 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-700 transition hover:border-blue-600 hover:text-blue-600 sm:order-none dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
        >
          <ShoppingCart aria-hidden className="size-5" />
          {cartCount > 0 && (
            <span className="absolute -right-2 -top-2 flex min-w-5 items-center justify-center rounded-full bg-[#0E806A] px-1 text-[10px] font-black text-white shadow-xs">
              {cartCount}
            </span>
          )}
        </button>
        {!isPublicHost(
          typeof window !== "undefined" ? window.location.hostname : "",
        ) && (
          <Link
            href="/login"
            className="hidden shrink-0 items-center gap-1.5 text-[11px] font-bold text-slate-500 hover:text-blue-600 sm:flex dark:text-slate-400"
          >
            <User aria-hidden className="size-4" /> دخول الفريق
          </Link>
        )}
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
