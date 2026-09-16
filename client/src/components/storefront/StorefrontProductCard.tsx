import React, { useState } from "react";
import { Heart, Share2, Plus, Minus, AlertTriangle, Flame, Package, TrendingUp, Check, Eye } from "lucide-react";
import { fmtInt } from "@/lib/money";

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
  onOpen: (productId: number) => void;
  onAdd: (product: any, event: React.MouseEvent<HTMLButtonElement>) => void;
  onToggleWishlist: (productId: number) => void;
  onShare: (productId: number, productName: string) => void;
  canBeOrdered: (product: any) => boolean;
  actionLabel: string;
  mediaComponent?: React.ReactNode;
  isRecentlyAdded?: boolean;
  cartQuantity?: number;
  onUpdateQuantity?: (productId: number, delta: number) => void;
}

export function StorefrontProductCard({
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
  const [localAdded, setLocalAdded] = useState(false);
  const onSale = p.salePrice != null && p.price != null && Number(p.salePrice) < Number(p.price);
  const pct = onSale ? Math.round((1 - Number(p.salePrice) / Number(p.price)) * 100) : 0;
  const savings = onSale ? Number(p.price) - Number(p.salePrice) : 0;
  const currentPrice = p.salePrice ?? p.price;
  const orderable = canBeOrdered(p);
  const showAdded = isRecentlyAdded || localAdded;

  const handleAddClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    setLocalAdded(true);
    window.setTimeout(() => setLocalAdded(false), 1500);
    onAdd(p, event);
  };

  return (
    <article
      className={`store-product-card group relative flex h-full flex-col overflow-hidden rounded-2xl border bg-white transition-all duration-300 dark:bg-slate-900 ${
        showAdded
          ? "border-emerald-400 ring-2 ring-emerald-400/20 shadow-lg shadow-emerald-500/10"
          : p.inStock
          ? "border-slate-200/80 hover:-translate-y-1 hover:border-blue-300 hover:shadow-xl dark:border-slate-800 dark:hover:border-blue-900"
          : "border-slate-200/80 opacity-75 dark:border-slate-800"
      }`}
    >
      {/* منطقة صورة المنتج والوسائط — نسبة ثابتة محكمة */}
      <div className="relative aspect-[4/3] w-full shrink-0 overflow-hidden bg-slate-50 text-right dark:bg-slate-950">
        <button
          type="button"
          onClick={() => onOpen(p.productId)}
          aria-label={`فتح تفاصيل ${p.productName}`}
          className="relative block size-full focus:outline-none"
        >
          {mediaComponent}

          {/* شارات الحالة والعروض */}
          <div className="absolute right-2.5 top-2.5 z-10 flex flex-col gap-1">
            {onSale && pct > 0 && (
              <span className="inline-flex items-center gap-1 rounded-lg bg-orange-600 px-2 py-1 text-[10px] font-black text-white shadow-sm">
                <Flame aria-hidden className="size-3" />
                خصم {pct}٪
              </span>
            )}
            {p.isBundle && (
              <span className="inline-flex items-center gap-1 rounded-lg bg-blue-600 px-2 py-1 text-[10px] font-black text-white shadow-sm">
                <Package aria-hidden className="size-3" />
                بكج توفير
              </span>
            )}
            {p.stockLeft != null && p.stockLeft <= 3 && p.stockLeft > 0 && (
              <span className="inline-flex items-center gap-1 rounded-lg bg-rose-600 px-2 py-1 text-[10px] font-black text-white shadow-sm">
                بقي {p.stockLeft} فقط
              </span>
            )}
          </div>

          {!p.inStock && (
            <span className="absolute inset-x-0 bottom-0 bg-slate-950/80 py-2 text-center text-[11px] font-black text-white backdrop-blur-xs">
              غير متوفر حالياً
            </span>
          )}
        </button>

        {/* زر نظرة سريعة يظهر بنعومة عند تمرير الماوس على سطح المكتب */}
        <div className="pointer-events-none absolute inset-x-0 bottom-2.5 z-10 hidden justify-center px-4 opacity-0 transition-all duration-200 group-hover:opacity-100 md:flex">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onOpen(p.productId);
            }}
            className="pointer-events-auto flex items-center gap-1.5 rounded-full bg-slate-950/85 px-3 py-1 text-[10px] font-black text-white shadow-md backdrop-blur-md transition-all hover:bg-slate-900 active:scale-95"
          >
            <Eye aria-hidden className="size-3" />
            <span>نظرة سريعة</span>
          </button>
        </div>

        {/* أزرار الإعجاب والمشاركة السريعة */}
        <div className="absolute left-2.5 top-2.5 z-10 flex gap-1.5">
          <button
            type="button"
            onClick={() => onToggleWishlist(p.productId)}
            aria-label={
              isWishlisted
                ? `إزالة ${p.productName} من المفضلة`
                : `إضافة ${p.productName} إلى المفضلة`
            }
            aria-pressed={isWishlisted}
            className={`store-action-button flex size-8 items-center justify-center rounded-full bg-white/90 shadow-sm ring-1 ring-slate-200/80 backdrop-blur-sm transition-all hover:scale-110 active:scale-95 dark:bg-slate-800/90 dark:ring-slate-700 ${
              isWishlisted
                ? "text-rose-600"
                : "text-slate-500 hover:text-rose-500 dark:text-slate-400"
            } ${heartPulseTarget === `product-${p.productId}` ? "store-action-button--active" : ""}`}
          >
            <Heart
              key={`wishlist-${p.productId}-${heartPulseNonce}`}
              aria-hidden
              className={`size-3.5 ${isWishlisted ? "fill-current" : ""} ${
                heartPulseTarget === `product-${p.productId}`
                  ? "animate__animated animate__heartBeat animate__faster"
                  : ""
              }`}
            />
          </button>

          <button
            type="button"
            onClick={() => onShare(p.productId, p.productName)}
            aria-label={`مشاركة ${p.productName}`}
            className={`store-action-button flex size-8 items-center justify-center rounded-full bg-white/90 text-slate-600 shadow-sm ring-1 ring-slate-200/80 backdrop-blur-sm transition-all hover:scale-110 hover:text-blue-600 active:scale-95 dark:bg-slate-800/90 dark:text-slate-300 dark:ring-slate-700 ${
              sharePulseTarget === `product-${p.productId}` ? "store-action-button--active" : ""
            }`}
          >
            <Share2
              key={`share-${p.productId}-${sharePulseNonce}`}
              aria-hidden
              className={`size-3.5 ${
                sharePulseTarget === `product-${p.productId}`
                  ? "animate__animated animate__pulse animate__faster"
                  : ""
              }`}
            />
          </button>
        </div>
      </div>

      {/* تفاصيل ومعلومات المنتج بارتفاعات عمودية محكمة لتوحيد خط الأزرار الأفقي */}
      <div className="flex flex-1 flex-col p-4">
        {/* الماركة أو الوسم — ارتفاع مقفل */}
        <div className="flex h-4 items-center">
          <span className="truncate text-[10px] font-black uppercase tracking-wider text-orange-600 dark:text-orange-400">
            {p.brand ?? "المكتبة العربية"}
          </span>
        </div>

        {/* عنوان المنتج — ارتفاع مقفل بسطرين دائماً */}
        <div className="mt-1.5 flex h-10 items-start">
          <button
            type="button"
            onClick={() => onOpen(p.productId)}
            className="w-full text-right focus:outline-none"
          >
            <span className="line-clamp-2 text-xs font-black leading-tight text-slate-800 transition-colors group-hover:text-blue-700 dark:text-slate-100 dark:group-hover:text-blue-400">
              {p.productName}
            </span>
          </button>
        </div>

        {/* الأسعار ومقدار التوفير — ارتفاع مقفل موحد */}
        <div className="mt-2.5 flex h-12 flex-col justify-center">
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="text-base font-black tracking-tight text-blue-700 dark:text-blue-400">
              {currentPrice != null ? `${fmtInt(Number(currentPrice))} د.ع` : "غير محدد"}
            </span>
            {onSale && p.price != null && (
              <span className="text-[11px] font-semibold text-slate-400 line-through">
                {fmtInt(Number(p.price))} د.ع
              </span>
            )}
          </div>
          {onSale && savings > 0 ? (
            <div className="mt-1">
              <span className="inline-block rounded-md bg-emerald-50 px-2 py-0.5 text-[10px] font-black text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400">
                وفرت {fmtInt(savings)} د.ع
              </span>
            </div>
          ) : (
            <div className="mt-1 h-[21px]" />
          )}
        </div>

        {/* شريط الإلحاح والندرة الاجتماعية — ارتفاع مقفل موحد */}
        <div className="mt-2.5 flex h-5 items-center justify-between gap-2 text-[11px] font-bold">
          {p.stockLeft != null && p.stockLeft > 0 && p.stockLeft <= 5 ? (
            <span className="flex items-center gap-1 font-extrabold text-orange-600 dark:text-orange-400">
              <Flame aria-hidden className="size-3" />
              بقي {p.stockLeft} فقط!
            </span>
          ) : p.soldCount >= 3 ? (
            <span className="flex items-center gap-1 text-blue-700 dark:text-blue-400">
              <TrendingUp aria-hidden className="size-3" />
              الأكثر طلباً
            </span>
          ) : (
            <span className="text-slate-400 dark:text-slate-500">{p.unitName}</span>
          )}
        </div>

        {/* زر الإضافة السريع للسلة أو وحدة التحكم بالكمية المتحولة — متطابق أفقياً بارتفاع h-11 */}
        {!p.isCustomizable && cartQuantity > 0 && onUpdateQuantity ? (
          <div className="animate-spring-pop mt-auto flex h-11 w-full items-center justify-between rounded-xl border border-emerald-600/30 bg-emerald-50 px-2 text-emerald-900 shadow-sm dark:border-emerald-500/30 dark:bg-emerald-950/40 dark:text-emerald-200">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onUpdateQuantity(p.productId, -1);
              }}
              aria-label={`تقليل كمية ${p.productName}`}
              className="flex size-8 items-center justify-center rounded-lg bg-white text-emerald-700 shadow-xs transition hover:bg-emerald-100/60 active:scale-90 dark:bg-slate-800 dark:text-emerald-400"
            >
              <Minus aria-hidden className="size-3.5 stroke-[2.5]" />
            </button>

            <div className="flex items-center gap-1.5 px-2 font-mono text-xs font-black tabular-nums">
              <span className="text-sm">{cartQuantity}</span>
              <span className="text-[10px] font-bold text-emerald-700 dark:text-emerald-400">
                {p.unitName ? p.unitName : "في السلة"}
              </span>
            </div>

            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onUpdateQuantity(p.productId, 1);
              }}
              disabled={p.stockLeft != null && cartQuantity >= p.stockLeft}
              aria-label={`زيادة كمية ${p.productName}`}
              className="flex size-8 items-center justify-center rounded-lg bg-emerald-600 text-white shadow-xs transition hover:bg-emerald-500 active:scale-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Plus aria-hidden className="size-3.5 stroke-[2.5]" />
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={handleAddClick}
            disabled={!orderable}
            className={`store-primary-action mt-auto flex h-11 w-full items-center justify-center gap-2 rounded-xl text-xs font-black text-white shadow-md transition-all duration-200 active:scale-95 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400 disabled:shadow-none dark:disabled:bg-slate-800 dark:disabled:text-slate-600 ${
              showAdded
                ? "bg-emerald-600 shadow-emerald-500/30 scale-[1.02]"
                : "bg-orange-600 hover:bg-orange-500 shadow-orange-600/20"
            }`}
          >
            {showAdded ? (
              <>
                <Check aria-hidden className="size-4 animate-scale-in" />
                <span>تمت الإضافة</span>
              </>
            ) : p.isCustomizable ? (
              <>
                <AlertTriangle aria-hidden className="size-4" />
                <span>{actionLabel}</span>
              </>
            ) : (
              <>
                <Plus aria-hidden className="size-4" />
                <span>{actionLabel}</span>
              </>
            )}
          </button>
        )}
      </div>
    </article>
  );
}
