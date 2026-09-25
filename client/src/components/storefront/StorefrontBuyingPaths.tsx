import React from "react";
import { GraduationCap, Briefcase, Building2, Gift, ArrowLeft } from "lucide-react";

export interface BuyingPath {
  title: string;
  description: string;
  keywords: string;
  tone: string;
  icon: React.ReactNode;
}

interface StorefrontBuyingPathsProps {
  onSelectPath: (keywords: string) => void;
  onExploreAll?: () => void;
}

const DEFAULT_PATHS: BuyingPath[] = [
  {
    title: "مستلزمات دراسية وأكاديمية",
    description: "دفاتر كراس، أقلام هندسة، وأدوات دراسية ممتازة للطلبة والأساتذة.",
    keywords: "دفتر قلم كراس هندسة مدرسة دراسة",
    tone: "border-amber-200/80 bg-amber-50/70 text-amber-950 dark:border-amber-500/20 dark:bg-amber-950/20 dark:text-amber-200",
    icon: <GraduationCap aria-hidden className="size-5 text-amber-600 dark:text-amber-400" />,
  },
  {
    title: "تجهيزات المكاتب والعمل",
    description: "ملفات تنظيمية، أوراق طباعة فاخرة، وأدوات مكتبية ترفع إنتاجيتك.",
    keywords: "ملف ورق طباعة منظم تدبيس مكتب",
    tone: "border-blue-200/80 bg-blue-50/70 text-blue-950 dark:border-blue-500/20 dark:bg-blue-950/20 dark:text-blue-200",
    icon: <Briefcase aria-hidden className="size-5 text-blue-600 dark:text-blue-400" />,
  },
  {
    title: "هدايا وقرطاسية النخبة",
    description: "أقلام حبر سائل عالمية، مذكرات جلدية، وأطقم هدايا تليق بالمناسبات.",
    keywords: "هدية قلم حبر فاخر مذكرات جلد",
    tone: "border-rose-200/80 bg-rose-50/70 text-rose-950 dark:border-rose-500/20 dark:bg-rose-950/20 dark:text-rose-200",
    icon: <Gift aria-hidden className="size-5 text-rose-600 dark:text-rose-400" />,
  },
  {
    title: "طلبات الجملة والشركات",
    description: "تجهيز مخصص للشركات والمؤسسات بأسعار خاصة وعروض كميات.",
    keywords: "جملة كميات كرتون تجهيز شركة",
    tone: "border-emerald-200/80 bg-emerald-50/70 text-emerald-950 dark:border-emerald-500/20 dark:bg-emerald-950/20 dark:text-emerald-200",
    icon: <Building2 aria-hidden className="size-5 text-emerald-600 dark:text-emerald-400" />,
  },
];

export function StorefrontBuyingPaths({
  onSelectPath,
  onExploreAll,
}: StorefrontBuyingPathsProps) {
  return (
    <section
      aria-labelledby="buying-paths-heading"
      className="mt-8 rounded-3xl border border-orange-100/90 bg-gradient-to-br from-orange-50/50 via-white to-amber-50/30 p-5 sm:p-7 dark:border-slate-800 dark:from-slate-900/90 dark:to-slate-900/60"
    >
      <div className="mb-5 flex items-end justify-between">
        <div>
          <p className="text-[11px] font-black uppercase tracking-[0.15em] text-orange-600 dark:text-orange-400">
            ابدأ من هنا
          </p>
          <h2
            id="buying-paths-heading"
            className="mt-1 text-2xl font-black tracking-tight text-slate-900 dark:text-slate-100"
          >
            اختَر طريق الشراء المناسب لاحتياجك
          </h2>
        </div>
        {onExploreAll && (
          <button
            type="button"
            onClick={onExploreAll}
            className="hidden text-xs font-black text-blue-700 hover:underline dark:text-blue-400 sm:block cursor-pointer"
          >
            عرض كل المنتجات ←
          </button>
        )}
      </div>

      <div className="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-4">
        {DEFAULT_PATHS.map((path) => (
          <button
            key={path.title}
            type="button"
            onClick={() => onSelectPath(path.keywords)}
            aria-label={`تصفح ${path.title}`}
            className={`group flex min-h-[148px] flex-col justify-between rounded-2xl border p-5 text-right transition-all duration-200 hover:-translate-y-1 hover:shadow-lg focus:outline-none focus:ring-2 focus:ring-orange-500/40 cursor-pointer ${path.tone}`}
          >
            <span className="flex size-11 items-center justify-center rounded-xl bg-white/90 shadow-sm backdrop-blur-xs transition-transform group-hover:scale-105 dark:bg-slate-800/90">
              {path.icon}
            </span>
            <div className="mt-4">
              <span className="block text-base font-black leading-snug">
                {path.title}
              </span>
              <span className="mt-1.5 block text-xs font-medium leading-relaxed opacity-80">
                {path.description}
              </span>
              <span className="mt-3 inline-flex items-center gap-1 text-[11px] font-black underline decoration-current/30 underline-offset-4 group-hover:decoration-current">
                <span>تصفح الاختيارات</span>
                <ArrowLeft aria-hidden className="size-3 transition-transform group-hover:-translate-x-1" />
              </span>
            </div>
          </button>
        ))}
      </div>
    </section>
  );
}
