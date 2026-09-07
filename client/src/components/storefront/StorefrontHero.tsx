import React, { useEffect, useState } from "react";
import { ShoppingBag, Clock, Flame, ArrowLeft, ShieldCheck, ArrowRight, Package } from "lucide-react";
import { BannerFrame, type StoreBannerCreative } from "@/components/store/BannerFrame";

interface StorefrontHeroProps {
  heroBanners: StoreBannerCreative[];
  featuredHero?: StoreBannerCreative;
  bannerCarouselComponent?: React.ReactNode;
  onScrollToProducts: () => void;
  onExplorePicks: () => void;
}

export function StorefrontHero({
  heroBanners,
  featuredHero,
  bannerCarouselComponent,
  onScrollToProducts,
  onExplorePicks,
}: StorefrontHeroProps) {
  // عداد تنازلي لعروض اليوم الحصرية
  const [timeLeft, setTimeLeft] = useState({ hours: 7, minutes: 24, seconds: 18 });

  useEffect(() => {
    const timer = setInterval(() => {
      setTimeLeft((prev) => {
        if (prev.seconds > 0) return { ...prev, seconds: prev.seconds - 1 };
        if (prev.minutes > 0) return { ...prev, minutes: prev.minutes - 1, seconds: 59 };
        if (prev.hours > 0) return { hours: prev.hours - 1, minutes: 59, seconds: 59 };
        return { hours: 12, minutes: 0, seconds: 0 };
      });
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const formatDigit = (num: number) => String(num).padStart(2, "0");

  return (
    <section
      id="store-start"
      className="relative grid overflow-hidden rounded-[2.5rem] border border-stone-800/80 bg-gradient-to-br from-slate-950 via-[#101726] to-[#0a0f1d] text-white shadow-2xl lg:grid-cols-[1.15fr_0.85fr]"
    >
      {/* خلفية معمارية تجارية وإضاءة دافئة ناعمة */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -right-20 -top-20 size-[420px] rounded-full bg-amber-600/10 blur-[90px]"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -bottom-24 left-10 size-[380px] rounded-full bg-orange-600/15 blur-[100px]"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-white/[0.04] via-transparent to-transparent"
      />

      {/* المحتوى التسويقي التحريري الجاذب */}
      <div className="relative z-10 flex flex-col justify-center p-7 sm:p-10 lg:p-12">
        {/* شارة العرض والعداد التنازلي التحريري */}
        <div className="mb-5 flex flex-wrap items-center gap-2.5">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-orange-500/30 bg-orange-500/15 px-3.5 py-1 text-[11px] font-black tracking-wide text-orange-300 backdrop-blur-md">
            <Flame aria-hidden className="size-3.5 text-orange-400" />
            عروض موسمية محدودة
          </span>

          <div className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-3.5 py-1 text-[11px] font-bold text-stone-300 backdrop-blur-md">
            <Clock aria-hidden className="size-3.5 text-amber-400" />
            <span>تنتهي بعد:</span>
            <span className="font-mono font-black text-amber-300 tabular-nums" dir="ltr">
              {formatDigit(timeLeft.hours)}:{formatDigit(timeLeft.minutes)}:{formatDigit(timeLeft.seconds)}
            </span>
          </div>
        </div>

        <div className="mb-2 inline-flex items-center gap-2 text-xs font-extrabold uppercase tracking-widest text-amber-400/90">
          <span className="h-px w-6 bg-amber-400/40" />
          <span>المكتبة العربية — قرطاسية النخبة</span>
        </div>

        <h2 className="text-3xl font-black leading-[1.22] tracking-tight text-white sm:text-5xl lg:text-[44px] xl:text-[48px]">
          أدواتك المفضلة،
          <br />
          <span className="bg-gradient-to-l from-orange-400 via-amber-300 to-yellow-200 bg-clip-text text-transparent">
            بجودة لا تقبل المساومة.
          </span>
        </h2>

        <p className="mt-4 max-w-lg text-sm font-medium leading-relaxed text-stone-300 sm:text-base">
          قرطاسية راقية، دفاتر ورق كريمي ياباني، أدوات هندسة ألمانية، وهدايا تليق بذوقك. تصلك لباب منزلك في جميع محافظات العراق مع خيار الفحص الكامل قبل الدفع.
        </p>

        {/* أزرار الإجراءات الرئيسية CTAs */}
        <div className="mt-8 flex flex-wrap items-center gap-3.5">
          <button
            type="button"
            onClick={onScrollToProducts}
            className="group flex items-center gap-2.5 rounded-2xl bg-gradient-to-l from-orange-600 to-amber-600 px-7 py-4 text-sm font-black text-white shadow-xl shadow-orange-600/25 transition-all duration-200 hover:from-orange-500 hover:to-amber-500 hover:shadow-orange-600/40 active:scale-95"
          >
            <ShoppingBag aria-hidden className="size-4 transition-transform duration-200 group-hover:-translate-y-0.5" />
            <span>تسوق التشكيلة الآن</span>
            <ArrowLeft aria-hidden className="size-4 transition-transform duration-200 group-hover:-translate-x-1" />
          </button>

          <button
            type="button"
            onClick={onExplorePicks}
            className="flex items-center gap-2 rounded-2xl border border-white/20 bg-white/10 px-6 py-4 text-sm font-bold text-white backdrop-blur-md transition-all duration-200 hover:bg-white/20 active:scale-95"
          >
            <span>أبرز المختارات</span>
          </button>
        </div>

        {/* شريط ركائز الثقة السريع */}
        <div className="mt-8 grid max-w-md grid-cols-3 gap-3 border-t border-white/10 pt-4 text-[11px] font-bold text-stone-300">
          <span className="flex items-center gap-1.5">
            <ShieldCheck aria-hidden className="size-3.5 text-emerald-400" />
            فحص كامل عند الاستلام
          </span>
          <span className="flex items-center gap-1.5">
            <span className="size-1.5 rounded-full bg-amber-400" />
            شحن لكل محافظات العراق
          </span>
          <span className="flex items-center gap-1.5">
            <span className="size-1.5 rounded-full bg-emerald-400" />
            ضمان أصالة 100%
          </span>
        </div>
      </div>

      {/* جانب البانر الإبداعي أو الإطار الترويجي */}
      <div className="relative flex min-h-[320px] items-center justify-center bg-black/30 p-4 sm:p-6 lg:min-h-[460px]">
        {bannerCarouselComponent ? (
          bannerCarouselComponent
        ) : featuredHero ? (
          <div className="size-full overflow-hidden rounded-2xl shadow-xl">
            <BannerFrame banner={featuredHero} slot="HERO" active />
          </div>
        ) : (
          <div className="relative flex size-full flex-col justify-between overflow-hidden rounded-3xl border border-white/15 bg-gradient-to-br from-stone-900/90 via-slate-900/95 to-stone-950 p-6 sm:p-8 text-white shadow-2xl backdrop-blur-md">
            {/* زخرفة إضاءة تحريرية */}
            <div aria-hidden className="pointer-events-none absolute -left-10 -top-10 size-48 rounded-full bg-orange-500/10 blur-2xl" />
            <div aria-hidden className="pointer-events-none absolute -bottom-10 -right-10 size-48 rounded-full bg-amber-500/10 blur-2xl" />

            <div className="relative z-10 flex items-center justify-between">
              <span className="inline-flex items-center gap-1.5 rounded-xl border border-amber-400/20 bg-amber-400/10 px-3 py-1.5 text-xs font-bold text-amber-300">
                <Package aria-hidden className="size-3.5" />
                مختارات البكجات
              </span>
              <span className="rounded-full bg-white/10 px-3 py-1 text-[11px] font-semibold text-stone-300">
                تجهيز متكامل
              </span>
            </div>

            <div className="relative z-10 my-6">
              <span className="text-xs font-black uppercase tracking-wider text-orange-400">
                إصدار العام الأكاديمي
              </span>
              <h3 className="mt-2 text-2xl font-black leading-tight sm:text-3xl">
                أحدث البكجات والتجهيزات المكتبية الفاخرة
              </h3>
              <p className="mt-2 text-xs leading-relaxed text-stone-300">
                تشكيلات متكاملة تجمع بين أقلام الحبر العالمية والدفاتر الهندسية الفاخرة مع توفير يصل إلى 25%.
              </p>
            </div>

            <button
              type="button"
              onClick={onExplorePicks}
              className="relative z-10 group flex w-full items-center justify-between rounded-2xl border border-white/20 bg-white/10 px-5 py-3.5 text-xs font-black text-white transition hover:bg-white/20 active:scale-95"
            >
              <span>استكشف الباقة الحصرية</span>
              <ArrowRight aria-hidden className="size-4 transition-transform group-hover:-translate-x-1" />
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

