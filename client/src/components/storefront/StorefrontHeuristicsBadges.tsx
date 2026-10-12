import React from "react";
import { Sparkles, Droplets, Zap, GraduationCap, Briefcase, ShieldCheck } from "lucide-react";

export interface HeuristicBadgeItem {
  key: string;
  label: string;
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" | "false" }>;
  tone: "amber" | "blue" | "emerald" | "purple";
}

interface StorefrontHeuristicsBadgesProps {
  productName?: string;
  category?: string | null;
  description?: string | null;
  isCustomizable?: boolean;
  isBundle?: boolean;
  className?: string;
  limit?: number;
}

export function getProductHeuristics(params: {
  productName?: string;
  category?: string | null;
  description?: string | null;
  isCustomizable?: boolean;
  isBundle?: boolean;
}): HeuristicBadgeItem[] {
  const name = (params.productName ?? "").toLowerCase();
  const cat = (params.category ?? "").toLowerCase();
  const desc = (params.description ?? "").toLowerCase();
  const allText = `${name} ${cat} ${desc}`;

  const badges: HeuristicBadgeItem[] = [];

  // 1. ورق فاخر وخامات راقية للمطبوعات والكروت
  if (
    allText.includes("كارت") ||
    allText.includes("كروت") ||
    allText.includes("بروشور") ||
    allText.includes("فولدر") ||
    allText.includes("ورق") ||
    allText.includes("طباعة") ||
    allText.includes("كوشيه")
  ) {
    badges.push({
      key: "paper_quality",
      label: "ورق كوشيه فاخر 350 غم",
      icon: Sparkles,
      tone: "amber",
    });
    badges.push({
      key: "water_resistant",
      label: "طباعة ليزرية مقاومة للماء والمسح",
      icon: Droplets,
      tone: "blue",
    });
  }

  // 2. خيارات التخرج والجامعات
  if (
    allText.includes("تخرج") ||
    allText.includes("وشاح") ||
    allText.includes("روب") ||
    allText.includes("درع") ||
    allText.includes("جامع") ||
    allText.includes("طالب")
  ) {
    badges.push({
      key: "graduation",
      label: "الخيار المفضل لطلبة الجامعات",
      icon: GraduationCap,
      tone: "purple",
    });
  }

  // 3. باقات وحلول الشركات والمكاتب
  if (
    params.isBundle ||
    allText.includes("شركة") ||
    allText.includes("مكتب") ||
    allText.includes("ختم") ||
    allText.includes("مؤسس") ||
    allText.includes("عقد")
  ) {
    badges.push({
      key: "corporate",
      label: "معتمد لتأسيس المكاتب والشركات",
      icon: Briefcase,
      tone: "emerald",
    });
  }

  // 4. سرعة التجهيز والشحن
  badges.push({
    key: "fast_dispatch",
    label: "تجهيز وتسليم فوري خلال 24-48 ساعة",
    icon: Zap,
    tone: "emerald",
  });

  return badges;
}

const TONE_CLASSES: Record<HeuristicBadgeItem["tone"], string> = {
  amber: "border-amber-200/80 bg-amber-50/70 text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-300",
  blue: "border-sky-200/80 bg-sky-50/70 text-sky-900 dark:border-sky-900/50 dark:bg-sky-950/40 dark:text-sky-300",
  purple: "border-purple-200/80 bg-purple-50/70 text-purple-900 dark:border-purple-900/50 dark:bg-purple-950/40 dark:text-purple-300",
  emerald: "border-emerald-200/80 bg-emerald-50/70 text-emerald-900 dark:border-emerald-900/50 dark:bg-emerald-950/40 dark:text-emerald-300",
};

export function StorefrontHeuristicsBadges({
  productName,
  category,
  description,
  isCustomizable,
  isBundle,
  className = "",
  limit = 2,
}: StorefrontHeuristicsBadgesProps) {
  const badges = getProductHeuristics({
    productName,
    category,
    description,
    isCustomizable,
    isBundle,
  }).slice(0, limit);

  if (badges.length === 0) return null;

  return (
    <div className={`flex flex-wrap items-center gap-1.5 ${className}`} aria-label="ميزات ومواصفات المنتج">
      {badges.map((b) => {
        const Icon = b.icon;
        return (
          <span
            key={b.key}
            className={`inline-flex items-center gap-1 rounded-lg border px-2 py-0.5 text-[10px] font-bold transition shadow-2xs ${TONE_CLASSES[b.tone]}`}
          >
            <Icon aria-hidden="true" className="size-3 shrink-0" />
            <span>{b.label}</span>
          </span>
        );
      })}
    </div>
  );
}
