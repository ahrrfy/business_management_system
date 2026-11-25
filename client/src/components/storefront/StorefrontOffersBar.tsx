/**
 * StorefrontOffersBar — شريط العروض الفعّالة اليوم بتصميم Apple نظيف ومتناغم مع هوية المتجر.
 * يعرض الحملات والخصومات السارية حالياً بلا أي زخارف اصطناعية أو ألوان متنافرة.
 */

import { ArrowLeft, BadgePercent, Check, Clock, X } from "lucide-react";
import type { RouterOutputs } from "@/lib/trpc";

export type LiveStoreOffer = RouterOutputs["storefront"]["offers"][number];

function computeUrgencyBadge(effectiveTo?: string | null): string | null {
  if (!effectiveTo) return null;
  const endYmd = effectiveTo.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(endYmd)) return null;
  const endDayUtc = Date.parse(`${endYmd}T00:00:00Z`);
  if (!Number.isFinite(endDayUtc)) return null;
  const baghdadTodayYmd = new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);
  const todayDayUtc = Date.parse(`${baghdadTodayYmd}T00:00:00Z`);
  const diffDays = Math.round((endDayUtc - todayDayUtc) / 86_400_000);
  if (diffDays < 0) return null;
  if (diffDays === 0) return "اليوم الأخير";
  if (diffDays === 1) return "ينتهي غداً";
  if (diffDays <= 7) return `ينتهي خلال ${diffDays} أيام`;
  return null;
}

interface StorefrontOffersBarProps {
  offers: LiveStoreOffer[];
  activeOfferId: number | null;
  onSelectOffer: (offer: LiveStoreOffer) => void;
  onClearOffer: () => void;
  embedded?: boolean;
  className?: string;
}

export function StorefrontOffersBar({
  offers,
  activeOfferId,
  onSelectOffer,
  onClearOffer,
  embedded = false,
  className = "",
}: StorefrontOffersBarProps) {
  const visibleOffers = offers.slice(0, 10);
  if (visibleOffers.length === 0) return null;

  return (
    <div
      aria-label="العروض الفعّالة اليوم"
      className={
        embedded
          ? `${className}`
          : `w-full rounded-2xl sm:rounded-3xl border border-slate-900/[0.08] bg-white p-4 sm:p-5 shadow-2xs dark:border-slate-800 dark:bg-slate-900 ${className}`
      }
    >
      {!embedded && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2.5">
            <span className="flex size-8 items-center justify-center rounded-xl bg-[var(--store-accent)] text-white shadow-2xs">
              <BadgePercent aria-hidden className="size-4" />
            </span>
            <div>
              <h2 className="store-display-title text-sm sm:text-base font-bold text-[#1d1d1f] dark:text-slate-100">
                حملات التوفير السارية اليوم
              </h2>
              <p className="text-[11px] font-medium text-[#6e6e73] dark:text-slate-400">
                اختر أي عرض لتصفية الأصناف المتوفرة المشمولة بالسعر المخفّض
              </p>
            </div>
          </div>

          {activeOfferId != null && (
            <button
              type="button"
              onClick={onClearOffer}
              className="inline-flex items-center gap-1 rounded-full bg-[#1d1d1f] px-3 py-1 text-xs font-bold text-white transition-transform hover:opacity-90 active:scale-95 dark:bg-white dark:text-[#1d1d1f]"
            >
              <X aria-hidden className="size-3.5" />
              عرض كل الكتالوج
            </button>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-stretch gap-2.5">
        {visibleOffers.map((offer) => {
          const isSelected = activeOfferId === offer.id;
          const badge =
            offer.summary ||
            (offer.type === "PERCENT"
              ? `خصم ${Number(offer.discountPercent)}%`
              : `خصم ${Number(offer.discountAmount)} د.ع`);
          const urgency = computeUrgencyBadge(offer.effectiveTo);
          return (
            <button
              key={offer.id}
              type="button"
              onClick={() => (isSelected ? onClearOffer() : onSelectOffer(offer))}
              className={`group flex min-w-[240px] flex-1 items-center justify-between gap-3 rounded-2xl border p-3 text-right transition-transform duration-150 active:scale-[0.985] ${
                isSelected
                  ? "border-[#1d1d1f] bg-[#1d1d1f] text-white shadow-sm dark:border-white dark:bg-white dark:text-[#1d1d1f]"
                  : "border-slate-900/[0.08] bg-[#f5f5f7] text-[#1d1d1f] hover:-translate-y-0.5 hover:bg-[#ebebef] dark:border-slate-800 dark:bg-slate-800/70 dark:text-slate-100"
              }`}
            >
              <div className="min-w-0 flex-1">
                <div className="mb-1 flex flex-wrap items-center gap-1.5">
                  <span
                    className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[10px] font-bold ${
                      isSelected
                        ? "bg-white/15 text-white dark:bg-black/10 dark:text-[#1d1d1f]"
                        : "bg-[var(--store-accent)] text-white"
                    }`}
                  >
                    <BadgePercent aria-hidden className="size-2.5" />
                    <span>{badge}</span>
                  </span>
                  {offer.targetCount != null && offer.targetCount > 0 && (
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-bold tabular-nums ${
                        isSelected
                          ? "bg-white/15 text-white/90 dark:bg-black/10 dark:text-[#1d1d1f]"
                          : "bg-white text-[#1d1d1f] ring-1 ring-slate-900/[0.06] dark:bg-slate-900 dark:text-slate-200"
                      }`}
                    >
                      {offer.targetCount} صنف مشمول
                    </span>
                  )}
                  {urgency && (
                    <span
                      className={`inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-[10px] font-bold ${
                        isSelected
                          ? "bg-white/15 text-white"
                          : "bg-rose-50 text-rose-700 ring-1 ring-rose-200/80"
                      }`}
                    >
                      <Clock aria-hidden className="size-2.5" />
                      {urgency}
                    </span>
                  )}
                </div>
                <div className="line-clamp-1 text-xs sm:text-sm font-bold tracking-tight">
                  {offer.name}
                </div>
              </div>

              <span
                className={`flex size-8 shrink-0 items-center justify-center rounded-full transition-colors ${
                  isSelected
                    ? "bg-white text-[#1d1d1f] dark:bg-[#1d1d1f] dark:text-white"
                    : "bg-white text-[#1d1d1f] shadow-2xs group-hover:bg-[#1d1d1f] group-hover:text-white dark:bg-slate-900 dark:text-slate-100"
                }`}
              >
                {isSelected ? (
                  <Check aria-hidden className="size-4" />
                ) : (
                  <ArrowLeft aria-hidden className="size-4 transition-transform group-hover:-translate-x-0.5" />
                )}
              </span>
            </button>
          );
        })}
        {embedded && activeOfferId != null && (
          <button
            type="button"
            onClick={onClearOffer}
            className="inline-flex items-center gap-1 self-center rounded-full border border-slate-300 bg-white px-3.5 py-2 text-xs font-bold text-[#1d1d1f] transition hover:bg-slate-100 active:scale-95"
          >
            <X aria-hidden className="size-3.5" />
            إلغاء تصفية العرض
          </button>
        )}
      </div>
    </div>
  );
}
