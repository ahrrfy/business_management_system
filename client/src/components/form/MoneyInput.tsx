import { useRef, useState, type ChangeEvent, type FocusEvent } from "react";
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

/** يشذّب الأصفار العشرية الزائدة والنقطة اليتيمة: "500.0000" → "500"، "500.50" → "500.5"،
 *  "500." → "500". لا يمسّ الأرقام الدالّة. يُستعمَل للعرض غير المُركَّز وعند فقد التركيز. */
function stripTrailingZeros(raw: string): string {
  if (!raw) return "";
  const neg = raw.startsWith("-");
  const body = neg ? raw.slice(1) : raw;
  const dot = body.indexOf(".");
  if (dot === -1) return raw;
  const intPart = body.slice(0, dot);
  let decPart = body.slice(dot + 1).replace(/0+$/, "");
  const cleaned = decPart.length > 0 ? `${intPart}.${decPart}` : intPart;
  return neg ? `-${cleaned}` : cleaned;
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
  placeholder = "0",
  disabled,
  allowNegative = false,
  decimals = 2,
  className,
  ariaLabel,
}: MoneyInputProps) {
  const ref = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);
  // أثناء التركيز: نُبقي ما يكتبه المستخدم كما هو (كي لا يختفي «.» أثناء كتابة كسر).
  // خارج التركيز: نشذّب الأصفار العشرية الزائدة للعرض ⇒ «500.00» تظهر «500»، «3000.50» تظهر «3,000.5».
  const rawForDisplay = focused ? (value ?? "") : stripTrailingZeros(value ?? "");
  const display = groupThousands(rawForDisplay);

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

  const handleBlur = (_e: FocusEvent<HTMLInputElement>) => {
    setFocused(false);
    // نُطبّع القيمة الخام نفسها فور فقد التركيز — كي لا تُرسَل «500.00» للخادم/الحفظ.
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
      dir="ltr"
      inputMode="decimal"
      placeholder={placeholder}
      disabled={disabled}
      aria-label={ariaLabel}
      className={cn("tabular-nums", className)}
    />
  );
}
