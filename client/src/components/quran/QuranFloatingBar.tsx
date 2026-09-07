import { useQuranAudio } from "./QuranAudioContext";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import {
  Play,
  Pause,
  SkipForward,
  SkipBack,
  Volume2,
  VolumeX,
  RotateCcw,
  RotateCw,
  X,
  ListMusic,
  Loader2,
  BookOpen,
} from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { cn } from "@/lib/utils";

function formatTime(seconds: number): string {
  if (isNaN(seconds) || seconds < 0) return "00:00";
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

export function QuranFloatingBar() {
  const {
    currentSurah,
    currentReciter,
    isPlaying,
    isLoading,
    currentTime,
    duration,
    volume,
    isMuted,
    floatingBarVisible,
    togglePlay,
    nextSurah,
    prevSurah,
    seek,
    setVolume,
    toggleMute,
    openDrawer,
    setFloatingBarVisible,
  } = useQuranAudio();

  if (!floatingBarVisible) {
    return (
      <motion.button
        type="button"
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        onClick={() => setFloatingBarVisible(true)}
        className="fixed bottom-16 lg:bottom-4 start-4 z-40 flex items-center gap-2.5 px-3.5 py-2 rounded-full bg-card/95 border border-primary/30 shadow-xl backdrop-blur-md text-foreground hover:border-primary transition-all group"
        title="إظهار مشغل القرآن الكريم الكامل"
      >
        <div
          className={cn(
            "flex size-6 items-center justify-center rounded-full transition-colors",
            isPlaying ? "bg-primary text-primary-foreground" : "bg-primary/10 text-primary"
          )}
        >
          <BookOpen className="size-3.5" aria-hidden />
        </div>
        <div className="flex items-center gap-1.5 text-xs">
          <span className="font-bold">إذاعة القرآن</span>
          <span className="text-muted-foreground font-medium">· سورة {currentSurah.name}</span>
        </div>
        {isPlaying && (
          <span className="flex size-2 rounded-full bg-emerald-500 animate-ping" aria-hidden />
        )}
      </motion.button>
    );
  }

  return (
    <AnimatePresence>
      <motion.div
        initial={{ y: 80, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 80, opacity: 0 }}
        transition={{ type: "spring", stiffness: 300, damping: 25 }}
        className="fixed bottom-16 lg:bottom-4 inset-x-2 sm:inset-x-6 lg:inset-x-auto lg:left-1/2 lg:-translate-x-1/2 lg:w-[680px] z-40"
        dir="rtl"
      >
        <div className="relative flex flex-col gap-2 p-3 sm:p-3.5 rounded-2xl bg-card/95 backdrop-blur-md border border-border/80 shadow-2xl">
          {/* الشريط العلوي للمشغل: بيانات السورة والقارئ + أزرار الخيارات */}
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5 min-w-0">
              <button
                type="button"
                onClick={openDrawer}
                className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
                title="فتح محطة القرآن وقائمة القراء"
              >
                <ListMusic className="size-4.5" aria-hidden />
              </button>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-bold text-sm truncate text-foreground">
                    سورة {currentSurah.name}
                  </span>
                  <span className="inline-flex items-center px-1.5 py-0.2 text-[10px] font-medium rounded-full bg-muted text-muted-foreground">
                    {currentSurah.type}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground truncate">
                  بصوت القارئ {currentReciter.name}
                </p>
              </div>
            </div>

            {/* أدوات التحكم المركزية */}
            <div className="flex items-center gap-1 sm:gap-2">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-8 text-muted-foreground hover:text-foreground"
                onClick={prevSurah}
                title="السورة السابقة"
                aria-label="السورة السابقة"
              >
                <SkipForward className="size-4" aria-hidden />
              </Button>

              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-8 text-muted-foreground hover:text-foreground"
                onClick={() => seek(Math.max(0, currentTime - 10))}
                title="تأخير 10 ثوانٍ"
                aria-label="تأخير 10 ثوانٍ"
              >
                <RotateCcw className="size-3.5" aria-hidden />
              </Button>

              <Button
                type="button"
                variant="default"
                size="icon"
                className="size-9 rounded-full shadow-md bg-primary hover:bg-primary/90 text-primary-foreground"
                onClick={togglePlay}
                disabled={isLoading}
                title={isPlaying ? "إيقاف مؤقت" : "تشغيل"}
                aria-label={isPlaying ? "إيقاف مؤقت" : "تشغيل"}
              >
                {isLoading ? (
                  <Loader2 className="size-4.5 animate-spin" aria-hidden />
                ) : isPlaying ? (
                  <Pause className="size-4.5 fill-current" aria-hidden />
                ) : (
                  <Play className="size-4.5 fill-current me-0.5" aria-hidden />
                )}
              </Button>

              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-8 text-muted-foreground hover:text-foreground"
                onClick={() => seek(Math.min(duration || Infinity, currentTime + 10))}
                title="تقديم 10 ثوانٍ"
                aria-label="تقديم 10 ثوانٍ"
              >
                <RotateCw className="size-3.5" aria-hidden />
              </Button>

              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-8 text-muted-foreground hover:text-foreground"
                onClick={nextSurah}
                title="السورة التالية"
                aria-label="السورة التالية"
              >
                <SkipBack className="size-4" aria-hidden />
              </Button>
            </div>

            {/* مستوى الصوت وزر الإغلاق */}
            <div className="flex items-center gap-1.5">
              <div className="hidden sm:flex items-center gap-1.5 w-24">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-7 text-muted-foreground hover:text-foreground"
                  onClick={toggleMute}
                  title={isMuted ? "إلغاء الكتم" : "كتم الصوت"}
                  aria-label={isMuted ? "إلغاء الكتم" : "كتم الصوت"}
                >
                  {isMuted || volume === 0 ? (
                    <VolumeX className="size-4" aria-hidden />
                  ) : (
                    <Volume2 className="size-4" aria-hidden />
                  )}
                </Button>
                <Slider
                  value={[isMuted ? 0 : volume * 100]}
                  max={100}
                  step={1}
                  onValueChange={(val) => setVolume((val[0] ?? 80) / 100)}
                  aria-label="مستوى الصوت"
                  className="w-16"
                />
              </div>

              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7 rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
                onClick={() => setFloatingBarVisible(false)}
                title="إخفاء شريط المشغل"
                aria-label="إخفاء شريط المشغل"
              >
                <X className="size-4" aria-hidden />
              </Button>
            </div>
          </div>

          {/* شريط التقدم والوقت */}
          <div className="flex items-center gap-2 px-1">
            <span className="text-[11px] font-mono text-muted-foreground tabular-nums w-10 text-end">
              {formatTime(currentTime)}
            </span>
            <Slider
              value={[currentTime]}
              max={duration || 100}
              step={1}
              onValueChange={(val) => seek(val[0] ?? 0)}
              aria-label="شريط تقدم التلاوة"
              className="flex-1"
            />
            <span className="text-[11px] font-mono text-muted-foreground tabular-nums w-10">
              {formatTime(duration)}
            </span>
          </div>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
