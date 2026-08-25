import * as React from "react";
import { D, fmt, fmtAr } from "@/lib/money";
import { cn } from "@/lib/utils";

/**
 * عرض مبلغٍ ماليّ بلونٍ دلاليّ (موجب/سالب/محايد) — **مصدرٌ وحيد** يمنع ألوان Tailwind الخامّة.
 *
 * قبله كانت الشاشات تكتب `text-red-700`/`text-emerald-700`/`text-rose-600` مباشرةً على أرقام
 * مالية (~٨٠٩ موضعاً حسب تدقيق ٢٧/٧/٢٦) — بلا استفادة من الوضع الليليّ (لا `dark:`)، وبلا
 * توكن دلاليّ يوحّد الدرجات. النتيجة: خلافٌ بصريّ عبر الشاشات + قراءةٌ سيئة في dark mode.
 *
 * التوكنز الحاكمة (معرَّفة في `client/src/lib/theme/tokens.css` لكلا الوضعَين):
 *   • `--sem-pos`  → أخضر دلاليّ (oklch مضبوطة للراحة، ليس أخضر Tailwind الحادّ)
 *   • `--sem-neg`  → أحمر دلاليّ
 *
 * القاعدة:
 *   • v > 0 ⇒ `text-[var(--sem-pos)]`
 *   • v < 0 ⇒ `text-[var(--sem-neg)]`
 *   • v = 0 ⇒ محايد (foreground عادي)
 *
 * `dir="ltr"` و`tabular-nums` عمداً: الأرقام تبقى بأرقام لاتينية (`fmt`/`fmtAr`) وتُصفّ عمودياً.
 * تمرير `sign="always"` يُضيف علامة `+` للموجب (لعرض تغيّرات/دلتا).
 * `variant="ar"` يستعمل تنسيق ar-IQ (arabic separators)، الافتراضي en-US (فواصل غربية).
 */
export type SignedMoneyProps = {
  value: string | number | null | undefined;
  /** `always` يضيف علامة `+` للموجب — للتغيّرات/الدلتا. الافتراضي: بلا علامة للموجب. */
  sign?: "auto" | "always";
  /** `ar` = `fmtAr` (١٢٣٤.٥٦), `en` = `fmt` (1,234.56). الافتراضي `en`. */
  variant?: "ar" | "en";
  /** لاحقة عملة (مثلاً " د.ع"). الافتراضي بلا لاحقة. */
  suffix?: React.ReactNode;
  className?: string;
};

/**
 * @example
 *   <SignedMoney value={balance} />                         // سالب/موجب/صفر بلونٍ دلاليّ
 *   <SignedMoney value={delta} sign="always" />             // ‎+1,234.56 / -500.00
 *   <SignedMoney value={net} suffix=" د.ع" variant="ar" />  // بلاحقة العملة
 */
export function SignedMoney({ value, sign = "auto", variant = "en", suffix, className }: SignedMoneyProps) {
  const d = D(value);
  const isNeg = d.isNegative();
  const isPos = d.gt(0);
  const tone = isNeg
    ? "text-[var(--sem-neg)]"
    : isPos
      ? "text-[var(--sem-pos)]"
      : "";
  const raw = variant === "ar" ? fmtAr(value) : fmt(value);
  const shown = sign === "always" && isPos ? `+${raw}` : raw;
  return (
    <span dir="ltr" className={cn("tabular-nums", tone, className)}>
      {shown}
      {suffix}
    </span>
  );
}

/**
 * className فقط (بلا JSX) — للحالات التي تحوي المبلغ بالفعل ولا تريد wrapper.
 * مثال: `<td className={cn("text-end", moneyToneClass(v))}>{fmt(v)}</td>`
 */
export function moneyToneClass(value: string | number | null | undefined): string {
  const d = D(value);
  if (d.isNegative()) return "text-[var(--sem-neg)]";
  if (d.gt(0)) return "text-[var(--sem-pos)]";
  return "";
}
