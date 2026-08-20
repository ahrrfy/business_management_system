// Stepper — مؤشّر خطوات أفقيّ مشترك (RTL) لأيّ عمليةٍ متسلسلة.
//
// استُخرج من نمط `StocktakeNew.tsx` الذي كان المرجع الوحيد للمعالجات في المشروع، لأنّ العمليات
// الخطِرة (جرد، موجة تسعير) تشترك في قاعدةٍ واحدة: **لا يُتخذ قرارٌ على مجموعةٍ غير مرئية**،
// والخطوات هي ما يجعل «من يتأثّر» و«ماذا سيحدث» و«هل هذا ما تريد» أسئلةً منفصلة لا حقولاً متجاورة.
//
// المكوّن عرضٌ محض: الحالة والتحقّق عند الصفحة (`step` + `stepError()`), وهو يُبرز فقط
// أين نحن وما اكتمل. النقر على خطوةٍ سابقة مسموحٌ (رجوعٌ بلا فقدان حالة) والتقدّم ممنوع
// إلا عبر زرّ «التالي» كي تمرّ كلُّ خطوةٍ بتحقّقها.
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

export interface StepperProps {
  steps: string[];
  /** الخطوة الحالية (0-based). */
  current: number;
  /** الرجوع لخطوةٍ سابقة؛ غيابه يجعل المؤشّر للعرض فقط. */
  onStepClick?: (index: number) => void;
  className?: string;
}

export function Stepper({
  steps,
  current,
  onStepClick,
  className,
}: StepperProps) {
  return (
    <ol
      className={cn("flex items-center gap-2", className)}
      aria-label="خطوات العملية"
    >
      {steps.map((label, i) => {
        const done = i < current;
        const active = i === current;
        const canGo = !!onStepClick && i < current;
        return (
          <li
            key={label}
            className="flex flex-1 items-center gap-2 last:flex-none"
          >
            <button
              type="button"
              onClick={canGo ? () => onStepClick(i) : undefined}
              disabled={!canGo}
              aria-current={active ? "step" : undefined}
              title={canGo ? `رجوع إلى: ${label}` : label}
              className={cn(
                "flex shrink-0 items-center gap-2 rounded-md px-1 py-0.5 text-sm transition-colors",
                canGo && "hover:bg-accent cursor-pointer",
                !canGo && "cursor-default",
              )}
            >
              <span
                className={cn(
                  "flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
                  done && "bg-[var(--sem-pos)] text-white",
                  active && "bg-primary text-primary-foreground",
                  !done && !active && "bg-muted text-muted-foreground",
                )}
              >
                {done ? <Check aria-hidden className="size-4" /> : i + 1}
              </span>
              <span
                className={cn(
                  "hidden whitespace-nowrap sm:inline",
                  active
                    ? "font-semibold text-foreground"
                    : "text-muted-foreground",
                )}
              >
                {label}
              </span>
            </button>
            {i < steps.length - 1 && (
              <span
                aria-hidden
                className={cn(
                  "h-px flex-1",
                  i < current ? "bg-[var(--sem-pos)]" : "bg-border",
                )}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}
