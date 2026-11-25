import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Tag, TrendingUp, Play, Pause, ArrowRight, Plus, Minus, Layers, Package } from "lucide-react";
import { fmtInt } from "@/lib/money";
import { formatQuantity } from "@shared/quantityFormat";
import { AnimatedAddToCartButton } from "./AnimatedAddToCartButton";

function money(v: string | number | null): string {
  if (v == null || v === "") return "0";
  return fmtInt(v);
}

export type RowProduct = {
  productUnitId: number;
  productId: number;
  productName: string;
  price: string | null;
  salePrice?: string | null;
  imageUrl: string | null;
  bundleImageUrls?: string[];
  unitName: string;
  inStock?: boolean;
  isCustomizable?: boolean;
  hasAlternatives?: boolean;
};

function priceLabel(price: string | null): string {
  if (price == null || price === "") return "تواصل معنا للسعر";
  return `${money(price)} د.ع`;
}

interface CuratedCardProps {
  p: RowProduct;
  onSelect: () => void;
  onAdd: (event: React.MouseEvent<HTMLButtonElement>) => boolean;
  recentlyAdded?: boolean;
  canBeOrdered: (p: RowProduct) => boolean;
  cartQuantity?: number;
  onUpdateQuantity?: (productId: number, delta: number) => void;
  inertClone?: boolean;
}

