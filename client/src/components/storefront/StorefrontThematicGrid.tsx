import React from "react";
import { ArrowLeft, PenTool, GraduationCap, Briefcase, ChevronLeft } from "lucide-react";

interface ThematicCollection {
  id: string;
  tag: string;
  title: string;
  description: string;
  cta: string;
  bgGradient: string;
  borderColor: string;
  icon: React.ReactNode;
  filterKeyword: string;
}

interface StorefrontThematicGridProps {
  onSelectKeyword: (keyword: string) => void;
}

const COLLECTIONS: ThematicCollection[] = [
  {
    id: "calligraphy",
    tag: "مختارات النخبة",
    title: "أناقة الحرف وهواة الحبر العربي",
    description: "أقلام حبر سائل ألمانية، دفاتر مخطوطات، ومحابر كلاسيكية صُممت لعشاق التفاصيل والخط الأصيل.",
    cta: "تصفح أدوات الخط",
    bgGradient: "from-amber-950/80 via-slate-900 to-slate-950",
    borderColor: "border-amber-500/30 hover:border-amber-500/60",
    icon: <PenTool className="size-5 text-amber-400" />,
    filterKeyword: "حبر",
  },
  {
    id: "academic",
    tag: "الأعلى طلباً للموسم",
    title: "حقيبة التفوق الأكاديمي والجامعي",
    description: "دفاتر سلك فاخرة، أقلام تظليل مقاومة للنزف، ومنظمات مدمجة تُعينك على إتقان مهامك ومحاضراتك.",
    cta: "تجهيزات الدراسة",
    bgGradient: "from-blue-950/80 via-slate-900 to-slate-950",
    borderColor: "border-blue-500/30 hover:border-blue-500/60",
    icon: <GraduationCap className="size-5 text-blue-400" />,
    filterKeyword: "دفتر",
  },
  {
    id: "executive",
    tag: "إصدار الإهداء الفاخر",
    title: "تجهيزات المكاتب القيادية والأعمال",
    description: "علب هدايا ملكية متكاملة، حوامل حواسيب ألمنيوم، وأقلام توقيع رسمية تليق بأفخم المكاتب.",
    cta: "مختارات المكاتب",
    bgGradient: "from-emerald-950/80 via-slate-900 to-slate-950",
    borderColor: "border-emerald-500/30 hover:border-emerald-500/60",
    icon: <Briefcase className="size-5 text-emerald-400" />,
    filterKeyword: "مكتب",
  },
];

export function StorefrontThematicGrid({ onSelectKeyword }: StorefrontThematicGridProps) {
  return (
    <section aria-labelledby="thematic-collections-heading" className="mt-12">
      <div className="mb-5 flex items-end justify-between">
        <div>
          <p className="text-xs font-black uppercase tracking-wider text-orange-600 dark:text-orange-400">
            تشكيلات تحريرية منتقاة
          </p>
          <h2 id="thematic-collections-heading" className="mt-1 text-2xl font-black text-slate-900 dark:text-slate-100">
            مجموعات صُممت لإلهام يومك وإنجازك
          </h2>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {COLLECTIONS.map((col) => (
          <article
            key={col.id}
            className={`group relative flex flex-col justify-between overflow-hidden rounded-3xl border ${col.borderColor} bg-gradient-to-br ${col.bgGradient} p-6 text-white shadow-lg transition-all duration-300 hover:-translate-y-1 hover:shadow-2xl`}
          >
            {/* إضاءة خلفية دقيقة */}
            <div className="pointer-events-none absolute -right-12 -top-12 size-40 rounded-full bg-white/5 blur-2xl" />

            <div>
              <div className="flex items-center justify-between">
                <span className="flex size-10 items-center justify-center rounded-2xl bg-white/10 backdrop-blur-md">
                  {col.icon}
                </span>
                <span className="rounded-full bg-white/10 px-3 py-1 text-[10px] font-black text-slate-200 backdrop-blur-xs">
                  {col.tag}
                </span>
              </div>

              <h3 className="mt-5 text-lg font-black leading-snug text-white">
                {col.title}
              </h3>
              <p className="mt-2 text-xs font-medium leading-relaxed text-slate-300">
                {col.description}
              </p>
            </div>

            <div className="mt-6 pt-4 border-t border-white/10">
              <button
                type="button"
                onClick={() => onSelectKeyword(col.filterKeyword)}
                className="inline-flex w-full items-center justify-between rounded-xl bg-white/10 px-4 py-2.5 text-xs font-black text-white transition hover:bg-white hover:text-slate-950"
              >
                <span>{col.cta}</span>
                <ChevronLeft aria-hidden className="size-4 transition-transform group-hover:-translate-x-1" />
              </button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
