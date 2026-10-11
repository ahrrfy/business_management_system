import React from "react";
import { TrendingUp, Flame, CheckCircle } from "lucide-react";
import { formatQuantity } from "@shared/quantityFormat";

interface StorefrontSocialProofTickerProps {
  soldCount?: number | null;
  productName?: string;
  className?: string;
}

export function StorefrontSocialProofTicker({
  soldCount = 0,
  productName,
  className = "",
}: StorefrontSocialProofTickerProps) {
  const count = soldCount ?? 0;
  if (count < 3) return null;

  let text = "";
  let icon = null;
  let badgeTone = "";

  if (count >= 10) {
    text = `تم طلب هذا المنتج أكثر من ${formatQuantity(count)} مرة في بغداد والمحافظات`;
    icon = <Flame aria-hidden className="size-3.5 text-orange-600 dark:text-orange-400" />;
    badgeTone = "border-orange-200/90 bg-orange-50/70 text-orange-950 dark:border-orange-800/50 dark:bg-orange-950/30 dark:text-orange-300";
  } else if (count >= 3) {
    text = `منتج موثوق: تم طلبه ${formatQuantity(count)} مرات بنجاح`;
    icon = <TrendingUp aria-hidden className="size-3.5 text-blue-600 dark:text-blue-400" />;
    badgeTone = "border-blue-200/90 bg-blue-50/70 text-blue-950 dark:border-blue-800/50 dark:bg-blue-950/30 dark:text-blue-300";
  }

  return (
    <div
      className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-[11px] font-bold shadow-xs ${badgeTone} ${className}`}
      role="status"
      aria-label="مؤشر إقبال المتسوقين"
    >
      <div className="shrink-0">{icon}</div>
      <p className="min-w-0 flex-1 leading-snug">{text}</p>
    </div>
  );
}
