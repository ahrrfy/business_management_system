import { Input } from "@/components/ui/input";
import { DEFAULT_DIAL, DIAL_CODES, normalizeNational, parseE164, toE164 } from "@/lib/intlPhone";
import { cn } from "@/lib/utils";
import { useEffect, useState } from "react";

/**
 * هاتف دولي بصيغة E.164 (مثل +9647701234567).
 *
 * - يخزّن دائماً E.164 موحّداً في `value` (سلسلة) ⇒ سهل على الخادم.
 * - يعرض مفتاح دولة (٪١٧ قائمة) + رقم وطني بأرقام إنكليزية فقط (LTR).
 * - يحذف الصفر البادئ تلقائياً (0770 → 770) لأن العراقيين يكتبونها بالعادة.
 *
 * v3-add-screens: يُستعمل في العميل/المورّد (٣×) والمستخدم (١) وأمر الشغل (channelHandle).
 */
export interface IntlPhoneInputProps {
  id?: string;
  value: string | null | undefined;
  onChange: (e164: string) => void;
  placeholder?: string;
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
}

export function IntlPhoneInput({
  id,
  value,
  onChange,
  placeholder = "770 123 4567",
  disabled,
  ariaLabel,
  className,
}: IntlPhoneInputProps) {
  // مصدر الحقيقة الخارجي قد يتغيّر ⇒ نعيد المزامنة، لكن الكتابة المحلية لا تُفقد.
  const initial = parseE164(value);
  const [dial, setDial] = useState(initial.dial || DEFAULT_DIAL);
  const [national, setNational] = useState(initial.national);

  useEffect(() => {
    const parsed = parseE164(value);
    // فقط حدّث الحالة المحلية إن اختلف فعلاً، حتى لا نمسح ما يكتبه المستخدم لحظياً.
    if (parsed.dial !== dial || parsed.national !== national) {
      setDial(parsed.dial || DEFAULT_DIAL);
      setNational(parsed.national);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  function emit(nextDial: string, nextNational: string) {
    onChange(toE164(nextDial, nextNational));
  }

  return (
    <div
      dir="ltr"
      className={cn(
        "flex items-stretch gap-1 rounded-md border border-input bg-transparent shadow-xs focus-within:border-ring focus-within:ring-ring/50 focus-within:ring-[3px] transition-[color,box-shadow]",
        disabled && "opacity-50 pointer-events-none",
        className
      )}
    >
      <select
        value={dial}
        onChange={(e) => {
          setDial(e.target.value);
          emit(e.target.value, national);
        }}
        disabled={disabled}
        aria-label="مفتاح الدولة"
        className="h-9 shrink-0 rounded-r-md bg-transparent px-2 text-xs font-medium outline-none border-l border-input cursor-pointer"
      >
        {DIAL_CODES.map((d) => (
          <option key={d.code} value={d.code} title={d.label}>
            {d.flag} {d.code}
          </option>
        ))}
      </select>
      <Input
        id={id}
        dir="ltr"
        inputMode="numeric"
        autoComplete="tel"
        aria-label={ariaLabel ?? "رقم الهاتف"}
        value={national}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => {
          const n = normalizeNational(e.target.value);
          setNational(n);
          emit(dial, n);
        }}
        className="border-0 shadow-none focus-visible:ring-0 focus-visible:border-transparent"
      />
    </div>
  );
}
