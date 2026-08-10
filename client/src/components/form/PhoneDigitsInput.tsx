import { useEffect, useRef, useState, type ChangeEvent, type ClipboardEvent, type KeyboardEvent } from "react";
import { cn } from "@/lib/utils";

/**
 * حقل هاتف عراقيّ بـ١١ خانة ذكيّة (طلب المالك) — رقمٌ واحد لكل خانة، انتقالٌ تلقائيّ للخانة التالية
 * عند الكتابة، ورجوعٌ بالمسافة الخلفية، ولصقٌ يملأ الكل. تصير الخانات **خضراء** عند اكتمال رقمٍ
 * عراقيّ صحيح (07 + ٩ أرقام = ١١). القيمة أرقامٌ فقط (بلا فراغات/رموز). dir=ltr للأرقام.
 *
 * حالةٌ داخليّة موضعيّة (slots): تحافظ على موضع كل خانة عند **تصحيح خانةٍ وسطية** — لولاها كان
 * تفريغُ خانةٍ في الوسط يزيح ما بعدها يساراً فيُفسد الرقم (مراجعة Codex). المزامنة من القيمة
 * الخارجيّة تقع فقط حين تختلف عمّا انبعثناه (لا نُعيد طيّ فراغٍ وسطيٍّ أثناء التحرير).
 */

const LEN = 11;
/** رقم موبايل عراقيّ: يبدأ بـ07 ويتكوّن من ١١ رقماً. (لا نُقيّد مُشغّلاً بعينه كي لا نرفض أرقاماً صحيحة.) */
export const isValidIqMobile = (d: string) => /^07\d{9}$/.test(d);

const toSlots = (v: string): string[] => {
  const digits = (v || "").replace(/\D/g, "").slice(0, LEN).split("");
  return Array.from({ length: LEN }, (_, i) => digits[i] ?? "");
};

interface PhoneDigitsInputProps {
  /** أرقامٌ فقط (حتى ١١). */
  value: string;
  onChange: (digits: string) => void;
  className?: string;
  ariaLabel?: string;
}

export function PhoneDigitsInput({ value, onChange, className, ariaLabel }: PhoneDigitsInputProps) {
  const [slots, setSlots] = useState<string[]>(() => toSlots(value));
  const emittedRef = useRef<string>((value || "").replace(/\D/g, "").slice(0, LEN));
  const refs = useRef<(HTMLInputElement | null)[]>([]);

  // مزامنة من قيمةٍ خارجيّة فقط (ضبطٌ من الأب) — لا من انبعاثنا، فلا يُطوى فراغُ خانةٍ وسطيّة أثناء التصحيح.
  useEffect(() => {
    const compact = (value || "").replace(/\D/g, "").slice(0, LEN);
    if (compact !== emittedRef.current) {
      emittedRef.current = compact;
      setSlots(toSlots(compact));
    }
  }, [value]);

  const commit = (next: string[]) => {
    setSlots(next);
    const compact = next.join("").replace(/\D/g, "").slice(0, LEN);
    emittedRef.current = compact;
    onChange(compact);
  };

  const valid = isValidIqMobile(slots.join(""));

  const handleInput = (i: number, e: ChangeEvent<HTMLInputElement>) => {
    const ch = e.target.value.replace(/\D/g, "").slice(-1); // آخر رقمٍ كُتب (الخانة مُحدَّدة عند التركيز فيُستبدَل في مكانه)
    const next = slots.slice();
    next[i] = ch;
    commit(next);
    if (ch && i < LEN - 1) refs.current[i + 1]?.focus();
  };

  const handleKey = (i: number, e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Backspace" && !slots[i] && i > 0) {
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
    commit(toSlots(pasted));
    refs.current[Math.min(pasted.length, LEN - 1)]?.focus();
  };

  return (
    <div
      dir="ltr"
      role="group"
      aria-label={ariaLabel ?? "رقم الهاتف — ١١ خانة"}
      className={cn("inline-flex items-center gap-1", className)}
    >
      {slots.map((d, i) => (
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
