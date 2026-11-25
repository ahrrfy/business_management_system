import React, { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpLeft, LayoutGrid, Pause, Play } from "lucide-react";

interface StorefrontCategoryItem {
  id: number;
  name: string;
  productCount?: number;
  availableCount?: number;
}

interface StorefrontCategoriesProps<TCat extends StorefrontCategoryItem = StorefrontCategoryItem> {
  categories: TCat[];
  selectedId: number | null;
  onSelectCategory: (id: number | null) => void;
  categoryCountFn: (cat: TCat) => number;
  className?: string;
  id?: string;
}

/**
 * لوحة ألوان بطاقات الأقسام المتناغمة مع هوية Apple المعتمدة في المتجر:
 * تدرجات باستيل هادئة عالية التباين (WCAG AA) مع نص داكن #1d1d1f وشارة عدد متناغمة.
 */
const APPLE_CATEGORY_TINTS = [
  {
    bg: "bg-[#eef5ff] hover:bg-[#e3eeff] dark:bg-sky-950/35",
    border: "border-[#cfe2ff] hover:border-[#9dc3ff] dark:border-sky-800/60",
    pillBg: "bg-[#0066cc]/12 text-[#0055b3] dark:bg-sky-400/15 dark:text-sky-300",
    accentDot: "bg-[#0066cc]",
  },
  {
    bg: "bg-[#edfbf5] hover:bg-[#def7ec] dark:bg-emerald-950/35",
    border: "border-[#c3f0dc] hover:border-[#8ee2bd] dark:border-emerald-800/60",
    pillBg: "bg-[#0d8a5f]/12 text-[#0a6e4b] dark:bg-emerald-400/15 dark:text-emerald-300",
    accentDot: "bg-[#0d8a5f]",
  },
  {
    bg: "bg-[#fff7eb] hover:bg-[#ffefd6] dark:bg-amber-950/35",
    border: "border-[#fde2b8] hover:border-[#f9c97d] dark:border-amber-800/60",
    pillBg: "bg-[#b85d00]/12 text-[#944a00] dark:bg-amber-400/15 dark:text-amber-300",
    accentDot: "bg-[#c76a00]",
  },
  {
    bg: "bg-[#f3f1ff] hover:bg-[#e9e5ff] dark:bg-indigo-950/35",
    border: "border-[#dcd6ff] hover:border-[#b9adff] dark:border-indigo-800/60",
    pillBg: "bg-[#5856d6]/12 text-[#4341b5] dark:bg-indigo-400/15 dark:text-indigo-300",
    accentDot: "bg-[#5856d6]",
  },
  {
    bg: "bg-[#fff1f2] hover:bg-[#ffe4e7] dark:bg-rose-950/35",
    border: "border-[#fecdd3] hover:border-[#fda4af] dark:border-rose-800/60",
    pillBg: "bg-[#c83243]/12 text-[#a62332] dark:bg-rose-400/15 dark:text-rose-300",
    accentDot: "bg-[#d93848]",
  },
  {
    bg: "bg-[#edfafd] hover:bg-[#ddf4fa] dark:bg-cyan-950/35",
    border: "border-[#bfeaf5] hover:border-[#8cd8ec] dark:border-cyan-800/60",
    pillBg: "bg-[#007a94]/12 text-[#006177] dark:bg-cyan-400/15 dark:text-cyan-300",
    accentDot: "bg-[#008299]",
  },
  {
    bg: "bg-[#fbf2ff] hover:bg-[#f5e4ff] dark:bg-purple-950/35",
    border: "border-[#eed2ff] hover:border-[#dcabff] dark:border-purple-800/60",
    pillBg: "bg-[#8e2aa8]/12 text-[#711e87] dark:bg-purple-400/15 dark:text-purple-300",
    accentDot: "bg-[#9b30b6]",
  },
  {
    bg: "bg-[#f5f5f7] hover:bg-[#ebebef] dark:bg-slate-800/60",
    border: "border-slate-900/[0.09] hover:border-slate-900/20 dark:border-slate-700",
    pillBg: "bg-slate-900/[0.08] text-[#1d1d1f] dark:bg-white/10 dark:text-slate-200",
    accentDot: "bg-[#1d1d1f]",
  },
] as const;

