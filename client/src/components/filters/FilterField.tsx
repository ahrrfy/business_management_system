/**
 * حقل فلتر موحّد — تسمية ظاهرة + تحكّم + تلميح/خطأ، بربطٍ صحيحٍ بينها.
 *
 * لماذا التسمية **إلزامية** لا اختيارية: تعليقٌ قائم في `Customers.tsx` يوثّق الجذر —
 * «شكوى المالك الأصلية ‹الفلاتر مبعثرة› سببٌ رئيسيّ لها هو **غياب التسميات**». حقلٌ بلا
 * تسمية يعتمد على الـplaceholder، والـplaceholder يختفي عند الكتابة فيضيع المعنى
 * (§Forms `input-labels`: «تسمية ظاهرة لكل حقل — لا placeholder وحده»).
 *
 * الربط: إن لم تُمرَّر `htmlFor` وُلِّد معرّفٌ تلقائيّ وأُلحِق بالابن المباشر إن كان عنصراً
 * واحداً بلا `id` — فيبقى `<label for>` صحيحاً بلا عبءٍ على كل مستدعٍ (§A11y `form-labels`).
 */
import * as React from "react";
import { Label } from "@/components/ui/label";
import { FieldError } from "@/components/form/FieldError";
import { cn } from "@/lib/utils";

export type FilterFieldProps = {
  /** التسمية العربية الظاهرة — **إلزامية**. */
  label: string;
  children: React.ReactNode;
  /** معرّف التحكّم؛ يُولَّد تلقائياً حين يُترك فارغاً. */
  htmlFor?: string;
  /** تلميحٌ دائم أسفل الحقل (لا placeholder) — §Forms `input-helper-text`. */
  hint?: string;
  /** رسالة خطأ — تُعرض أسفل الحقل مباشرةً (§Forms `error-placement`). */
  error?: string;
  /** يمتدّ على عمودين في الشبكة (للبحث ونحوه). */
  wide?: boolean;
  required?: boolean;
  className?: string;
};

export function FilterField({
  label,
  children,
  htmlFor,
  hint,
  error,
  wide,
  required,
  className,
}: FilterFieldProps) {
  const generatedId = React.useId();
  const controlId = htmlFor ?? generatedId;
  const hintId = hint ? `${controlId}-hint` : undefined;
  const errorId = error ? `${controlId}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;

  // يُلحق المعرّف والوصف بالابن حين يكون عنصراً واحداً لم يُعرّفهما بنفسه.
  const control = React.useMemo(() => {
    if (htmlFor || !React.isValidElement(children)) return children;
    const child = children as React.ReactElement<Record<string, unknown>>;
    if (child.props.id) return children;
    return React.cloneElement(child, {
      id: controlId,
      ...(describedBy && !child.props["aria-describedby"]
        ? { "aria-describedby": describedBy }
        : {}),
      ...(error && child.props["aria-invalid"] == null ? { "aria-invalid": true } : {}),
    });
  }, [children, htmlFor, controlId, describedBy, error]);

  return (
    <div className={cn("min-w-0 space-y-1.5", wide && "sm:col-span-2", className)}>
      <Label htmlFor={controlId} className="text-xs font-medium text-muted-foreground">
        {label}
        {required && <span className="text-destructive"> *</span>}
      </Label>
      {control}
      {hint && !error && (
        <p id={hintId} className="text-2xs text-muted-foreground">
          {hint}
        </p>
      )}
      <FieldError id={errorId} message={error} />
    </div>
  );
}