function CuratedProductCard({
  p,
  onSelect,
  onAdd,
  recentlyAdded = false,
  canBeOrdered,
  cartQuantity = 0,
  onUpdateQuantity,
  inertClone = false,
}: CuratedCardProps) {
  const onSale = p.salePrice != null && p.price != null && Number(p.salePrice) < Number(p.price);
  const pct = onSale ? Math.round((1 - Number(p.salePrice) / Number(p.price)) * 100) : 0;
  const savings = onSale ? Number(p.price) - Number(p.salePrice) : 0;
  const isOrderable = canBeOrdered(p);
  const showAdded = recentlyAdded;

  return (
    <div
      aria-hidden={inertClone || undefined}
      className={`store-product-card group relative flex w-[164px] shrink-0 flex-col overflow-hidden rounded-2xl border bg-white sm:w-[192px] lg:w-[204px] dark:bg-slate-900 ${
        showAdded
          ? "border-[var(--store-brand)] ring-2 ring-[var(--store-brand)]/20"
          : "border-slate-900/[0.08] dark:border-slate-800"
      }`}
    >
      <button
        type="button"
        tabIndex={inertClone ? -1 : 0}
        onClick={onSelect}
        className="relative block w-full overflow-hidden bg-[#f5f5f7] text-right focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--store-brand)] dark:bg-slate-950"
        aria-label={`عرض تفاصيل ${p.productName}`}
      >
        <div className="flex aspect-[4/3] w-full items-center justify-center overflow-hidden bg-[#f5f5f7] p-2.5 transition-transform duration-300 ease-out group-hover:scale-[1.04] dark:bg-slate-950">
          {p.imageUrl ? (
            <img
              src={p.imageUrl}
              alt={p.productName}
              className="size-full object-contain select-none"
              draggable={false}
              loading="lazy"
            />
          ) : (
            <div className="flex flex-col items-center justify-center gap-1.5 text-slate-300 dark:text-slate-600">
              <Package className="size-8 text-slate-300 dark:text-slate-600" />
              <span className="text-[10px] font-bold text-slate-400 dark:text-slate-500">المكتبة العربية</span>
            </div>
          )}
        </div>

        {onSale && pct > 0 && (
          <span className="absolute right-2 top-2 rounded-md bg-[var(--store-accent)] px-2 py-0.5 text-[10px] font-bold text-white shadow-2xs whitespace-nowrap tabular-nums">
            خصم {pct}٪
          </span>
        )}

        {p.inStock === false && (
          <span className="absolute inset-x-0 bottom-0 bg-[#1d1d1f]/85 py-1.5 text-center text-[11px] font-bold text-white backdrop-blur-xs">
            نافد حالياً
          </span>
        )}
      </button>

      <div className="flex flex-1 flex-col p-3">
        <div className="flex h-4 items-center">
          {p.hasAlternatives ? (
            <span className="inline-flex items-center gap-1 rounded bg-[#f5f5f7] px-1.5 py-0.5 text-[9px] font-bold text-[#6e6e73] dark:bg-slate-800 dark:text-slate-300 whitespace-nowrap">
              <Layers aria-hidden className="size-2.5" /> ماركات متعددة
            </span>
          ) : (
            <span className="truncate text-[10px] font-medium text-[#6e6e73] dark:text-slate-400">
              {p.unitName}
            </span>
          )}
        </div>

        <div className="mt-1 flex h-9 items-start">
          <button
            type="button"
            tabIndex={inertClone ? -1 : 0}
            onClick={onSelect}
            className="w-full text-right focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--store-brand)] rounded"
          >
            <span className="line-clamp-2 text-xs font-semibold leading-snug text-[#1d1d1f] transition-colors group-hover:text-[var(--store-brand)] dark:text-slate-100 dark:group-hover:text-blue-400">
              {p.productName}
            </span>
          </button>
        </div>

        <div className="mt-1.5 mb-2 flex min-h-10 flex-col justify-center">
          <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
            <span className="text-xs sm:text-sm font-bold tracking-tight whitespace-nowrap text-[#1d1d1f] tabular-nums dark:text-white">
              {priceLabel(p.salePrice ?? p.price)}
            </span>
            {onSale && (
              <span className="text-[10px] text-[#6e6e73] line-through whitespace-nowrap tabular-nums">
                {money(p.price)}
              </span>
            )}
          </div>
          {onSale && savings > 0 ? (
            <span className="text-[10px] font-semibold text-[var(--store-brand)] whitespace-nowrap tabular-nums">
              توفير {money(savings)} د.ع
            </span>
          ) : (
            <div className="h-[14px]" />
          )}
        </div>

        {!p.isCustomizable && cartQuantity > 0 && onUpdateQuantity ? (
          <div className="mt-auto flex h-9.5 w-full items-center justify-between rounded-xl border border-slate-900/12 bg-[#f5f5f7] px-1.5 text-[#1d1d1f] shadow-2xs dark:border-slate-700 dark:bg-slate-800 dark:text-white">
            <button
              type="button"
              tabIndex={inertClone ? -1 : 0}
              onClick={(e) => {
                e.stopPropagation();
                onUpdateQuantity(p.productId, -1);
              }}
              aria-label={`تقليل كمية ${p.productName}`}
              className="flex size-7 items-center justify-center rounded-lg bg-white text-[#1d1d1f] shadow-xs transition-transform hover:bg-slate-100 active:scale-90 dark:bg-slate-900 dark:text-white"
            >
              <Minus aria-hidden className="size-3 stroke-[2.5]" />
            </button>

            <div className="flex min-w-0 flex-1 items-center justify-center gap-1 px-0.5 font-mono text-[11px] font-black tabular-nums">
              <span className="shrink-0">{formatQuantity(cartQuantity)}</span>
              <span className="truncate text-[9px] font-bold text-slate-600 dark:text-slate-300">
                {p.unitName ? p.unitName : "بالسلة"}
              </span>
            </div>

            <button
              type="button"
              tabIndex={inertClone ? -1 : 0}
              onClick={(e) => {
                e.stopPropagation();
                onUpdateQuantity(p.productId, 1);
              }}
              aria-label={`زيادة كمية ${p.productName}`}
              className="flex size-7 items-center justify-center rounded-lg bg-[#1d1d1f] text-white shadow-xs transition-transform hover:bg-slate-800 active:scale-90 dark:bg-white dark:text-[#1d1d1f]"
            >
              <Plus aria-hidden className="size-3 stroke-[2.5]" />
            </button>
          </div>
        ) : (
          <div className="mt-auto w-full">
            <AnimatedAddToCartButton
              size="sm"
              disabled={!isOrderable}
              label={!p.inStock ? "نافد من المخزون" : p.isCustomizable ? "طلب مخصص" : "أضف إلى السلة"}
              addedLabel="تمت الإضافة"
              onAdd={(btnEl) => {
                return onAdd({ currentTarget: btnEl, stopPropagation: () => {} } as unknown as React.MouseEvent<HTMLButtonElement>);
              }}
              cartCount={cartQuantity}
              showCartCount={false}
            />
          </div>
        )}
      </div>
    </div>
  );
}

