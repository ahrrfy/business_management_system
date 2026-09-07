import { useState, useMemo } from "react";
import { useQuranAudio } from "./QuranAudioContext";
import { QURAN_RECITERS, type QuranReciter } from "./quranData";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Search, UserCheck, Check, Mic2, Sparkles, X } from "lucide-react";
import { cn } from "@/lib/utils";

interface QuranReciterModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const HARAMAIN_IDS = new Set(["maher", "shuraim", "yasser", "hudhaify"]);
const MUJAWWAD_IDS = new Set(["basit_mujawwad", "minshawi_mujawwad"]);

type FilterCategory = "all" | "murattal" | "mujawwad" | "haramain";

export function QuranReciterModal({ open, onOpenChange }: QuranReciterModalProps) {
  const { currentReciter, setReciter, isPlaying, playSurah, currentSurah } = useQuranAudio();
  const [search, setSearch] = useState("");
  const [activeCategory, setActiveCategory] = useState<FilterCategory>("all");

  const filteredReciters = useMemo(() => {
    const q = search.trim().toLowerCase();
    return QURAN_RECITERS.filter((reciter) => {
      // بحث نصي
      const matchesSearch =
        !q ||
        reciter.name.toLowerCase().includes(q) ||
        reciter.style.toLowerCase().includes(q);

      if (!matchesSearch) return false;

      // تصفية الفئة
      if (activeCategory === "haramain") return HARAMAIN_IDS.has(reciter.id);
      if (activeCategory === "mujawwad") return MUJAWWAD_IDS.has(reciter.id);
      if (activeCategory === "murattal") return !MUJAWWAD_IDS.has(reciter.id);
      return true;
    });
  }, [search, activeCategory]);

  const handleSelect = (reciter: QuranReciter) => {
    setReciter(reciter);
    if (isPlaying) {
      playSurah(currentSurah.id, reciter.id);
    }
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        dir="rtl"
        className="sm:max-w-xl p-0 gap-0 overflow-hidden bg-card border-border shadow-2xl"
      >
        <DialogHeader className="p-4 border-b bg-muted/30">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="flex size-9 items-center justify-center rounded-xl bg-primary/10 text-primary shadow-2xs">
                <Mic2 className="size-5" aria-hidden />
              </div>
              <div>
                <DialogTitle className="text-base font-bold text-foreground">
                  اختيار القارئ
                </DialogTitle>
                <p className="text-xs text-muted-foreground">
                  تلاوات بأصوات كبار قراء العالم الإسلامي (17 قارئاً معتمداً)
                </p>
              </div>
            </div>
          </div>
          <DialogDescription className="sr-only">
            نافذة اختيار القارئ من بين نخبة قراء القرآن الكريم
          </DialogDescription>
        </DialogHeader>

        {/* حقل البحث والفلاتر */}
        <div className="p-3 border-b bg-card space-y-2.5">
          <div className="relative">
            <Search className="absolute right-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" aria-hidden />
            <Input
              type="text"
              placeholder="ابحث باسم القارئ (مثال: عبد الباسط، المعيقلي، العفاسي)..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pe-9 ps-8 h-9 text-xs"
              autoFocus
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch("")}
                className="absolute left-2.5 top-1/2 -translate-y-1/2 p-0.5 rounded text-muted-foreground hover:text-foreground"
                aria-label="مسح البحث"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>

          {/* فئات الفلترة */}
          <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5 scrollbar-none">
            <Button
              type="button"
              variant={activeCategory === "all" ? "default" : "outline"}
              size="sm"
              onClick={() => setActiveCategory("all")}
              className="h-7 text-xs px-2.5 rounded-full"
            >
              الكل (17)
            </Button>
            <Button
              type="button"
              variant={activeCategory === "murattal" ? "default" : "outline"}
              size="sm"
              onClick={() => setActiveCategory("murattal")}
              className="h-7 text-xs px-2.5 rounded-full"
            >
              المصحف المرتل (15)
            </Button>
            <Button
              type="button"
              variant={activeCategory === "mujawwad" ? "default" : "outline"}
              size="sm"
              onClick={() => setActiveCategory("mujawwad")}
              className="h-7 text-xs px-2.5 rounded-full"
            >
              المصحف المجوّد (2)
            </Button>
            <Button
              type="button"
              variant={activeCategory === "haramain" ? "default" : "outline"}
              size="sm"
              onClick={() => setActiveCategory("haramain")}
              className="h-7 text-xs px-2.5 rounded-full gap-1"
            >
              <Sparkles className="size-3 text-amber-500" aria-hidden />
              <span>أئمة الحرمين (4)</span>
            </Button>
          </div>
        </div>

        {/* شبكة القراء */}
        <ScrollArea className="max-h-[380px] p-3">
          {filteredReciters.length === 0 ? (
            <div className="py-8 text-center text-xs text-muted-foreground">
              لا يوجد قارئ يطابق بحثك «{search}».
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {filteredReciters.map((reciter) => {
                const isSelected = reciter.id === currentReciter.id;
                const isHaramain = HARAMAIN_IDS.has(reciter.id);
                const isMujawwad = MUJAWWAD_IDS.has(reciter.id);

                return (
                  <button
                    key={reciter.id}
                    type="button"
                    onClick={() => handleSelect(reciter)}
                    className={cn(
                      "flex items-center justify-between p-2.5 rounded-xl border text-start transition-all group cursor-pointer",
                      isSelected
                        ? "bg-primary/10 border-primary text-primary shadow-xs ring-1 ring-primary/40"
                        : "bg-card border-border/80 hover:border-primary/40 hover:bg-muted/40"
                    )}
                  >
                    <div className="flex items-center gap-2.5 min-w-0 flex-1">
                      <div
                        className={cn(
                          "flex size-8 shrink-0 items-center justify-center rounded-lg text-xs font-bold transition-colors",
                          isSelected
                            ? "bg-primary text-primary-foreground"
                            : "bg-muted text-muted-foreground group-hover:bg-primary/15 group-hover:text-primary"
                        )}
                      >
                        {isSelected ? (
                          <Check className="size-4" aria-hidden />
                        ) : (
                          <UserCheck className="size-4" aria-hidden />
                        )}
                      </div>

                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="text-xs font-bold text-foreground truncate group-hover:text-primary transition-colors">
                            {reciter.name}
                          </span>
                        </div>
                        <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
                          <span>{reciter.style}</span>
                          {isHaramain && (
                            <span className="px-1 py-0.2 rounded bg-amber-500/15 text-amber-700 dark:text-amber-300 text-[10px] font-medium">
                              الحرم
                            </span>
                          )}
                          {isMujawwad && (
                            <span className="px-1 py-0.2 rounded bg-indigo-500/15 text-indigo-700 dark:text-indigo-300 text-[10px] font-medium">
                              مجوّد
                            </span>
                          )}
                        </div>
                      </div>
                    </div>

                    {isSelected && (
                      <span className="shrink-0 text-[10px] font-bold text-primary px-1.5 py-0.5 rounded bg-primary/10">
                        محدد
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
