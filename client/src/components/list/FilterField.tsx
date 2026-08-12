import { cn } from "@/lib/utils";
import * as React from "react";

export interface FilterFieldProps {
  label: string;
  children: React.ReactNode;
  className?: string;
  /**
   * ⚠️ يجب أن يكون `true` عند لفّ **مجموعة أزرار / radiogroup** (لا حقل نموذجٍ واحد):
   * HTML `<label>` يُفعِّل أوّل labelable descendant عند النقر ⇒ نقر التسمية «الاتجاه»
   * فوق مجموعة الأزرار يُفعِّل أوّل زرّ («الكل») فيسحب اختيار المستخدم صامتاً (Codex P2).
   * الافتراضي `<label>` هو الصحيح لـ`<input>`/`<select>`/`<AppSelect>` (يركّز الحقل — WCAG).
   */
  asGroup?: boolean;
}

/**
 * غلاف تسمية موحّد لفلاتر القوائم.
 * يمنع الاعتماد على placeholder وحده، والذي يختفي بعد الاختيار ولا يشرح وظيفة الحقل.
 */
export function FilterField({ label, children, className, asGroup }: FilterFieldProps) {
  const captionId = React.useId();
  if (asGroup) {
    return (
      <div className={cn("flex min-w-0 flex-col gap-1", className)} role="group" aria-labelledby={captionId}>
        <span id={captionId} className="px-0.5 text-xs font-semibold text-muted-foreground">{label}</span>
        {children}
      </div>
    );
  }
  return (
    <label className={cn("flex min-w-0 flex-col gap-1", className)}>
      <span className="px-0.5 text-xs font-semibold text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}
