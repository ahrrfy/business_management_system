import { useRef, useState, type ChangeEvent, type FocusEvent } from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * حقل عددٍ (كميّة/معامل/عدد قطع) — بلا فواصل ألوف وبلا أصفار عشرية زائدة.
 *
 * الفرق عن `MoneyInput`:
 *  - **بلا فواصل ألوف** (المعامل «١٢» يظهر «12» لا «12٫000»).
 *  - **بلا أصفار عشرية زائدة** («12.0000» تُعرَض «12»، «1.50» تُعرَض «1.5»).
 *  - `decimals` افتراضياً 0 (عدد صحيح فقط) — مرّر مثلاً `decimals={4}` لمعامل التحويل الذي يقبل الكسور.
 *
 * القيمة الخام في state تبقى نظيفة بعد فقد التركيز (تُطبَّع تلقائياً)، فلا تصل «12.0000» للخادم بلا داعٍ.
 */
export interface NumberInputProps {
  id?: string;
  value: string;
  onChange: (raw: string) => void;
  placeholder?: string;
  disabled?: boolean;
  /** يقبل إشارة سالبة بادئة. افتراضياً false (الكميّات موجبة). */
  allowNegative?: boolean;
  /** أقصى عدد منازل عشرية. 0 = عدد صحيح فقط (افتراضي). */
  decimals?: number;
  className?: string;
  ariaLabel?: string;
  dir?: "ltr" | "rtl" | "auto";
}

function sanitizeRaw(input: string, allowNegative: boolean, decimals: number): string {
  const neg = allowNegative && input.trim().startsWith("-");
  let s = input.replace(/[^0-9.]/g, "");
  const firstDot = s.indexOf(".");
  if (firstDot !== -1) {
    s = s.slice(0, firstDot + 1) + s.slice(firstDot + 1).replace(/\./g, "");
  }
  if (decimals <= 0) {
    s = s.split(".")[0] ?? "";
  } else {
    const [intPart, decPart] = s.split(".");
    if (decPart !== undefined) s = `${intPart}.${decPart.slice(0, decimals)}`;
  }
  return neg && s !== "" ? `-${s}` : s;
}

/** «12.0000» → «12»، «1.50» → «1.5»، «1.» → «1». */
function stripTrailingZeros(raw: string): string {
  if (!raw) return "";
  const neg = raw.startsWith("-");
  const body = neg ? raw.slice(1) : raw;
  const dot = body.indexOf(".");
  if (dot === -1) return raw;
  const intPart = body.slice(0, dot);
  const decPart = body.slice(dot + 1).replace(/0+$/, "");
  const cleaned = decPart.length > 0 ? `${intPart}.${decPart}` : intPart;
  return neg ? `-${cleaned}` : cleaned;
}

export function NumberInput({
  id,
  value,
  onChange,
  placeholder,
  disabled,
  allowNegative = false,
  decimals = 0,
  className,
  ariaLabel,
  dir = "ltr",
}: NumberInputProps) {
  const ref = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);
  // خارج التركيز: نُطبّع للعرض. داخله: نُبقي «١٢.» أثناء الكتابة لتفادي اختفاء النقطة.
  const display = focused ? (value ?? "") : stripTrailingZeros(value ?? "");

  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    const raw = sanitizeRaw(e.target.value, allowNegative, decimals);
    onChange(raw);
  };

  const handleBlur = (_e: FocusEvent<HTMLInputElement>) => {
    setFocused(false);
    const normalized = stripTrailingZeros(value ?? "");
    if (normalized !== (value ?? "")) onChange(normalized);
  };

  return (
    <Input
      id={id}
      ref={ref}
      value={display}
      onChange={handleChange}
      onFocus={() => setFocused(true)}
      onBlur={handleBlur}
      dir={dir}
      inputMode={decimals > 0 ? "decimal" : "numeric"}
      placeholder={placeholder}
      disabled={disabled}
      aria-label={ariaLabel}
      className={cn("tabular-nums", className)}
    />
  );
}
