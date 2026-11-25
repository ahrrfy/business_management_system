import React from "react";
import {
  Briefcase,
  GraduationCap,
  PenTool,
  Tag,
  LayoutGrid,
  Palette,
  BookOpen,
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
  Sparkles: Layers,
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
      aria-label="مجموعات مختارة"
      className={`w-full rounded-2xl border border-slate-900/[0.08] bg-white p-4 sm:p-6 dark:border-slate-800 dark:bg-slate-900 ${className}`}
    >
      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 className="store-display-title text-base sm:text-lg font-bold text-slate-900 dark:text-slate-100">
            مجموعات حسب الاستخدام
          </h3>
          <p className="mt-0.5 text-xs font-medium text-slate-500 dark:text-slate-400">
            باقات وتجهيزات جاهزة للمكاتب والعمل اليومي
          </p>
        </div>

        {activeCollectionId && (
          <button
            type="button"
            onClick={onClearCollection}
            className="inline-flex touch-manipulation items-center gap-1.5 self-start rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold text-slate-700 transition-[transform,background-color] duration-150 ease-out hover:bg-slate-100 active:scale-[0.97] dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
          >
            <X className="size-3.5" />
            <span>إلغاء التصفية</span>
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {cards.map((card) => {
          const IconComp = ICON_MAP[card.iconName] ?? Layers;
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
              className={`group flex cursor-pointer touch-manipulation flex-col justify-between rounded-xl border p-4 text-right transition-[transform,border-color,background-color] duration-150 ease-out focus:outline-none focus:ring-2 focus:ring-[var(--store-brand)] active:scale-[0.985] ${
                isSelected
                  ? "border-[var(--store-brand)] bg-slate-50 ring-1 ring-[var(--store-brand)] dark:bg-slate-800"
                  : "border-slate-900/[0.08] bg-[#f8f8fa] hover:border-slate-900/20 hover:bg-white dark:border-slate-800 dark:bg-slate-800/50 dark:hover:border-slate-700"
              }`}
            >
              <div>
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-slate-500 dark:text-slate-400">
                    <IconComp className="size-3.5" />
                    {card.tag}
                  </span>

                  <span className="text-[11px] font-medium text-slate-500 tabular-nums dark:text-slate-400">
                    {fmtInt(card.itemCount)} صنف
                  </span>
                </div>

                <h4 className="text-sm font-bold text-slate-900 dark:text-slate-100">
                  {card.title}
                </h4>

                <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-slate-600 dark:text-slate-300">
                  {card.description}
                </p>
              </div>

              <div className="mt-3.5 flex items-center justify-between border-t border-slate-900/[0.06] pt-2.5 text-xs font-semibold text-[var(--store-brand)] dark:border-slate-800 dark:text-blue-400">
                <span>{card.cta || "عرض المجموعة"}</span>
                {isSelected ? (
                  <Check className="size-3.5" />
                ) : (
                  <ArrowLeft className="size-3.5 transition-transform duration-150 group-hover:-translate-x-0.5" />
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
