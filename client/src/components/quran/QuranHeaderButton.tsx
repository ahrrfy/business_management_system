import { useQuranAudio } from "./QuranAudioContext";
import { Button } from "@/components/ui/button";
import { BookOpen } from "lucide-react";
import { cn } from "@/lib/utils";

export function QuranHeaderButton() {
  const { isPlaying, isLoading, currentSurah, openDrawer } = useQuranAudio();

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      onClick={openDrawer}
      aria-label={`مشغل القرآن الكريم: ${currentSurah.name}`}
      title={`مشغل القرآن الكريم (${currentSurah.name}) — اضغط للاستعراض والتشغيل`}
      className={cn(
        "relative transition-all duration-300",
        isPlaying ? "text-primary hover:text-primary/90" : "text-muted-foreground hover:text-foreground",
      )}
    >
      <BookOpen className="size-5" aria-hidden />

      {/* مؤشر الموجات الصوتية المصغر عند التشغيل */}
      {isPlaying && (
        <span
          className="absolute -bottom-0.5 left-1.5 flex items-end gap-0.5 h-2.5 px-0.5 py-0.5 rounded bg-background/90 shadow-xs"
          aria-hidden
        >
          <span className="w-0.5 h-full bg-primary rounded-full animate-[pulse_0.6s_ease-in-out_infinite]" />
          <span className="w-0.5 h-2/3 bg-primary rounded-full animate-[pulse_0.9s_ease-in-out_infinite_0.2s]" />
          <span className="w-0.5 h-4/5 bg-primary rounded-full animate-[pulse_0.75s_ease-in-out_infinite_0.4s]" />
        </span>
      )}

      {/* نقطة تحميل إن كان البث جاري التجهيز */}
      {isLoading && !isPlaying && (
        <span
          className="absolute top-1.5 right-1.5 size-2 rounded-full bg-primary animate-ping"
          aria-hidden
        />
      )}
    </Button>
  );
}
