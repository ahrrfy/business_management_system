import React, { useEffect, useState } from "react";
import { Clock, Truck, ShieldCheck, Zap } from "lucide-react";

export function StorefrontDispatchCountdown() {
  const [timeLeft, setTimeLeft] = useState<{ hours: number; minutes: number; seconds: number } | null>(null);

  useEffect(() => {
    function computeCutoff() {
      const now = new Date();
      // موعد الشحن اليومي المعتمد: الساعة 3:00 عصراً بتوقيت بغداد
      const cutoff = new Date(now);
      cutoff.setHours(15, 0, 0, 0);

      if (now.getTime() >= cutoff.getTime()) {
        // بعد الساعة الثالثة عصراً: العداد يحسب لموعد شحنة الغد الصباحية 10:00 صباحاً
        cutoff.setDate(cutoff.getDate() + 1);
        cutoff.setHours(10, 0, 0, 0);
      }

      const diffMs = Math.max(0, cutoff.getTime() - now.getTime());
      const hours = Math.floor(diffMs / (1000 * 60 * 60));
      const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
      const seconds = Math.floor((diffMs % (1000 * 60)) / 1000);

      setTimeLeft({ hours, minutes, seconds });
    }

    computeCutoff();
    const timer = setInterval(computeCutoff, 1000);
    return () => clearInterval(timer);
  }, []);

  if (!timeLeft) return null;

  const pad = (n: number) => n.toString().padStart(2, "0");

  return (
    <div
      role="region"
      aria-label="مؤشر الشحن السريع اللحظي"
      className="relative overflow-hidden rounded-2xl border border-emerald-500/30 bg-gradient-to-r from-emerald-50 via-teal-50 to-emerald-100/50 p-3 sm:p-4 text-emerald-950 shadow-xs dark:border-emerald-500/20 dark:from-emerald-950/40 dark:via-slate-900 dark:to-emerald-950/30 dark:text-emerald-100"
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-emerald-600 text-white shadow-xs">
            <Truck aria-hidden className="size-4" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="inline-flex items-center gap-1 rounded-md bg-emerald-600/15 px-1.5 py-0.5 text-[10px] font-black text-emerald-800 dark:bg-emerald-400/15 dark:text-emerald-300">
                <Zap aria-hidden className="size-3" /> شحن اليوم السريع
              </span>
              <span className="text-xs font-bold text-slate-700 dark:text-slate-200">
                اطلب الآن لتشحن طلبيتك ضمن الوجبة القادمة:
              </span>
            </div>
            <p className="mt-0.5 truncate text-[11px] text-slate-500 dark:text-slate-400">
              يصلك أينما كنت في بغداد وكافة محافظات العراق مع خيار الدفع عند الاستلام.
            </p>
          </div>
        </div>

        {/* عداد الوقت التنازلي التفاعلي */}
        <div className="flex items-center justify-between sm:justify-end gap-2 shrink-0 border-t border-emerald-200/60 pt-2 sm:border-0 sm:pt-0 dark:border-emerald-800/60">
          <div className="flex items-center gap-1 font-mono text-xs font-black" dir="ltr">
            <div className="flex flex-col items-center rounded-lg bg-white px-2 py-1 shadow-2xs ring-1 ring-emerald-200 dark:bg-slate-800 dark:ring-emerald-900">
              <span className="text-sm font-extrabold text-emerald-700 dark:text-emerald-300">{pad(timeLeft.hours)}</span>
              <span className="text-[8px] text-slate-400">ساعة</span>
            </div>
            <span className="text-emerald-600 font-bold">:</span>
            <div className="flex flex-col items-center rounded-lg bg-white px-2 py-1 shadow-2xs ring-1 ring-emerald-200 dark:bg-slate-800 dark:ring-emerald-900">
              <span className="text-sm font-extrabold text-emerald-700 dark:text-emerald-300">{pad(timeLeft.minutes)}</span>
              <span className="text-[8px] text-slate-400">دقيقة</span>
            </div>
            <span className="text-emerald-600 font-bold">:</span>
            <div className="flex flex-col items-center rounded-lg bg-white px-2 py-1 shadow-2xs ring-1 ring-emerald-200 dark:bg-slate-800 dark:ring-emerald-900">
              <span className="text-sm font-extrabold text-emerald-700 dark:text-emerald-300">{pad(timeLeft.seconds)}</span>
              <span className="text-[8px] text-slate-400">ثانية</span>
            </div>
          </div>

          <div className="hidden lg:flex items-center gap-1 text-[10px] font-bold text-emerald-800 dark:text-emerald-300">
            <ShieldCheck aria-hidden className="size-3.5 text-emerald-600 dark:text-emerald-400" />
            <span>ضمان فحص قبل الدفع</span>
          </div>
        </div>
      </div>
    </div>
  );
}
