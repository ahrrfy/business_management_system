import { useState, Suspense, lazy } from "react";
import { useQuranAudio } from "./QuranAudioContext";
import { Button } from "@/components/ui/button";

const QuranReciterModal = lazy(() =>
  import("./QuranReciterModal").then((m) => ({ default: m.QuranReciterModal })),
);
import {
  BookOpen,
  Play,
  Pause,
  SkipForward,
  SkipBack,
  Volume2,
  VolumeX,
  ListMusic,
  Loader2,
  Mic2,
  ChevronDown,
  ChevronUp,
  RotateCcw,
} from "lucide-react";
import { cn } from "@/lib/utils";

function formatTime(seconds: number): string {
  if (isNaN(seconds) || seconds < 0) return "00:00";
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

export function QuranSidebarCard() {
  const {
    currentSurah,
    currentReciter,
    isPlaying,
    isLoading,
    currentTime,
    duration,
    isMuted,
    togglePlay,
    nextSurah,
    prevSurah,
    toggleMute,
    seek,
    openDrawer,
    savedPosition,
    resumeFromBookmark,
  } = useQuranAudio();

  const [reciterModalOpen, setReciterModalOpen] = useState(false);
  const [isMinimized, setIsMinimized] = useState(() => {
    try {
      const saved = localStorage.getItem("erp.quran.minimized");
      return saved === null ? true : saved === "1";
    } catch {
      return true;
    }
  });

  const toggleMinimized = () => {
    setIsMinimized((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("erp.quran.minimized", next ? "1" : "0");
      } catch {
        // ignore
      }
      return next;
    });
  };

  const progressPercent = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;

  return (
    <>
      <div
        dir="rtl"
        className="mx-2 my-1 rounded-lg border border-white/15 bg-white/10 backdrop-blur-md transition-all overflow-hidden group"
      >
        {/* وضع التصغير الرشيق الافتراضي — سطر واحد بارتفاع 34px يوفّر مساحة القائمة الجانبية */}
        {isMinimized ? (
          <div className="flex items-center justify-between px-2 py-1 gap-1.5 min-h-[34px]">
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-6 rounded-md bg-white/15 text-white hover:bg-white/25 shrink-0"
              onClick={togglePlay}
              disabled={isLoading}
              title={isPlaying ? "إيقاف مؤقت" : "تشغيل تلاوة القرآن"}
              aria-label={isPlaying ? "إيقاف مؤقت" : "تشغيل تلاوة القرآن"}
            >
              {isLoading ? (
                <Loader2 className="size-3 animate-spin" />
              ) : isPlaying ? (
                <Pause className="size-3 fill-current" />
              ) : (
                <Play className="size-3 fill-current me-0.5" />
              )}
            </Button>

            <button
              type="button"
              onClick={toggleMinimized}
              className="min-w-0 flex-1 flex items-center justify-between gap-1 text-start truncate text-[11px] text-white/90 hover:text-white"
              title="اضغط لتوسيع مشغل القرآن الكريم"
            >
              <span className="font-bold truncate">إذاعة القرآن</span>
              <span className="text-[10px] text-white/75 truncate">
                {currentSurah.name} · {currentReciter.name.split(" ")[0]}
              </span>
            </button>

            <div className="flex items-center gap-0.5 shrink-0">
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="size-5 rounded text-white/75 hover:text-white hover:bg-white/15"
                onClick={openDrawer}
                title="فهرس السور (114 سورة)"
                aria-label="فهرس السور"
              >
                <ListMusic className="size-3" aria-hidden />
              </Button>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="size-5 rounded text-white/75 hover:text-white hover:bg-white/15"
                onClick={toggleMinimized}
                title="توسيع المشغل"
                aria-label="توسيع المشغل"
              >
                <ChevronDown className="size-3" />
              </Button>
            </div>
          </div>
        ) : (
          <>
            {/* شريط العنوان وأزرار الفهرس والتصغير عند التوسيع */}
            <div className="flex items-center justify-between px-2.5 pt-1.5 pb-1 gap-1 bg-card/90 text-foreground">
              <div className="flex items-center gap-1.5 min-w-0">
                <div
                  className={cn(
                    "flex size-5 shrink-0 items-center justify-center rounded-md shadow-2xs transition-colors",
                    isPlaying
                      ? "bg-primary text-primary-foreground"
                      : "bg-primary/10 text-primary"
                  )}
                >
                  <BookOpen className="size-3" aria-hidden />
                </div>

                <span className="text-xs font-bold text-foreground truncate">
                  إذاعة القرآن الكريم
                </span>

                {isPlaying && (
                  <div className="flex items-end gap-0.5 h-3 ms-0.5" aria-hidden>
                    <span className="w-0.5 bg-emerald-500 rounded-full animate-[pulse_0.6s_ease-in-out_infinite] h-2" />
                    <span className="w-0.5 bg-emerald-500 rounded-full animate-[pulse_0.4s_ease-in-out_infinite] h-3" />
                    <span className="w-0.5 bg-emerald-500 rounded-full animate-[pulse_0.8s_ease-in-out_infinite] h-1.5" />
                  </div>
                )}
              </div>

              <div className="flex items-center gap-0.5 shrink-0">
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="size-5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted"
                  onClick={openDrawer}
                  title="فهرس السور (114 سورة)"
                  aria-label="فهرس السور"
                >
                  <ListMusic className="size-3" aria-hidden />
                </Button>

                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="size-5 rounded-md text-muted-foreground/70 hover:text-foreground hover:bg-muted"
                  onClick={toggleMinimized}
                  title="تصغير المشغل"
                  aria-label="تصغير المشغل"
                >
                  <ChevronUp className="size-3" />
                </Button>
              </div>
            </div>
          {/* وضع التحكم الكامل والمطور (Full Controls Mode) */}
          <div className="px-2.5 pb-2 pt-1 space-y-1.5 bg-card/90 text-foreground">
            {/* معلومات السورة وزر اختيار القارئ التفاعلي */}
            <div className="flex items-center justify-between gap-1 text-xs">
              {/* اسم السورة وزر الاستئناف — ينقر لفتح درج السور */}
              <div className="flex items-center gap-1 min-w-0">
                <button
                  type="button"
                  onClick={openDrawer}
                  className="font-bold text-foreground hover:text-primary transition-colors truncate max-w-[95px] text-start"
                  title="اضغط لتغيير السورة من الفهرس"
                >
                  {currentSurah.name}
                  <span className="text-[10px] font-normal text-muted-foreground ms-0.5">
                    ({currentSurah.type})
                  </span>
                </button>
                {!isPlaying && savedPosition > 10 && (
                  <button
                    type="button"
                    onClick={resumeFromBookmark}
                    className="inline-flex items-center gap-0.5 px-1 py-0.2 text-[9px] font-bold rounded bg-primary/15 text-primary hover:bg-primary/25 transition-colors cursor-pointer shrink-0"
                    title={`استئناف التلاوة من الدقيقة ${formatTime(savedPosition)}`}
                  >
                    <RotateCcw className="size-2" aria-hidden />
                    <span>{formatTime(savedPosition)}</span>
                  </button>
                )}
              </div>

              {/* زر اختيار القارئ البارز — يفتح نافذة القراء الـ17 */}
              <button
                type="button"
                onClick={() => setReciterModalOpen(true)}
                className="flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-muted/60 hover:bg-primary/15 hover:text-primary text-muted-foreground text-[10px] font-medium transition-colors truncate max-w-[110px]"
                title="اضغط لتغيير القارئ (17 قارئاً معتمداً)"
              >
                <Mic2 className="size-2.5 text-primary shrink-0" aria-hidden />
                <span className="truncate">{currentReciter.name.split(" ").slice(0, 2).join(" ")}</span>
                <ChevronDown className="size-2.5 opacity-60 shrink-0" aria-hidden />
              </button>
            </div>

            {/* أزرار التحكم بالتشغيل المحسنة هندسياً */}
            <div className="flex items-center justify-center gap-1.5 py-0.5">
              {/* السورة السابقة */}
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="size-7 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted active:scale-95 transition-transform"
                onClick={prevSurah}
                title="السورة السابقة"
                aria-label="السورة السابقة"
              >
                <SkipBack className="size-3.5" aria-hidden />
              </Button>

              {/* زر التشغيل والإيقاف الرئيسي — بارز وجذاب */}
              <Button
                type="button"
                size="icon"
                className={cn(
                  "size-9 rounded-full shadow-xs hover:scale-105 active:scale-95 transition-all flex items-center justify-center",
                  isPlaying
                    ? "bg-primary text-primary-foreground ring-2 ring-primary/30"
                    : "bg-primary text-primary-foreground"
                )}
                onClick={togglePlay}
                disabled={isLoading}
                title={isPlaying ? "إيقاف مؤقت (Space)" : "تشغيل تلاوة القرآن"}
                aria-label={isPlaying ? "إيقاف مؤقت" : "تشغيل تلاوة القرآن"}
              >
                {isLoading ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                ) : isPlaying ? (
                  <Pause className="size-4 fill-current" aria-hidden />
                ) : (
                  <Play className="size-4 fill-current me-0.5" aria-hidden />
                )}
              </Button>

              {/* السورة التالية */}
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="size-7 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted active:scale-95 transition-transform"
                onClick={nextSurah}
                title="السورة التالية"
                aria-label="السورة التالية"
              >
                <SkipForward className="size-3.5" aria-hidden />
              </Button>

              {/* كتم / تفعيل الصوت */}
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className={cn(
                  "size-7 rounded-lg transition-colors ms-0.5",
                  isMuted
                    ? "text-destructive hover:bg-destructive/10"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted"
                )}
                onClick={toggleMute}
                title={isMuted ? "إلغاء كتم الصوت" : "كتم الصوت"}
                aria-label={isMuted ? "إلغاء كتم الصوت" : "كتم الصوت"}
              >
                {isMuted ? (
                  <VolumeX className="size-3.5 text-destructive" aria-hidden />
                ) : (
                  <Volume2 className="size-3.5" aria-hidden />
                )}
              </Button>
            </div>

            {/* مسار التقدم الزمني الدقيق */}
            <div className="space-y-0.5 pt-0.5">
              <div
                className="w-full bg-muted h-1.5 rounded-full overflow-hidden cursor-pointer hover:h-2 transition-all relative"
                onClick={(e) => {
                  if (!duration) return;
                  const rect = e.currentTarget.getBoundingClientRect();
                  const clickX = e.clientX - rect.left;
                  // حساب النسبة بدقة (RTL: من اليمين إلى اليسار)
                  const ratio = Math.max(0, Math.min(1, 1 - clickX / rect.width));
                  seek(ratio * duration);
                }}
                title="انقر للانتقال في التلاوة"
              >
                <div
                  className="bg-primary h-full rounded-full transition-all duration-150"
                  style={{ width: `${progressPercent}%` }}
                />
              </div>

              <div className="flex items-center justify-between text-[9px] text-muted-foreground font-mono tabular-nums px-0.5">
                <span>{formatTime(currentTime)}</span>
                <span>{formatTime(duration)}</span>
              </div>
            </div>
          </div>
          </>
        )}
      </div>

      {/* نافذة اختيار القارئ المنفصلة السلسة */}
      {reciterModalOpen && (
        <Suspense fallback={null}>
          <QuranReciterModal
            open={reciterModalOpen}
            onOpenChange={setReciterModalOpen}
          />
        </Suspense>
      )}
    </>
  );
}