interface MarqueeRowProps {
  items: Array<{ cat: StorefrontCategoryItem; count: number; tintIdx: number }>;
  direction: 1 | -1;
  speedPxPerSec: number;
  paused: boolean;
  selectedId: number | null;
  onSelectCategory: (id: number) => void;
}

function CategoryMarqueeRow({
  items,
  direction,
  speedPxPerSec,
  paused,
  selectedId,
  onSelectCategory,
}: MarqueeRowProps) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const seg0Ref = useRef<HTMLDivElement | null>(null);
  const seg1Ref = useRef<HTMLDivElement | null>(null);
  const offsetRef = useRef(0);
  const velocityFactorRef = useRef(1);
  const isHoveredRef = useRef(false);
  const isFocusedRef = useRef(false);
  const dragRef = useRef({
    active: false,
    pointerId: -1,
    startX: 0,
    startOffset: 0,
    moved: false,
  });

  const repeatCount = items.length < 5 ? 4 : items.length < 9 ? 3 : 2;

  useEffect(() => {
    if (typeof window === "undefined" || items.length === 0) return;
    const reduceMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduceMotion) return;

    let rafId = 0;
    let lastTime = performance.now();

    const tick = (now: number) => {
      const dt = Math.min((now - lastTime) / 1000, 0.064);
      lastTime = now;

      let unitWidth = 0;
      if (seg0Ref.current && seg1Ref.current) {
        unitWidth = Math.abs(seg1Ref.current.offsetLeft - seg0Ref.current.offsetLeft);
      } else if (seg0Ref.current) {
        unitWidth = seg0Ref.current.offsetWidth + 10;
      }

      if (unitWidth > 0 && trackRef.current && !dragRef.current.active) {
        const shouldPause =
          paused || isHoveredRef.current || isFocusedRef.current || document.hidden;
        const targetFactor = shouldPause ? 0 : 1;
        velocityFactorRef.current +=
          (targetFactor - velocityFactorRef.current) * Math.min(1, dt * 8);

        if (velocityFactorRef.current > 0.004) {
          offsetRef.current += direction * speedPxPerSec * velocityFactorRef.current * dt;
        }

        while (offsetRef.current >= unitWidth) offsetRef.current -= unitWidth;
        while (offsetRef.current < 0) offsetRef.current += unitWidth;

        trackRef.current.style.transform = `translate3d(${offsetRef.current.toFixed(2)}px, 0, 0)`;
      }

      rafId = window.requestAnimationFrame(tick);
    };

    rafId = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(rafId);
  }, [direction, items.length, paused, speedPxPerSec]);

  return (
    <div
      className="relative overflow-hidden py-0.5 mask-gradient-x"
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
      onPointerDown={(e) => {
        if (e.pointerType === "mouse" && e.button !== 0) return;
        dragRef.current = {
          active: true,
          pointerId: e.pointerId,
          startX: e.clientX,
          startOffset: offsetRef.current,
          moved: false,
        };
      }}
      onPointerMove={(e) => {
        if (!dragRef.current.active || dragRef.current.pointerId !== e.pointerId) return;
        const dx = e.clientX - dragRef.current.startX;
        if (Math.abs(dx) > 6 && !dragRef.current.moved) {
          dragRef.current.moved = true;
          e.currentTarget.setPointerCapture?.(e.pointerId);
        }
        if (dragRef.current.moved && trackRef.current) {
          let unitWidth = 0;
          if (seg0Ref.current && seg1Ref.current) {
            unitWidth = Math.abs(seg1Ref.current.offsetLeft - seg0Ref.current.offsetLeft);
          }
          let next = dragRef.current.startOffset + dx;
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
      onClickCapture={(e) => {
        if (dragRef.current.moved) {
          e.preventDefault();
          e.stopPropagation();
          dragRef.current.moved = false;
        }
      }}
    >
      <div
        ref={trackRef}
        className="flex w-max items-stretch gap-2.5 select-none will-change-transform motion-reduce:!transform-none motion-reduce:flex-wrap"
      >
        {Array.from({ length: repeatCount }).map((_, copyIdx) => (
          <div
            key={copyIdx}
            ref={copyIdx === 0 ? seg0Ref : copyIdx === 1 ? seg1Ref : undefined}
            aria-hidden={copyIdx > 0 || undefined}
            className="flex items-stretch gap-2.5 shrink-0"
          >
            {items.map(({ cat, count, tintIdx }) => {
              const isSelected = selectedId === cat.id;
              const tint = APPLE_CATEGORY_TINTS[tintIdx % APPLE_CATEGORY_TINTS.length]!;
              return (
                <button
                  key={`${copyIdx}-${cat.id}`}
                  type="button"
                  tabIndex={copyIdx === 0 ? 0 : -1}
                  aria-pressed={copyIdx === 0 ? isSelected : undefined}
                  onClick={() => onSelectCategory(cat.id)}
                  className={`group flex min-h-[4.6rem] w-[178px] sm:w-[208px] shrink-0 touch-manipulation flex-col justify-between rounded-2xl border p-3.5 text-right transition-transform duration-200 ease-out hover:-translate-y-0.5 active:scale-[0.97] ${
                    isSelected
                      ? "border-[#1d1d1f] bg-[#1d1d1f] text-white shadow-md dark:border-white dark:bg-white dark:text-[#1d1d1f]"
                      : `${tint.bg} ${tint.border} text-[#1d1d1f] shadow-[inset_0_1px_0_rgba(255,255,255,0.75)] dark:text-slate-100`
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="line-clamp-1 text-xs sm:text-[13px] font-bold leading-snug tracking-tight">
                      {cat.name}
                    </span>
                    <ArrowUpLeft
                      aria-hidden
                      className={`size-3.5 shrink-0 transition-transform duration-200 group-hover:-translate-x-0.5 group-hover:-translate-y-0.5 ${
                        isSelected ? "text-white/80 dark:text-[#1d1d1f]/70" : "text-slate-400"
                      }`}
                    />
                  </div>
                  <div className="mt-2 flex items-center justify-between gap-1.5">
                    <span
                      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-bold tabular-nums ${
                        isSelected
                          ? "bg-white/15 text-white dark:bg-black/10 dark:text-[#1d1d1f]"
                          : tint.pillBg
                      }`}
                    >
                      <span
                        aria-hidden
                        className={`size-1.5 rounded-full ${
                          isSelected ? "bg-white dark:bg-[#1d1d1f]" : tint.accentDot
                        }`}
                      />
                      {count > 0 ? `${count} منتج متوفر` : "تصفح القسم"}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

export function StorefrontCategories<TCat extends StorefrontCategoryItem = StorefrontCategoryItem>({
  categories,
  selectedId,
  onSelectCategory,
  categoryCountFn,
  className = "",
  id = "store-categories",
}: StorefrontCategoriesProps<TCat>) {
  const [gridExpanded, setGridExpanded] = useState(false);
  const [paused, setPaused] = useState(false);

  const enriched = useMemo(() => {
    const all = categories.map((cat, idx) => ({
      cat,
      count: categoryCountFn(cat),
      tintIdx: idx,
    }));
    const inStockOnly = all.filter((item) => item.count > 0 || item.cat.id === selectedId);
    return (inStockOnly.length > 0 ? inStockOnly : all).map((item, idx) => ({
      ...item,
      tintIdx: idx,
    }));
  }, [categories, categoryCountFn, selectedId]);

  if (enriched.length === 0) return null;

  const midpoint = Math.ceil(enriched.length / 2);
  const rowOne = enriched.slice(0, midpoint);
  const rowTwo = enriched.slice(midpoint);

  return (
    <section
      id={id}
      aria-labelledby="store-category-title"
      className={`overflow-hidden rounded-2xl sm:rounded-3xl border border-slate-900/[0.08] bg-white p-4 sm:p-6 shadow-2xs dark:border-slate-800 dark:bg-slate-900 ${className}`}
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div>
          <span className="text-[11px] font-semibold tracking-tight text-[#6e6e73] dark:text-slate-400">
            تصفح حسب اهتمامك
          </span>
          <h2
            id="store-category-title"
            className="store-display-title mt-0.5 text-lg sm:text-2xl font-bold text-[#1d1d1f] dark:text-slate-100"
          >
            الأقسام الرئيسية
          </h2>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {selectedId != null && (
            <button
              type="button"
              onClick={() => onSelectCategory(null)}
              className="touch-manipulation rounded-full bg-[#1d1d1f] px-3.5 py-1.5 text-xs font-bold text-white transition-transform duration-150 hover:opacity-90 active:scale-[0.97] dark:bg-white dark:text-[#1d1d1f]"
            >
              عرض كل الأقسام
            </button>
          )}
          {!gridExpanded && rowTwo.length > 0 && (
            <button
              type="button"
              onClick={() => setPaused((p) => !p)}
              aria-label={paused ? "تشغيل حركة الأقسام" : "إيقاف حركة الأقسام"}
              title={paused ? "تشغيل الحركة" : "إيقاف الحركة"}
              className="flex size-8 touch-manipulation items-center justify-center rounded-full border border-slate-900/10 bg-[#f5f5f7] text-[#1d1d1f] transition-transform duration-150 hover:bg-slate-200/70 active:scale-95 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
            >
              {paused ? <Play aria-hidden className="size-3.5" /> : <Pause aria-hidden className="size-3.5" />}
            </button>
          )}
          <button
            type="button"
            onClick={() => setGridExpanded((prev) => !prev)}
            className="inline-flex touch-manipulation items-center gap-1.5 rounded-full border border-slate-900/10 bg-[#f5f5f7] px-3 py-1.5 text-xs font-semibold text-[#1d1d1f] transition-transform duration-150 hover:bg-slate-200/70 active:scale-[0.97] dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
          >
            <LayoutGrid aria-hidden className="size-3.5" />
            <span>{gridExpanded ? "العرض المتحرك" : `كل الأقسام (${enriched.length})`}</span>
          </button>
        </div>
      </div>

      {gridExpanded || rowTwo.length === 0 ? (
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
          {enriched.map(({ cat, count, tintIdx }) => {
            const isSelected = selectedId === cat.id;
            const tint = APPLE_CATEGORY_TINTS[tintIdx % APPLE_CATEGORY_TINTS.length]!;
            return (
              <button
                key={cat.id}
                type="button"
                onClick={() => onSelectCategory(cat.id)}
                aria-pressed={isSelected}
                className={`group flex min-h-[4.6rem] touch-manipulation flex-col justify-between rounded-2xl border p-3.5 text-right transition-transform duration-150 ease-out hover:-translate-y-0.5 active:scale-[0.98] ${
                  isSelected
                    ? "border-[#1d1d1f] bg-[#1d1d1f] text-white shadow-sm dark:border-white dark:bg-white dark:text-[#1d1d1f]"
                    : `${tint.bg} ${tint.border} text-[#1d1d1f] dark:text-slate-100`
                }`}
              >
                <span className="line-clamp-2 text-xs sm:text-[13px] font-bold leading-snug">
                  {cat.name}
                </span>
                {count > 0 && (
                  <span
                    className={`mt-2 inline-flex w-fit items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold tabular-nums ${
                      isSelected
                        ? "bg-white/15 text-white dark:bg-black/10 dark:text-[#1d1d1f]"
                        : tint.pillBg
                    }`}
                  >
                    <span
                      aria-hidden
                      className={`size-1.5 rounded-full ${
                        isSelected ? "bg-white dark:bg-[#1d1d1f]" : tint.accentDot
                      }`}
                    />
                    {count} منتج
                  </span>
                )}
              </button>
            );
          })}
        </div>
      ) : (
        <div className="space-y-2.5">
          <CategoryMarqueeRow
            items={rowOne}
            direction={1}
            speedPxPerSec={25}
            paused={paused}
            selectedId={selectedId}
            onSelectCategory={(cid) => onSelectCategory(cid)}
          />
          <CategoryMarqueeRow
            items={rowTwo}
            direction={-1}
            speedPxPerSec={25}
            paused={paused}
            selectedId={selectedId}
            onSelectCategory={(cid) => onSelectCategory(cid)}
          />
        </div>
      )}
    </section>
  );
}
