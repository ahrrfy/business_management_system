import { useRef, type ChangeEvent, type ClipboardEvent, type KeyboardEvent } from "react";
import { cn } from "@/lib/utils";

/**
 * حقل هاتف عراقيّ بـ١١ خانة ذكيّة (طلب المالك) — رقمٌ واحد لكل خانة، انتقالٌ تلقائيّ للخانة التالية
 * عند الكتابة، ورجوعٌ بالمسافة الخلفية، ولصقٌ يملأ الكل. تصير الخانات **خضراء** عند اكتمال رقمٍ
 * عراقيّ صحيح (07 + ٩ أرقام = ١١). القيمة أرقامٌ فقط (بلا فراغات/رموز). dir=ltr للأرقام.
 */

const LEN = 11;
/** رقم موبايل عراقيّ: يبدأ بـ07 ويتكوّن من ١١ رقماً. (لا نُقيّد مُشغّلاً بعينه كي لا نرفض أرقاماً صحيحة.) */
export const isValidIqMobile = (d: string) => /^07\d{9}$/.test(d);

interface PhoneDigitsInputProps {
  /** أرقامٌ فقط (حتى ١١). */
  value: string;
  onChange: (digits: string) => void;
  className?: string;
  ariaLabel?: string;
}

export function PhoneDigitsInput({ value, onChange, className, ariaLabel }: PhoneDigitsInputProps) {
  const digits = (value || "").replace(/\D/g, "").slice(0, LEN);
  const cells = Array.from({ length: LEN }, (_, i) => digits[i] ?? "");
  const valid = isValidIqMobile(digits);
  const refs = useRef<(HTMLInputElement | null)[]>([]);

  const emit = (next: string[]) => onChange(next.join("").replace(/\D/g, "").slice(0, LEN));

  const handleInput = (i: number, e: ChangeEvent<HTMLInputElement>) => {
    const ch = e.target.value.replace(/\D/g, "").slice(-1); // آخر رقمٍ كُتب (الخانة مُحدَّدة عند التركيز فيُستبدَل)
    const next = cells.slice();
    next[i] = ch;
    emit(next);
    if (ch && i < LEN - 1) refs.current[i + 1]?.focus();
  };

  const handleKey = (i: number, e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Backspace" && !cells[i] && i > 0) {
      e.preventDefault();
      refs.current[i - 1]?.focus();
    } else if (e.key === "ArrowLeft" && i > 0) {
      refs.current[i - 1]?.focus();
    } else if (e.key === "ArrowRight" && i < LEN - 1) {
      refs.current[i + 1]?.focus();
    }
  };

  const handlePaste = (e: ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    const pasted = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, LEN);
    if (!pasted) return;
    onChange(pasted);
    refs.current[Math.min(pasted.length, LEN - 1)]?.focus();
  };

  return (
    <div
      dir="ltr"
      role="group"
      aria-label={ariaLabel ?? "رقم الهاتف — ١١ خانة"}
      className={cn("inline-flex items-center gap-1", className)}
    >
      {cells.map((d, i) => (
        <input
          key={i}
          ref={(el) => {
            refs.current[i] = el;
          }}
          value={d}
          inputMode="numeric"
          autoComplete="off"
          maxLength={1}
          aria-label={`الخانة ${i + 1} من ${LEN}`}
          onChange={(e) => handleInput(i, e)}
          onKeyDown={(e) => handleKey(i, e)}
          onPaste={handlePaste}
          onFocus={(e) => e.currentTarget.select()}
          className={cn(
            "h-8 w-6 rounded-md border text-center text-sm font-bold tabular-nums outline-none transition-colors",
            "focus:border-primary focus:ring-1 focus:ring-primary",
            valid
              ? "border-[var(--sem-pos)] bg-[var(--sem-pos-bg)] text-[var(--sem-pos)]"
              : "border-input bg-background text-foreground",
          )}
        />
      ))}
    </div>
  );
}
