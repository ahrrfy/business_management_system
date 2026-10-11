import React from "react";
import {
  Briefcase,
  GraduationCap,
  PenTool,
  Tag,
  LayoutGrid,
  Palette,
  BookOpen,
  Sparkles,
  ArrowLeft,
  Check,
  X,
  Layers,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { fmtInt } from "@/lib/money";

export interface ThematicCollectionCard {
  id: string;
  tag: string;
  title: string;
  description: string;
  cta: string;
  bgGradient?: string;
  borderColor?: string;
  iconName: "Briefcase" | "GraduationCap" | "PenTool" | "Tag" | "LayoutGrid" | "Palette" | "BookOpen" | "Sparkles";
  filterType: "category" | "keyword" | "deal";
  filterValue: string;
  itemCount: number;
  productIds?: number[];
  sampleProductNames?: string[];
}

const ICON_MAP: Record<ThematicCollectionCard["iconName"], React.ComponentType<{ className?: string }>> = {
  Briefcase,
  GraduationCap,
  PenTool,
  Tag,
  LayoutGrid,
  Palette,
  BookOpen,
  Sparkles,
};

interface StorefrontThematicStripProps {
  activeCollectionId: string | null;
  onSelectCollection: (collection: ThematicCollectionCard) => void;
  onClearCollection: () => void;
  className?: string;
}

export function StorefrontThematicStrip({
  activeCollectionId,
  onSelectCollection,
  onClearCollection,
  className = "",
}: StorefrontThematicStripProps) {
  const query = trpc.storefront.thematicCollections.useQuery(undefined, {
    staleTime: 5 * 60 * 1000,
  });

  const cards: ThematicCollectionCard[] = (query.data as ThematicCollectionCard[] | undefined) ?? [];

  if (query.isLoading) {
    return (
      <div className={`w-full overflow-hidden py-2 ${className}`}>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-32 animate-pulse rounded-2xl bg-slate-100 dark:bg-slate-800/60"
            />
          ))}
        </div>
      </div>
    );
  }

  if (cards.length === 0) {
    return null;
  }

  return (
    <section
      aria-label="التشكيلات التحريرية الذكية"
      className={`relative w-full rounded-3xl border border-slate-200/80 bg-gradient-to-b from-slate-50/80 via-white to-slate-50/40 p-4 sm:p-6 shadow-xs dark:border-slate-800 dark:from-slate-900/90 dark:via-slate-900 dark:to-slate-950 ${className}`}
    >
      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <div className="flex size-8 items-center justify-center rounded-xl bg-blue-600/10 text-blue-600 dark:bg-blue-500/20 dark:text-blue-400">
            <Layers className="size-4.5" />
          </div>
          <div>
            <h3 className="text-sm font-black tracking-tight text-slate-900 dark:text-slate-100">
              تشكيلات وباقات منتقاة بعناية
            </h3>
            <p className="text-[11px] font-bold text-slate-500 dark:text-slate-400">
              حلول متكاملة مخصصة لشركتك، تخرجك، ومكتبك بأفضل قيمة مجمعة
            </p>
          </div>
        </div>

        {activeCollectionId && (
          <button
            type="button"
            onClick={onClearCollection}
            className="inline-flex items-center gap-1.5 self-start rounded-full border border-rose-200 bg-rose-50 px-3 py-1 text-xs font-black text-rose-700 transition hover:bg-rose-100 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-300"
          >
            <X className="size-3.5" />
            <span>إلغاء تصفية الباقة</span>
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {cards.map((card) => {
          const IconComp = ICON_MAP[card.iconName] ?? Sparkles;
          const isSelected = activeCollectionId === card.id;

          return (
            <div
              key={card.id}
              role="button"
              tabIndex={0}
              onClick={() => {
                if (isSelected) {
                  onClearCollection();
                } else {
                  onSelectCollection(card);
                }
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  if (isSelected) onClearCollection();
                  else onSelectCollection(card);
                }
              }}
              className={`group relative flex flex-col justify-between overflow-hidden rounded-2xl border p-4 text-right transition-all duration-200 cursor-pointer focus:outline-none focus:ring-2 focus:ring-blue-600 ${
                isSelected
                  ? "border-blue-600 bg-blue-50/70 shadow-md ring-2 ring-blue-600/30 dark:border-blue-500 dark:bg-blue-950/40 dark:ring-blue-500/20"
                  : "border-slate-200/90 bg-white hover:border-slate-300 hover:shadow-md dark:border-slate-800 dark:bg-slate-900/90 dark:hover:border-slate-700"
              }`}
            >
              <div>
                <div className="mb-2.5 flex items-center justify-between">
                  <span
                    className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[10px] font-black ${
                      isSelected
                        ? "bg-blue-600 text-white"
                        : "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300"
                    }`}
                  >
                    <IconComp className="size-3" />
                    {card.tag}
                  </span>

                  <span className="text-[11px] font-black text-slate-500 dark:text-slate-400">
                    {fmtInt(card.itemCount)} صنف
                  </span>
                </div>

                <h4 className="text-sm font-black text-slate-900 dark:text-slate-100 group-hover:text-blue-600 dark:group-hover:text-blue-400">
                  {card.title}
                </h4>

                <p className="mt-1 line-clamp-2 text-xs font-bold leading-relaxed text-slate-600 dark:text-slate-300">
                  {card.description}
                </p>
              </div>

              <div className="mt-4 flex items-center justify-between border-t border-slate-100 pt-3 dark:border-slate-800">
                <span className="text-xs font-black text-blue-600 dark:text-blue-400">
                  {card.cta || "استعراض الأصناف"}
                </span>

                <div
                  className={`flex size-6 items-center justify-center rounded-full transition ${
                    isSelected
                      ? "bg-blue-600 text-white"
                      : "bg-slate-100 text-slate-600 group-hover:bg-blue-600 group-hover:text-white dark:bg-slate-800 dark:text-slate-300"
                  }`}
                >
                  {isSelected ? (
                    <Check className="size-3.5" />
                  ) : (
                    <ArrowLeft className="size-3.5" />
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
