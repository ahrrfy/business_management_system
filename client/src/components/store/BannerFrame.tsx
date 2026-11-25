import { useEffect, useRef, useState } from "react";
import { trpc } from "@/lib/trpc";

export type StoreBannerCreative = {
  id: number;
  imageIndex?: number;
  title: string;
  subtitle?: string | null;
  imageUrl?: string | null;
  mobileImageUrl?: string | null;
  ctaLabel?: string | null;
  ctaUrl?: string | null;
  placement?: "HERO" | "SIDE" | "INLINE";
  renderMode?: "SMART_CROP" | "PRESERVE_FULL" | "LAYERED";
  focusX?: number;
  focusY?: number;
};

type Slot = "HERO" | "SIDE" | "INLINE";

export const STOREFRONT_BANNER_NAVIGATE_EVENT = "storefront:banner-navigate";

export function dispatchStorefrontBannerNavigate(url: string): boolean {
  if (typeof window === "undefined") return false;
  const event = new CustomEvent<{ url: string; handled: boolean }>(
    STOREFRONT_BANNER_NAVIGATE_EVENT,
    {
      detail: { url, handled: false },
      cancelable: true,
    },
  );
  window.dispatchEvent(event);
  return event.detail.handled;
}

/**
 * إطار موحد للبنر:
 * - PRESERVE_FULL يحفظ التصميم كاملاً مع خلفية ضبابية مشتقة ناعمة (بدل البياض الحادّ المعزول).
 * - SMART_CROP / LAYERED يملآن الإطار مع نقطة تركيز.
 * - يدعم التحميل الكسول للشرائح غير النشطة والتنقل الفوري SPA داخل المتجر.
 */
