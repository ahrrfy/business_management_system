import { useState } from "react";
import { Crown, Award, Medal, TrendingUp, Tv, Maximize2, Minimize2, Sparkles, User } from "lucide-react";
import { iqd } from "@/lib/hr/ui";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface PodiumRow {
  rank: number;
  employeeId: number;
  employeeName: string;
  position: string | null;
  photoUrl?: string | null;
  branchName: string | null;
  planName: string;
  sales: string;
  effectiveBase: string;
  target: string | null;
  achievementPct: string | null;
  projectedCommission: string;
}

interface LeaderboardPodiumProps {
  rows: PodiumRow[];
  period: string;
}

export function LeaderboardPodium({ rows, period }: LeaderboardPodiumProps) {
  const [tvMode, setTvMode] = useState(false);

  const top3 = rows.slice(0, 3);
  if (top3.length === 0) return null;

  const first = top3[0];
  const second = top3[1];
  const third = top3[2];

  // ترتيب العرض في المنصة: المركز الثاني (يسار)، المركز الأول (وسط وأعلى)، المركز الثالث (يمين)
  return (
    <div
      className={cn(
        "relative rounded-2xl border transition-all duration-300",
        tvMode
          ? "fixed inset-0 z-[120] flex flex-col justify-between overflow-y-auto bg-background/98 p-6 backdrop-blur-md"
          : "border-primary/25 bg-gradient-to-b from-card to-muted/20 p-5 shadow-xs",
      )}
      dir="rtl"
    >
      {/* الرأس والتحكم */}
      <div className="flex items-center justify-between border-b border-border/60 pb-3 mb-4">
        <div className="flex items-center gap-2">
          <div className="grid size-8 place-items-center rounded-xl bg-amber-500/10 text-amber-500">
            <Crown aria-hidden className="size-5" />
          </div>
          <div>
            <h3 className="font-black text-sm sm:text-base text-foreground flex items-center gap-1.5">
              <span>منصة صدارة المبيعات والتكريم — شهر {period}</span>
              <Sparkles aria-hidden className="size-4 text-amber-500 animate-pulse" />
            </h3>
            <p className="text-xs text-muted-foreground">
              المراكز الثلاثة الأولى الأكثر إنجازاً وتحقيقاً للمبيعات والعمولات
            </p>
          </div>
        </div>

        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setTvMode(!tvMode)}
          className="h-8 gap-1.5 text-xs font-bold border-primary/30"
          title={tvMode ? "الخروج من وضع الشاشة الكاملة" : "تفعيل وضع الشاشة التلفزيونية"}
        >
          {tvMode ? (
            <>
              <Minimize2 aria-hidden className="size-3.5" />
              <span>إغلاق وضع الشاشة</span>
            </>
          ) : (
            <>
              <Tv aria-hidden className="size-3.5" />
              <span>وضع شاشة الصالة (TV)</span>
            </>
          )}
        </Button>
      </div>

      {/* منصة التتويج */}
      <div className={cn("grid grid-cols-1 md:grid-cols-3 gap-4 items-end pt-4", tvMode && "max-w-5xl mx-auto my-auto w-full")}>
        {/* المركز الثاني */}
        {second ? (
          <PodiumCard
            row={second}
            rank={2}
            medalColor="border-slate-300 bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200"
            badgeColor="bg-slate-400 text-white"
            medalLabel="المركز الثاني"
            cardHeight="md:min-h-[260px]"
          />
        ) : (
          <div className="hidden md:block" />
        )}

        {/* المركز الأول */}
        {first && (
          <PodiumCard
            row={first}
            rank={1}
            medalColor="border-amber-400 bg-amber-50/80 dark:bg-amber-950/30 text-amber-800 dark:text-amber-200 shadow-md"
            badgeColor="bg-amber-500 text-white shadow-xs"
            medalLabel="بطل الصدارة"
            cardHeight="md:min-h-[300px]"
            isChampion
          />
        )}

        {/* المركز الثالث */}
        {third ? (
          <PodiumCard
            row={third}
            rank={3}
            medalColor="border-amber-700/30 bg-amber-900/5 text-amber-800 dark:text-amber-300"
            badgeColor="bg-amber-700 text-white"
            medalLabel="المركز الثالث"
            cardHeight="md:min-h-[240px]"
          />
        ) : (
          <div className="hidden md:block" />
        )}
      </div>
    </div>
  );
}

