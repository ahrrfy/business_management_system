import React from "react";
import { Truck, Gift, PackageCheck, CheckCircle2 } from "lucide-react";
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

  // إذا كانت العتبتان معطلتين تماماً، لا نعرض شيئاً (صفر وعود كاذبة)
  if (!numBaghdad && !numGov) {
    return null;
  }

  // الحالة 1: عتبتان نشطتان ومختلفتان (مثال: بغداد 35 ألف، المحافظات 60 ألف)
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
      statusText = `شحن مجاني داخل بغداد عند ${fmtInt(numBaghdad)} د.ع، ولكافة المحافظات عند ${fmtInt(numGov)} د.ع`;
    } else if (!lowerUnlocked) {
      const diff = tierLower - cartSubtotal;
      statusText = `تبقى لك ${fmtInt(diff)} د.ع للحصول على شحن مجاني داخل ${lowerName}`;
    } else if (!higherUnlocked) {
      const diff = tierHigher - cartSubtotal;
      statusText = `حققت شحن ${lowerName} المجاني! أضف ${fmtInt(diff)} د.ع لشحن مجاني لـ ${higherName}`;
    } else {
      statusText = "تهانينا! طلبيتك مؤهلة للشحن السريع المجاني والتغليف الفاخر لكافة المحافظات";
    }

    const markerPct = Math.round((tierLower / tierHigher) * 100);

    if (compact) {
      return (
        <div className={`flex flex-col gap-1.5 ${className}`}>
          <div className="flex items-center justify-between text-[11px] font-black">
            <span className="flex items-center gap-1 text-slate-200">
              {higherUnlocked ? (
                <PackageCheck aria-hidden className="size-3.5 text-emerald-400" />
              ) : (
                <Truck aria-hidden className="size-3.5 text-orange-400" />
              )}
              <span className="truncate">{statusText}</span>
            </span>
            <span className="shrink-0 text-emerald-400 tabular-nums">{progressPct}٪</span>
          </div>
          <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
            <div
              className="h-full rounded-full bg-gradient-to-r from-orange-500 to-emerald-400 transition-all duration-500 ease-out"
              style={{ width: `${progressPct}%` }}
            />
          </div>
        </div>
      );
    }

    return (
      <aside
        aria-label="محفز الشحن المجاني"
        className={`relative overflow-hidden rounded-2xl border border-slate-200/80 bg-gradient-to-r from-amber-50/70 via-white to-orange-50/70 p-3.5 shadow-xs transition dark:border-slate-800 dark:from-slate-900 dark:via-slate-900/90 dark:to-slate-800 ${className}`}
      >
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2.5 min-w-0">
            <div
              className={`flex size-8 shrink-0 items-center justify-center rounded-xl transition ${
                higherUnlocked
                  ? "bg-emerald-500 text-white shadow-sm shadow-emerald-500/20"
                  : lowerUnlocked
                  ? "bg-orange-500 text-white shadow-sm shadow-orange-500/20"
                  : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300"
              }`}
            >
              {higherUnlocked ? (
                <PackageCheck aria-hidden className="size-4" />
              ) : (
                <Truck aria-hidden className="size-4" />
              )}
            </div>
            <p className="truncate text-xs font-black text-slate-800 dark:text-slate-100">
              {statusText}
            </p>
          </div>

          <div className="flex items-center gap-3 text-[11px] font-black text-slate-500 dark:text-slate-400">
            <div className="flex items-center gap-1">
              {lowerUnlocked ? (
                <CheckCircle2 aria-hidden className="size-3.5 text-emerald-600 dark:text-emerald-400" />
              ) : (
                <span className="size-2 rounded-full bg-slate-300 dark:bg-slate-700" />
              )}
              <span className={lowerUnlocked ? "text-emerald-700 dark:text-emerald-400" : ""}>
                {lowerName} ({fmtInt(tierLower)})
              </span>
            </div>
            <span className="text-slate-300 dark:text-slate-700">|</span>
            <div className="flex items-center gap-1">
              {higherUnlocked ? (
                <CheckCircle2 aria-hidden className="size-3.5 text-emerald-600 dark:text-emerald-400" />
              ) : (
                <Gift aria-hidden className="size-3.5 text-slate-400" />
              )}
              <span className={higherUnlocked ? "text-emerald-700 dark:text-emerald-400" : ""}>
                {higherName} ({fmtInt(tierHigher)})
              </span>
            </div>
          </div>
        </div>

        <div className="relative mt-2.5 h-2 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
          <div
            className="h-full rounded-full bg-gradient-to-r from-amber-500 via-orange-500 to-emerald-500 transition-all duration-700 ease-out"
            style={{ width: `${progressPct}%` }}
          />
          {/* علامة محطة المرحلة الأولى */}
          <div
            className="absolute top-0 bottom-0 w-0.5 bg-white/80 dark:bg-slate-900"
            style={{ left: `${markerPct}%` }}
            title={`مرحلة شحن ${lowerName} المجاني`}
          />
        </div>
      </aside>
    );
  }

  // الحالة 2: عتبة وحيدة نشطة (بغداد فقط، أو المحافظات فقط، أو كلاهما بنفس القيمة)
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
    statusText = `شحن مجاني ${regionLabel} عند ${fmtInt(singleTier)} د.ع`;
  } else if (!isUnlocked) {
    const diff = singleTier - cartSubtotal;
    statusText = `تبقى لك ${fmtInt(diff)} د.ع للحصول على شحن مجاني ${regionLabel}`;
  } else {
    statusText = `تهانينا! طلبيتك مؤهلة للشحن المجاني ${regionLabel}`;
  }

  if (compact) {
    return (
      <div className={`flex flex-col gap-1.5 ${className}`}>
        <div className="flex items-center justify-between text-[11px] font-black">
          <span className="flex items-center gap-1 text-slate-200">
            {isUnlocked ? (
              <PackageCheck aria-hidden className="size-3.5 text-emerald-400" />
            ) : (
              <Truck aria-hidden className="size-3.5 text-orange-400" />
            )}
            <span className="truncate">{statusText}</span>
          </span>
          <span className="shrink-0 text-emerald-400 tabular-nums">{progressPct}٪</span>
        </div>
        <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
          <div
            className="h-full rounded-full bg-gradient-to-r from-orange-500 to-emerald-400 transition-all duration-500 ease-out"
            style={{ width: `${progressPct}%` }}
          />
        </div>
      </div>
    );
  }

  return (
    <aside
      aria-label="محفز الشحن المجاني"
      className={`relative overflow-hidden rounded-2xl border border-slate-200/80 bg-gradient-to-r from-amber-50/70 via-white to-orange-50/70 p-3.5 shadow-xs transition dark:border-slate-800 dark:from-slate-900 dark:via-slate-900/90 dark:to-slate-800 ${className}`}
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2.5 min-w-0">
          <div
            className={`flex size-8 shrink-0 items-center justify-center rounded-xl transition ${
              isUnlocked
                ? "bg-emerald-500 text-white shadow-sm shadow-emerald-500/20"
                : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300"
            }`}
          >
            {isUnlocked ? (
              <PackageCheck aria-hidden className="size-4" />
            ) : (
              <Truck aria-hidden className="size-4" />
            )}
          </div>
          <p className="truncate text-xs font-black text-slate-800 dark:text-slate-100">
            {statusText}
          </p>
        </div>

        <div className="flex items-center gap-2 text-[11px] font-black text-slate-500 dark:text-slate-400">
          <div className="flex items-center gap-1">
            {isUnlocked ? (
              <CheckCircle2 aria-hidden className="size-3.5 text-emerald-600 dark:text-emerald-400" />
            ) : (
              <span className="size-2 rounded-full bg-slate-300 dark:bg-slate-700" />
            )}
            <span className={isUnlocked ? "text-emerald-700 dark:text-emerald-400" : ""}>
              {regionLabel} ({fmtInt(singleTier)})
            </span>
          </div>
        </div>
      </div>

      <div className="relative mt-2.5 h-2 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
        <div
          className="h-full rounded-full bg-gradient-to-r from-amber-500 via-orange-500 to-emerald-500 transition-all duration-700 ease-out"
          style={{ width: `${progressPct}%` }}
        />
      </div>
    </aside>
  );
}
