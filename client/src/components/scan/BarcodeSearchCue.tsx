import { ScanLine } from "lucide-react";
import { cn } from "@/lib/utils";

/** الهوية البصرية فقط، للحقول التي تدعم الماسح من دون شارة داخلية. */
export const barcodeSearchVisualClass =
  "border-primary/60 bg-primary/[0.06] ring-1 ring-primary/15 focus-visible:border-primary focus-visible:ring-primary/25";

/**
 * الحشو الأيمن مهم عمداً: الشارة مثبتة في يمين الحقل بصرف النظر عن `dir` الخاص
 * بالنص (RTL/LTR/auto). علامة `!` تمنع `px-*` في الحقول المستهلكة من إلغاء
 * المساحة المحجوزة للشارة بحسب ترتيب CSS.
 */
export const barcodeSearchInputClass =
  `pr-[5.75rem]! ${barcodeSearchVisualClass}`;

export const barcodeSearchCueClass =
  "pointer-events-none absolute right-2 top-1/2 z-10 inline-flex -translate-y-1/2 items-center gap-1 whitespace-nowrap rounded-md bg-primary px-1.5 py-0.5 text-[10px] font-bold text-primary-foreground shadow-sm";

/** شارة داخل حقل البحث توضّح للموظف بصرياً أن قارئ الباركود يعمل هنا. */
export function BarcodeSearchCue({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        barcodeSearchCueClass,
        className,
      )}
    >
      <ScanLine className="size-3" /> باركود
    </span>
  );
}
