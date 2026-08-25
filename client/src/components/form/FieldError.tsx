import * as React from "react";
import { AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * FieldError — رسالة خطأ حقلٍ موحّدة عبر كل النماذج.
 *
 * يوحّد ما كان متفاوتاً: بعض النماذج تعرض `<p className="text-xs text-destructive">`،
 * وبعضها `<span className="text-red-500">` (يخرق قاعدة الأرقام اللاتينية + `check:colors`)،
 * وبعضها بلا `role='alert'` فقارئ الشاشة لا يعلن التغيير.
 *
 * الالتزامات:
 *  - `role="alert"` — قارئ الشاشة يعلنها فور ظهورها.
 *  - `aria-live="polite"` — إعلان بلا مقاطعة.
 *  - `text-destructive` — توكن الحالة (لا `text-red-*` خامّ).
 *  - أيقونة `AlertCircle` — دلالة بصريّة إضافية للمستخدمين اللونيّين.
 *  - `id` مُمرَّر — للربط مع `aria-describedby` على الحقل (Field يتعامل معه تلقائياً).
 *
 * أُنشئ في S6 (٢٥/٨/٢٦) — استُهلك أولاً من Field؛ نماذج CRUD الرئيسية تُهاجَر تدريجياً.
 */
export interface FieldErrorProps {
  /** رسالة الخطأ العربية (نصّ أو ReactNode). إن كانت فارغة/undefined لا يُعرض شيء. */
  message?: React.ReactNode;
  /** `id` يُمرَّر ثم يُربط بـ`aria-describedby` على الحقل. */
  id?: string;
  className?: string;
}

export function FieldError({ message, id, className }: FieldErrorProps) {
  if (!message) return null;
  return (
    <p
      id={id}
      role="alert"
      aria-live="polite"
      className={cn("flex items-center gap-1.5 text-xs text-destructive", className)}
    >
      <AlertCircle aria-hidden className="size-3.5 shrink-0" />
      <span>{message}</span>
    </p>
  );
}
