import type { ReactNode } from "react";
import { CopyInline } from "@/components/CopyButton";
import { fmt, fmtAr } from "@/lib/money";
import { cn } from "@/lib/utils";

export type SummaryRowTone =
  | "amber"
  | "emerald"
  | "pos"
  | "warn"
  | "neg"
  | "destructive"
  | "info"
  | "default";

export type SummaryRowProps = {
  /** تسمية السطر (يمين في RTL) */
  label: ReactNode;
  /** القيمة الخام (رقم أو نص مالي) */
  value: string | number | null | undefined;
  /** العرض المخصص البديل عن التنسيق التلقائي */
  display?: ReactNode;
  /** لاحقة العملة (مثل "د.ع" أو "$") */
  currencySuffix?: string;
  /** إبراز الخط (للإجماليات والمجاميع النهائية) */
  strong?: boolean;
  /** النبرة الدلالية الملونة للرقم */
  tone?: SummaryRowTone;
  /** هل يُتاح نسخ القيمة بنقرة واحدة؟ (افتراضي: true للمستندات القابلة للمطابقة) */
  copyable?: boolean;
  /** وصف إضافي صغير أسفل التسمية */
  sublabel?: ReactNode;
  className?: string;
};

const TONE_CLASSES: Record<SummaryRowTone, string> = {
  default: "",
  emerald: "text-[var(--sem-pos)]",
  pos: "text-[var(--sem-pos)]",
  amber: "text-[var(--sem-warn)]",
  warn: "text-[var(--sem-warn)]",
  neg: "text-[var(--sem-neg)]",
  destructive: "text-[var(--sem-neg)]",
  info: "text-[var(--sem-info)]",
};

/**
 * سطر موحّد في لوحات التلخيص المالي (Design System — Financial Summary Row).
 *
 * القواعد الصارمة:
 * 1. ممنوع منعاً باتاً اقتطاع المبالغ المالية بأقنعة CSS (`truncate` أو `...`).
 * 2. القيمة محمية دائماً بـ `shrink-0` و `whitespace-nowrap` و `tabular-nums`.
 * 3. القيمة الصفرية "0" تُعرض واضحة وظاهرة ومكتملة ولا تختفي في المتصفحات.
 */
export function SummaryRow({
  label,
  value,
  display,
  currencySuffix,
  strong = false,
  tone = "default",
  copyable = true,
  sublabel,
  className,
}: SummaryRowProps) {
  const rawStr = value == null ? "" : String(value);
  const formatted = display ?? (rawStr ? fmt(rawStr) : "—");
  const toneCls = TONE_CLASSES[tone] ?? "";

  const renderedValue = (
    <span className="inline-flex items-center gap-1">
      <span>{formatted}</span>
      {currencySuffix && (
        <span className="text-2xs text-muted-foreground font-normal">
          {currencySuffix}
        </span>
      )}
    </span>
  );

  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 text-sm min-w-0 py-0.5",
        className,
      )}
    >
      <div className="flex flex-col min-w-0 shrink-0">
        <span
          className={cn(
            "text-muted-foreground shrink-0",
            strong && "font-semibold text-foreground",
          )}
        >
          {label}
        </span>
        {sublabel && (
          <span className="text-2xs text-muted-foreground">{sublabel}</span>
        )}
      </div>

      <span
        dir="ltr"
        className={cn(
          "tabular-nums shrink-0 whitespace-nowrap text-end",
          strong ? "text-base sm:text-lg font-bold" : "text-sm font-medium",
          toneCls,
        )}
      >
        {copyable && rawStr ? (
          <CopyInline
            value={rawStr}
            display={renderedValue}
            mono={false}
            truncate={false}
          />
        ) : (
          renderedValue
        )}
      </span>
    </div>
  );
}

export default SummaryRow;
