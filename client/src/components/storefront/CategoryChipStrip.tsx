import React, { useCallback, useEffect, useMemo, useRef } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

export function CategoryChipStrip({
  cats,
  selectedId,
  onPick,
}: {
  cats: { id: number; name: string }[];
  selectedId: number | null;
  onPick: (id: number | null) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const set0Ref = useRef<HTMLDivElement | null>(null);
  const set1Ref = useRef<HTMLDivElement | null>(null);
  const offsetRef = useRef(0);
  const targetNudgeRef = useRef(0);
  const isHoveredRef = useRef(false);
  const isFocusedRef = useRef(false);
  const isDraggingRef = useRef(false);
  const isPausedTemporarilyRef = useRef(false);
  const pauseTimerRef = useRef<number | null>(null);
  const dragStartRef = useRef({ x: 0, startOffset: 0, moved: false });

  const allChips = useMemo(
    () => [{ id: null, name: "كل الأقسام" }, ...cats.map((c) => ({ id: c.id, name: c.name }))],
    [cats],
  );

  const repeatCount = useMemo(() => {
    if (allChips.length === 0) return 1;
    if (allChips.length < 6) return 5;
    if (allChips.length < 12) return 4;
    return 3;
  }, [allChips.length]);

  const pauseAutoSlideTemporarily = useCallback((ms = 2200) => {
    isPausedTemporarilyRef.current = true;
    if (pauseTimerRef.current != null) {
      window.clearTimeout(pauseTimerRef.current);
    }
    pauseTimerRef.current = window.setTimeout(() => {
      isPausedTemporarilyRef.current = false;
      pauseTimerRef.current = null;
    }, ms);
  }, []);

  const move = useCallback(
    (direction: -1 | 1) => {
      // 1 = right (RTL previous), -1 = left (RTL next)
      targetNudgeRef.current += direction * 240;
      pauseAutoSlideTemporarily(2500);
    },
    [pauseAutoSlideTemporarily],
  );

  useEffect(() => {
    pauseAutoSlideTemporarily(3500);
  }, [selectedId, pauseAutoSlideTemporarily]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (mediaQuery.matches) return;

    let animId: number;
    let lastTime = performance.now();

    const tick = (now: number) => {
      const dt = Math.min((now - lastTime) / 1000, 0.1);
      lastTime = now;

      let unitWidth = 0;
      if (set0Ref.current && set1Ref.current) {
        unitWidth = Math.abs(set1Ref.current.offsetLeft - set0Ref.current.offsetLeft);
      } else if (set0Ref.current) {
        unitWidth = set0Ref.current.offsetWidth + 8;
      }

      if (unitWidth > 0 && trackRef.current) {
        if (!isDraggingRef.current) {
          if (Math.abs(targetNudgeRef.current) > 0.5) {
            const step = targetNudgeRef.current * Math.min(1, 14 * dt);
            offsetRef.current += step;
            targetNudgeRef.current -= step;
          } else {
            targetNudgeRef.current = 0;
            const isPaused =
              isHoveredRef.current ||
              isFocusedRef.current ||
              isPausedTemporarilyRef.current;
            if (!isPaused) {
              offsetRef.current += 30 * dt;
            }
          }

          while (offsetRef.current >= unitWidth) {
            offsetRef.current -= unitWidth;
          }
          while (offsetRef.current < 0) {
            offsetRef.current += unitWidth;
          }

          trackRef.current.style.transform = `translate3d(${offsetRef.current}px, 0, 0)`;
        }
      }

      animId = window.requestAnimationFrame(tick);
    };

    const onVisibilityChange = () => {
      if (document.hidden) {
        isPausedTemporarilyRef.current = true;
      } else {
        lastTime = performance.now();
        isPausedTemporarilyRef.current = false;
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    animId = window.requestAnimationFrame(tick);
    return () => {
      window.cancelAnimationFrame(animId);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (pauseTimerRef.current != null) {
        window.clearTimeout(pauseTimerRef.current);
      }
    };
  }, []);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    // NOTE: NEVER call setPointerCapture! Let pointerup and click bubble naturally to child buttons.
    isDraggingRef.current = true;
    dragStartRef.current = {
      x: e.clientX,
      startOffset: offsetRef.current,
      moved: false,
    };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDraggingRef.current) return;
    const delta = e.clientX - dragStartRef.current.x;
    if (Math.abs(delta) > 8) {
      dragStartRef.current.moved = true;
      offsetRef.current = dragStartRef.current.startOffset + delta;
      if (trackRef.current) {
        trackRef.current.style.transform = `translate3d(${offsetRef.current}px, 0, 0)`;
      }
    }
  };

  const onPointerUp = () => {
    if (!isDraggingRef.current) return;
    isDraggingRef.current = false;
    pauseAutoSlideTemporarily(1600);
    window.setTimeout(() => {
      dragStartRef.current.moved = false;
    }, 50);
  };

  const onWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (delta !== 0) {
      targetNudgeRef.current -= delta * 0.7;
      pauseAutoSlideTemporarily(2000);
    }
  };

  return (
    <div className="mx-auto flex max-w-[1500px] items-center gap-1.5 sm:gap-2 px-2 sm:px-3 lg:px-6">
      <button
        type="button"
        onClick={() => move(1)}
        aria-label="مرر الأقسام إلى اليمين"
        className="hidden sm:flex size-8 shrink-0 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-700 shadow-sm transition hover:border-[#0E806A] hover:text-[#0E806A] active:scale-95 dark:border-slate-800 dark:bg-slate-800 dark:text-slate-200"
      >
        <ChevronRight aria-hidden className="size-4" />
      </button>

      <div
        ref={containerRef}
        dir="rtl"
        className="relative flex min-w-0 flex-1 cursor-grab items-center overflow-hidden py-2 sm:py-2.5 active:cursor-grabbing select-none [mask-image:linear-gradient(to_right,transparent,black_16px,black_calc(100%-16px),transparent)] sm:[mask-image:linear-gradient(to_right,transparent,black_28px,black_calc(100%-28px),transparent)]"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerEnter={() => {
          isHoveredRef.current = true;
        }}
        onPointerLeave={() => {
          if (!isDraggingRef.current) isHoveredRef.current = false;
        }}
        onFocusCapture={() => {
          isFocusedRef.current = true;
        }}
        onBlurCapture={() => {
          isFocusedRef.current = false;
        }}
        onWheel={onWheel}
        aria-label="شريط أقسام المنتجات"
      >
        <div
          ref={trackRef}
          className="flex shrink-0 items-center gap-1.5 sm:gap-2 will-change-transform"
          style={{ transform: "translate3d(0, 0, 0)" }}
        >
          {Array.from({ length: repeatCount }).map((_, setIndex) => (
            <div
              key={setIndex}
              ref={setIndex === 0 ? set0Ref : setIndex === 1 ? set1Ref : undefined}
              className="flex shrink-0 items-center gap-1.5 sm:gap-2"
              aria-hidden={setIndex > 0 ? "true" : undefined}
            >
              {allChips.map((chip) => {
                const isSelected = chip.id == null ? selectedId == null : selectedId === chip.id;
                const activeClass =
                  chip.id == null
                    ? "border-[#183D36] bg-[#183D36] text-white shadow-xs dark:border-white dark:bg-white dark:text-slate-900"
                    : "border-[#0E806A] bg-[#0E806A] text-white shadow-xs";
                const inactiveClass =
                  "border-slate-200 bg-white text-slate-600 hover:border-slate-400 hover:text-slate-900 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300";

                return (
                  <button
                    type="button"
                    key={`${setIndex}-${chip.id ?? "all"}`}
                    tabIndex={setIndex > 0 ? -1 : 0}
                    data-selected={isSelected}
                    aria-pressed={isSelected}
                    onClick={(e) => {
                      if (dragStartRef.current.moved) {
                        e.preventDefault();
                        return;
                      }
                      pauseAutoSlideTemporarily(3500);
                      onPick(chip.id);
                    }}
                    className={`shrink-0 rounded-full border px-3 sm:px-3.5 py-1 sm:py-1.5 text-xs font-black transition-all duration-200 hover:-translate-y-0.5 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0E806A] ${
                      isSelected ? activeClass : inactiveClass
                    }`}
                  >
                    {chip.name}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      <button
        type="button"
        onClick={() => move(-1)}
        aria-label="مرر الأقسام إلى اليسار"
        className="hidden sm:flex size-8 shrink-0 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-700 shadow-sm transition hover:border-[#0E806A] hover:text-[#0E806A] active:scale-95 dark:border-slate-800 dark:bg-slate-800 dark:text-slate-200"
      >
        <ChevronLeft aria-hidden className="size-4" />
      </button>
    </div>
  );
}
