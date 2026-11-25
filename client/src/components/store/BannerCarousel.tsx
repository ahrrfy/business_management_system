import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Pause, Play } from "lucide-react";
import { BannerFrame, type StoreBannerCreative } from "@/components/store/BannerFrame";

export interface BannerCarouselProps {
  banners: StoreBannerCreative[];
  slot?: "HERO" | "INLINE";
  className?: string;
}

/**
 * كاروسيل البنرات المحسّن بمعايير الاستجابة الحركية (Fluid Touch/Pointer Swipe):
 * - سحب باللمس والمؤشر مع حساب إزاحة وسرعة الإفلات (Velocity Projection) ودعم RTL.
 * - تحميل ذكي للشريحة الحالية والتالية فقط (لا يستنزف الشبكة عند وجود 20 شريحة).
 * - شريط نقاط مضغوط بحد أقصى 7 مؤشرات مرئية حتى لا يفيض على الهواتف مع الشرائح الكثيرة.
 * - ارتفاع متوازن على الشاشات العريضة يبقي الفئات والعروض ظاهرة فوق الطيّ (Above the Fold).
 */
export function BannerCarousel({ banners, slot = "HERO", className = "" }: BannerCarouselProps) {
  const [cur, setCur] = useState(0);
  const [interactionPaused, setInteractionPaused] = useState(false);
  const [autoPlayPaused, setAutoPlayPaused] = useState(false);
  const [dragOffsetPx, setDragOffsetPx] = useState(0);
  const [adaptiveRatio, setAdaptiveRatio] = useState<number | null>(null);

  const gestureRef = useRef<{
    pointerId: number | null;
    startX: number;
    startY: number;
    lastX: number;
    lastTime: number;
    velocityX: number;
    swiping: boolean;
    suppressClick: boolean;
  }>({
    pointerId: null,
    startX: 0,
    startY: 0,
    lastX: 0,
    lastTime: 0,
    velocityX: 0,
    swiping: false,
    suppressClick: false,
  });

  useEffect(() => {
    if (
      banners.length <= 1 ||
      interactionPaused ||
      autoPlayPaused ||
      (typeof window !== "undefined" &&
        typeof window.matchMedia === "function" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches)
    ) {
      return;
    }
    const t = window.setInterval(() => setCur((i) => (i + 1) % banners.length), 5000);
    return () => window.clearInterval(t);
  }, [autoPlayPaused, banners.length, interactionPaused]);

  useEffect(() => {
    setCur((current) => Math.min(current, Math.max(0, banners.length - 1)));
  }, [banners.length]);

  if (banners.length === 0) return null;

  const total = banners.length;
  const active = cur % total;
  const nextIdx = (active + 1) % total;
  const prevIdx = (active - 1 + total) % total;
  const isHero = slot === "HERO";
  // يبدأ بنسبة قياسية (2:1 للبطل و3:1 للشريط) ثم يتكيف تلقائياً عبر onNaturalRatio مع مقاس الاستوديو (2.5:1 لسطح المكتب و2:1 للهاتف)
  const aspect = isHero ? "aspect-[2/1]" : "aspect-[3/1]";

  function goNext() {
    setCur((i) => (i + 1) % total);
  }
  function goPrev() {
    setCur((i) => (i - 1 + total) % total);
  }

  function handlePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (total <= 1 || (e.pointerType === "mouse" && e.button !== 0)) return;
    setInteractionPaused(true);
    gestureRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      lastTime: performance.now(),
      velocityX: 0,
      swiping: false,
      suppressClick: false,
    };
  }

  function handlePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const g = gestureRef.current;
    if (g.pointerId !== e.pointerId) return;
    const dx = e.clientX - g.startX;
    const dy = e.clientY - g.startY;
    if (!g.swiping) {
      if (Math.abs(dx) < 10) return;
      if (Math.abs(dy) > Math.abs(dx)) {
        // تمرير عمودي للصفحة — لا نعترضه ونعيد تفعيل التبديل التلقائي
        g.pointerId = null;
        setInteractionPaused(false);
        return;
      }
      g.swiping = true;
      g.suppressClick = true;
      e.currentTarget.setPointerCapture?.(e.pointerId);
    }
    const now = performance.now();
    const dt = Math.max(now - g.lastTime, 8);
    g.velocityX = (e.clientX - g.lastX) / dt;
    g.lastX = e.clientX;
    g.lastTime = now;
    // مقاومة مطاطية ناعمة (Rubber-band)
    const damped = Math.sign(dx) * Math.min(Math.abs(dx) * 0.42, 72);
    setDragOffsetPx(damped);
  }

  function finishGesture(e: React.PointerEvent<HTMLDivElement>) {
    const g = gestureRef.current;
    if (g.pointerId !== e.pointerId) return;
    const dx = e.clientX - g.startX;
    const projected = dx + g.velocityX * 160;
    g.pointerId = null;
    setDragOffsetPx(0);
    setInteractionPaused(false);
    if (g.swiping && Math.abs(projected) > 48) {
      // في واجهة RTL: السحب لليمين (projected > 0) يتقدم للشريحة التالية، ولليسار يرجع للسابقة
      if (projected > 0) goNext();
      else goPrev();
      setAutoPlayPaused(true);
    }
  }

  // نافذة النقاط المرئية (حتى 7 نقاط كحد أقصى فلا تفيض على الهاتف مع 20 شريحة)
  const maxVisibleDots = 7;
  const windowStart =
    total <= maxVisibleDots
      ? 0
      : Math.min(Math.max(0, active - Math.floor(maxVisibleDots / 2)), total - maxVisibleDots);
  const visibleIndices = Array.from(
    { length: Math.min(total, maxVisibleDots) },
    (_, k) => windowStart + k,
  );

  return (
    <section
      className={`w-full ${isHero ? "flex flex-col justify-center" : "mb-4"} ${className}`}
      aria-roledescription="carousel"
      aria-label={isHero ? "العروض الرئيسية" : "العروض الترويجية بين المنتجات"}
      tabIndex={total > 1 ? 0 : undefined}
      onKeyDown={(e) => {
        if (total <= 1) return;
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          goNext();
          setAutoPlayPaused(true);
        } else if (e.key === "ArrowRight") {
          e.preventDefault();
          goPrev();
          setAutoPlayPaused(true);
        }
      }}
      onMouseEnter={() => setInteractionPaused(true)}
      onMouseLeave={() => setInteractionPaused(false)}
      onFocusCapture={() => setInteractionPaused(true)}
      onBlurCapture={() => setInteractionPaused(false)}
    >
      <div
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishGesture}
        onPointerCancel={finishGesture}
        onClickCapture={(e) => {
          if (gestureRef.current.suppressClick) {
            e.preventDefault();
            e.stopPropagation();
            gestureRef.current.suppressClick = false;
          }
        }}
        className={`group/carousel relative w-full touch-pan-y select-none overflow-hidden rounded-2xl shadow-lg ${
          isHero ? "ring-1 ring-slate-900/10" : "ring-1 ring-black/5"
        } ${adaptiveRatio ? "" : aspect}`}
        style={adaptiveRatio ? { aspectRatio: String(adaptiveRatio) } : undefined}
      >
        <div
          className="relative size-full transition-transform duration-200 ease-out motion-reduce:transition-none"
          style={dragOffsetPx ? { transform: `translate3d(${dragOffsetPx}px, 0, 0)` } : undefined}
        >
          {banners.map((b, i) => {
            const isCurrent = i === active;
            const isNeighbor = i === nextIdx || i === prevIdx;
            if (!isCurrent && !isNeighbor) return null;
            return (
              <div
                key={`${b.id}-${b.imageIndex ?? i}`}
                aria-hidden={!isCurrent}
                inert={!isCurrent}
                className={`absolute inset-0 transition-opacity duration-500 motion-reduce:transition-none ${
                  isCurrent ? "z-10 opacity-100" : "pointer-events-none z-0 opacity-0"
                }`}
              >
                <BannerFrame
                  banner={b}
                  slot={slot}
                  active={isCurrent}
                  preload={isNeighbor}
                  onNaturalRatio={(r) => {
                    if (isCurrent && r >= 1.45 && r <= 3.8) {
                      setAdaptiveRatio(Math.round(r * 100) / 100);
                    }
                  }}
                />
              </div>
            );
          })}
        </div>

        {total > 1 && (
          <>
            <span
              dir="ltr"
              className="pointer-events-none absolute right-3 top-3 z-20 rounded-full border border-white/20 bg-black/55 px-2.5 py-1 text-[10px] font-black text-white shadow-sm backdrop-blur-md tabular-nums"
            >
              {active + 1} / {total}
            </span>

            <button
              type="button"
              onClick={() => {
                goPrev();
                setAutoPlayPaused(true);
              }}
              aria-label="الشريحة السابقة"
              className="absolute right-2.5 top-1/2 z-20 hidden size-9 -translate-y-1/2 items-center justify-center rounded-full border border-white/20 bg-black/45 text-white opacity-0 shadow backdrop-blur-md transition hover:bg-black/65 active:scale-95 sm:flex sm:group-hover/carousel:opacity-100 focus-visible:opacity-100"
            >
              <ChevronRight aria-hidden className="size-4" />
            </button>
            <button
              type="button"
              onClick={() => {
                goNext();
                setAutoPlayPaused(true);
              }}
              aria-label="الشريحة التالية"
              className="absolute left-2.5 top-1/2 z-20 hidden size-9 -translate-y-1/2 items-center justify-center rounded-full border border-white/20 bg-black/45 text-white opacity-0 shadow backdrop-blur-md transition hover:bg-black/65 active:scale-95 sm:flex sm:group-hover/carousel:opacity-100 focus-visible:opacity-100"
            >
              <ChevronLeft aria-hidden className="size-4" />
            </button>
          </>
        )}
      </div>

      {total > 1 && (
        <div className="mt-2.5 flex items-center justify-center gap-1.5" aria-label="اختيار البنر">
          <button
            type="button"
            onClick={() => setAutoPlayPaused((value) => !value)}
            aria-label={autoPlayPaused ? "تشغيل تبديل البنرات تلقائياً" : "إيقاف تبديل البنرات تلقائياً"}
            aria-pressed={autoPlayPaused}
            className="flex size-7 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-700 shadow-2xs transition hover:bg-slate-50 active:scale-95"
          >
            {autoPlayPaused ? <Play aria-hidden className="size-3" /> : <Pause aria-hidden className="size-3" />}
          </button>

          <div className="flex items-center gap-1.5 rounded-full border border-slate-200/80 bg-white/90 px-2.5 py-1.5 shadow-2xs backdrop-blur-xs">
            {visibleIndices.map((idx) => {
              const isEdge =
                total > maxVisibleDots &&
                ((idx === windowStart && windowStart > 0) ||
                  (idx === windowStart + maxVisibleDots - 1 && windowStart + maxVisibleDots < total));
              return (
                <button
                  type="button"
                  key={`${banners[idx]!.id}-${banners[idx]!.imageIndex ?? idx}`}
                  onClick={() => {
                    setCur(idx);
                    setAutoPlayPaused(true);
                  }}
                  aria-current={idx === active ? "true" : undefined}
                  aria-label={`الانتقال للبنر ${idx + 1}`}
                  className={`rounded-full transition-all duration-300 motion-reduce:transition-none ${
                    idx === active
                      ? "h-2 w-6 bg-[var(--store-brand)]"
                      : isEdge
                        ? "size-1.5 bg-slate-300"
                        : "size-2 bg-slate-300 hover:bg-slate-400"
                  }`}
                />
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}

export default BannerCarousel;
