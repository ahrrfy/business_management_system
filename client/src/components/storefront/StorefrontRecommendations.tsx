import { AnimatedAddToCartButton } from "@/components/storefront/AnimatedAddToCartButton";
import { AlertTriangle, ArrowRight, ChevronDown } from "lucide-react";
import React, { useRef, useState } from "react";
import { priceLabel } from "./storefrontCartMath";
import { matchesPriceFilter, type PriceFilter } from "./storefrontCatalogModel";
import { ProductImage } from "./StorefrontMedia";

export type StorefrontUnitForCartAction = {
  productUnitId: number;
  price: string | null;
  salePrice?: string | null;
  unitName: string;
  inStock: boolean;
  stockLeft?: number | null;
};

export type StorefrontProductForCartAction = {
  productId: number;
  productName: string;
  imageUrl: string | null;
  price: string | null;
  salePrice?: string | null;
  productUnitId: number;
  unitName: string;
  inStock?: boolean;
  stockLeft?: number | null;
  isCustomizable?: boolean;
  storeUnits?: StorefrontUnitForCartAction[];
  variants?: Array<{ label: string; units: StorefrontUnitForCartAction[] }>;
  bundleImageUrls?: string[];
  hasAlternatives?: boolean;
};

export type RelatedProduct = StorefrontProductForCartAction;

export function storefrontProductCanBeOrdered(product: {
  inStock?: boolean;
  isCustomizable?: boolean;
}): boolean {
  return product.inStock !== false;
}

export function recommendationNeedsSelection(product: RelatedProduct): boolean {
  const selectableUnitIds = new Set([
    ...(product.storeUnits ?? [])
      .filter((unit) => unit.inStock)
      .map((unit) => unit.productUnitId),
    ...(product.variants ?? []).flatMap((variant) =>
      variant.units
        .filter((unit) => unit.inStock)
        .map((unit) => unit.productUnitId),
    ),
  ]);
  return (
    Boolean(product.isCustomizable) ||
    Boolean(product.hasAlternatives) ||
    (product.variants?.length ?? 0) > 1 ||
    selectableUnitIds.size > 1
  );
}

export function recommendationActionLabel(product: RelatedProduct): string {
  if (product.isCustomizable) return "اختر تفاصيل التخصيص";
  return recommendationNeedsSelection(product)
    ? "اختر الخيارات"
    : product.inStock === false
      ? "غير متوفر"
      : "أضف إلى السلة";
}

