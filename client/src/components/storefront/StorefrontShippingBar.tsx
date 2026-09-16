import React from "react";
import { Truck, CheckCircle2 } from "lucide-react";
import { fmtInt } from "@/lib/money";

interface StorefrontShippingBarProps {
  cartSubtotal: number;
  freeShippingThreshold: number;
  onOpenCart?: () => void;
  className?: string;
}

export function StorefrontShippingBar({
  cartSubtotal,
  freeShippingThreshold,
  onOpenCart,
  className = "",
}: StorefrontShippingBarProps) {
  if (freeShippingThreshold <= 0) return null;

  const qualifies = cartSubtotal >= freeShippingThreshold;
  const remaining = Math.max(freeShippingThreshold - cartSubtotal, 0);
  const progressPercent = Math.min(
    100,
    Math.max(0, Math.round((cartSubtotal / freeShippingThreshold) * 100)),
  );

  return (
    <div
      className={`relative overflow-hidden rounded-2xl border border-slate-200/80 bg-white p-3.5 shadow-sm transition-all duration-300 dark:border-slate-800 dark:bg-slate-900 ${className}`}
      role="region"
      aria-label="شريط تقدم الشحن المجاني"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <div
            className={`flex size-8 shrink-0 items-center justify-center rounded-xl transition-colors duration-300 ${
              qualifies
                ? "bg-emerald-600 text-white shadow-sm"
                : "bg-blue-600 text-white shadow-sm"
            }`}
          >
            {qualifies ? (
              <CheckCircle2 aria-hidden className="size-4 animate-in zoom-in duration-200" />
            ) : (
              <Truck aria-hidden className="size-4" />
            )}
          </div>
          <div className="text-right">
            {qualifies ? (
              <p className="flex items-center gap-1.5 text-xs font-black text-emerald-700 dark:text-emerald-400">
                <CheckCircle2 aria-hidden className="size-3.5 text-emerald-600" />
                مبارك! طلبك مؤهل الآن للشحن المجاني بالكامل
              </p>
            ) : cartSubtotal === 0 ? (
              <p className="text-xs font-bold text-slate-700 dark:text-slate-200">
                توصيل مجاني للطلبات بقيمة{" "}
                <span className="font-black text-blue-700 dark:text-blue-400">
                  {fmtInt(freeShippingThreshold)} د.ع
                </span>{" "}
                أو أكثر
              </p>
            ) : (
              <p className="text-xs font-bold text-slate-700 dark:text-slate-200">
                أضف{" "}
                <span className="font-black text-orange-600 dark:text-orange-400">
                  {fmtInt(remaining)} د.ع
                </span>{" "}
                فقط لتحصل على{" "}
                <span className="font-black text-emerald-700 dark:text-emerald-400">
                  توصيل مجاني
                </span>
              </p>
            )}
          </div>
        </div>

        {onOpenCart && cartSubtotal > 0 && (
          <button
            type="button"
            onClick={onOpenCart}
            className="text-[11px] font-black text-blue-700 underline underline-offset-4 transition hover:text-orange-600 dark:text-blue-400"
          >
            عرض السلة ({fmtInt(cartSubtotal)} د.ع) ←
          </button>
        )}
      </div>

      {/* شريط التقدم التفاعلي المتدرج */}
      <div className="mt-2.5">
        <div className="relative h-2.5 w-full overflow-hidden rounded-full bg-slate-200/80 dark:bg-slate-700">
          <div
            className={`store-shimmer-bar h-full rounded-full transition-all duration-500 ease-out ${
              qualifies
                ? "bg-gradient-to-r from-emerald-500 to-teal-400"
                : "bg-gradient-to-r from-blue-600 via-indigo-500 to-orange-500"
            }`}
            style={{ width: `${progressPercent}%` }}
            role="progressbar"
            aria-valuenow={progressPercent}
            aria-valuemin={0}
            aria-valuemax={100}
          />
        </div>
      </div>
    </div>
  );
}
