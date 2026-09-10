import React, { useRef, useState, useEffect } from "react";
import { Tag, TrendingUp, Play, Pause, ArrowRight, Check, AlertTriangle, Plus, Minus, Layers, Package } from "lucide-react";
import { fmtInt } from "@/lib/money";

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
  if (price == null || price === "") return "اسأل الموظّف";
  return `${money(price)} د.ع`;
}

interface CuratedCardProps {
  p: RowProduct;
  onSelect: () => void;
  onAdd: (event: React.MouseEvent<HTMLButtonElement>) => void;
  recentlyAdded?: boolean;
  canBeOrdered: (p: RowProduct) => boolean;
  cartQuantity?: number;
  onUpdateQuantity?: (productId: number, delta: number) => void;
}

function CuratedProductCard({
  p,
  onSelect,
  onAdd,
  recentlyAdded = false,
  canBeOrdered,
  cartQuantity = 0,
  onUpdateQuantity,
}: CuratedCardProps) {
  const [localAdded, setLocalAdded] = useState(false);
  const onSale = p.salePrice != null && p.price != null && Number(p.salePrice) < Number(p.price);
  const pct = onSale ? Math.round((1 - Number(p.salePrice) / Number(p.price)) * 100) : 0;
  const isOrderable = canBeOrdered(p);
  const showAdded = recentlyAdded || localAdded;

  const handleAddClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    setLocalAdded(true);
    window.setTimeout(() => setLocalAdded(false), 1500);
    onAdd(event);
  };

  return (
    <div
      className={`store-product-card group relative flex w-[164px] shrink-0 flex-col overflow-hidden rounded-2xl border bg-white transition-all duration-300 sm:w-[184px] lg:w-[196px] dark:bg-slate-900 ${
        showAdded
          ? "border-emerald-400 ring-2 ring-emerald-400/20 shadow-lg shadow-emerald-500/10"
          : "border-slate-200/80 hover:-translate-y-1 hover:border-blue-300 hover:shadow-lg dark:border-slate-800"
      }`}
    >
      <button
        type="button"
        onClick={onSelect}
        className="relative block w-full overflow-hidden bg-slate-50 text-right focus:outline-none dark:bg-slate-950"
        aria-label={`عرض تفاصيل ${p.productName}`}
      >
        <div className="flex aspect-square w-full items-center justify-center overflow-hidden bg-slate-50 p-2.5 transition-transform duration-500 ease-out group-hover:scale-105 dark:bg-slate-950">
          {p.imageUrl ? (
            <img
              src={p.imageUrl}
              alt={p.productName}
              className="size-full object-contain"
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
          <span className="absolute right-2 top-2 rounded-md bg-orange-600 px-2 py-0.5 text-[10px] font-black text-white shadow-sm">
            خصم {pct}٪
          </span>
        )}

        {p.inStock === false && (
          <span className="absolute inset-x-0 bottom-0 bg-slate-950/80 py-1.5 text-center text-[11px] font-bold text-white backdrop-blur-xs">
            غير متوفّر
          </span>
        )}
      </button>

      {/* محتوى البطاقة بارتفاعات عمودية ثابتة ومحاذاة خط الأزرار */}
      <div className="flex flex-1 flex-col p-3">
        {/* وسم التصنيف أو الماركة البديلة */}
        <div className="flex h-4 items-center">
          {p.hasAlternatives ? (
            <span className="inline-flex items-center gap-1 rounded bg-slate-100 px-1.5 py-0.5 text-[9px] font-bold text-slate-600 dark:bg-slate-800 dark:text-slate-300">
              <Layers aria-hidden className="size-2.5" /> ماركات متعددة
            </span>
          ) : (
            <span className="text-[9px] font-bold text-slate-400 dark:text-slate-500">
              {p.unitName}
            </span>
          )}
        </div>

        {/* عنوان المنتج بسطرين مقفول الارتفاع */}
        <div className="mt-1 flex h-9 items-start">
          <button
            type="button"
            onClick={onSelect}
            className="w-full text-right focus:outline-none"
          >
            <span className="line-clamp-2 text-xs font-black leading-snug text-slate-900 transition-colors group-hover:text-blue-700 dark:text-slate-100 dark:group-hover:text-blue-400">
              {p.productName}
            </span>
          </button>
        </div>

        {/* الأسعار ومقدار التخفيض */}
        <div className="mt-2 flex h-10 flex-col justify-center">
          <div className="flex items-baseline gap-1.5">
            <span className="text-sm font-black text-blue-900 dark:text-blue-300">
              {priceLabel(p.salePrice ?? p.price)}
            </span>
            {onSale && (
              <span className="text-[10px] text-slate-400 line-through">
                {money(p.price)}
              </span>
            )}
          </div>
          {onSale && pct > 0 ? (
            <span className="text-[9px] font-black text-emerald-600 dark:text-emerald-400">
              توفير {pct}٪
            </span>
          ) : (
            <div className="h-[14px]" />
          )}
        </div>

        {/* زر الإضافة السريع للسلة أو وحدة التحكم بالكمية المتحولة — متطابق أفقياً بارتفاع h-10 */}
        {!p.isCustomizable && cartQuantity > 0 && onUpdateQuantity ? (
          <div className="animate-spring-pop mt-auto flex h-10 w-full items-center justify-between rounded-xl border border-emerald-600/30 bg-emerald-50 px-1.5 text-emerald-900 shadow-sm dark:border-emerald-500/30 dark:bg-emerald-950/40 dark:text-emerald-200">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onUpdateQuantity(p.productId, -1);
              }}
              aria-label={`تقليل كمية ${p.productName}`}
              className="flex size-7 items-center justify-center rounded-lg bg-white text-emerald-700 shadow-xs transition hover:bg-emerald-100/60 active:scale-90 dark:bg-slate-800 dark:text-emerald-400"
            >
              <Minus aria-hidden className="size-3 stroke-[2.5]" />
            </button>

            <div className="flex items-center gap-1 font-mono text-[11px] font-black tabular-nums">
              <span>{cartQuantity}</span>
              <span className="text-[9px] font-bold text-emerald-700 dark:text-emerald-400">
                {p.unitName ? p.unitName : "بالسلة"}
              </span>
            </div>

            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onUpdateQuantity(p.productId, 1);
              }}
              aria-label={`زيادة كمية ${p.productName}`}
              className="flex size-7 items-center justify-center rounded-lg bg-emerald-600 text-white shadow-xs transition hover:bg-emerald-500 active:scale-90"
            >
              <Plus aria-hidden className="size-3 stroke-[2.5]" />
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={handleAddClick}
            disabled={!isOrderable}
            className={`store-primary-action store-action-button mt-auto flex h-10 w-full items-center justify-center gap-1.5 rounded-xl text-[11px] font-black text-white shadow-sm transition-all duration-200 motion-safe:active:scale-95 ${
              showAdded
                ? "bg-emerald-600 shadow-emerald-600/30 scale-[1.02]"
                : "bg-orange-600 hover:bg-orange-500 shadow-orange-600/20"
            } disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400 disabled:shadow-none dark:disabled:bg-slate-800 dark:disabled:text-slate-600`}
          >
            {showAdded ? (
              <>
                <Check aria-hidden className="size-3.5 animate-scale-in" />
                <span>تمت الإضافة</span>
              </>
            ) : p.isCustomizable ? (
              <>
                <AlertTriangle aria-hidden className="size-3.5" />
                <span>طلب مخصص</span>
              </>
            ) : (
              <>
                <Plus aria-hidden className="size-3.5" />
                <span>أضف إلى السلة</span>
              </>
            )}
          </button>
        )}
      </div>
    </div>
  );
}

