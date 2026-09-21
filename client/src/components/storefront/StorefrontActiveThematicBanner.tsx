import React from "react";
import { Sparkles, X } from "lucide-react";

interface StorefrontActiveThematicBannerProps {
  thematic: {
    id: string;
    title: string;
    tag: string;
  };
  matchingCount: number;
  onClear: () => void;
}

/**
 * شريط التشكيلة التحريرية المفعّلة — يعرض اسم التشكيلة، وسمها، وعدد الأصناف المطابقة،
 * مع زر إلغاء الفلترة السريع للعودة لكامل الكتالوج.
 */
export function StorefrontActiveThematicBanner({
  thematic,
  matchingCount,
  onClear,
}: StorefrontActiveThematicBannerProps) {
  return (
    <div className="mb-4 flex items-center justify-between rounded-2xl border border-[var(--sem-pos)]/30 bg-[var(--sem-pos-bg)] p-3 text-xs text-[var(--sem-pos)]">
      <div className="flex items-center gap-2">
        <Sparkles aria-hidden className="size-4 shrink-0" />
        <span>
          تشكيلة مفعّلة: <strong className="font-black">{thematic.title}</strong>
        </span>
        <span className="rounded-full bg-white/40 px-2 py-0.5 text-[10px] font-bold dark:bg-black/20">
          {matchingCount} صنف مطابق
        </span>
      </div>
      <button
        type="button"
        onClick={onClear}
        className="inline-flex cursor-pointer items-center gap-1 rounded-xl bg-white/50 px-2.5 py-1 text-xs font-black transition hover:bg-white/80 focus:outline-none focus:ring-2 focus:ring-[var(--sem-pos)] dark:bg-white/10 dark:hover:bg-white/20"
        aria-label="إلغاء فلترة التشكيلة وعرض الكتالوج بالكامل"
      >
        <span>عرض كل المنتجات</span>
        <X aria-hidden className="size-3.5" />
      </button>
    </div>
  );
}
