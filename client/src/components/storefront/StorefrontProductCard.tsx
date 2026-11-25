import React from "react";
import { Heart, Share2, Plus, Minus, Sparkles, Package, Eye, Star } from "lucide-react";
import { fmtInt } from "@/lib/money";
import { formatQuantity } from "@shared/quantityFormat";
import { AnimatedAddToCartButton } from "./AnimatedAddToCartButton";
import { recommendationNeedsSelection } from "./StorefrontRecommendations";

export interface StorefrontCatalogProduct {
  productId: number;
  productUnitId?: number;
  productName: string;
  brand: string | null;
  price: string | number | null;
  salePrice: string | number | null;
  stockLeft: number | null;
  unitName: string;
  soldCount: number;
  inStock: boolean;
  isBundle?: boolean;
  isCustomizable?: boolean;
  bundleImageUrls?: string[];
  imageUrls?: string[];
  imageUrl?: string | null;
  [key: string]: any;
}

interface StorefrontProductCardProps {
  product: any;
  isWishlisted: boolean;
  heartPulseTarget?: string | null;
  heartPulseNonce?: number;
  sharePulseTarget?: string | null;
  sharePulseNonce?: number;
  onOpen: (productId: number, options?: { openReview?: boolean; orderNumber?: string | null }) => void;
  onAdd: (product: any, event: React.MouseEvent<HTMLButtonElement>) => boolean;
  onToggleWishlist: (productId: number) => void;
  onShare: (productId: number, productName: string) => void;
  canBeOrdered: (product: any) => boolean;
  actionLabel: string;
  mediaComponent?: React.ReactNode;
  isRecentlyAdded?: boolean;
  cartQuantity?: number;
  onUpdateQuantity?: (productId: number, delta: number) => void;
}

