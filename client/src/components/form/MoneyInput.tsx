import { useRef, type ChangeEvent } from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * حقل مبلغ بفواصل آلاف حيّة أثناء الكتابة (١٬٢٣٤٬٥٦٧) — القيمة الخام (بلا فواصل) هي ما
 * يُرسَل عبر onChange (نظير `value`/`onChange` القياسيَّين)، فتبقى متوافقة مع zod moneyStr/signedMoneyStr
 * في الخادم (يرفض الفواصل). ⛔ لا تُرسل القيمة المعروضة (المنسَّقة) إلى أي mutation — أرسل `value` فقط.
 */
export interface MoneyInputProps {
  id?: string;
  value: string;
  onChange: (raw: string) => void;
  placeholder?: string;
  disabled?: boolean;
  /** يقبل إشارة سالبة بادئة (لأرصدة موقّعة مثل الرصيد الافتتاحي/المطابقة). افتراضياً false. */
  allowNegative?: boolean;
  /** أقصى عدد منازل عشرية (افتراضياً ٢، نظير moneyStr). صفر = عدد صحيح فقط. */
  decimals?: number;
  className?: string;
  ariaLabel?: string;
}

/** يُبقي فقط أرقاماً + نقطة عشرية واحدة + إشارة سالبة بادئة واحدة (إن سُمح بها)، ويحدّ المنازل العشرية. */
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

/** يُدرج فواصل الآلاف في الجزء الصحيح فقط، ويترك الجزء العشري والإشارة كما هما. */
function groupThousands(raw: string): string {
  if (!raw) return "";
  const neg = raw.startsWith("-");
  const body = neg ? raw.slice(1) : raw;
  const [intPart, decPart] = body.split(".");
  const grouped = (intPart || "").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return (neg ? "-" : "") + grouped + (decPart !== undefined ? `.${decPart}` : "");
}

/** عدد الخانات «الدالّة» (أرقام/نقطة/سالب — كل ما عدا الفاصلة) حتى موضع upto. */
function meaningfulCount(s: string, upto: number): number {
  let count = 0;
  for (let i = 0; i < upto && i < s.length; i++) {
    if (s[i] !== ",") count++;
  }
  return count;
}

/** يجد موضع المؤشّر في نص منسَّق يقابل عدد خانات دالّة معيّناً من اليسار. */
function cursorForMeaningfulCount(s: string, target: number): number {
  if (target <= 0) return 0;
  let count = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== ",") count++;
    if (count >= target) return i + 1;
  }
  return s.length;
}

export function MoneyInput({
  id,
  value,
  onChange,
  placeholder = "0.00",
  disabled,
  allowNegative = false,
  decimals = 2,
  className,
  ariaLabel,
}: MoneyInputProps) {
  const ref = useRef<HTMLInputElement>(null);
  const display = groupThousands(value ?? "");

  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    const el = e.target;
    const cursor = el.selectionStart ?? el.value.length;
    const meaningfulBefore = meaningfulCount(el.value, cursor);

    const raw = sanitizeRaw(el.value, allowNegative, decimals);
    onChange(raw);

    const nextDisplay = groupThousands(raw);
    requestAnimationFrame(() => {
      if (!ref.current) return;
      const pos = cursorForMeaningfulCount(nextDisplay, meaningfulBefore);
      ref.current.setSelectionRange(pos, pos);
    });
  };

  return (
    <Input
      id={id}
      ref={ref}
      value={display}
      onChange={handleChange}
      dir="ltr"
      inputMode="decimal"
      placeholder={placeholder}
      disabled={disabled}
      aria-label={ariaLabel}
      className={cn("tabular-nums", className)}
    />
  );
}
