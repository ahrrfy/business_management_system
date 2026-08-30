import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  DISPLAY_SCALE_LABEL,
  DISPLAY_SCALES,
  readDisplayScale,
  setDisplayScale,
  subscribeDisplayScale,
  type DisplayScale,
} from "@/lib/displayScale";
import { Check, Type } from "lucide-react";
import { useSyncExternalStore } from "react";

/** تحكّم محدود بمقياس الخط؛ تقريب المتصفح الأصلي يبقى متاحاً ولا يُعاد اعتراض اختصاراته. */
export function DisplayScaleControl() {
  const scale = useSyncExternalStore(subscribeDisplayScale, readDisplayScale, () => "normal" as DisplayScale);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={`حجم العرض: ${DISPLAY_SCALE_LABEL[scale]}`}
          title={`حجم العرض: ${DISPLAY_SCALE_LABEL[scale]}`}
        >
          <Type aria-hidden className="size-5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44 text-right">
        <DropdownMenuLabel>حجم الخط والعرض</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {DISPLAY_SCALES.map((option) => (
          <DropdownMenuItem key={option} onClick={() => setDisplayScale(option)}>
            <span className="flex-1">{DISPLAY_SCALE_LABEL[option]}</span>
            {scale === option && <Check aria-hidden className="size-4" />}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <div className="px-2 py-1.5 text-[11px] leading-relaxed text-muted-foreground">
          لتكبير الصفحة كاملة استخدم تقريب المتصفح؛ هذا الخيار يضبط قراءة النظام فقط.
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
