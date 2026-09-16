import { useState, useMemo } from "react";
import { useQuranAudio } from "./QuranAudioContext";
import { QURAN_RECITERS, QURAN_SURAHS, type QuranReciter, type QuranSurah } from "./quranData";
import { QuranReciterModal } from "./QuranReciterModal";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Search,
  BookOpen,
  Play,
  Pause,
  Sparkles,
  Mic2,
  ChevronDown,
  SkipForward,
  SkipBack,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";

const POPULAR_SURAH_IDS = [1, 18, 36, 55, 56, 67]; // الفاتحة، الكهف، يس، الرحمن، الواقعة، الملك
const QUICK_RECITER_IDS = ["afs", "basit_murattal", "maher", "minshawi_murattal"];

function formatTime(seconds: number): string {
  if (isNaN(seconds) || seconds < 0) return "00:00";
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

export function QuranStationDrawer() {
  const {
    drawerOpen,
    closeDrawer,
    currentSurah,
    currentReciter,
    isPlaying,
    currentTime,
    duration,
    isMuted,
    playSurah,
    togglePlay,
    setReciter,
    nextSurah,
    prevSurah,
    toggleMute,
    seek,
  } = useQuranAudio();

  const [searchQuery, setSearchQuery] = useState("");
  const [reciterModalOpen, setReciterModalOpen] = useState(false);

  // تصفية السور حسب البحث
  const filteredSurahs = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return QURAN_SURAHS;
    return QURAN_SURAHS.filter(
      (s) =>
        s.name.includes(q) ||
        s.englishName.toLowerCase().includes(q) ||
        String(s.id).includes(q)
    );
  }, [searchQuery]);

  const handlePlaySurah = (surah: QuranSurah) => {
    if (currentSurah.id === surah.id && isPlaying) {
      togglePlay();
    } else {
      playSurah(surah.id, currentReciter.id);
    }
  };

  const progressPercent = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;

  return (
    <>
      <Sheet open={drawerOpen} onOpenChange={(open) => !open && closeDrawer()}>
        <SheetContent
          side="left"
          dir="rtl"
          className="w-full sm:max-w-md md:max-w-lg p-0 flex flex-col bg-card border-e"
        >
          {/* رأس النافذة */}
          <SheetHeader className="p-4 border-b bg-muted/30 shrink-0">
            <div className="flex items-center gap-2.5">
              <div className="flex size-9 items-center justify-center rounded-xl bg-primary/10 text-primary shadow-2xs">
                <BookOpen className="size-5" aria-hidden />
              </div>
              <div className="min-w-0">
                <SheetTitle className="text-base font-bold">
                  مشغل القرآن الكريم — إذاعة الرؤية
                </SheetTitle>
                <p className="text-xs text-muted-foreground">
                  فهرس السور الـ114 ونخبة من كبار القرّاء
                </p>
              </div>
            </div>
            <SheetDescription className="sr-only">
              فهرس سور القرآن الكريم واختيار القراء والتحكم بالتلاوة
            </SheetDescription>
          </SheetHeader>

          <div className="flex flex-col flex-1 min-h-0 divide-y">
            {/* بطاقة القارئ المعتمد المحدثة والأنيقة */}
            <div className="p-3 bg-muted/20 shrink-0 space-y-2">
              <div className="flex items-center justify-between gap-2 p-2.5 rounded-xl border border-primary/20 bg-card shadow-2xs">
                <div className="flex items-center gap-2.5 min-w-0 flex-1">
                  <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <Mic2 className="size-4" aria-hidden />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-[10px] text-muted-foreground font-medium leading-tight">
                      القارئ المعتمد
                    </div>
                    <div className="text-xs font-bold text-foreground truncate">
                      {currentReciter.name}
                    </div>
                  </div>
                </div>

                {/* زر فتح نافذة اختيار القراء الـ17 */}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setReciterModalOpen(true)}
                  className="h-7 text-xs px-2.5 rounded-lg border-primary/30 text-primary hover:bg-primary/10 gap-1 shrink-0"
                >
                  <span>تغيير القارئ</span>
                  <ChevronDown className="size-3 opacity-70" aria-hidden />
                </Button>
              </div>

              {/* أزرار التبديل السريع لأشهر القراء */}
              <div className="flex items-center gap-1 overflow-x-auto pb-0.5 scrollbar-none">
                <span className="text-[10px] text-muted-foreground shrink-0 me-1">أشهر القراء:</span>
                {QUICK_RECITER_IDS.map((id) => {
                  const r = QURAN_RECITERS.find((rec) => rec.id === id);
                  if (!r) return null;
                  const isSelected = r.id === currentReciter.id;
                  return (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => {
                        setReciter(r);
                        if (isPlaying) playSurah(currentSurah.id, r.id);
                      }}
                      className={cn(
                        "shrink-0 px-2 py-0.5 rounded-md text-[10px] font-medium transition-colors border",
                        isSelected
                          ? "bg-primary text-primary-foreground border-primary"
                          : "bg-card border-border/80 text-muted-foreground hover:bg-muted hover:text-foreground"
                      )}
                    >
                      {r.name.split(" ")[0]} {r.name.split(" ")[1] ?? ""}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* محرك البحث واختصارات السور الشائعة */}
            <div className="p-3 bg-card space-y-2 shrink-0">
              <div className="relative">
                <Search className="absolute right-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" aria-hidden />
                <Input
                  type="text"
                  placeholder="ابحث باسم السورة أو رقمها (مثال: الكهف، 18)..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pe-9 ps-8 h-9 text-xs"
                />
                {searchQuery && (
                  <button
                    type="button"
                    onClick={() => setSearchQuery("")}
                    className="absolute left-2.5 top-1/2 -translate-y-1/2 p-0.5 rounded text-muted-foreground hover:text-foreground"
                    aria-label="مسح البحث"
                  >
                    <X className="size-3.5" />
                  </button>
                )}
              </div>

              {/* السور الأكثر طلباً */}
              <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5 scrollbar-none">
                <span className="text-[10px] font-medium text-muted-foreground shrink-0 flex items-center gap-1">
                  <Sparkles className="size-3 text-amber-500" aria-hidden />
                  المفضلة:
                </span>
                {POPULAR_SURAH_IDS.map((id) => {
                  const s = QURAN_SURAHS.find((item) => item.id === id);
                  if (!s) return null;
                  const isCurrent = currentSurah.id === s.id;
                  return (
                    <button
                      key={id}
                      type="button"
                      onClick={() => handlePlaySurah(s)}
                      className={cn(
                        "shrink-0 px-2 py-0.5 text-[11px] rounded-md transition font-medium border",
                        isCurrent
                          ? "bg-primary/10 border-primary text-primary font-bold"
                          : "bg-muted/40 border-transparent text-muted-foreground hover:bg-muted hover:text-foreground"
                      )}
                    >
                      {s.name}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* قائمة السور الكاملة */}
            <ScrollArea className="flex-1 p-2">
              <div className="space-y-1">
                {filteredSurahs.map((surah) => {
                  const isCurrent = currentSurah.id === surah.id;
                  const isCurrentPlaying = isCurrent && isPlaying;

                  return (
                    <div
                      key={surah.id}
                      className={cn(
                        "flex items-center justify-between p-2 rounded-xl transition border",
                        isCurrent
                          ? "bg-primary/10 border-primary/40 shadow-xs ring-1 ring-primary/20"
                          : "bg-card border-transparent hover:bg-muted/40 hover:border-border/60"
                      )}
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        {/* رقم السورة */}
                        <span
                          className={cn(
                            "flex size-7 shrink-0 items-center justify-center rounded-lg text-xs font-mono font-bold tabular-nums",
                            isCurrent
                              ? "bg-primary text-primary-foreground"
                              : "bg-muted text-muted-foreground"
                          )}
                        >
                          {surah.id}
                        </span>

                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className={cn("font-bold text-sm", isCurrent && "text-primary")}>
                              سورة {surah.name}
                            </span>
                            <span className="text-[10px] text-muted-foreground px-1.5 py-0.2 rounded bg-muted">
                              {surah.type}
                            </span>
                          </div>
                          <span className="text-[11px] text-muted-foreground tabular-nums">
                            {surah.ayahCount} آية
                          </span>
                        </div>
                      </div>

                      {/* زر التشغيل المحسن والمميز */}
                      <Button
                        type="button"
                        size="icon"
                        onClick={() => handlePlaySurah(surah)}
                        className={cn(
                          "size-8 rounded-full transition-all flex items-center justify-center",
                          isCurrentPlaying
                            ? "bg-primary text-primary-foreground ring-2 ring-primary/30 shadow-xs"
                            : isCurrent
                            ? "bg-primary/15 text-primary hover:bg-primary/25"
                            : "bg-muted/60 text-muted-foreground hover:bg-primary/15 hover:text-primary"
                        )}
                        title={isCurrentPlaying ? "إيقاف مؤقت" : `تشغيل سورة ${surah.name}`}
                        aria-label={isCurrentPlaying ? "إيقاف مؤقت" : `تشغيل سورة ${surah.name}`}
                      >
                        {isCurrentPlaying ? (
                          <Pause className="size-3.5 fill-current" aria-hidden />
                        ) : (
                          <Play className="size-3.5 fill-current me-0.5" aria-hidden />
                        )}
                      </Button>
                    </div>
                  );
                })}

                {filteredSurahs.length === 0 && (
                  <div className="py-12 text-center text-sm text-muted-foreground">
                    لا توجد سور مطابقة لـ &quot;{searchQuery}&quot;
                  </div>
                )}
              </div>
            </ScrollArea>

            {/* شريط التحكم السفلي الدائم داخل الدرج */}
            <div className="p-3 border-t bg-card shrink-0 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-bold text-foreground truncate">
                      سورة {currentSurah.name}
                    </span>
                    <span className="text-[10px] text-muted-foreground truncate">
                      ({currentReciter.name.split(" ")[0]})
                    </span>
                  </div>
                </div>

                {/* أزرار التحكم بالتشغيل */}
                <div className="flex items-center gap-1.5 shrink-0">
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="size-7 rounded-lg text-muted-foreground hover:text-foreground"
                    onClick={prevSurah}
                    title="السورة السابقة"
                  >
                    <SkipBack className="size-3.5" />
                  </Button>

                  <Button
                    type="button"
                    size="icon"
                    className={cn(
                      "size-8 rounded-full shadow-xs",
                      isPlaying
                        ? "bg-primary text-primary-foreground"
                        : "bg-primary text-primary-foreground"
                    )}
                    onClick={togglePlay}
                    title={isPlaying ? "إيقاف مؤقت" : "تشغيل"}
                  >
                    {isPlaying ? (
                      <Pause className="size-4 fill-current" />
                    ) : (
                      <Play className="size-4 fill-current me-0.5" />
                    )}
                  </Button>

                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="size-7 rounded-lg text-muted-foreground hover:text-foreground"
                    onClick={nextSurah}
                    title="السورة التالية"
                  >
                    <SkipForward className="size-3.5" />
                  </Button>

                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className={cn(
                      "size-7 rounded-lg",
                      isMuted ? "text-destructive" : "text-muted-foreground hover:text-foreground"
                    )}
                    onClick={toggleMute}
                    title={isMuted ? "إلغاء كتم الصوت" : "كتم الصوت"}
                  >
                    {isMuted ? <VolumeX className="size-3.5" /> : <Volume2 className="size-3.5" />}
                  </Button>
                </div>
              </div>

              {/* شريط التقدم */}
              <div className="space-y-0.5">
                <div
                  className="w-full bg-muted h-1.5 rounded-full overflow-hidden cursor-pointer hover:h-2 transition-all relative"
                  onClick={(e) => {
                    if (!duration) return;
                    const rect = e.currentTarget.getBoundingClientRect();
                    const clickX = e.clientX - rect.left;
                    const ratio = Math.max(0, Math.min(1, 1 - clickX / rect.width));
                    seek(ratio * duration);
                  }}
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
          </div>
        </SheetContent>
      </Sheet>

      {/* نافذة اختيار القراء المتخصصة */}
      <QuranReciterModal
        open={reciterModalOpen}
        onOpenChange={setReciterModalOpen}
      />
    </>
  );
}
