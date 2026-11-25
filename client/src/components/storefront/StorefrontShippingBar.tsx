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
      className={`rounded-xl border border-slate-900/[0.08] bg-white p-3.5 dark:border-slate-800 dark:bg-slate-900 ${className}`}
      role="region"
      aria-label="شريط تقدم الشحن المجاني"
    >
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <div className="flex items-center gap-2">
          {qualifies ? (
            <CheckCircle2 aria-hidden className="size-4 shrink-0 text-[var(--store-brand)]" />
          ) : (
            <Truck aria-hidden className="size-4 shrink-0 text-slate-500 dark:text-slate-400" />
          )}
          <div className="text-right">
            {qualifies ? (
              <p className="text-xs font-semibold text-[var(--store-brand)]">
                الطلب مؤهل الآن للشحن المجاني
              </p>
            ) : cartSubtotal === 0 ? (
              <p className="text-xs font-medium text-slate-700 dark:text-slate-200">
                شحن مجاني للطلبات من{" "}
                <span className="font-bold text-slate-900 tabular-nums dark:text-white">
                  {fmtInt(freeShippingThreshold)} د.ع
                </span>{" "}
                أو أكثر
              </p>
            ) : (
              <p className="text-xs font-medium text-slate-700 dark:text-slate-200">
                أضف{" "}
                <span className="font-bold text-slate-900 tabular-nums dark:text-white">
                  {fmtInt(remaining)} د.ع
                </span>{" "}
                للحصول على شحن مجاني
              </p>
            )}
          </div>
        </div>

        {onOpenCart && cartSubtotal > 0 && (
          <button
            type="button"
            onClick={onOpenCart}
            className="text-[11px] font-semibold text-[var(--store-brand)] hover:underline dark:text-blue-400"
          >
            عرض السلة
          </button>
        )}
      </div>

      <div className="mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
        <div
          className={`h-full rounded-full transition-[width,background-color] duration-300 ease-out ${
            qualifies ? "bg-[#1d1d1f] dark:bg-white" : "bg-[var(--store-brand)]"
          }`}
          style={{ width: `${progressPercent}%` }}
        />
      </div>
    </div>
  );
}