export function BannerFrame({
  banner,
  slot,
  active = true,
  preload = false,
  preview = false,
  onNaturalRatio,
}: {
  banner: StoreBannerCreative;
  slot: Slot;
  active?: boolean;
  preload?: boolean;
  preview?: boolean;
  onNaturalRatio?: (ratio: number) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [naturalRatio, setNaturalRatio] = useState<number | null>(null);
  const track = trpc.storefront.trackBanner.useMutation();
  const metricPlacement = banner.placement ?? slot;
  const mode = banner.renderMode ?? "PRESERVE_FULL";
  const focus = `${Math.min(100, Math.max(0, banner.focusX ?? 50))}% ${Math.min(100, Math.max(0, banner.focusY ?? 50))}%`;
  const slideKey = banner.imageIndex ?? 0;
  const key = `store-banner-impression:${banner.id}:${slideKey}:${metricPlacement}:${new Date().toISOString().slice(0, 10)}`;

  useEffect(() => {
    if (preview || !active || banner.id <= 0 || !ref.current || sessionStorage.getItem(key)) return;
    const node = ref.current;
    let timer: number | undefined;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting || entry.intersectionRatio < 0.5) {
          if (timer) window.clearTimeout(timer);
          timer = undefined;
          return;
        }
        timer = window.setTimeout(() => {
          if (!sessionStorage.getItem(key)) {
            sessionStorage.setItem(key, "1");
            track.mutate({ bannerId: banner.id, placement: metricPlacement, event: "IMPRESSION" });
          }
        }, 1000);
      },
      { threshold: [0.5] },
    );
    observer.observe(node);
    return () => {
      observer.disconnect();
      if (timer) window.clearTimeout(timer);
    };
  }, [active, banner.id, key, metricPlacement, preview, track]);

  const source = banner.imageUrl;
  const shouldEagerLoad = active || preload;
  const isPrimaryHeroLcp = slot === "HERO" && active && !preload && !preview;

  function reportDimensions(el: HTMLImageElement | null) {
    if (!el || !el.naturalWidth || !el.naturalHeight) return;
    const r = el.naturalWidth / el.naturalHeight;
    if (!Number.isFinite(r) || r <= 0) return;
    setNaturalRatio(r);
    if (active) onNaturalRatio?.(r);
  }

  useEffect(() => {
    if (active && imgRef.current?.complete) {
      reportDimensions(imgRef.current);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, source, banner.mobileImageUrl]);

  const isExtremePortraitOrSquare = naturalRatio != null && naturalRatio < 1.45;

  const media = source ? (
    mode === "PRESERVE_FULL" && isExtremePortraitOrSquare ? (
      <div className="absolute inset-0 overflow-hidden bg-slate-950">
        <img
          src={source}
          alt=""
          aria-hidden="true"
          loading={shouldEagerLoad ? "eager" : "lazy"}
          decoding="async"
          className="pointer-events-none absolute inset-0 size-full scale-125 object-cover opacity-80 blur-3xl saturate-125"
        />
        <picture className="relative z-10 flex size-full items-center justify-center">
          {banner.mobileImageUrl && <source media="(max-width: 639px)" srcSet={banner.mobileImageUrl} />}
          <img
            ref={imgRef}
            src={source}
            alt={banner.title}
            onLoad={(e) => reportDimensions(e.currentTarget)}
            loading={shouldEagerLoad ? "eager" : "lazy"}
            fetchPriority={isPrimaryHeroLcp ? "high" : "auto"}
            decoding={active ? "sync" : "async"}
            draggable={false}
            className="size-full select-none object-contain"
            style={{ objectPosition: focus }}
          />
        </picture>
      </div>
    ) : (
      <picture
        className={`absolute inset-0 block size-full ${
          mode === "PRESERVE_FULL" ? "bg-white" : ""
        }`}
      >
        {banner.mobileImageUrl && <source media="(max-width: 639px)" srcSet={banner.mobileImageUrl} />}
        <img
          ref={imgRef}
          src={source}
          alt={banner.title}
          onLoad={(e) => reportDimensions(e.currentTarget)}
          loading={shouldEagerLoad ? "eager" : "lazy"}
          fetchPriority={isPrimaryHeroLcp ? "high" : "auto"}
          decoding={active ? "sync" : "async"}
          draggable={false}
          className={`size-full select-none ${
            mode === "PRESERVE_FULL" ? "object-contain" : "object-cover"
          }`}
          style={{ objectPosition: focus }}
        />
      </picture>
    )
  ) : (
    <div
      className={`absolute inset-0 ${
        slot === "HERO"
          ? "bg-gradient-to-br from-[#0f172a] via-[#172554] to-[#1e3a8a]"
          : "bg-gradient-to-l from-[#0f172a] via-[#1e293b] to-[#334155]"
      }`}
    />
  );

  const showCopy = mode !== "PRESERVE_FULL" || !source;
  const content = (
    <>
      {media}
      {showCopy && (
        <div className="relative z-20 flex size-full flex-col justify-end bg-gradient-to-t from-black/75 via-black/25 to-transparent p-4 text-white sm:p-6">
          <p className="text-base font-extrabold leading-tight sm:text-2xl">{banner.title}</p>
          {banner.subtitle && (
            <p className="mt-1 max-w-[90%] text-xs text-white/90 sm:text-sm">{banner.subtitle}</p>
          )}
          {banner.ctaLabel && (
            <span className="mt-2.5 inline-flex w-fit items-center gap-1.5 rounded-full bg-white px-4 py-1.5 text-xs font-bold text-[#1d1d1f] shadow">
              {banner.ctaLabel}
            </span>
          )}
        </div>
      )}
      {!showCopy && banner.ctaLabel && (
        <span className="absolute bottom-3 left-3 z-20 rounded-full bg-white/95 px-3.5 py-1.5 text-xs font-bold text-[#1d1d1f] shadow-md backdrop-blur-xs transition-transform group-hover:scale-105">
          {banner.ctaLabel}
        </span>
      )}
    </>
  );

  function handleLinkClick(e: React.MouseEvent<HTMLAnchorElement>) {
    if (preview) {
      e.preventDefault();
      return;
    }
    if (banner.id > 0) {
      track.mutate({ bannerId: banner.id, placement: metricPlacement, event: "CLICK" });
    }
    if (
      banner.ctaUrl &&
      e.button === 0 &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.shiftKey &&
      !e.altKey
    ) {
      const handled = dispatchStorefrontBannerNavigate(banner.ctaUrl);
      if (handled) e.preventDefault();
    }
  }

  return (
    <div ref={ref} className="group relative size-full overflow-hidden">
      {banner.ctaUrl ? (
        <a href={banner.ctaUrl} className="block size-full" onClick={handleLinkClick}>
          {content}
        </a>
      ) : (
        content
      )}
    </div>
  );
}

/** طبقة الصورة فقط لاستعمالها داخل أغلفة قديمة تتولى النص أو التنقل بنفسها. */
export function BannerMedia({ banner }: { banner: StoreBannerCreative }) {
  const source = banner.imageUrl;
  const mode = banner.renderMode ?? "PRESERVE_FULL";
  const focus = `${Math.min(100, Math.max(0, banner.focusX ?? 50))}% ${Math.min(100, Math.max(0, banner.focusY ?? 50))}%`;
  if (!source) return <div className="absolute inset-0 bg-[#f5f5f7]" />;
  if (mode === "PRESERVE_FULL") {
    return (
      <picture className="absolute inset-0 flex items-center justify-center bg-slate-900">
        {banner.mobileImageUrl && <source media="(max-width: 639px)" srcSet={banner.mobileImageUrl} />}
        <img
          src={source}
          alt={banner.title}
          className="size-full object-contain"
          style={{ objectPosition: focus }}
        />
      </picture>
    );
  }
  return (
    <picture className="absolute inset-0">
      {banner.mobileImageUrl && <source media="(max-width: 639px)" srcSet={banner.mobileImageUrl} />}
      <img
        src={source}
        alt={banner.title}
        className="size-full object-cover"
        style={{ objectPosition: focus }}
      />
    </picture>
  );
}
