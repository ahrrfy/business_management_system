import { ScanLine } from "lucide-react";
import { cn } from "@/lib/utils";

export const barcodeSearchInputClass =
  "border-primary/60 bg-primary/[0.06] ring-1 ring-primary/15 focus-visible:border-primary focus-visible:ring-primary/25";

/** شارة داخل حقل البحث توضّح للموظف بصرياً أن قارئ الباركود يعمل هنا. */
export function BarcodeSearchCue({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "pointer-events-none absolute start-2 top-1/2 z-10 inline-flex -translate-y-1/2 items-center gap-1 rounded-md bg-primary px-1.5 py-0.5 text-[10px] font-bold text-primary-foreground shadow-sm",
        className,
      )}
    >
      <ScanLine className="size-3" /> باركود
    </span>
  );
}
