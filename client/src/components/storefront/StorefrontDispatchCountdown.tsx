import React, { useEffect, useState } from "react";
import { Clock, ShieldCheck } from "lucide-react";

export function StorefrontDispatchCountdown() {
  const [timeLeft, setTimeLeft] = useState<{ hours: number; minutes: number; seconds: number } | null>(null);

  useEffect(() => {
    function computeCutoff() {
      const now = new Date();
      // بغداد بتوقيت موحد UTC+3 دون تغيير صيفي
      const nowUtc = now.getTime();
      // موعد الشحن اليومي 3:00 عصراً بتوقيت بغداد = 12:00:00 UTC
      const cutoffUtc = new Date(now);
      cutoffUtc.setUTCHours(12, 0, 0, 0);

      let targetMs = cutoffUtc.getTime();
      if (nowUtc >= targetMs) {
        const nextDayUtc = new Date(now);
        nextDayUtc.setUTCDate(nextDayUtc.getUTCDate() + 1);
        nextDayUtc.setUTCHours(7, 0, 0, 0);
        targetMs = nextDayUtc.getTime();
      }

      const diffMs = Math.max(0, targetMs - nowUtc);
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
      aria-label="موعد تجهيز الشحنة القادمة"
      className="rounded-xl border border-slate-900/[0.08] bg-white px-3.5 py-2.5 text-slate-700 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs font-medium">
          <Clock aria-hidden className="size-4 shrink-0 text-[var(--store-brand)]" />
          <span>التجهيز للشحنة القادمة خلال</span>
          <span
            dir="ltr"
            className="inline-flex items-center rounded-md bg-slate-100 px-2 py-0.5 font-mono text-xs font-bold text-slate-900 tabular-nums whitespace-nowrap dark:bg-slate-800 dark:text-slate-100"
          >
            {pad(timeLeft.hours)}:{pad(timeLeft.minutes)}:{pad(timeLeft.seconds)}
          </span>
        </div>

        <div className="flex items-center gap-1.5 text-[11px] font-medium text-slate-500 dark:text-slate-400 whitespace-nowrap">
          <ShieldCheck aria-hidden className="size-3.5 text-slate-500 dark:text-slate-400" />
          <span>توصيل لجميع المحافظات • دفع عند الاستلام</span>
        </div>
      </div>
    </div>
  );
}
