// منتقي شهر (YYYY-MM) بأسهم سابق/تالي — أول منتقي شهر مشترك في النظام (وحدة العمولات).
// RTL: «السابق» يشير يميناً و«التالي» يساراً. القيمة الخام دائماً YYYY-MM (توافق period في الخادم).
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { ChevronLeft, ChevronRight } from "lucide-react";

/** الشهر الجاري بتوقيت جهاز المستخدم (بغداد عملياً) — YYYY-MM. */
export function thisMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** إزاحة شهور نصّية بحتة (بلا Date ولا مناطق زمنية). */
export function addMonths(ym: string, n: number): string {
  const [y, m] = ym.split("-").map(Number);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${ny}-${String(nm).padStart(2, "0")}`;
}

export interface MonthPickerProps {
  value: string;
  onChange: (ym: string) => void;
  /** أقصى شهر قابل للاختيار (اختياري — مثلاً الشهر الجاري للتشغيلات). */
  max?: string;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
}

export function MonthPicker({ value, onChange, max, disabled, className, ariaLabel }: MonthPickerProps) {
  const nextDisabled = disabled || (max != null && addMonths(value, 1) > max);
  return (
    <div className={cn("flex items-center gap-1", className)}>
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="size-9"
        aria-label="الشهر السابق"
        disabled={disabled}
        onClick={() => onChange(addMonths(value, -1))}
      >
        <ChevronRight className="size-4" aria-hidden />
      </Button>
      <Input
        type="month"
        dir="ltr"
        className="h-9 w-40 text-center tabular-nums"
        value={value}
        max={max}
        aria-label={ariaLabel ?? "الشهر"}
        disabled={disabled}
        onChange={(e) => {
          // متصفح يمسح الحقل يعطي "" — نتجاهلها للحفاظ على قيمة صالحة دائماً.
          if (e.target.value) onChange(e.target.value);
        }}
      />
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="size-9"
        aria-label="الشهر التالي"
        disabled={nextDisabled}
        onClick={() => onChange(addMonths(value, 1))}
      >
        <ChevronLeft className="size-4" aria-hidden />
      </Button>
    </div>
  );
}
