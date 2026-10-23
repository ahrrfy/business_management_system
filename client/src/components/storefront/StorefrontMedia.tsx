import * as DialogPrimitive from "@radix-ui/react-dialog";
import { ArrowRight, Package, X } from "lucide-react";
import React, { useEffect, useMemo, useRef, useState } from "react";

export function ProductImage({
  url,
  alt,
  className,
  showFallbackLabel = false,
}: {
  url: string | null;
  alt: string;
  className?: string;
  /** The catalogue grid has room to explain an absent image; compact rows do not. */
  showFallbackLabel?: boolean;
}) {
  if (!url) {
    return (
      <div
        className={`store-product-image-placeholder flex flex-col items-center justify-center gap-2 bg-gradient-to-br from-slate-50 to-blue-50/40 text-slate-400 dark:from-slate-900 dark:to-slate-800 ${className ?? ""}`}
        role="img"
        aria-label={`منتج قرطاسية: ${alt}`}
      >
        <Package
          aria-hidden
          className="size-8 text-slate-300 dark:text-slate-600"
        />
        <span className="text-[10px] font-bold text-slate-400 dark:text-slate-500">
          المكتبة العربية
        </span>
      </div>
    );
  }
  return (
    <img
      src={url}
      alt={alt}
      loading="lazy"
      decoding="async"
      className={`store-product-image object-contain ${className ?? ""}`}
    />
  );
}

export function storefrontMediaUrls(
  urls: string[] | undefined,
  fallbackUrl: string | null,
  limit = 8,
): string[] {
  return Array.from(
    new Set(
      [...(urls ?? []), fallbackUrl].filter((url): url is string =>
        Boolean(url),
      ),
    ),
  ).slice(0, limit);
}

export type StorefrontVariantMediaSource = {
  imageUrl: string | null;
  imageUrls?: string[];
  variants?: Array<{
    variantId: number;
    imageUrl: string | null;
    imageUrls?: string[];
  }>;
};

export function storefrontVariantMedia(
  product: StorefrontVariantMediaSource,
  selectedVariantId: number | null | undefined,
): { urls: string[] | undefined; fallbackUrl: string | null } {
  const variant = product.variants?.find(
    (candidate) => candidate.variantId === selectedVariantId,
  );
  return {
    urls: variant?.imageUrls?.length ? variant.imageUrls : product.imageUrls,
    fallbackUrl: variant?.imageUrl ?? product.imageUrl,
  };
}

export function clampStorefrontZoomPoint(
  point: { x: number; y: number },
  width: number,
  height: number,
  lensSize = 256,
): { x: number; y: number } {
  const edgeX = Math.min(50, (lensSize / Math.max(1, width)) * 50);
  const edgeY = Math.min(50, (lensSize / Math.max(1, height)) * 50);
  return {
    x: Math.max(edgeX, Math.min(100 - edgeX, point.x)),
    y: Math.max(edgeY, Math.min(100 - edgeY, point.y)),
  };
}

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(media.matches);
    update();
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, []);
  return reduced;
}

export function CardMediaCarousel({
  urls,
  fallbackUrl,
  alt,
  className,
  showFallbackLabel = false,
}: {
  urls?: string[];
  fallbackUrl: string | null;
  alt: string;
  className?: string;
  showFallbackLabel?: boolean;
}) {
  const sources = useMemo(
    () => storefrontMediaUrls(urls, fallbackUrl),
    [urls, fallbackUrl],
  );
  const reducedMotion = usePrefersReducedMotion();
  const [index, setIndex] = useState(0);
  const [active, setActive] = useState(false);
  // عند تبدّل المصادر نبدأ من الصورة الرئيسية، لا من فهرسٍ يعود لمعرض سابق.
  useEffect(() => setIndex(0), [sources.join("|")]);
  useEffect(() => {
    if (sources.length < 2 || !active || reducedMotion) return;
    const timer = window.setInterval(
      () => setIndex((current) => (current + 1) % sources.length),
      1500,
    );
    return () => window.clearInterval(timer);
  }, [active, reducedMotion, sources.length]);
  const activate = () => {
    if (!reducedMotion) setActive(true);
  };
  const current = sources[index] ?? null;
  return (
    <div
      className={`group relative overflow-hidden bg-white ${className ?? ""}`}
      role="img"
      onPointerEnter={(event) => {
        if (event.pointerType === "mouse") activate();
      }}
      onPointerLeave={() => setActive(false)}
      onFocus={activate}
      onBlur={() => setActive(false)}
      onTouchStart={activate}
      onTouchEnd={() => setActive(false)}
      aria-label={
        sources.length > 1
          ? `${alt} — صورة ${index + 1} من ${sources.length}`
          : alt
      }
    >
      <ProductImage
        key={`${current ?? "empty"}-${index}`}
        url={current}
        alt=""
        className="size-full bg-white animate__animated animate__fadeIn animate__faster"
        showFallbackLabel={showFallbackLabel}
      />
      {sources.length > 1 && (
        <span className="pointer-events-none absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-[#183d36]/75 px-2 py-0.5 text-[9px] font-black text-white opacity-0 transition-opacity group-hover:opacity-100">
          {index + 1} / {sources.length}
        </span>
      )}
    </div>
  );
}

