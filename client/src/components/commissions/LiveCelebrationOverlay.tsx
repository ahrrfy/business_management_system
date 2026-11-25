import React, { useState, useEffect, useRef } from "react";
import { Trophy, Award, Sparkles, X, TrendingUp } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { fmtInt } from "@/lib/money";

interface LiveCelebrationOverlayProps {
  branchId?: number;
  className?: string;
}

export function LiveCelebrationOverlay({
  branchId,
  className = "",
}: LiveCelebrationOverlayProps) {
  const [currentCelebration, setCurrentCelebration] = useState<{
    id: string;
    employeeName: string;
    employeePhotoUrl: string | null;
    orderNumber: string;
    dealAmount: string;
    commissionEarned: string;
    celebrationType: "BIG_DEAL" | "TARGET_100";
  } | null>(null);

  const seenIdsRef = useRef<Set<string>>(new Set());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const query = trpc.commissions.performance.recentCelebrations.useQuery(
    branchId ? { branchId } : undefined,
    {
      refetchInterval: 25_000,
      staleTime: 10_000,
    }
  );

  useEffect(() => {
    const list = query.data ?? [];
    if (list.length === 0) return;

    // Pick the most recent unseen celebration
    const unseen = list.find((c) => !seenIdsRef.current.has(c.id));
    if (unseen) {
      seenIdsRef.current.add(unseen.id);
      setCurrentCelebration(unseen);

      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        setCurrentCelebration(null);
      }, 5500); // 5.5 seconds display
    }
  }, [query.data]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  if (!currentCelebration) return null;

  return (
    <aside
      aria-label="إشعار الاحتفال اللحظي"
      aria-live="polite"
      className={`fixed top-4 left-1/2 -translate-x-1/2 z-[9999] w-[92vw] max-w-md pointer-events-auto transition-all duration-300 animate__animated animate__fadeInDown animate__faster ${className}`}
    >
      <div className="relative overflow-hidden rounded-2xl border border-amber-400/60 bg-gradient-to-r from-amber-950/95 via-slate-900/95 to-slate-950/95 p-4 shadow-2xl backdrop-blur-md text-white">
        {/* Decorative corner glow */}
        <div className="absolute -top-10 -right-10 size-24 rounded-full bg-amber-500/20 blur-xl pointer-events-none" />

        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="relative flex size-12 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-tr from-amber-500 to-amber-300 text-slate-950 shadow-md">
              {currentCelebration.employeePhotoUrl ? (
                <img
                  src={currentCelebration.employeePhotoUrl}
                  alt={currentCelebration.employeeName}
                  className="size-full rounded-2xl object-cover"
                />
              ) : (
                <Trophy className="size-6 text-slate-950" />
              )}
              <span className="absolute -bottom-1 -right-1 flex size-5 items-center justify-center rounded-full bg-slate-900 border border-amber-400 text-amber-400">
                <Sparkles className="size-3" />
              </span>
            </div>

            <div>
              <div className="flex items-center gap-1.5">
                <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/20 px-2 py-0.5 text-[10px] font-black text-amber-300 border border-amber-500/30">
                  <Award className="size-3" />
                  نجم اللحظة
                </span>
                <span className="text-[11px] font-bold text-slate-400">
                  طلب {currentCelebration.orderNumber}
                </span>
              </div>

              <h4 className="mt-0.5 text-sm font-black text-amber-100">
                {currentCelebration.employeeName}
              </h4>
            </div>
          </div>

          <button
            type="button"
            onClick={() => setCurrentCelebration(null)}
            className="flex size-7 items-center justify-center rounded-full bg-slate-800/80 text-slate-400 hover:text-white transition"
            aria-label="إغلاق الإشعار"
          >
            <X className="size-3.5" />
          </button>
        </div>

        <div className="mt-3 rounded-xl border border-white/10 bg-white/5 p-2.5">
          <p className="text-xs leading-relaxed text-slate-200 font-bold">
            أغلق صفقة بقيمة{" "}
            <span className="font-black text-amber-300 underline decoration-amber-400/50">
              {fmtInt(Number(currentCelebration.dealAmount))} د.ع
            </span>{" "}
            وأضاف{" "}
            <span className="font-black text-emerald-400">
              +{fmtInt(Number(currentCelebration.commissionEarned))} د.ع
            </span>{" "}
            لعمولته اليوم.. برافو ومبارك للجميع!
          </p>
        </div>
      </div>
    </aside>
  );
}
