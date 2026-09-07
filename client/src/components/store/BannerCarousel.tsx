import { useState, useEffect } from "react";
import { Play, Pause } from "lucide-react";
import { BannerFrame, type StoreBannerCreative } from "@/components/store/BannerFrame";

export interface BannerCarouselProps {
  banners: StoreBannerCreative[];
  slot?: "HERO" | "INLINE";
  className?: string;
}

export function BannerCarousel({ banners, slot = "HERO", className = "" }: BannerCarouselProps) {
  const [cur, setCur] = useState(0);
  const [interactionPaused, setInteractionPaused] = useState(false);
  const [autoPlayPaused, setAutoPlayPaused] = useState(false);

  useEffect(() => {
    if (
      banners.length <= 1 ||
      interactionPaused ||
      autoPlayPaused ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      return;
    const t = setInterval(() => setCur((i) => (i + 1) % banners.length), 4500);
    return () => clearInterval(t);
  }, [autoPlayPaused, banners.length, interactionPaused]);

  useEffect(() => {
    setCur((current) => Math.min(current, Math.max(0, banners.length - 1)));
  }, [banners.length]);

  if (banners.length === 0) return null;

  const active = cur % banners.length;
  const isHero = slot === "HERO";
  const aspect = isHero ? "aspect-[2/1]" : "aspect-[3.2/1]";

  return (
    <section
      className={`w-full ${isHero ? "flex flex-col justify-center" : "mb-4"} ${className}`}
      aria-roledescription="carousel"
      aria-label={isHero ? "العروض الرئيسية" : "العروض الترويجية بين المنتجات"}
      onMouseEnter={() => setInteractionPaused(true)}
      onMouseLeave={() => setInteractionPaused(false)}
      onFocusCapture={() => setInteractionPaused(true)}
      onBlurCapture={() => setInteractionPaused(false)}
      onPointerDown={() => setInteractionPaused(true)}
    >
      <div
        className={`relative w-full overflow-hidden rounded-2xl shadow-xl ${
          isHero ? "ring-1 ring-white/10" : "ring-1 ring-black/5"
        } ${aspect}`}
      >
        {banners.map((b, i) => (
          <div
            key={`${b.id}-${b.imageIndex ?? 0}`}
            aria-hidden={i !== active}
            inert={i !== active}
            className={`absolute inset-0 transition-opacity duration-700 motion-reduce:transition-none ${
              i === active ? "opacity-100" : "pointer-events-none opacity-0"
            }`}
          >
            <BannerFrame banner={b} slot={slot} active={i === active} />
          </div>
        ))}
        {banners.length > 1 && (
          <span
            className={`absolute right-3 top-3 rounded-full px-2.5 py-1 text-[10px] font-black shadow-sm ${
              isHero
                ? "bg-black/60 text-white border border-white/10 backdrop-blur-md"
                : "bg-[#183d36]/85 text-white"
            }`}
          >
            {active + 1} / {banners.length}
          </span>
        )}
      </div>

      {banners.length > 1 && (
        <div className="mt-3 flex items-center justify-center gap-2" aria-label="اختيار البنر">
          <button
            type="button"
            onClick={() => setAutoPlayPaused((value) => !value)}
            aria-label={autoPlayPaused ? "تشغيل تبديل البنرات تلقائياً" : "إيقاف تبديل البنرات تلقائياً"}
            aria-pressed={autoPlayPaused}
            className={`flex items-center justify-center rounded-full border transition active:scale-95 ${
              isHero
                ? "size-7 border-white/15 bg-white/10 text-white/90 backdrop-blur-md hover:bg-white/20"
                : "size-9 border-[#d7d2ca] bg-white text-[#1e4a63] hover:bg-stone-50"
            }`}
          >
            {autoPlayPaused ? <Play aria-hidden className="size-3.5" /> : <Pause aria-hidden className="size-3.5" />}
          </button>
          {banners.map((b, i) => (
            <button
              type="button"
              key={`${b.id}-${b.imageIndex ?? 0}`}
              onClick={() => {
                setCur(i);
                setAutoPlayPaused(true);
              }}
              aria-current={i === active ? "true" : undefined}
              aria-label={`الانتقال للبنر ${i + 1}`}
              className={`transition-all duration-300 motion-reduce:transition-none ${
                isHero
                  ? i === active
                    ? "h-2 w-7 rounded-full bg-amber-400 shadow-sm shadow-amber-400/50"
                    : "h-2 w-2 rounded-full bg-white/25 hover:bg-white/40"
                  : i === active
                    ? "size-5 rounded-full bg-[var(--store-accent)]"
                    : "size-5 rounded-full bg-[#f3b85a]/60 hover:bg-[var(--store-accent)]"
              }`}
            />
          ))}
        </div>
      )}
    </section>
  );
}

export default BannerCarousel;
