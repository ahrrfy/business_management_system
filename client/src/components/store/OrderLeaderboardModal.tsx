import { useState } from "react";
import { Award, Clock, Flame, Medal, Trophy, Users, Zap } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { trpc } from "@/lib/trpc";

interface OrderLeaderboardModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function OrderLeaderboardModal({
  open,
  onOpenChange,
}: OrderLeaderboardModalProps) {
  const [tab, setTab] = useState<"today" | "month">("today");
  const leaderboardQ = trpc.storeAdmin.orders.leaderboard.useQuery(undefined, {
    enabled: open,
  });

  const list = (tab === "today" ? leaderboardQ.data?.today : leaderboardQ.data?.month) ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <Trophy className="size-5 text-amber-500" aria-hidden />
            <DialogTitle className="text-base font-bold">
              لوحة أبطال التجهيز والمنافسة
            </DialogTitle>
          </div>
        </DialogHeader>

        {/* أزرار التبديل بين اليوم والشهر */}
        <div className="flex rounded-lg bg-muted p-1 gap-1">
          <button
            type="button"
            onClick={() => setTab("today")}
            className={`flex-1 rounded-md py-1.5 text-xs font-bold transition ${
              tab === "today"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            إنجاز اليوم
          </button>
          <button
            type="button"
            onClick={() => setTab("month")}
            className={`flex-1 rounded-md py-1.5 text-xs font-bold transition ${
              tab === "month"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            أبطال الشهر
          </button>
        </div>

        {/* المحتوى وقائمة المتصدرين */}
        <div className="space-y-3 py-2">
          {leaderboardQ.isLoading ? (
            <div className="py-8 text-center text-xs text-muted-foreground">
              جارٍ حساب إحصائيات التجهيز والسرعة…
            </div>
          ) : list.length === 0 ? (
            <div className="py-8 text-center space-y-1 text-muted-foreground">
              <Users className="size-8 mx-auto opacity-40 mb-2" aria-hidden />
              <p className="text-xs font-medium">لا توجد طلبات مجهزة مسجلة في هذه الفترة بعد.</p>
              <p className="text-[11px]">التقط طلباً جديداً وجهزه لتكون أول المتصدرين!</p>
            </div>
          ) : (
            <div className="divide-y rounded-lg border bg-card overflow-hidden">
              {list.map((entry, idx) => {
                const rank = idx + 1;
                return (
                  <div
                    key={entry.userId}
                    className={`p-3 flex items-center justify-between gap-3 text-xs ${
                      rank === 1 ? "bg-amber-500/5" : ""
                    }`}
                  >
                    <div className="flex items-center gap-2.5">
                      {/* رتبة الموظف وأيقونتها */}
                      <div className="size-7 rounded-full flex items-center justify-center font-bold font-mono shrink-0">
                        {rank === 1 ? (
                          <Trophy className="size-4 text-amber-500" aria-hidden />
                        ) : rank === 2 ? (
                          <Medal className="size-4 text-slate-400" aria-hidden />
                        ) : rank === 3 ? (
                          <Award className="size-4 text-amber-700" aria-hidden />
                        ) : (
                          <span className="text-muted-foreground text-xs">{rank}</span>
                        )}
                      </div>

                      <div className="flex flex-col">
                        <span className="font-bold text-foreground">
                          {entry.userName}
                        </span>
                        <span className="text-[11px] text-muted-foreground flex items-center gap-1">
                          <Zap className="size-3 text-primary" aria-hidden />
                          أسرع طلب: {entry.fastestMinutes} د
                        </span>
                      </div>
                    </div>

                    <div className="flex items-center gap-4 text-end">
                      <div className="flex flex-col items-end">
                        <span className="font-bold text-foreground font-mono">
                          {entry.count} طلب
                        </span>
                        <span className="text-[10px] text-muted-foreground flex items-center gap-1">
                          <Clock className="size-2.5" aria-hidden />
                          معدل {entry.avgMinutes} د
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* تنبيه تشجيعي على الحوافز */}
          <div className="flex items-center gap-2 rounded-lg bg-[var(--sem-info-bg)] border border-[var(--sem-info)]/30 p-2.5 text-[11px] text-[var(--sem-info)]">
            <Flame className="size-4 shrink-0 text-amber-500" aria-hidden />
            <span>
              <strong>حافز التجهيز:</strong> كل طلب تنجزه يسجل رصيداً في عمولاتك الشهرية، والتجهيز السريع يرفع تقييمك التنافسي!
            </span>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