export function RelatedProductStrip({
  products,
  onSelect,
  onAdd,
  onRecommendationClick,
}: {
  products: RelatedProduct[];
  onSelect: (id: number) => void;
  onAdd: (
    product: RelatedProduct,
    event: React.MouseEvent<HTMLButtonElement>,
  ) => boolean;
  onRecommendationClick: (recommendedProductId: number) => void;
}) {
  const [priceFilter, setPriceFilter] = useState<PriceFilter>("ALL");
  const filteredProducts = products.filter((product) =>
    matchesPriceFilter(
      Number(product.salePrice ?? product.price ?? 0),
      priceFilter,
    ),
  );
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef({
    active: false,
    startX: 0,
    startScroll: 0,
    moved: false,
  });
  const move = (direction: -1 | 1) => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    scroller.scrollBy({
      left: direction * Math.max(240, Math.floor(scroller.clientWidth * 0.86)),
      behavior: "smooth",
    });
  };
  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if (
      (event.target as HTMLElement).closest("button, a, select, input, label")
    )
      return;
    const scroller = scrollerRef.current;
    if (!scroller) return;
    dragRef.current = {
      active: true,
      startX: event.clientX,
      startScroll: scroller.scrollLeft,
      moved: false,
    };
  };
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const scroller = scrollerRef.current;
    if (!scroller || !dragRef.current.active) return;
    const delta = event.clientX - dragRef.current.startX;
    if (Math.abs(delta) > 6) {
      if (!dragRef.current.moved) {
        dragRef.current.moved = true;
        if (!scroller.hasPointerCapture(event.pointerId)) {
          scroller.setPointerCapture(event.pointerId);
        }
      }
      event.preventDefault();
      scroller.scrollLeft = dragRef.current.startScroll - delta;
    }
  };
  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const scroller = scrollerRef.current;
    dragRef.current.active = false;
    if (scroller?.hasPointerCapture(event.pointerId))
      scroller.releasePointerCapture(event.pointerId);
    window.setTimeout(() => {
      dragRef.current.moved = false;
    }, 0);
  };

  return (
    <div className="animate__animated animate__fadeIn mt-5 min-w-0">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-extrabold text-slate-800 dark:text-slate-200">
            قد يعجبك أيضاً
          </h3>
          <span className="text-[10px] font-bold text-slate-400">
            {filteredProducts.length} اقتراح
          </span>
        </div>
        <div className="flex items-center gap-1">
          {/* لا يُحوَّل إلى AppSelect عمداً: حبّةُ فلترٍ دقيقة (نصّ 10px · ارتفاع ~٢٤px · سهمٌ
              خاصّ) بجوار زرَّي تنقّل size-7 (٢٨px). أقلّ ارتفاعٍ يبلغه AppSelect هو
              `--ui-control-sm` = 40px بأولويّةٍ لا يهزمها صنفُ ارتفاعٍ خارجيّ ⇒ التحويل
              يُضخّم الحبّة ٦٦٪ ويكسر صفّ الشريط. راجع تبرير الموجة. */}
          <label className="relative shrink-0">
            <span className="sr-only">تصفية التوصيات حسب السعر</span>
            <select
              value={priceFilter}
              onChange={(event) =>
                setPriceFilter(event.target.value as PriceFilter)
              }
              className="appearance-none rounded-full border border-slate-200 bg-white py-1.5 pr-2.5 pl-6 text-[10px] font-bold text-slate-600 outline-none focus:border-emerald-400 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300"
            >
              <option value="ALL">كل الأسعار</option>
              <option value="UNDER_5000">أقل من 5,000 د.ع</option>
              <option dir="ltr" value="FROM_5000_TO_15000">
                5,000–15,000 د.ع
              </option>
              <option value="OVER_15000">أكثر من 15,000 د.ع</option>
            </select>
            <ChevronDown
              aria-hidden
              className="pointer-events-none absolute left-1.5 top-1/2 size-3 -translate-y-1/2 text-slate-400"
            />
          </label>
          <div
            className="flex items-center gap-1"
            aria-label="تنقل المنتجات المقترحة"
          >
            <button
              type="button"
              onClick={() => move(1)}
              className="flex size-7 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-600 transition hover:border-emerald-300 hover:text-emerald-700 active:scale-95"
              aria-label="مرر المنتجات المقترحة إلى اليسار"
            >
              <ArrowRight aria-hidden className="size-3.5 rotate-180" />
            </button>
            <button
              type="button"
              onClick={() => move(-1)}
              className="flex size-7 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-600 transition hover:border-emerald-300 hover:text-emerald-700 active:scale-95"
              aria-label="مرر المنتجات المقترحة إلى اليمين"
            >
              <ArrowRight aria-hidden className="size-3.5" />
            </button>
          </div>
        </div>
      </div>
      <div
        ref={scrollerRef}
        dir="rtl"
        className="flex min-w-0 cursor-grab touch-pan-x select-none snap-x snap-mandatory scroll-smooth gap-3 overflow-x-auto overscroll-x-contain pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden active:cursor-grabbing"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onClickCapture={(event) => {
          if (dragRef.current.moved) {
            event.preventDefault();
            event.stopPropagation();
          }
        }}
        aria-label="منتجات مقترحة — اسحب لاكتشاف المزيد"
      >
        {filteredProducts.length === 0 ? (
          <p className="w-full py-4 text-center text-xs font-bold text-slate-400">
            لا توجد اقتراحات ضمن هذا النطاق السعري.
          </p>
        ) : (
          filteredProducts.map((rp) => (
            <article
              key={rp.productId}
              className="store-product-card flex min-w-[120px] max-w-[130px] shrink-0 snap-start flex-col overflow-hidden rounded-xl bg-white ring-1 ring-slate-100 dark:bg-slate-900 dark:ring-slate-800"
            >
              <button
                type="button"
                onClick={() => {
                  onRecommendationClick(rp.productId);
                  onSelect(rp.productId);
                }}
                aria-label={`فتح تفاصيل ${rp.productName}`}
                className="text-right"
              >
                <ProductImage
                  url={rp.imageUrl}
                  alt={rp.productName}
                  className="store-product-media aspect-square w-full"
                />
              </button>
              <div className="flex flex-1 flex-col gap-1 p-2">
                <button
                  type="button"
                  onClick={() => {
                    onRecommendationClick(rp.productId);
                    onSelect(rp.productId);
                  }}
                  className="line-clamp-2 min-h-[2.2em] text-right text-[11px] font-bold leading-tight"
                  aria-label={`فتح تفاصيل ${rp.productName}`}
                >
                  {rp.productName}
                </button>
                <span className="text-xs font-extrabold text-emerald-600 dark:text-emerald-400">
                  {priceLabel(rp.salePrice ?? rp.price)}
                </span>
                <div className="mt-auto w-full">
                  <AnimatedAddToCartButton
                    size="xs"
                    disabled={!storefrontProductCanBeOrdered(rp)}
                    label={recommendationActionLabel(rp)}
                    addedLabel="تمت الإضافة"
                    icon={
                      rp.isCustomizable ? (
                        <AlertTriangle aria-hidden className="size-3" />
                      ) : undefined
                    }
                    onAdd={(btnEl) => {
                      onRecommendationClick(rp.productId);
                      return onAdd(rp, {
                        currentTarget: btnEl,
                        stopPropagation: () => {},
                      } as unknown as React.MouseEvent<HTMLButtonElement>);
                    }}
                    showCartCount={false}
                  />
                </div>
              </div>
            </article>
          ))
        )}
      </div>
    </div>
  );
}