export interface CuratedRowProps {
  title: string;
  icon: React.ReactNode;
  products: RowProduct[];
  onSelect: (id: number) => void;
  onAdd: (p: RowProduct, event: React.MouseEvent<HTMLButtonElement>) => void;
  recentlyAddedId?: number | null;
  canBeOrdered?: (p: RowProduct) => boolean;
  getCartQuantity?: (id: number) => number;
  onUpdateQuantity?: (productId: number, delta: number) => void;
}

export function CuratedRow({
  title,
  icon,
  products,
  onSelect,
  onAdd,
  recentlyAddedId,
  canBeOrdered = (p) => p.inStock !== false,
  getCartQuantity,
  onUpdateQuantity,
}: CuratedRowProps) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef({ active: false, startX: 0, startScroll: 0, moved: false });
  const isHoveredRef = useRef(false);
  const isInteractingRef = useRef(false);
  const resumeTimerRef = useRef<number | null>(null);
  const [interactionPaused, setInteractionPaused] = useState(false);
  const [autoPlayPaused, setAutoPlayPaused] = useState(false);

  // تكرار قائمة المنتجات إن كانت قليلة لضمان استمرار الحركة الانسيابية على الشاشات العريضة
  const displayProducts = products.length < 10 ? [...products, ...products] : products;

  // محرك الحركة المستمرة الانسيابية بمعدل 60 إطاراً في الثانية مع فيزياء التباطؤ والتسارع الانسيابية
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || products.length < 3) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduceMotion) return;

    let rafId: number = 0;
    let isRunning = false;
    let lastTime = performance.now();
    let targetSpeed = 0.55;
    let currentSpeed = 0.55;

    const resumeLoop = () => {
      if (!isRunning && !autoPlayPaused && !interactionPaused && !document.hidden) {
        isRunning = true;
        lastTime = performance.now();
        rafId = requestAnimationFrame(step);
      }
    };

    const onEnter = () => { isHoveredRef.current = true; };
    const onLeave = () => {
      isHoveredRef.current = false;
      resumeLoop();
    };
    const onTouchStart = () => {
      isInteractingRef.current = true;
      if (resumeTimerRef.current) window.clearTimeout(resumeTimerRef.current);
    };
    const onTouchEnd = () => {
      if (resumeTimerRef.current) window.clearTimeout(resumeTimerRef.current);
      resumeTimerRef.current = window.setTimeout(() => {
        isInteractingRef.current = false;
        resumeLoop();
      }, 1800);
    };

    scroller.addEventListener("mouseenter", onEnter, { passive: true });
    scroller.addEventListener("mouseleave", onLeave, { passive: true });
    scroller.addEventListener("touchstart", onTouchStart, { passive: true });
    scroller.addEventListener("touchend", onTouchEnd, { passive: true });
    scroller.addEventListener("pointerdown", onTouchStart, { passive: true });
    scroller.addEventListener("pointerup", onTouchEnd, { passive: true });

    const step = (time: number) => {
      const dt = Math.min(time - lastTime, 40);
      lastTime = time;

      const isPaused =
        isHoveredRef.current ||
        isInteractingRef.current ||
        interactionPaused ||
        autoPlayPaused ||
        document.hidden;

      targetSpeed = isPaused ? 0 : 0.55;
      currentSpeed += (targetSpeed - currentSpeed) * 0.15;

      if (currentSpeed > 0.01) {
        const maxScroll = scroller.scrollWidth - scroller.clientWidth;
        if (maxScroll > 6) {
          // في متصفحات RTL التمرير لليسار سالب القيمة
          if (Math.abs(scroller.scrollLeft) >= maxScroll - 2) {
            scroller.scrollLeft = 0;
          } else {
            scroller.scrollLeft -= (currentSpeed * dt) / 16;
          }
        }
      }

      if (isPaused && currentSpeed <= 0.01) {
        isRunning = false;
        return;
      }

      rafId = requestAnimationFrame(step);
    };

    if (!autoPlayPaused) {
      isRunning = true;
      rafId = requestAnimationFrame(step);
    }

    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      if (resumeTimerRef.current) window.clearTimeout(resumeTimerRef.current);
      scroller.removeEventListener("mouseenter", onEnter);
      scroller.removeEventListener("mouseleave", onLeave);
      scroller.removeEventListener("touchstart", onTouchStart);
      scroller.removeEventListener("touchend", onTouchEnd);
      scroller.removeEventListener("pointerdown", onTouchStart);
      scroller.removeEventListener("pointerup", onTouchEnd);
    };
  }, [autoPlayPaused, interactionPaused, products.length]);

  if (products.length === 0) return null;

  const moveRow = (direction: -1 | 1) => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    scroller.scrollBy({ left: direction * Math.max(220, Math.floor(scroller.clientWidth * 0.72)), behavior: "smooth" });
  };

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("button")) return;
    const scroller = scrollerRef.current;
    if (!scroller) return;
    dragRef.current = { active: true, startX: event.clientX, startScroll: scroller.scrollLeft, moved: false };
    scroller.setPointerCapture(event.pointerId);
    isInteractingRef.current = true;
    setInteractionPaused(true);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const scroller = scrollerRef.current;
    if (!scroller || !dragRef.current.active) return;
    const delta = event.clientX - dragRef.current.startX;
    if (Math.abs(delta) > 6) dragRef.current.moved = true;
    scroller.scrollLeft = dragRef.current.startScroll - delta;
  };

  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const scroller = scrollerRef.current;
    dragRef.current.active = false;
    if (scroller?.hasPointerCapture(event.pointerId)) scroller.releasePointerCapture(event.pointerId);
    window.setTimeout(() => { dragRef.current.moved = false; }, 0);
    setInteractionPaused(false);

    // مهلة استئناف للمس على الهواتف
    if (resumeTimerRef.current) window.clearTimeout(resumeTimerRef.current);
    resumeTimerRef.current = window.setTimeout(() => {
      isInteractingRef.current = false;
    }, 1800);
  };

  return (
    <section className="min-w-0">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span className="flex size-7 items-center justify-center rounded-lg bg-orange-100 text-orange-600 dark:bg-slate-800 dark:text-orange-400">
            {icon}
          </span>
          <h3 className="flex items-center gap-2 text-base font-black text-slate-900 dark:text-slate-100">
            <span>{title}</span>
            <span className="inline-block size-2 rounded-full bg-emerald-500 animate-pulse" />
          </h3>
        </div>
        <div className="flex items-center gap-1.5" aria-label={`تنقل ${title}`}>
          <button
            type="button"
            onClick={() => setAutoPlayPaused((v) => !v)}
            className="flex size-9 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-600 transition hover:border-blue-300 hover:text-blue-700 dark:border-slate-800 dark:bg-slate-800 dark:text-slate-300"
            aria-label={autoPlayPaused ? `تشغيل الحركة التلقائية في ${title}` : `إيقاف الحركة التلقائية في ${title}`}
            aria-pressed={autoPlayPaused}
          >
            {autoPlayPaused ? <Play aria-hidden className="size-3.5" /> : <Pause aria-hidden className="size-3.5" />}
          </button>
          <button
            type="button"
            onClick={() => moveRow(1)}
            onFocus={() => setInteractionPaused(true)}
            onBlur={() => setInteractionPaused(false)}
            className="flex size-9 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-600 transition hover:border-blue-300 hover:text-blue-700 dark:border-slate-800 dark:bg-slate-800 dark:text-slate-300"
            aria-label={`مرر ${title} إلى اليسار`}
          >
            <ArrowRight aria-hidden className="size-3.5 rotate-180" />
          </button>
          <button
            type="button"
            onClick={() => moveRow(-1)}
            onFocus={() => setInteractionPaused(true)}
            onBlur={() => setInteractionPaused(false)}
            className="flex size-9 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-600 transition hover:border-blue-300 hover:text-blue-700 dark:border-slate-800 dark:bg-slate-800 dark:text-slate-300"
            aria-label={`مرر ${title} إلى اليمين`}
          >
            <ArrowRight aria-hidden className="size-3.5" />
          </button>
        </div>
      </div>

      <div
        ref={scrollerRef}
        dir="rtl"
        className="mask-gradient-x flex min-w-0 cursor-grab touch-pan-x gap-3 overflow-x-auto overscroll-x-contain pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden active:cursor-grabbing"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerEnter={() => { isHoveredRef.current = true; }}
        onPointerLeave={() => { isHoveredRef.current = false; }}
        onMouseEnter={() => { isHoveredRef.current = true; }}
        onMouseLeave={() => { isHoveredRef.current = false; }}
        onTouchStart={() => {
          isInteractingRef.current = true;
          if (resumeTimerRef.current) window.clearTimeout(resumeTimerRef.current);
        }}
        onTouchEnd={() => {
          if (resumeTimerRef.current) window.clearTimeout(resumeTimerRef.current);
          resumeTimerRef.current = window.setTimeout(() => {
            isInteractingRef.current = false;
          }, 1800);
        }}
        onFocusCapture={() => setInteractionPaused(true)}
        onBlurCapture={() => setInteractionPaused(false)}
        onClickCapture={(event) => { if (dragRef.current.moved) { event.preventDefault(); event.stopPropagation(); } }}
        aria-label={`${title} — اسحب لاكتشاف المزيد`}
      >
        {displayProducts.map((p, idx) => (
          <CuratedProductCard
            key={`${p.productId}-${idx}`}
            p={p}
            onSelect={() => onSelect(p.productId)}
            onAdd={(event) => onAdd(p, event)}
            recentlyAdded={recentlyAddedId === p.productId}
            canBeOrdered={canBeOrdered}
            cartQuantity={getCartQuantity ? getCartQuantity(p.productId) : 0}
            onUpdateQuantity={onUpdateQuantity}
          />
        ))}
      </div>
    </section>
  );
}

interface StorefrontCuratedRowsProps {
  dealProducts: RowProduct[];
  bestSellers: RowProduct[];
  onSelectProduct: (id: number) => void;
  onAddToCart: (p: RowProduct, event: React.MouseEvent<HTMLButtonElement>) => void;
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
      className="mt-8 grid min-w-0 grid-cols-1 gap-8 rounded-3xl border border-slate-200/80 bg-slate-50/50 p-5 sm:p-7 dark:border-slate-800 dark:bg-slate-900/50"
    >
      {dealProducts.length > 0 && (
        <CuratedRow
          title="عروض حصرية مختارة"
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
