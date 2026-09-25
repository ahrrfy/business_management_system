import React from "react";
import {
  PenTool,
  GraduationCap,
  Briefcase,
  ChevronLeft,
  Tag,
  LayoutGrid,
  Palette,
  BookOpen,
  Sparkles,
} from "lucide-react";
import { trpc } from "@/lib/trpc";

export type ThematicFilterType = "category" | "keyword" | "deal";

export interface ThematicSelectEvent {
  id: string;
  title: string;
  tag: string;
  itemCount: number;
  productIds: number[];
  filterType?: ThematicFilterType;
  filterValue?: string;
}

export interface StorefrontThematicGridProps {
  onSelectCollection?: (event: ThematicSelectEvent) => void;
  onSelectKeyword?: (keyword: string) => void;
}

const ICON_MAP = {
  Briefcase,
  GraduationCap,
  PenTool,
  Tag,
  LayoutGrid,
  Palette,
  BookOpen,
  Sparkles,
} as const;

export function StorefrontThematicGrid({
  onSelectCollection,
  onSelectKeyword,
}: StorefrontThematicGridProps) {
  const query = trpc.storefront.thematicCollections.useQuery(undefined, {
    staleTime: 60_000,
  });

  const collections = query.data ?? [];

  if (query.isLoading && collections.length === 0) {
    return (
      <section aria-label="تشكيلات تحريرية منتقاة" className="mt-12">
        <div className="mb-5 flex items-end justify-between">
          <div className="space-y-2">
            <div className="h-3 w-28 rounded-full bg-slate-200 dark:bg-slate-800 animate-pulse" />
            <div className="h-6 w-64 rounded-full bg-slate-200 dark:bg-slate-800 animate-pulse" />
          </div>
        </div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-64 rounded-3xl border border-slate-200/50 bg-slate-900/60 p-6 shadow-md animate-pulse"
            />
          ))}
        </div>
      </section>
    );
  }

  if (collections.length === 0) {
    return null;
  }

  function handleCardClick(col: (typeof collections)[number]) {
    if (onSelectCollection) {
      onSelectCollection({
        id: col.id,
        title: col.title,
        tag: col.tag,
        itemCount: col.itemCount,
        productIds: col.productIds ?? [],
        filterType: col.filterType,
        filterValue: col.filterValue,
      });
    } else if (onSelectKeyword && col.filterValue) {
      onSelectKeyword(col.filterValue);
    }
  }

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
        {collections.map((col) => {
          const IconComponent = (col.iconName && ICON_MAP[col.iconName as keyof typeof ICON_MAP]) || Sparkles;

          return (
            <article
              key={col.id}
              role="button"
              tabIndex={0}
              onClick={() => handleCardClick(col)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  handleCardClick(col);
                }
              }}
              className={`group relative flex flex-col justify-between overflow-hidden rounded-3xl border ${col.borderColor} bg-gradient-to-br ${col.bgGradient} p-5 sm:p-6 text-white shadow-lg transition-all duration-300 hover:-translate-y-1 hover:shadow-2xl cursor-pointer focus:outline-none focus:ring-2 focus:ring-white/50`}
            >
              <div className="pointer-events-none absolute -right-12 -top-12 size-40 rounded-full bg-white/5 blur-2xl" />

              <div>
                <div className="flex items-center justify-between">
                  <span className="flex size-10 items-center justify-center rounded-2xl bg-white/10 backdrop-blur-md">
                    <IconComponent aria-hidden className="size-5 text-white/90" />
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
                <div className="inline-flex w-full items-center justify-between rounded-xl bg-white/10 px-4 py-2.5 text-xs font-black text-white transition group-hover:bg-white group-hover:text-slate-950">
                  <span className="truncate">{col.cta}</span>
                  <ChevronLeft aria-hidden className="size-4 shrink-0 transition-transform group-hover:-translate-x-1" />
                </div>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
