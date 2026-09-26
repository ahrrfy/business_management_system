import * as React from "react";
import { cn } from "@/lib/utils";
import { CopyButton } from "@/components/CopyButton";

export type StackedEntityCellProps = {
  /** السطر الأول: الاسم الرئيسي للكيان (مثل اسم المورد أو العميل) */
  primary: React.ReactNode;
  /** تلميح اختياري للسطر الأول */
  primaryTitle?: string;
  /** السطر الثاني: الرمز أو الرقم التعريفي (مثل رقم الأمر أو الفاتورة) */
  secondary?: React.ReactNode;
  /** تلميح اختياري للسطر الثاني */
  secondaryTitle?: string;
  /** معرّف أو قيمة للنسخ — يظهر زر نسخ بجانب السطر الثاني */
  copyValue?: string | number | null;
  /** تلميح زر النسخ (افتراضي: "نسخ") */
  copyTitle?: string;
  /** إجراء عند النقر على السطر الثاني (مثل فتح درج المعاينة) */
  onSecondaryClick?: () => void;
  /** شارة أو عنصر إضافي اختياري بجانب السطر الثانوي */
  secondaryBadge?: React.ReactNode;
  /** تحديد اتجاه السطر الثانوي صراحة (ltr / rtl / auto) — افتراضياً ltr للأكواد والرموز وauto للنصوص العادية */
  secondaryDir?: "ltr" | "rtl" | "auto";
  /** هل السطر الثاني كود/رقم تعريفي يجب تنسيقه بـ font-mono؟ افتراضياً true */
  secondaryIsCode?: boolean;
  /** فئات CSS إضافية للسطر الثانوي */
  secondaryClassName?: string;
  /** فئات CSS إضافية للحاوية */
  className?: string;
};

/**
 * خلية مكدّسة موحّدة للجداول (اسم الكيان + رمزه/رقمه).
 * توفّر مساحة أفقية وتلغي التمرير الجانبي المزعج مع الحفاظ على كامل البيانات وقابلية النسخ.
 */
export function StackedEntityCell({
  primary,
  primaryTitle,
  secondary,
  secondaryTitle,
  copyValue,
  copyTitle = "نسخ",
  onSecondaryClick,
  secondaryBadge,
  secondaryDir,
  secondaryIsCode = true,
  secondaryClassName,
  className,
}: StackedEntityCellProps) {
  const hasSecondary =
    secondary != null &&
    (typeof secondary !== "string" || secondary.trim() !== "");
  const hasCopy = copyValue != null && String(copyValue).trim() !== "";
  const hasBadge = secondaryBadge != null;
  const showSecondary = hasSecondary || hasCopy || hasBadge;
  const dir = secondaryDir ?? (secondaryIsCode ? "ltr" : "auto");

  return (
    <div
      className={cn(
        "flex w-full min-w-0 max-w-full flex-col items-start gap-0.5 text-start",
        className,
      )}
    >
      {/* السطر الأول: اسم الكيان الرئيسي */}
      <div
        className="w-full min-w-0 max-w-full truncate text-sm font-medium leading-snug text-foreground"
        title={primaryTitle ?? (typeof primary === "string" ? primary : undefined)}
      >
        {primary}
      </div>

      {/* السطر الثاني: الرمز أو الرقم التعريفي + زر النسخ المستقل */}
      {showSecondary && (
        <div className="flex w-full min-w-0 max-w-full items-center gap-1.5 text-xs text-muted-foreground">
          {hasSecondary &&
            (onSecondaryClick ? (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onSecondaryClick();
                }}
                className={cn(
                  "cursor-pointer truncate text-start text-xs font-medium text-primary transition-colors hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded-xs",
                  secondaryIsCode && "font-mono",
                  secondaryClassName,
                )}
                title={secondaryTitle ?? (typeof secondary === "string" ? secondary : undefined)}
              >
                {dir === "ltr" ? <bdi dir="ltr">{secondary}</bdi> : <bdi dir={dir}>{secondary}</bdi>}
              </button>
            ) : (
              <span
                className={cn(
                  "inline-block truncate text-xs text-muted-foreground",
                  secondaryIsCode && "font-mono",
                  secondaryClassName,
                )}
                title={secondaryTitle ?? (typeof secondary === "string" ? secondary : undefined)}
              >
                {dir === "ltr" ? <bdi dir="ltr">{secondary}</bdi> : <bdi dir={dir}>{secondary}</bdi>}
              </span>
            ))}

          {hasCopy && (
            <span
              onClick={(e) => e.stopPropagation()}
              className="inline-flex shrink-0"
            >
              <CopyButton
                value={copyValue}
                title={copyTitle}
                className="size-5 p-0.5 text-muted-foreground hover:text-foreground shrink-0 [&_svg]:size-3"
              />
            </span>
          )}

          {secondaryBadge}
        </div>
      )}
    </div>
  );
}
