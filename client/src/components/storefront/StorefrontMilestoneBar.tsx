import React from "react";
import { Truck, Gift, PackageCheck, CheckCircle2 } from "lucide-react";
import { fmtInt } from "@/lib/money";

interface StorefrontMilestoneBarProps {
  cartSubtotal: number;
  className?: string;
  compact?: boolean;
}

const TIER_BAGHDAD = 35000;
const TIER_ALL_IRAQ = 60000;

export function StorefrontMilestoneBar({
  cartSubtotal,
  className = "",
  compact = false,
}: StorefrontMilestoneBarProps) {
  const progressPct = Math.min(100, Math.round((cartSubtotal / TIER_ALL_IRAQ) * 100));
  const baghdadUnlocked = cartSubtotal >= TIER_BAGHDAD;
  const allIraqUnlocked = cartSubtotal >= TIER_ALL_IRAQ;

  let statusText = "";
  if (cartSubtotal <= 0) {
    statusText = "شحن مجاني داخل بغداد عند 35,000 د.ع، ولكافة المحافظات عند 60,000 د.ع";
  } else if (!baghdadUnlocked) {
    const diff = TIER_BAGHDAD - cartSubtotal;
    statusText = `تبقى لك ${fmtInt(diff)} د.ع للحصول على شحن مجاني داخل بغداد`;
  } else if (!allIraqUnlocked) {
    const diff = TIER_ALL_IRAQ - cartSubtotal;
    statusText = `حققت شحن بغداد المجاني! أضف ${fmtInt(diff)} د.ع لشحن مجاني لكافة المحافظات`;
  } else {
    statusText = "تهانينا! طلبيتك مؤهلة للشحن السريع المجاني والتغليف الفاخر لكافة المحافظات";
  }

  if (compact) {
    return (
      <div className={`flex flex-col gap-1.5 ${className}`}>
        <div className="flex items-center justify-between text-[11px] font-black">
          <span className="flex items-center gap-1 text-slate-200">
            {allIraqUnlocked ? (
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
              allIraqUnlocked
                ? "bg-emerald-500 text-white shadow-sm shadow-emerald-500/20"
                : baghdadUnlocked
                ? "bg-orange-500 text-white shadow-sm shadow-orange-500/20"
                : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300"
            }`}
          >
            {allIraqUnlocked ? (
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
            {baghdadUnlocked ? (
              <CheckCircle2 aria-hidden className="size-3.5 text-emerald-600 dark:text-emerald-400" />
            ) : (
              <span className="size-2 rounded-full bg-slate-300 dark:bg-slate-700" />
            )}
            <span className={baghdadUnlocked ? "text-emerald-700 dark:text-emerald-400" : ""}>
              بغداد (35 ألف)
            </span>
          </div>
          <span className="text-slate-300 dark:text-slate-700">|</span>
          <div className="flex items-center gap-1">
            {allIraqUnlocked ? (
              <CheckCircle2 aria-hidden className="size-3.5 text-emerald-600 dark:text-emerald-400" />
            ) : (
              <Gift aria-hidden className="size-3.5 text-slate-400" />
            )}
            <span className={allIraqUnlocked ? "text-emerald-700 dark:text-emerald-400" : ""}>
              كل العراق (60 ألف)
            </span>
          </div>
        </div>
      </div>

      <div className="relative mt-2.5 h-2 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
        <div
          className="h-full rounded-full bg-gradient-to-r from-amber-500 via-orange-500 to-emerald-500 transition-all duration-700 ease-out"
          style={{ width: `${progressPct}%` }}
        />
        {/* علامة محطة بغداد عند 58% */}
        <div
          className="absolute top-0 bottom-0 w-0.5 bg-white/80 dark:bg-slate-900"
          style={{ left: `${Math.round((TIER_BAGHDAD / TIER_ALL_IRAQ) * 100)}%` }}
          title="مرحلة شحن بغداد المجاني"
        />
      </div>
    </aside>
  );
}