export function ProductGallery({
  urls,
  fallbackUrl,
  alt,
}: {
  urls?: string[];
  fallbackUrl: string | null;
  alt: string;
}) {
  const sources = useMemo(
    () => storefrontMediaUrls(urls, fallbackUrl, 12),
    [urls, fallbackUrl],
  );
  const reducedMotion = usePrefersReducedMotion();
  const [index, setIndex] = useState(0);
  const [hovered, setHovered] = useState(false);
  const [zoomPoint, setZoomPoint] = useState<{ x: number; y: number } | null>(
    null,
  );
  const zoomPendingRef = useRef<{ x: number; y: number } | null>(null);
  const zoomFrameRef = useRef<number | null>(null);
  const [fullScreen, setFullScreen] = useState(false);
  const fullScreenCloseRef = useRef<HTMLButtonElement | null>(null);
  useEffect(
    () => () => {
      if (zoomFrameRef.current != null)
        window.cancelAnimationFrame(zoomFrameRef.current);
    },
    [],
  );
  // تبديل البديل يعيد المعرض إلى صورته الرئيسية ولا يُبقي فهرساً من معرضٍ سابق.
  useEffect(() => setIndex(0), [sources.join("|")]);
  useEffect(() => {
    if (sources.length < 2 || !hovered || reducedMotion) return;
    const timer = window.setInterval(
      () => setIndex((current) => (current + 1) % sources.length),
      2600,
    );
    return () => window.clearInterval(timer);
  }, [hovered, reducedMotion, sources.length]);
  const move = (delta: -1 | 1) =>
    setIndex((current) => (current + delta + sources.length) % sources.length);
  const currentUrl = sources[index] ?? null;
  const handleZoomMove = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!currentUrl || window.matchMedia("(pointer: coarse)").matches) return;
    const rect = event.currentTarget.getBoundingClientRect();
    zoomPendingRef.current = clampStorefrontZoomPoint(
      {
        x: ((event.clientX - rect.left) / rect.width) * 100,
        y: ((event.clientY - rect.top) / rect.height) * 100,
      },
      rect.width,
      rect.height,
    );
    if (zoomFrameRef.current == null) {
      zoomFrameRef.current = window.requestAnimationFrame(() => {
        zoomFrameRef.current = null;
        if (zoomPendingRef.current) setZoomPoint(zoomPendingRef.current);
      });
    }
  };
  return (
    <div
      className="space-y-2"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => {
        setHovered(false);
        setZoomPoint(null);
        zoomPendingRef.current = null;
        if (zoomFrameRef.current != null) {
          window.cancelAnimationFrame(zoomFrameRef.current);
          zoomFrameRef.current = null;
        }
      }}
    >
      <div
        className="group relative aspect-square overflow-hidden rounded-2xl bg-white ring-1 ring-[#ead8c8]"
        onMouseMove={handleZoomMove}
      >
        <button
          type="button"
          disabled={!currentUrl}
          aria-label={
            currentUrl ? `تكبير صورة ${alt}` : `لا توجد صورة متاحة لـ${alt}`
          }
          onClick={() => currentUrl && setFullScreen(true)}
          className="block size-full disabled:cursor-default"
        >
          <ProductImage
            url={currentUrl}
            alt={alt}
            className="size-full bg-white"
            showFallbackLabel
          />
        </button>
        {zoomPoint && currentUrl && (
          <div
            className="pointer-events-none absolute hidden size-64 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-white bg-no-repeat shadow-[0_10px_30px_rgba(24,61,54,0.28)] lg:block"
            style={{
              left: `${zoomPoint.x}%`,
              top: `${zoomPoint.y}%`,
              backgroundImage: `url(${JSON.stringify(currentUrl)})`,
              backgroundSize: "300% 300%",
              backgroundPosition: `${zoomPoint.x}% ${zoomPoint.y}%`,
            }}
            aria-hidden="true"
          />
        )}
        {currentUrl && (
          <span className="pointer-events-none absolute bottom-3 right-3 rounded-full bg-white/90 px-2.5 py-1 text-[10px] font-black text-[#1e4a63] opacity-0 shadow-sm transition-opacity group-hover:opacity-100">
            مرّر للتكبير
          </span>
        )}
        {sources.length > 1 && (
          <>
            <button
              type="button"
              onClick={() => move(-1)}
              aria-label="الصورة السابقة"
              className="absolute right-3 top-1/2 flex size-11 -translate-y-1/2 items-center justify-center rounded-full bg-white/90 text-[#1e4a63] shadow-md transition hover:bg-white active:scale-95"
            >
              <ArrowRight aria-hidden className="size-4" />
            </button>
            <button
              type="button"
              onClick={() => move(1)}
              aria-label="الصورة التالية"
              className="absolute left-3 top-1/2 flex size-11 -translate-y-1/2 items-center justify-center rounded-full bg-white/90 text-[#1e4a63] shadow-md transition hover:bg-white active:scale-95"
            >
              <ArrowRight aria-hidden className="size-4 rotate-180" />
            </button>
            <span className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-[#183d36]/85 px-2.5 py-1 text-[10px] font-black text-white">
              {index + 1} / {sources.length}
            </span>
          </>
        )}
      </div>
      {sources.length > 1 && (
        <div
          className="flex gap-2 overflow-x-auto pb-1"
          aria-label="صور المنتج المصغرة"
        >
          {sources.map((source, thumbnailIndex) => (
            <button
              type="button"
              key={source}
              onClick={() => setIndex(thumbnailIndex)}
              aria-label={`عرض الصورة ${thumbnailIndex + 1}`}
              aria-pressed={thumbnailIndex === index}
              className={`size-14 shrink-0 overflow-hidden rounded-lg bg-white ring-1 transition ${thumbnailIndex === index ? "ring-[var(--store-accent)] ring-2" : "ring-[#ead8c8]"}`}
            >
              <img
                src={source}
                alt=""
                loading="lazy"
                className="size-full object-contain"
              />
            </button>
          ))}
        </div>
      )}
      <DialogPrimitive.Root open={fullScreen} onOpenChange={setFullScreen}>
        {currentUrl && (
          <DialogPrimitive.Portal>
            <DialogPrimitive.Overlay className="fixed inset-0 z-[80] bg-slate-950/90" />
            <DialogPrimitive.Content
              aria-describedby={undefined}
              onOpenAutoFocus={(event) => {
                event.preventDefault();
                fullScreenCloseRef.current?.focus();
              }}
              className="fixed inset-0 z-[81] flex items-center justify-center p-4 outline-none"
            >
              <DialogPrimitive.Title className="sr-only">
                صورة {alt} بالحجم الكامل
              </DialogPrimitive.Title>
              <img
                src={currentUrl}
                alt={alt}
                className="max-h-[90dvh] max-w-[96vw] object-contain"
              />
              <DialogPrimitive.Close asChild>
                <button
                  ref={fullScreenCloseRef}
                  type="button"
                  aria-label="إغلاق التكبير"
                  className="absolute right-4 flex size-11 items-center justify-center rounded-full bg-white/95 text-slate-700 shadow-lg"
                  style={{ top: "calc(1rem + env(safe-area-inset-top))" }}
                >
                  <X aria-hidden className="size-5" />
                </button>
              </DialogPrimitive.Close>
            </DialogPrimitive.Content>
          </DialogPrimitive.Portal>
        )}
      </DialogPrimitive.Root>
    </div>
  );
}

export function BundleMedia({
  urls,
  fallbackUrl,
  alt,
  className,
  showFallbackLabel = false,
}: {
  urls?: string[];
  fallbackUrl: string | null;
  alt: string;
  className?: string;
  showFallbackLabel?: boolean;
}) {
  const sources = storefrontMediaUrls(urls, fallbackUrl, 4);
  return (
    <CardMediaCarousel
      urls={sources}
      fallbackUrl={null}
      alt={alt}
      className={`store-product-media overflow-hidden bg-white ${className ?? ""}`}
      showFallbackLabel={showFallbackLabel}
    />
  );
}
