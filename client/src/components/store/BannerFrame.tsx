import { useEffect, useRef } from "react";
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

/**
 * إطار موحد: PRESERVE_FULL يملأ الإطار بالخلفية ويحفظ التصميم كاملاً؛
 * SMART_CROP/LAYERED يملآن الصورة مع نقطة تركيز. لا يوجد قص صامت للنصوص.
 */
export function BannerFrame({ banner, slot, active = true, preview = false }: { banner: StoreBannerCreative; slot: Slot; active?: boolean; preview?: boolean }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const track = trpc.storefront.trackBanner.useMutation();
  const mode = banner.renderMode ?? "PRESERVE_FULL";
  const focus = `${Math.min(100, Math.max(0, banner.focusX ?? 50))}% ${Math.min(100, Math.max(0, banner.focusY ?? 50))}%`;
  const key = `store-banner-impression:${banner.id}:${slot}:${new Date().toISOString().slice(0, 10)}`;

  useEffect(() => {
    if (preview || !active || !ref.current || sessionStorage.getItem(key)) return;
    const node = ref.current;
    let timer: number | undefined;
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting || entry.intersectionRatio < 0.5) {
        if (timer) window.clearTimeout(timer);
        timer = undefined;
        return;
      }
      timer = window.setTimeout(() => {
        if (!sessionStorage.getItem(key)) {
          sessionStorage.setItem(key, "1");
          track.mutate({ bannerId: banner.id, placement: slot, event: "IMPRESSION" });
        }
      }, 1000);
    }, { threshold: [0.5] });
    observer.observe(node);
    return () => { observer.disconnect(); if (timer) window.clearTimeout(timer); };
  }, [active, banner.id, key, preview, slot, track]);

  const source = banner.imageUrl;
  const media = source ? (
    mode === "PRESERVE_FULL" ? (
      <>
        <picture className="absolute inset-0 overflow-hidden">
          {banner.mobileImageUrl && <source media="(max-width: 639px)" srcSet={banner.mobileImageUrl} />}
          <img src={source} alt="" className="size-full scale-110 object-cover opacity-70 blur-2xl" style={{ objectPosition: focus }} />
        </picture>
        <div className="absolute inset-0 bg-slate-950/20" />
        <picture className="absolute inset-0">
          {banner.mobileImageUrl && <source media="(max-width: 639px)" srcSet={banner.mobileImageUrl} />}
          <img src={source} alt={banner.title} className="size-full object-contain" style={{ objectPosition: focus }} />
        </picture>
      </>
    ) : (
      <picture className="absolute inset-0">
        {banner.mobileImageUrl && <source media="(max-width: 639px)" srcSet={banner.mobileImageUrl} />}
        <img src={source} alt={banner.title} className="size-full object-cover" style={{ objectPosition: focus }} />
      </picture>
    )
  ) : <div className="absolute inset-0 bg-gradient-to-l from-emerald-600 via-emerald-500 to-teal-500" />;

  const showCopy = mode !== "PRESERVE_FULL" || !source;
  const content = (
    <>
      {media}
      {showCopy && <div className="absolute inset-0 flex flex-col justify-end bg-gradient-to-t from-black/75 via-black/20 to-transparent p-4 text-white sm:p-6">
        <p className="text-base font-extrabold leading-tight sm:text-2xl">{banner.title}</p>
        {banner.subtitle && <p className="mt-1 max-w-[90%] text-xs text-white/90 sm:text-sm">{banner.subtitle}</p>}
        {banner.ctaLabel && <span className="mt-2 inline-flex w-fit rounded-full bg-amber-400 px-4 py-1.5 text-xs font-extrabold text-amber-950 shadow">{banner.ctaLabel}</span>}
      </div>}
      {!showCopy && banner.ctaLabel && <span className="absolute bottom-3 right-3 rounded-full bg-amber-400 px-3 py-1.5 text-xs font-extrabold text-amber-950 shadow">{banner.ctaLabel}</span>}
    </>
  );
  return (
    <div ref={ref} className="relative size-full overflow-hidden">
      {banner.ctaUrl ? <a href={banner.ctaUrl} className="block size-full" onClick={() => !preview && track.mutate({ bannerId: banner.id, placement: slot, event: "CLICK" })}>{content}</a> : content}
    </div>
  );
}

/** طبقة الصورة فقط لاستعمالها داخل أغلفة قديمة تتولى النص أو التنقل بنفسها. */
export function BannerMedia({ banner }: { banner: StoreBannerCreative }) {
  const source = banner.imageUrl;
  const mode = banner.renderMode ?? "PRESERVE_FULL";
  const focus = `${Math.min(100, Math.max(0, banner.focusX ?? 50))}% ${Math.min(100, Math.max(0, banner.focusY ?? 50))}%`;
  if (!source) return <div className="absolute inset-0 bg-gradient-to-l from-emerald-600 via-emerald-500 to-teal-500" />;
  if (mode === "PRESERVE_FULL") return <>
    <picture className="absolute inset-0 overflow-hidden"><img src={source} alt="" className="size-full scale-110 object-cover opacity-70 blur-2xl" style={{ objectPosition: focus }} /></picture>
    <div className="absolute inset-0 bg-slate-950/20" />
    <picture className="absolute inset-0">
      {banner.mobileImageUrl && <source media="(max-width: 639px)" srcSet={banner.mobileImageUrl} />}
      <img src={source} alt={banner.title} className="size-full object-contain" style={{ objectPosition: focus }} />
    </picture>
  </>;
  return <picture className="absolute inset-0">
    {banner.mobileImageUrl && <source media="(max-width: 639px)" srcSet={banner.mobileImageUrl} />}
    <img src={source} alt={banner.title} className="size-full object-cover" style={{ objectPosition: focus }} />
  </picture>;
}
