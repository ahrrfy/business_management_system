import { useState, useEffect, useRef, Suspense, lazy } from "react";
import { trpc } from "@/lib/trpc";
import type { AnnouncementItem } from "./AnnouncementDetailModal";

const AnnouncementDetailModal = lazy(() =>
  import("./AnnouncementDetailModal").then((m) => ({ default: m.AnnouncementDetailModal })),
);
import {
  Radio,
  ChevronRight,
  ChevronLeft,
  Maximize2,
  Minimize2,
  AlertCircle,
  BellRing,
  Info,
  Flame,
  Volume2,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/utils";

export function BroadcastTicker() {
  const announcementsQuery = trpc.announcements.mine.useQuery(
    { limit: 20 },
    {
      refetchInterval: 30_000,
      refetchOnWindowFocus: true,
      staleTime: 15_000,
    }
  );

  const announcements = (announcementsQuery.data?.rows || []) as AnnouncementItem[];
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
  const [isCollapsed, setIsCollapsed] = useState(() => {
    try {
      return localStorage.getItem("erp.ticker.collapsed") === "1";
    } catch {
      return false;
    }
  });
  const [selectedAnnouncement, setSelectedAnnouncement] = useState<AnnouncementItem | null>(null);

  const autoPlayTimerRef = useRef<number | null>(null);

  // تدوير الإعلانات تلقائياً كل 7 ثوانٍ إلا إذا كان الموظف يمرر مؤشر الفأرة
  useEffect(() => {
    if (announcements.length <= 1 || isPaused || isCollapsed) return;

    autoPlayTimerRef.current = window.setInterval(() => {
      setCurrentIndex((prev) => (prev + 1) % announcements.length);
    }, 7000);

    return () => {
      if (autoPlayTimerRef.current) clearInterval(autoPlayTimerRef.current);
    };
  }, [announcements.length, isPaused, isCollapsed]);

  // تصحيح المؤشر إن تغير طول المصفوفة
  useEffect(() => {
    if (currentIndex >= announcements.length && announcements.length > 0) {
      setCurrentIndex(0);
    }
  }, [announcements.length, currentIndex]);

  const toggleCollapsed = () => {
    setIsCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("erp.ticker.collapsed", next ? "1" : "0");
      } catch {
        // ignore
      }
      return next;
    });
  };

  if (!announcements || announcements.length === 0) {
    return null;
  }

  const current = announcements[currentIndex] || announcements[0];

  const priorityStyles = {
    CRITICAL: {
      badgeBg: "bg-gradient-to-r from-red-600 via-rose-600 to-red-700",
      badgeText: "عاجل وطارئ",
      tickerBorder: "border-red-500/40 dark:border-red-500/50",
      glow: "shadow-[0_0_15px_-3px_rgba(239,68,68,0.3)]",
      barBg: "bg-red-500/5 dark:bg-red-950/20",
      Icon: Flame,
      pulse: "animate-pulse",
    },
    IMPORTANT: {
      badgeBg: "bg-gradient-to-r from-amber-600 via-orange-600 to-amber-700",
      badgeText: "توجيه إداري",
      tickerBorder: "border-amber-500/40 dark:border-amber-500/50",
      glow: "shadow-[0_0_15px_-3px_rgba(245,158,11,0.25)]",
      barBg: "bg-amber-500/5 dark:bg-amber-950/20",
      Icon: AlertCircle,
      pulse: "",
    },
    NORMAL: {
      badgeBg: "bg-gradient-to-r from-blue-700 via-indigo-600 to-sky-700",
      badgeText: "إعلان داخلي",
      tickerBorder: "border-blue-500/30 dark:border-blue-500/40",
      glow: "shadow-[0_0_15px_-3px_rgba(59,130,246,0.2)]",
      barBg: "bg-blue-500/5 dark:bg-blue-950/20",
      Icon: Radio,
      pulse: "",
    },
  }[current.priority] || {
    badgeBg: "bg-muted",
    badgeText: "إعلان",
    tickerBorder: "border-border",
    glow: "",
    barBg: "bg-card",
    Icon: Info,
    pulse: "",
  };

  const BadgeIcon = priorityStyles.Icon;

  // إذا كان مطوياً، نعرض شريطاً صغيراً أو زراً عائماً أنيقاً
  if (isCollapsed) {
    return (
      <div className="w-full px-3 md:px-6 pt-2 pb-0.5 shrink-0" dir="rtl">
        <div className="w-full px-3 py-1.5 bg-muted/40 border border-border/60 rounded-lg flex items-center justify-between text-xs shadow-2xs">
          <button
            type="button"
            onClick={toggleCollapsed}
            className="flex items-center gap-2 text-muted-foreground hover:text-foreground transition font-medium cursor-pointer"
          >
            <span className="flex size-2 rounded-full bg-primary animate-ping" aria-hidden />
            <BadgeIcon className="size-3.5 text-primary" aria-hidden />
            <span>يوجد {announcements.length} إعلانات إدارية نشطة — اضغط لإظهار شريط السبتلايت الإخباري</span>
          </button>
          <button
            type="button"
            onClick={toggleCollapsed}
            className="text-xs text-primary hover:underline flex items-center gap-1 font-semibold cursor-pointer"
          >
            <Maximize2 className="size-3" aria-hidden />
            إظهار الشريط
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      <div dir="rtl" className="w-full px-3 md:px-6 pt-3 pb-1 shrink-0">
        <div
          onMouseEnter={() => setIsPaused(true)}
          onMouseLeave={() => setIsPaused(false)}
          className={cn(
            "w-full rounded-xl border transition-all duration-300 relative overflow-hidden shadow-xs",
            priorityStyles.barBg,
            priorityStyles.tickerBorder,
            priorityStyles.glow
          )}
        >
          <div className="flex items-center justify-between min-h-[40px] px-2.5 sm:px-4 gap-2">
          {/* شارة السبتلايت الإخبارية الفضائية (Spotlight Badge) */}
          <div className="flex items-center shrink-0">
            <div
              className={cn(
                "flex items-center gap-1.5 px-2.5 py-1 rounded-md text-white font-black text-xs tracking-wide shadow-xs",
                priorityStyles.badgeBg,
                priorityStyles.pulse
              )}
            >
              <BadgeIcon className="size-3.5 animate-[spin_4s_linear_infinite]" aria-hidden />
              <span>{priorityStyles.badgeText}</span>
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-white animate-ping ms-0.5" aria-hidden />
            </div>
          </div>

          {/* مسار النص الإخباري المتحرك الانسيابي */}
          <div className="flex-1 min-w-0 overflow-hidden relative mx-2">
            <AnimatePresence mode="wait">
              <motion.div
                key={current.id}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -12 }}
                transition={{ duration: 0.35, ease: "easeInOut" }}
                className="flex items-center gap-2 cursor-pointer group"
                onClick={() => setSelectedAnnouncement(current)}
                title="اضغط لقراءة التفاصيل الكاملة أو الإقرار"
              >
                <span className="font-bold text-xs sm:text-sm text-foreground truncate group-hover:text-primary transition-colors">
                  {current.title}
                </span>
                <span className="text-muted-foreground text-xs hidden md:inline truncate max-w-md">
                  — {current.body.replace(/\n+/g, " ")}
                </span>
                {current.requiresAck && !current.acknowledgedAt && (
                  <span className="shrink-0 text-[10px] font-bold px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-700 dark:text-amber-300 border border-amber-500/30">
                    مطلوب إقرارك
                  </span>
                )}
              </motion.div>
            </AnimatePresence>
          </div>

          {/* أزرار التحكم والخيارات */}
          <div className="flex items-center gap-1 shrink-0 text-muted-foreground">
            {/* عداد الإعلانات */}
            {announcements.length > 1 && (
              <span className="text-[11px] font-mono tabular-nums px-1.5 py-0.5 rounded bg-muted/60 text-foreground font-semibold">
                {currentIndex + 1} / {announcements.length}
              </span>
            )}

            {/* أزرار التنقل */}
            {announcements.length > 1 && (
              <div className="flex items-center">
                <button
                  type="button"
                  onClick={() =>
                    setCurrentIndex((prev) => (prev <= 0 ? announcements.length - 1 : prev - 1))
                  }
                  className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition"
                  title="الإعلان السابق"
                  aria-label="الإعلان السابق"
                >
                  <ChevronRight className="size-4" aria-hidden />
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setCurrentIndex((prev) => (prev + 1) % announcements.length)
                  }
                  className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition"
                  title="الإعلان التالي"
                  aria-label="الإعلان التالي"
                >
                  <ChevronLeft className="size-4" aria-hidden />
                </button>
              </div>
            )}

            {/* زر فتح التفاصيل */}
            <button
              type="button"
              onClick={() => setSelectedAnnouncement(current)}
              className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition"
              title="عرض التفاصيل الكاملة"
              aria-label="عرض التفاصيل الكاملة"
            >
              <Maximize2 className="size-3.5" aria-hidden />
            </button>

            {/* زر طيّ الشريط */}
            <button
              type="button"
              onClick={toggleCollapsed}
              className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition"
              title="تصغير الشريط الإعلاني"
              aria-label="تصغير الشريط الإعلاني"
            >
              <Minimize2 className="size-3.5" aria-hidden />
            </button>
          </div>
        </div>
      </div>
    </div>

      {/* نافذة التفاصيل والإقرار الإداري */}
      {selectedAnnouncement && (
        <Suspense fallback={null}>
          <AnnouncementDetailModal
            announcement={selectedAnnouncement}
            open={Boolean(selectedAnnouncement)}
            onOpenChange={(open) => {
              if (!open) setSelectedAnnouncement(null);
            }}
          />
        </Suspense>
      )}
    </>
  );
}