export interface CuratedRowProps {
  title: string;
  subtitle?: string;
  icon: React.ReactNode;
  products: RowProduct[];
  onSelect: (id: number) => void;
  onAdd: (p: RowProduct, event: React.MouseEvent<HTMLButtonElement>) => boolean;
  recentlyAddedId?: number | null;
  canBeOrdered?: (p: RowProduct) => boolean;
  getCartQuantity?: (id: number) => number;
  onUpdateQuantity?: (productId: number, delta: number) => void;
}

export function CuratedRow({
  title,
  subtitle,
  icon,
  products,
  onSelect,
  onAdd,
  recentlyAddedId,
  canBeOrdered = (p) => p.inStock !== false,
  getCartQuantity,
  onUpdateQuantity,
}: CuratedRowProps) {
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const seg0Ref = useRef<HTMLDivElement | null>(null);
  const seg1Ref = useRef<HTMLDivElement | null>(null);
  const offsetRef = useRef(0);
  const targetNudgeRef = useRef(0);
  const velocityFactorRef = useRef(1);
  const isHoveredRef = useRef(false);
  const isFocusedRef = useRef(false);
  const dragRef = useRef({ active: false, pointerId: -1, startX: 0, startOffset: 0, moved: false });
  const [autoPlayPaused, setAutoPlayPaused] = useState(false);
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(() =>
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setPrefersReducedMotion(mq.matches);
    const onChange = (ev: MediaQueryListEvent) => setPrefersReducedMotion(ev.matches);
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);

  // حماية صارمة: لا نعرض في مساحة العروض إلا الأصناف المتوفرة فعلاً بالمخزون
  const displayProducts = useMemo(
    () =>
      Array.from(
        new Map(
          products
            .filter((item) => item.inStock !== false)
            .map((item) => [item.productId, item]),
        ).values(),
      ),
    [products],
  );

  const hasMultipleCards = displayProducts.length >= 4;
  const shouldLoopMarquee = hasMultipleCards && !prefersReducedMotion;
  const repeatCount = !shouldLoopMarquee ? 1 : displayProducts.length < 7 ? 3 : 2;

  const moveRow = useCallback(
    (direction: -1 | 1) => {
      if (!shouldLoopMarquee) {
        scrollContainerRef.current?.scrollBy({ left: -direction * 280, behavior: "auto" });
        return;
      }
      targetNudgeRef.current += direction * 280;
    },
    [shouldLoopMarquee],
  );

  useEffect(() => {
    if (typeof window === "undefined" || !shouldLoopMarquee) {
      if (trackRef.current) trackRef.current.style.transform = "";
      return;
    }

    let rafId = 0;
    let lastTime = performance.now();

    const tick = (now: number) => {
      const dt = Math.min((now - lastTime) / 1000, 0.064);
      lastTime = now;

      let unitWidth = 0;
      if (seg0Ref.current && seg1Ref.current) {
        unitWidth = Math.abs(seg1Ref.current.offsetLeft - seg0Ref.current.offsetLeft);
      } else if (seg0Ref.current) {
        unitWidth = seg0Ref.current.offsetWidth + 12;
      }

      if (unitWidth > 0 && trackRef.current && !dragRef.current.active) {
        if (Math.abs(targetNudgeRef.current) > 0.5) {
          const step = targetNudgeRef.current * Math.min(1, 12 * dt);
          offsetRef.current += step;
          targetNudgeRef.current -= step;
        } else {
          targetNudgeRef.current = 0;
          const paused =
            autoPlayPaused ||
            isHoveredRef.current ||
            isFocusedRef.current ||
            document.hidden;
          const targetFactor = paused ? 0 : 1;
          velocityFactorRef.current +=
            (targetFactor - velocityFactorRef.current) * Math.min(1, dt * 7);
          if (velocityFactorRef.current > 0.004) {
            offsetRef.current += 28 * velocityFactorRef.current * dt;
          }
        }

        while (offsetRef.current >= unitWidth) offsetRef.current -= unitWidth;
        while (offsetRef.current < 0) offsetRef.current += unitWidth;

        trackRef.current.style.transform = `translate3d(${offsetRef.current.toFixed(2)}px, 0, 0)`;
      }

      rafId = window.requestAnimationFrame(tick);
    };

    rafId = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(rafId);
  }, [autoPlayPaused, shouldLoopMarquee]);

  if (displayProducts.length === 0) return null;

  return (
    <section className="min-w-0">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span className="flex size-8 items-center justify-center rounded-xl bg-[#f5f5f7] text-[var(--store-accent)] dark:bg-slate-800 dark:text-amber-400">
            {icon}
          </span>
          <div>
            <h3 className="store-display-title flex items-center gap-2 text-base sm:text-xl font-bold text-[#1d1d1f] dark:text-slate-100">
              <span>{title}</span>
              <span className="rounded-full bg-[#f5f5f7] px-2 py-0.5 text-[11px] font-bold text-[#6e6e73] tabular-nums dark:bg-slate-800 dark:text-slate-300">
                {displayProducts.length} صنف متوفر
              </span>
            </h3>
            {subtitle && (
              <p className="text-[11px] font-medium text-[#6e6e73] dark:text-slate-400">
                {subtitle}
              </p>
            )}
          </div>
        </div>
        {hasMultipleCards && (
          <div className="flex items-center gap-1.5" aria-label={`تنقل ${title}`}>
            {shouldLoopMarquee && (
              <button
                type="button"
                onClick={() => setAutoPlayPaused((v) => !v)}
                className="flex size-8 items-center justify-center rounded-full border border-slate-900/10 bg-[#f5f5f7] text-[#1d1d1f] transition-transform hover:bg-slate-200/70 active:scale-95 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
                aria-label={autoPlayPaused ? `تشغيل الحركة التلقائية في ${title}` : `إيقاف الحركة التلقائية في ${title}`}
                aria-pressed={autoPlayPaused}
              >
                {autoPlayPaused ? <Play aria-hidden className="size-3.5" /> : <Pause aria-hidden className="size-3.5" />}
              </button>
            )}
            <button
              type="button"
              onClick={() => moveRow(1)}
              className="flex size-8 items-center justify-center rounded-full border border-slate-900/10 bg-[#f5f5f7] text-[#1d1d1f] transition-transform hover:bg-slate-200/70 active:scale-95 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
              aria-label={`مرر ${title} إلى اليسار`}
            >
              <ArrowRight aria-hidden className="size-3.5 rotate-180" />
            </button>
            <button
              type="button"
              onClick={() => moveRow(-1)}
              className="flex size-8 items-center justify-center rounded-full border border-slate-900/10 bg-[#f5f5f7] text-[#1d1d1f] transition-transform hover:bg-slate-200/70 active:scale-95 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
              aria-label={`مرر ${title} إلى اليمين`}
            >
              <ArrowRight aria-hidden className="size-3.5" />
            </button>
          </div>
        )}
      </div>

      <div
        ref={scrollContainerRef}
        dir="rtl"
        className={`relative pb-1.5 ${shouldLoopMarquee ? "overflow-hidden mask-gradient-x cursor-grab active:cursor-grabbing" : "overflow-x-auto"}`}
        onMouseEnter={() => {
          isHoveredRef.current = true;
        }}
        onMouseLeave={() => {
          isHoveredRef.current = false;
        }}
        onFocusCapture={() => {
          isFocusedRef.current = true;
        }}
        onBlurCapture={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
            isFocusedRef.current = false;
          }
        }}
        onPointerDown={(event) => {
          if (!shouldLoopMarquee) return;
          if ((event.target as HTMLElement).closest("button")) return;
          dragRef.current = {
            active: true,
            pointerId: event.pointerId,
            startX: event.clientX,
            startOffset: offsetRef.current,
            moved: false,
          };
        }}
        onPointerMove={(event) => {
          if (!dragRef.current.active || dragRef.current.pointerId !== event.pointerId) return;
          const delta = event.clientX - dragRef.current.startX;
          if (Math.abs(delta) > 6 && !dragRef.current.moved) {
            dragRef.current.moved = true;
            event.currentTarget.setPointerCapture?.(event.pointerId);
          }
          if (dragRef.current.moved && trackRef.current) {
            let unitWidth = 0;
            if (seg0Ref.current && seg1Ref.current) {
              unitWidth = Math.abs(seg1Ref.current.offsetLeft - seg0Ref.current.offsetLeft);
            }
            let next = dragRef.current.startOffset + delta;
            if (unitWidth > 0) {
              while (next >= unitWidth) next -= unitWidth;
              while (next < 0) next += unitWidth;
            }
            offsetRef.current = next;
            trackRef.current.style.transform = `translate3d(${next.toFixed(2)}px, 0, 0)`;
          }
        }}
        onPointerUp={() => {
          dragRef.current.active = false;
        }}
        onPointerCancel={() => {
          dragRef.current.active = false;
        }}
        onClickCapture={(event) => {
          if (dragRef.current.moved) {
            event.preventDefault();
            event.stopPropagation();
            dragRef.current.moved = false;
          }
        }}
        aria-label={`${title} — اسحب لاكتشاف المزيد`}
      >
        <div
          ref={trackRef}
          className={`flex items-stretch gap-3 select-none ${shouldLoopMarquee ? "w-max will-change-transform" : "w-max"}`}
        >
          {Array.from({ length: repeatCount }).map((_, copyIdx) => (
            <div
              key={copyIdx}
              ref={copyIdx === 0 ? seg0Ref : copyIdx === 1 ? seg1Ref : undefined}
              aria-hidden={copyIdx > 0 || undefined}
              className="flex items-stretch gap-3 shrink-0"
            >
              {displayProducts.map((p, idx) => (
                <CuratedProductCard
                  key={`${copyIdx}-${p.productId}-${idx}`}
                  p={p}
                  inertClone={copyIdx > 0}
                  onSelect={() => onSelect(p.productId)}
                  onAdd={(event) => onAdd(p, event)}
                  recentlyAdded={recentlyAddedId === p.productId}
                  canBeOrdered={canBeOrdered}
                  cartQuantity={getCartQuantity ? getCartQuantity(p.productId) : 0}
                  onUpdateQuantity={onUpdateQuantity}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

interface StorefrontCuratedRowsProps {
  dealProducts: RowProduct[];
  bestSellers: RowProduct[];
  onSelectProduct: (id: number) => void;
  onAddToCart: (p: RowProduct, event: React.MouseEvent<HTMLButtonElement>) => boolean;
  recentlyAddedId?: number | null;
  canBeOrdered: (p: RowProduct) => boolean;
  getCartQuantity?: (id: number) => number;
  onUpdateQuantity?: (productId: number, delta: number) => void;
}

export function StorefrontCuratedRows({
  dealProducts,
  bestSellers,
  onSelectProduct,
  onAddToCart,
  recentlyAddedId,
  canBeOrdered,
  getCartQuantity,
  onUpdateQuantity,
}: StorefrontCuratedRowsProps) {
  if (dealProducts.length === 0 && bestSellers.length === 0) return null;

  return (
    <div
      id="store-picks"
      className="mt-8 grid min-w-0 grid-cols-1 gap-8 rounded-3xl border border-slate-900/[0.08] bg-white p-5 sm:p-7 dark:border-slate-800 dark:bg-slate-900"
    >
      {dealProducts.length > 0 && (
        <CuratedRow
          title="عروض وتخفيضات مختارة"
          icon={<Tag aria-hidden className="size-4" />}
          products={dealProducts}
          onSelect={onSelectProduct}
          onAdd={onAddToCart}
          recentlyAddedId={recentlyAddedId}
          canBeOrdered={canBeOrdered}
          getCartQuantity={getCartQuantity}
          onUpdateQuantity={onUpdateQuantity}
        />
      )}

      {bestSellers.length > 0 && (
        <CuratedRow
          title="الأكثر طلباً وتفضيلاً"
          icon={<TrendingUp aria-hidden className="size-4" />}
          products={bestSellers}
          onSelect={onSelectProduct}
          onAdd={onAddToCart}
          recentlyAddedId={recentlyAddedId}
          canBeOrdered={canBeOrdered}
          getCartQuantity={getCartQuantity}
          onUpdateQuantity={onUpdateQuantity}
        />
      )}
    </div>
  );
}

export { CuratedRow as ProductRow };