function PodiumCard({
  row,
  rank,
  medalColor,
  badgeColor,
  medalLabel,
  cardHeight,
  isChampion = false,
}: {
  row: PodiumRow;
  rank: number;
  medalColor: string;
  badgeColor: string;
  medalLabel: string;
  cardHeight: string;
  isChampion?: boolean;
}) {
  const photo = row.photoUrl;

  return (
    <div
      className={cn(
        "relative flex flex-col items-center justify-between rounded-2xl border-2 p-4 text-center transition-all hover:scale-[1.02]",
        medalColor,
        cardHeight,
        isChampion && "ring-2 ring-amber-400/40",
      )}
    >
      {/* تاج أو شارة المركز */}
      <div className="absolute -top-3.5 flex items-center gap-1 rounded-full px-3 py-0.5 text-xs font-black shadow-xs tracking-wider" style={{ background: isChampion ? "#f59e0b" : undefined }}>
        <span className={badgeColor + " rounded-full px-2 py-0.2"}>{rank}</span>
        <span className="text-[11px] font-bold">{medalLabel}</span>
      </div>

      {/* صورة الموظف */}
      <div className="mt-3 relative">
        <div
          className={cn(
            "size-20 sm:size-24 overflow-hidden rounded-full border-4 bg-card shadow-md mx-auto",
            isChampion ? "border-amber-400" : rank === 2 ? "border-slate-300" : "border-amber-700/40",
          )}
        >
          {photo ? (
            <img src={photo} alt={row.employeeName} className="size-full object-cover" />
          ) : (
            <div className="grid size-full place-items-center bg-muted text-muted-foreground font-black text-xl">
              {row.employeeName.slice(0, 2)}
            </div>
          )}
        </div>
        {isChampion && (
          <div className="absolute -bottom-1 -right-1 grid size-7 place-items-center rounded-full bg-amber-500 text-white shadow-xs">
            <Crown aria-hidden className="size-4" />
          </div>
        )}
      </div>

      {/* تفاصيل الموظف */}
      <div className="my-2 space-y-1">
        <h4 className="font-black text-sm sm:text-base text-foreground leading-tight">
          {row.employeeName}
        </h4>
        <p className="text-xs text-muted-foreground font-medium">
          {row.branchName ? `فرع ${row.branchName}` : "المقر الرئيسي"}
        </p>
      </div>

      {/* الأرقام المالية */}
      <div className="w-full rounded-xl bg-card/80 p-2.5 shadow-2xs border border-border/50 space-y-1.5">
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground font-bold">المبيعات:</span>
          <span className="font-black text-foreground tabular-nums">{iqd(row.effectiveBase)}</span>
        </div>

        {row.achievementPct != null && (
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground font-bold">التحقيق:</span>
            <span
              className={cn(
                "font-black tabular-nums",
                Number(row.achievementPct) >= 100 ? "text-[var(--sem-pos)]" : "text-primary",
              )}
            >
              {Number(row.achievementPct).toLocaleString("ar-IQ-u-nu-latn", { maximumFractionDigits: 1 })}%
            </span>
          </div>
        )}

        <div className="flex items-center justify-between text-xs border-t border-border/40 pt-1">
          <span className="text-muted-foreground font-bold">العمولة المتوقعة:</span>
          <span className="font-black text-primary tabular-nums">
            {iqd(row.projectedCommission)}
          </span>
        </div>
      </div>
    </div>
  );
}
