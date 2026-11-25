import * as DialogPrimitive from "@radix-ui/react-dialog";
import { ArrowRight, Package, X, ZoomIn, ZoomOut } from "lucide-react";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

export interface LoadedProductImageInfo {
  url: string;
  naturalWidth: number;
  naturalHeight: number;
}

export function ProductImage({
  url,
  alt,
  className,
  showFallbackLabel = false,
  eager = false,
  onImageReady,
}: {
  url: string | null;
  alt: string;
  className?: string;
  /** The catalogue grid has room to explain an absent image; compact rows do not. */
  showFallbackLabel?: boolean;
  eager?: boolean;
  onImageReady?: (info: LoadedProductImageInfo | null) => void;
}) {
  const [resolvedUrl, setResolvedUrl] = useState<string | null>(url);
  const imgRef = useRef<HTMLImageElement | null>(null);
  useEffect(() => {
    setResolvedUrl(url);
  }, [url]);

  useEffect(() => {
    if (!resolvedUrl) {
      onImageReady?.(null);
      return;
    }
    const el = imgRef.current;
    if (el && el.complete && el.naturalWidth > 0 && el.naturalHeight > 0) {
      onImageReady?.({
        url: resolvedUrl,
        naturalWidth: el.naturalWidth,
        naturalHeight: el.naturalHeight,
      });
    }
  }, [resolvedUrl, onImageReady]);

  if (!resolvedUrl) {
    return (
      <div
        className={`store-product-image-placeholder flex flex-col items-center justify-center gap-2 bg-[#f5f5f7] text-slate-400 dark:bg-slate-900 ${className ?? ""}`}
        role="img"
        aria-label={`منتج قرطاسية: ${alt}`}
      >
        <Package
          aria-hidden
          className="size-7 text-slate-300 dark:text-slate-600"
        />
        {showFallbackLabel && (
          <span className="text-[10px] font-medium text-slate-400 dark:text-slate-500">
            المكتبة العربية
          </span>
        )}
      </div>
    );
  }
  return (
    <img
      ref={imgRef}
      src={resolvedUrl}
      alt={alt}
      loading={eager ? "eager" : "lazy"}
      decoding="async"
      onLoad={(event) => {
        const el = event.currentTarget;
        if (resolvedUrl && el.naturalWidth > 0 && el.naturalHeight > 0) {
          onImageReady?.({
            url: resolvedUrl,
            naturalWidth: el.naturalWidth,
            naturalHeight: el.naturalHeight,
          });
        }
      }}
      onError={() => {
        if (/[?&]w=(?:1200|640)\b/.test(resolvedUrl)) {
          setResolvedUrl(
            resolvedUrl.replace(/([?&])w=(?:1200|640)\b/, "$1w=320"),
          );
          return;
        }
        onImageReady?.(null);
        setResolvedUrl(null);
      }}
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

export interface StorefrontZoomLensGeometry {
  lensLeftPx: number;
  lensTopPx: number;
  lensSizePx: number;
  zoomedWidthPx: number;
  zoomedHeightPx: number;
  imageOffsetXPx: number;
  imageOffsetYPx: number;
  u: number;
  v: number;
}

/**
 * يحسب هندسة عدسة التقريب بفصل موضع الدائرة البصري (يبقى داخل الإطار دون قصّ لحلقته)
 * عن نقطة الاستهداف على المستطيل الفعلي للصورة داخل `object-contain`، مع هامش أمان دائري
 * يضمن إمكانية تقريب الحواف والزوايا الأربع كاملة بنسبة أبعاد الصورة الحقيقية دون مطّ أو اقتطاع.
 */
export function computeStorefrontZoomLensGeometry(input: {
  cursorPx: { x: number; y: number };
  container: { width: number; height: number };
  natural?: { width: number; height: number } | null;
  lensSize?: number;
  zoomScale?: number;
}): StorefrontZoomLensGeometry {
  const cw = Math.max(1, input.container.width);
  const ch = Math.max(1, input.container.height);
  const nw =
    input.natural && input.natural.width > 0 ? input.natural.width : cw;
  const nh =
    input.natural && input.natural.height > 0 ? input.natural.height : ch;

  const containScale = Math.min(cw / nw, ch / nh);
  const renderedW = Math.max(1, nw * containScale);
  const renderedH = Math.max(1, nh * containScale);
  const renderedLeft = (cw - renderedW) / 2;
  const renderedTop = (ch - renderedH) / 2;

  const u = Math.max(
    0,
    Math.min(1, (input.cursorPx.x - renderedLeft) / renderedW),
  );
  const v = Math.max(
    0,
    Math.min(1, (input.cursorPx.y - renderedTop) / renderedH),
  );

  const requestedLens = input.lensSize ?? 224;
  const lensSizePx = Math.max(
    120,
    Math.min(requestedLens, Math.floor(Math.min(cw, ch) * 0.58)),
  );
  const radius = lensSizePx / 2;
  const frameInset = 6;
  const minCenterX = Math.min(cw / 2, radius + frameInset);
  const maxCenterX = Math.max(cw / 2, cw - radius - frameInset);
  const minCenterY = Math.min(ch / 2, radius + frameInset);
  const maxCenterY = Math.max(ch / 2, ch - radius - frameInset);

  const lensLeftPx = Math.max(
    minCenterX,
    Math.min(maxCenterX, input.cursorPx.x),
  );
  const lensTopPx = Math.max(
    minCenterY,
    Math.min(maxCenterY, input.cursorPx.y),
  );

  const zoomScale = input.zoomScale ?? 2.6;
  const zoomedWidthPx = renderedW * zoomScale;
  const zoomedHeightPx = renderedH * zoomScale;

  const edgeBringIn = Math.round(lensSizePx * 0.26);
  const panSpanX = zoomedWidthPx - lensSizePx + 2 * edgeBringIn;
  const panSpanY = zoomedHeightPx - lensSizePx + 2 * edgeBringIn;

  const imageOffsetXPx =
    panSpanX > 0
      ? edgeBringIn - u * panSpanX
      : (lensSizePx - zoomedWidthPx) / 2;
  const imageOffsetYPx =
    panSpanY > 0
      ? edgeBringIn - v * panSpanY
      : (lensSizePx - zoomedHeightPx) / 2;

  return {
    lensLeftPx,
    lensTopPx,
    lensSizePx,
    zoomedWidthPx,
    zoomedHeightPx,
    imageOffsetXPx,
    imageOffsetYPx,
    u,
    v,
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
        className="size-full bg-white"
        showFallbackLabel={showFallbackLabel}
      />
      {sources.length > 1 && (
        <span className="pointer-events-none absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-[#1d1d1f]/80 px-2 py-0.5 text-[9px] font-black text-white opacity-0 transition-opacity group-hover:opacity-100">
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
  const [imageInfo, setImageInfo] = useState<LoadedProductImageInfo | null>(
    null,
  );
  const [zoomLens, setZoomLens] = useState<StorefrontZoomLensGeometry | null>(
    null,
  );
  const zoomPendingRef = useRef<StorefrontZoomLensGeometry | null>(null);
  const zoomFrameRef = useRef<number | null>(null);
  const [fullScreen, setFullScreen] = useState(false);
  const [lightboxZoomed, setLightboxZoomed] = useState(false);
  const fullScreenCloseRef = useRef<HTMLButtonElement | null>(null);
  const handleImageReady = useCallback(
    (info: LoadedProductImageInfo | null) => {
      setImageInfo(info);
    },
    [],
  );
  useEffect(
    () => () => {
      if (zoomFrameRef.current != null)
        window.cancelAnimationFrame(zoomFrameRef.current);
    },
    [],
  );
  // تبديل البديل يعيد المعرض إلى صورته الرئيسية ولا يُبقي فهرساً من معرضٍ سابق.
  useEffect(() => {
    setIndex(0);
    setLightboxZoomed(false);
  }, [sources.join("|")]);
  useEffect(() => {
    setImageInfo(null);
    setZoomLens(null);
    setLightboxZoomed(false);
  }, [index]);
  useEffect(() => {
    if (
      sources.length < 2 ||
      !hovered ||
      zoomLens != null ||
      fullScreen ||
      reducedMotion
    ) {
      return;
    }
    const timer = window.setInterval(
      () => setIndex((current) => (current + 1) % sources.length),
      2600,
    );
    return () => window.clearInterval(timer);
  }, [hovered, zoomLens, fullScreen, reducedMotion, sources.length]);
  const move = (delta: -1 | 1) =>
    setIndex((current) => (current + delta + sources.length) % sources.length);
  const currentUrl = sources[index] ?? null;
  const activeZoomUrl = imageInfo?.url ?? currentUrl;
  const handleZoomMove = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!activeZoomUrl || window.matchMedia("(pointer: coarse)").matches) return;
    const rect = event.currentTarget.getBoundingClientRect();
    zoomPendingRef.current = computeStorefrontZoomLensGeometry({
      cursorPx: {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      },
      container: { width: rect.width, height: rect.height },
      natural: imageInfo
        ? { width: imageInfo.naturalWidth, height: imageInfo.naturalHeight }
        : null,
    });
    if (zoomFrameRef.current == null) {
      zoomFrameRef.current = window.requestAnimationFrame(() => {
        zoomFrameRef.current = null;
        if (zoomPendingRef.current) setZoomLens(zoomPendingRef.current);
      });
    }
  };
  return (
    <div
      className="space-y-2"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => {
        setHovered(false);
        setZoomLens(null);
        zoomPendingRef.current = null;
        if (zoomFrameRef.current != null) {
          window.cancelAnimationFrame(zoomFrameRef.current);
          zoomFrameRef.current = null;
        }
      }}
    >
      <div
        className="group relative aspect-square overflow-hidden rounded-2xl bg-white ring-1 ring-slate-200/80 dark:ring-slate-800"
        onMouseMove={handleZoomMove}
      >
        <button
          type="button"
          disabled={!currentUrl}
          aria-label={
            currentUrl ? `تكبير صورة ${alt}` : `لا توجد صورة متاحة لـ${alt}`
          }
          onClick={() => currentUrl && setFullScreen(true)}
          className="block size-full cursor-zoom-in disabled:cursor-default"
        >
          <ProductImage
            url={currentUrl}
            alt={alt}
            className="size-full bg-white"
            showFallbackLabel
            eager
            onImageReady={handleImageReady}
          />
        </button>
        {zoomLens && activeZoomUrl && (
          <div
            dir="ltr"
            className="pointer-events-none absolute top-0 left-0 z-10 hidden overflow-hidden rounded-full border-2 border-white bg-white shadow-[0_12px_32px_rgba(15,23,42,0.26)] ring-1 ring-slate-900/10 lg:block"
            style={{
              width: `${zoomLens.lensSizePx}px`,
              height: `${zoomLens.lensSizePx}px`,
              transform: `translate3d(${zoomLens.lensLeftPx - zoomLens.lensSizePx / 2}px, ${zoomLens.lensTopPx - zoomLens.lensSizePx / 2}px, 0)`,
            }}
            aria-hidden="true"
          >
            <img
              src={activeZoomUrl}
              alt=""
              draggable={false}
              className="pointer-events-none absolute top-0 left-0 max-w-none select-none"
              style={{
                width: `${zoomLens.zoomedWidthPx}px`,
                height: `${zoomLens.zoomedHeightPx}px`,
                transform: `translate3d(${zoomLens.imageOffsetXPx}px, ${zoomLens.imageOffsetYPx}px, 0)`,
              }}
            />
          </div>
        )}
        {currentUrl && (
          <span className="pointer-events-none absolute bottom-3 right-3 rounded-full bg-white/90 px-2.5 py-1 text-[10px] font-black text-[#1d1d1f] opacity-0 shadow-sm transition-opacity group-hover:opacity-100">
            مرّر أو اضغط للتكبير
          </span>
        )}
        {sources.length > 1 && (
          <>
            <button
              type="button"
              onClick={() => move(-1)}
              aria-label="الصورة السابقة"
              className="absolute right-3 top-1/2 z-20 flex size-11 -translate-y-1/2 items-center justify-center rounded-full bg-white/90 text-[#1d1d1f] shadow-md transition hover:bg-white active:scale-95"
            >
              <ArrowRight aria-hidden className="size-4" />
            </button>
            <button
              type="button"
              onClick={() => move(1)}
              aria-label="الصورة التالية"
              className="absolute left-3 top-1/2 z-20 flex size-11 -translate-y-1/2 items-center justify-center rounded-full bg-white/90 text-[#1d1d1f] shadow-md transition hover:bg-white active:scale-95"
            >
              <ArrowRight aria-hidden className="size-4 rotate-180" />
            </button>
            <span className="pointer-events-none absolute bottom-3 left-1/2 z-20 -translate-x-1/2 rounded-full bg-[#1d1d1f]/85 px-2.5 py-1 text-[10px] font-black text-white">
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
              className={`size-14 shrink-0 overflow-hidden rounded-lg bg-white ring-1 transition ${thumbnailIndex === index ? "ring-[var(--store-brand)] ring-2" : "ring-slate-200/80 dark:ring-slate-700"}`}
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
      <DialogPrimitive.Root
        open={fullScreen}
        onOpenChange={(open) => {
          setFullScreen(open);
          if (!open) setLightboxZoomed(false);
        }}
      >
        {activeZoomUrl && (
          <DialogPrimitive.Portal>
            <DialogPrimitive.Overlay className="fixed inset-0 z-[80] bg-slate-950/90" />
            <DialogPrimitive.Content
              aria-describedby={undefined}
              onOpenAutoFocus={(event) => {
                event.preventDefault();
                fullScreenCloseRef.current?.focus();
              }}
              className="fixed inset-0 z-[81] flex flex-col outline-none"
            >
              <DialogPrimitive.Title className="sr-only">
                صورة {alt} بالحجم الكامل
              </DialogPrimitive.Title>
              <div
                className="pointer-events-none absolute inset-x-4 z-10 flex items-center justify-between gap-2"
                style={{ top: "calc(1rem + env(safe-area-inset-top))" }}
              >
                <DialogPrimitive.Close asChild>
                  <button
                    ref={fullScreenCloseRef}
                    type="button"
                    aria-label="إغلاق التكبير"
                    className="pointer-events-auto flex size-11 items-center justify-center rounded-full bg-white/95 text-slate-800 shadow-lg transition hover:bg-white active:scale-95"
                  >
                    <X aria-hidden className="size-5" />
                  </button>
                </DialogPrimitive.Close>
                <button
                  type="button"
                  onClick={() => setLightboxZoomed((prev) => !prev)}
                  aria-pressed={lightboxZoomed}
                  aria-label={
                    lightboxZoomed ? "تصغير الصورة" : "تكبير الصورة للتفاصيل"
                  }
                  className="pointer-events-auto flex h-11 items-center gap-1.5 rounded-full bg-white/95 px-4 text-xs font-extrabold text-slate-800 shadow-lg transition hover:bg-white active:scale-95"
                >
                  {lightboxZoomed ? (
                    <>
                      <ZoomOut aria-hidden className="size-4" />
                      <span>تصغير</span>
                    </>
                  ) : (
                    <>
                      <ZoomIn aria-hidden className="size-4" />
                      <span>تكبير 2x</span>
                    </>
                  )}
                </button>
              </div>
              <div
                dir="ltr"
                className={`flex flex-1 overflow-auto p-4 pt-20 ${lightboxZoomed ? "items-start justify-start sm:justify-center" : "items-center justify-center"}`}
              >
                <img
                  src={activeZoomUrl}
                  alt={alt}
                  onClick={() => setLightboxZoomed((prev) => !prev)}
                  className={
                    lightboxZoomed
                      ? "m-auto w-[min(185vw,1200px)] max-w-none cursor-zoom-out object-contain select-none"
                      : "max-h-[85dvh] max-w-[94vw] cursor-zoom-in object-contain select-none"
                  }
                />
              </div>
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
