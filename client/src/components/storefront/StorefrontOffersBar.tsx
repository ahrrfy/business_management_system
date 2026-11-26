import { BadgePercent, X } from "lucide-react";
import type { RouterOutputs } from "@/lib/trpc";

export type LiveStoreOffer = RouterOutputs["storefront"]["offers"][number];

interface StorefrontOffersBarProps {
  offers: LiveStoreOffer[];
  activeOfferId: number | null;
  onSelectOffer: (offer: LiveStoreOffer) => void;
  onClearOffer: () => void;
  className?: string;
}

export function StorefrontOffersBar({
  offers,
  activeOfferId,
  onSelectOffer,
  onClearOffer,
  className = "",
}: StorefrontOffersBarProps) {
  const visibleOffers = offers.slice(0, 8);
  if (visibleOffers.length === 0) return null;

  return (
    <div
      id="store-deals"
      aria-label="العروض الفعالة اليوم"
      className={`flex items-center gap-1.5 overflow-x-auto py-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden ${className}`}
    >
      {visibleOffers.map((offer) => {
        const isSelected = activeOfferId === offer.id;
        const badge =
          offer.summary ||
          (offer.type === "PERCENT"
            ? `خصم ${Number(offer.discountPercent)}%`
            : `خصم ${Number(offer.discountAmount)} د.ع`);
        return (
          <button
            key={offer.id}
            type="button"
            aria-pressed={isSelected}
            onClick={() => (isSelected ? onClearOffer() : onSelectOffer(offer))}
            className={`inline-flex shrink-0 touch-manipulation items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-bold whitespace-nowrap transition active:scale-[0.98] ${
              isSelected
                ? "border-[#1d1d1f] bg-[#1d1d1f] text-white shadow-2xs dark:border-white dark:bg-white dark:text-[#1d1d1f]"
                : "border-slate-900/[0.08] bg-white text-[#1d1d1f] hover:border-slate-300 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-100"
            }`}
          >
            <BadgePercent
              aria-hidden
              className={`size-3.5 ${isSelected ? "text-white dark:text-[#1d1d1f]" : "text-[var(--store-accent)]"}`}
            />
            <span>{offer.name}</span>
            <span
              className={`rounded-full px-2 py-0.5 text-[10px] font-bold tabular-nums ${
                isSelected
                  ? "bg-white/15 text-white dark:bg-black/10 dark:text-[#1d1d1f]"
                  : "bg-[#f5f5f7] text-[var(--store-accent)] dark:bg-slate-800"
              }`}
            >
              {badge}
            </span>
          </button>
        );
      })}

      {activeOfferId != null && (
        <button
          type="button"
          onClick={onClearOffer}
          className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[#f5f5f7] px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-200/80 dark:bg-slate-800 dark:text-slate-200"
        >
          <X aria-hidden className="size-3.5" />
          <span>الكل</span>
        </button>
      )}
    </div>
  );
}
