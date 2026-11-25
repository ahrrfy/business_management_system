import React from "react";
import { Truck, PackageCheck, CheckCircle2 } from "lucide-react";
import { fmtInt } from "@/lib/money";

export interface StorefrontMilestoneBarProps {
  cartSubtotal: number;
  freeShippingThresholdBaghdad?: number | string | null;
  freeShippingThresholdGovernorates?: number | string | null;
  className?: string;
  compact?: boolean;
}

export function StorefrontMilestoneBar({
  cartSubtotal,
  freeShippingThresholdBaghdad,
  freeShippingThresholdGovernorates,
  className = "",
  compact = false,
}: StorefrontMilestoneBarProps) {
  const numBaghdad =
    freeShippingThresholdBaghdad != null && Number(freeShippingThresholdBaghdad) > 0
      ? Math.round(Number(freeShippingThresholdBaghdad))
      : null;
  const numGov =
    freeShippingThresholdGovernorates != null && Number(freeShippingThresholdGovernorates) > 0
      ? Math.round(Number(freeShippingThresholdGovernorates))
      : null;

  if (!numBaghdad && !numGov) {
    return null;
  }

  if (numBaghdad && numGov && numBaghdad !== numGov) {
    const tierLower = Math.min(numBaghdad, numGov);
    const tierHigher = Math.max(numBaghdad, numGov);
    const isLowerBaghdad = tierLower === numBaghdad;

    const lowerName = isLowerBaghdad ? "بغداد" : "المحافظات";
    const higherName = isLowerBaghdad ? "كافة المحافظات" : "بغداد";

    const progressPct = Math.min(100, Math.round((cartSubtotal / tierHigher) * 100));
    const lowerUnlocked = cartSubtotal >= tierLower;
    const higherUnlocked = cartSubtotal >= tierHigher;

    let statusText = "";
    if (cartSubtotal <= 0) {
      statusText = `التوصيل المجاني داخل بغداد من ${fmtInt(numBaghdad)} د.ع وللمحافظات من ${fmtInt(numGov)} د.ع`;
    } else if (!lowerUnlocked) {
      const diff = tierLower - cartSubtotal;
      statusText = `أضف ${fmtInt(diff)} د.ع للتوصيل المجاني داخل ${lowerName}`;
    } else if (!higherUnlocked) {
      const diff = tierHigher - cartSubtotal;
      statusText = `تم بلوغ توصيل ${lowerName} المجاني — أضف ${fmtInt(diff)} د.ع لـ ${higherName}`;
    } else {
      statusText = "الطلب مؤهل للتوصيل المجاني لكافة المحافظات";
    }

    const markerPct = Math.round((tierLower / tierHigher) * 100);

    if (compact) {
      return (
        <div className={`flex flex-col gap-1.5 ${className}`}>
          <div className="flex items-center justify-between text-[11px] font-semibold">
            <span className="flex items-center gap-1.5 text-slate-200">
              {higherUnlocked ? (
                <PackageCheck aria-hidden className="size-3.5 text-white" />
              ) : (
                <Truck aria-hidden className="size-3.5 text-slate-300" />
              )}
              <span className="truncate">{statusText}</span>
            </span>
            <span className="shrink-0 text-slate-200 tabular-nums">{progressPct}%</span>
          </div>
          <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
            <div
              className="h-full rounded-full bg-white transition-[width] duration-300 ease-out"
              style={{ width: `${progressPct}%` }}
            />
          </div>
        </div>
      );
    }

    return (
      <aside
        aria-label="تفاصيل التوصيل المجاني"
        className={`rounded-xl border border-slate-900/[0.08] bg-white px-3.5 py-3 dark:border-slate-800 dark:bg-slate-900 ${className}`}
      >
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2 min-w-0">
            {higherUnlocked ? (
              <PackageCheck aria-hidden className="size-4 shrink-0 text-[var(--store-brand)]" />
            ) : (
              <Truck aria-hidden className="size-4 shrink-0 text-slate-500 dark:text-slate-400" />
            )}
            <p className="text-xs font-semibold text-slate-800 dark:text-slate-100 leading-snug line-clamp-2 sm:line-clamp-1">
              {statusText}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5 text-[11px] font-medium text-slate-500 tabular-nums dark:text-slate-400">
            <span className={lowerUnlocked ? "inline-flex items-center gap-1 text-[var(--store-brand)] font-semibold" : "inline-flex items-center gap-1"}>
              {lowerUnlocked && <CheckCircle2 aria-hidden className="size-3.5" />}
              {lowerName}: {fmtInt(tierLower)}
            </span>
            <span className="text-slate-300 dark:text-slate-700">·</span>
            <span className={higherUnlocked ? "inline-flex items-center gap-1 text-[var(--store-brand)] font-semibold" : "inline-flex items-center gap-1"}>
              {higherUnlocked && <CheckCircle2 aria-hidden className="size-3.5" />}
              {higherName}: {fmtInt(tierHigher)}
            </span>
          </div>
        </div>

        <div className="relative mt-2 h-1.5 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
          <div
            className="h-full rounded-full bg-[var(--store-brand)] transition-[width] duration-300 ease-out"
            style={{ width: `${progressPct}%` }}
          />
          <div
            className="absolute top-0 bottom-0 w-px bg-white/90 dark:bg-slate-950"
            style={{ left: `${markerPct}%` }}
          />
        </div>
      </aside>
    );
  }

  const singleTier = (numBaghdad || numGov)!;
  const regionLabel =
    numBaghdad && numGov
      ? "لكافة المحافظات"
      : numBaghdad
        ? "داخل بغداد"
        : "لكافة المحافظات";

  const progressPct = Math.min(100, Math.round((cartSubtotal / singleTier) * 100));
  const isUnlocked = cartSubtotal >= singleTier;

  let statusText = "";
  if (cartSubtotal <= 0) {
    statusText = `توصيل مجاني ${regionLabel} للطلبات من ${fmtInt(singleTier)} د.ع`;
  } else if (!isUnlocked) {
    const diff = singleTier - cartSubtotal;
    statusText = `أضف ${fmtInt(diff)} د.ع للتوصيل المجاني ${regionLabel}`;
  } else {
    statusText = `الطلب مؤهل للتوصيل المجاني ${regionLabel}`;
  }

  if (compact) {
    return (
      <div className={`flex flex-col gap-1.5 ${className}`}>
        <div className="flex items-center justify-between text-[11px] font-semibold">
          <span className="flex items-center gap-1.5 text-slate-200">
            <Truck aria-hidden className="size-3.5 text-slate-300" />
            <span className="truncate">{statusText}</span>
          </span>
          <span className="shrink-0 text-slate-200 tabular-nums">{progressPct}%</span>
        </div>
        <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
          <div
            className="h-full rounded-full bg-white transition-[width] duration-300 ease-out"
            style={{ width: `${progressPct}%` }}
          />
        </div>
      </div>
    );
  }

  return (
    <aside
      aria-label="تفاصيل التوصيل المجاني"
      className={`rounded-xl border border-slate-900/[0.08] bg-white px-3.5 py-3 dark:border-slate-800 dark:bg-slate-900 ${className}`}
    >
      <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2 min-w-0">
          <Truck aria-hidden className="size-4 shrink-0 text-slate-500 dark:text-slate-400" />
          <p className="truncate text-xs font-semibold text-slate-800 dark:text-slate-100">
            {statusText}
          </p>
        </div>
        <span className="text-[11px] font-medium text-slate-500 tabular-nums dark:text-slate-400">
          {regionLabel} ({fmtInt(singleTier)})
        </span>
      </div>

      <div className="relative mt-2 h-1.5 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
        <div
          className="h-full rounded-full bg-[var(--store-brand)] transition-[width] duration-300 ease-out"
          style={{ width: `${progressPct}%` }}
        />
      </div>
    </aside>
  );
}