export const StorefrontProductCard = React.memo(function StorefrontProductCard({
  product: p,
  isWishlisted,
  heartPulseTarget,
  heartPulseNonce = 0,
  sharePulseTarget,
  sharePulseNonce = 0,
  onOpen,
  onAdd,
  onToggleWishlist,
  onShare,
  canBeOrdered,
  actionLabel,
  mediaComponent,
  isRecentlyAdded = false,
  cartQuantity = 0,
  onUpdateQuantity,
}: StorefrontProductCardProps) {
  const productTitle = p.productName ?? p.name ?? "منتج بدون اسم";
  const onSale = p.salePrice != null && p.price != null && Number(p.salePrice) < Number(p.price);
  const pct = onSale ? Math.round((1 - Number(p.salePrice) / Number(p.price)) * 100) : 0;
  const savings = onSale ? Number(p.price) - Number(p.salePrice) : 0;
  const currentPrice = p.salePrice ?? p.price;
  const orderable = canBeOrdered(p);
  const showAdded = isRecentlyAdded;


  const cardButtonLabel = (actionLabel ?? "أضف إلى السلة").length > 20
    ? "غير متاح إلكترونياً"
    : (actionLabel ?? "أضف إلى السلة");

  return (
    <article
      className={`store-product-card group relative flex h-full flex-col overflow-hidden rounded-2xl border bg-white dark:bg-slate-900 ${
        showAdded
          ? "border-emerald-500 ring-2 ring-emerald-500/20"
          : p.inStock
          ? "border-slate-900/[0.08] dark:border-slate-800"
          : "border-slate-900/[0.08] opacity-75 dark:border-slate-800"
      }`}
    >
      {/* منطقة صورة المنتج والوسائط — نسبة ثابتة محكمة */}
      <div className="relative aspect-[4/3] w-full shrink-0 overflow-hidden bg-[#f7f7f8] text-right dark:bg-slate-950">
        <button
          type="button"
          onClick={() => onOpen(p.productId)}
          aria-label={`فتح تفاصيل ${productTitle}`}
          className="relative block size-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--store-brand)]"
        >
          {mediaComponent}

          {!p.inStock && (
            <span className="absolute inset-x-0 bottom-0 bg-slate-950/75 py-1.5 text-center text-[11px] font-semibold text-white backdrop-blur-xs">
              غير متوفر حالياً
            </span>
          )}
        </button>

        {/* شريط الشارات والإجراءات العلوي — مبسّط وهادئ */}
        <div className="pointer-events-none absolute inset-x-2 top-2 z-10 flex items-start justify-between gap-1">
          <div className="pointer-events-auto flex flex-wrap items-start gap-1 max-w-[calc(100%-36px)]">
            {onSale && pct > 0 && (
              <span className="inline-flex items-center rounded-md bg-[var(--store-accent)] px-1.5 py-0.5 text-[10px] font-bold text-white whitespace-nowrap tabular-nums">
                خصم {pct}٪
              </span>
            )}
            {!onSale && p.isBundle && (
              <span className="inline-flex items-center gap-1 rounded-md bg-slate-900/85 px-1.5 py-0.5 text-[10px] font-semibold text-white whitespace-nowrap">
                <Package aria-hidden className="size-2.5" />
                <span>مجموعة</span>
              </span>
            )}
            {p.isCustomizable && (
              <span className="inline-flex items-center rounded-md bg-white/95 px-1.5 py-0.5 text-[10px] font-semibold text-slate-800 ring-1 ring-slate-900/10 whitespace-nowrap">
                {p.customizationKind === "PRINT"
                  ? "تخصيص وطباعة"
                  : p.customizationKind === "GIFT"
                    ? "تخصيص وإهداء"
                    : "قابل للتخصيص"}
              </span>
            )}
          </div>

          {/* أزرار الإجراءات — تلتصق باليسار في RTL وتمنع التزاحم */}
          <div className="pointer-events-auto flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={() => onToggleWishlist(p.productId)}
              aria-label={
                isWishlisted
                  ? `إزالة ${productTitle} من المفضلة`
                  : `إضافة ${productTitle} إلى المفضلة`
              }
              aria-pressed={isWishlisted}
              className={`store-action-button flex !size-8 sm:!size-8 !min-h-8 !min-w-8 touch-manipulation items-center justify-center rounded-full bg-white/95 shadow-xs ring-1 ring-slate-900/[0.08] transition-[transform,color] duration-150 ease-out hover:scale-105 active:scale-[0.94] before:absolute before:-inset-2 before:content-[''] dark:bg-slate-800/95 dark:ring-slate-700 ${
                isWishlisted
                  ? "text-rose-600"
                  : "text-slate-500 hover:text-rose-500 dark:text-slate-400"
              } ${heartPulseTarget === `product-${p.productId}` ? "store-action-button--active" : ""}`}
            >
              <Heart
                key={`wishlist-${p.productId}-${heartPulseNonce}`}
                aria-hidden
                className={`size-3 sm:size-3.5 ${isWishlisted ? "fill-current" : ""}`}
              />
            </button>

            {/* زر المشاركة — متاح على الشاشات الكبيرة لتفادي التزاحم على الهواتف */}
            <button
              type="button"
              onClick={() => onShare(p.productId, productTitle)}
              aria-label={`مشاركة ${productTitle}`}
              className={`store-action-button hidden sm:flex !size-8 !min-h-8 !min-w-8 touch-manipulation items-center justify-center rounded-full bg-white/95 text-slate-600 shadow-xs ring-1 ring-slate-900/[0.08] transition-[transform,color] duration-150 ease-out hover:scale-105 hover:text-[var(--store-brand)] active:scale-[0.94] before:absolute before:-inset-1.5 before:content-[''] dark:bg-slate-800/95 dark:text-slate-300 dark:ring-slate-700 ${
                sharePulseTarget === `product-${p.productId}` ? "store-action-button--active" : ""
              }`}
            >
              <Share2
                key={`share-${p.productId}-${sharePulseNonce}`}
                aria-hidden
                className="size-3.5"
              />
            </button>
          </div>
        </div>

        {/* زر نظرة سريعة يظهر بنعومة عند تمرير الماوس على سطح المكتب */}
        <div className="pointer-events-none absolute inset-x-0 bottom-2.5 z-10 hidden justify-center px-4 opacity-0 transition-opacity duration-200 group-hover:opacity-100 md:flex">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onOpen(p.productId);
            }}
            className="pointer-events-auto flex touch-manipulation items-center gap-1.5 rounded-full bg-slate-950/85 px-3 py-1 text-[10px] font-black text-white shadow-md backdrop-blur-[12px] transition-[transform,background-color] duration-150 ease-out hover:bg-slate-900 active:scale-[0.95]"
          >
            <Eye aria-hidden className="size-3" />
            <span>نظرة سريعة</span>
          </button>
        </div>
      </div>

      {/* تفاصيل ومعلومات المنتج — تدرج بصري هادئ وواضح */}
      <div className="flex flex-1 flex-col p-3 sm:p-4">
        <div className="flex h-4 items-center justify-between gap-1">
          <span className="truncate text-[10px] font-medium text-slate-500 dark:text-slate-400">
            {p.brand ?? "المكتبة العربية"}
          </span>
          {p.reviewsCount ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onOpen(p.productId, { openReview: true });
              }}
              aria-label={`تقييمات ومراجعات ${productTitle}`}
              className="flex items-center gap-0.5 text-[10px] font-semibold text-slate-600 shrink-0 transition-opacity hover:opacity-80 dark:text-slate-300"
            >
              <Star aria-hidden className="size-2.5 fill-amber-500 text-amber-500" />
              <span className="font-mono tabular-nums">{Number(p.ratingAverage ?? 5).toFixed(1)}</span>
              <span className="text-slate-400 font-normal font-mono tabular-nums">({formatQuantity(p.reviewsCount)})</span>
            </button>
          ) : null}
        </div>

        <div className="mt-1 flex min-h-[2.35rem] sm:min-h-[2.5rem] items-start">
          <button
            type="button"
            onClick={() => onOpen(p.productId)}
            className="w-full rounded text-right focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--store-brand)]"
          >
            <span className="line-clamp-2 text-xs sm:text-[13px] font-semibold leading-snug text-slate-900 transition-colors group-hover:text-[var(--store-brand)] dark:text-slate-100 dark:group-hover:text-blue-400">
              {productTitle}
            </span>
          </button>
        </div>

        <div className="mt-2 flex min-h-[2.25rem] flex-col justify-center">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="text-sm sm:text-base font-bold tracking-tight text-slate-900 whitespace-nowrap tabular-nums dark:text-white">
              {currentPrice != null ? `${fmtInt(Number(currentPrice))} د.ع` : "غير محدد"}
            </span>
            {onSale && p.price != null && (
              <span className="text-[10px] sm:text-[11px] font-medium text-slate-400 line-through whitespace-nowrap tabular-nums">
                {fmtInt(Number(p.price))} د.ع
              </span>
            )}
          </div>
          {onSale && savings > 0 ? (
            <span className="mt-0.5 text-[10px] font-medium text-[var(--store-brand)] whitespace-nowrap">
              توفير {fmtInt(savings)} د.ع
            </span>
          ) : (
            <div className="mt-0.5 h-3.5" />
          )}
        </div>

        <div className="mt-1.5 mb-2 flex min-h-4 items-center justify-between gap-1 text-[11px] font-medium">
          {p.stockLeft != null && p.stockLeft > 0 && p.stockLeft <= 5 ? (
            <span className="text-[var(--store-accent)] truncate">
              متبقي {formatQuantity(p.stockLeft)} فقط
            </span>
          ) : (
            <span className="truncate text-slate-400 dark:text-slate-500">{p.unitName}</span>
          )}
        </div>

        {/* زر الإضافة السريع للسلة أو وحدة التحكم بالكمية المتحولة — متطابق أفقياً ومرن للهواتف */}
        {!p.isCustomizable && cartQuantity > 0 && onUpdateQuantity ? (
          <div className="mt-auto flex h-10 w-full items-center justify-between rounded-xl border border-slate-900/12 bg-[#f5f5f7] px-1.5 sm:px-2 text-[#1d1d1f] shadow-2xs dark:border-slate-700 dark:bg-slate-800 dark:text-white">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onUpdateQuantity(p.productId, -1);
              }}
              aria-label={`تقليل كمية ${productTitle}`}
              className="flex size-7 sm:size-8 shrink-0 touch-manipulation items-center justify-center rounded-lg bg-white text-[#1d1d1f] shadow-xs transition-[transform,background-color] duration-100 ease-out hover:bg-slate-100 active:scale-[0.92] dark:bg-slate-900 dark:text-white"
            >
              <Minus aria-hidden className="size-3 sm:size-3.5 stroke-[2.5]" />
            </button>

            <div className="flex min-w-0 flex-1 items-center justify-center gap-1 px-1 font-mono text-xs font-black tabular-nums">
              <span className="text-xs sm:text-sm shrink-0">{formatQuantity(cartQuantity)}</span>
              <span className="truncate text-[8.5px] sm:text-[10px] font-bold text-slate-600 dark:text-slate-300">
                {p.unitName ? p.unitName : "بالسلة"}
              </span>
            </div>

            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onUpdateQuantity(p.productId, 1);
              }}
              disabled={!recommendationNeedsSelection(p) && p.stockLeft != null && cartQuantity >= p.stockLeft}
              aria-label={`زيادة كمية ${productTitle}`}
              className="flex size-7 sm:size-8 shrink-0 touch-manipulation items-center justify-center rounded-lg bg-[#1d1d1f] text-white shadow-xs transition-[transform,background-color] duration-100 ease-out hover:bg-slate-800 active:scale-[0.92] disabled:cursor-not-allowed disabled:opacity-40 dark:bg-white dark:text-[#1d1d1f]"
            >
              <Plus aria-hidden className="size-3 sm:size-3.5 stroke-[2.5]" />
            </button>
          </div>
        ) : (
          <div className="mt-auto w-full">
            <AnimatedAddToCartButton
              size="sm"
              disabled={!orderable}
              label={cardButtonLabel}
              addedLabel="تمت الإضافة"
              icon={p.isCustomizable ? <Sparkles aria-hidden className="size-3.5" /> : undefined}
              onAdd={(btnEl) => {
                return onAdd(p, { currentTarget: btnEl, stopPropagation: () => {} } as unknown as React.MouseEvent<HTMLButtonElement>);
              }}
              cartCount={cartQuantity}
              showCartCount={false}
            />
          </div>
        )}
      </div>
    </article>
  );
});
