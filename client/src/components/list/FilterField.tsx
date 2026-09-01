import { FieldError } from "@/components/form/FieldError";
import { cn } from "@/lib/utils";
import * as React from "react";

export interface FilterFieldProps {
  label: string;
  children: React.ReactNode;
  className?: string;
  /** تلميحٌ دائم أسفل الحقل — لا placeholder (§Forms `input-helper-text`). */
  hint?: string;
  /** رسالة خطأ تُعرض أسفل الحقل مباشرةً (§Forms `error-placement`). */
  error?: string;
  /** يمتدّ على عمودين في شبكة `FilterShell` (للبحث ونحوه). */
  wide?: boolean;
  /** يُلحق نجمةً بالتسمية. */
  required?: boolean;
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
export function FilterField({
  label,
  children,
  className,
  asGroup,
  hint,
  error,
  wide,
  required,
}: FilterFieldProps) {
  const captionId = React.useId();
  const caption = (
    <span id={asGroup ? captionId : undefined} className="px-0.5 text-xs font-semibold text-muted-foreground">
      {label}
      {required && <span className="text-destructive"> *</span>}
    </span>
  );

  /*
   * التلميح والخطأ **خارج** عنصر `<label>` عمداً: ما يقع داخله يدخل في الاسم المتاح
   * للحقل عند قارئ الشاشة، فيُقرأ «الفرع ضمن الصفحة المعروضة» بدل «الفرع».
   */
  const footnotes = (hint || error) && (
    <>
      {hint && !error && <p className="px-0.5 text-2xs text-muted-foreground">{hint}</p>}
      <FieldError message={error} />
    </>
  );

  const wrapperCls = cn("flex min-w-0 flex-col gap-1", wide && "sm:col-span-2", className);

  if (asGroup) {
    return (
      <div className={wrapperCls} role="group" aria-labelledby={captionId}>
        {caption}
        {children}
        {footnotes}
      </div>
    );
  }

  // بلا تلميح/خطأ: نُبقي البنية القديمة حرفياً (label يلفّ كل شيء) — ٣١ مستدعياً قائماً.
  if (!footnotes) {
    return (
      <label className={wrapperCls}>
        {caption}
        {children}
      </label>
    );
  }

  return (
    <div className={wrapperCls}>
      <label className="flex min-w-0 flex-col gap-1">
        {caption}
        {children}
      </label>
      {footnotes}
    </div>
  );
}
