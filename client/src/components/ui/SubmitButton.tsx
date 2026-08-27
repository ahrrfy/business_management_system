import * as React from "react";
import { Loader2 } from "lucide-react";
import { Button } from "./button";
import type { VariantProps } from "class-variance-authority";
import type { buttonVariants } from "./button";

/**
 * SubmitButton — زرّ حفظ/إرسال موحّد يوحّد نمط `isPending` عبر النماذج.
 *
 * قبله كان كلّ نموذج يكتب يدوياً:
 *   ```tsx
 *   <Button disabled={mutation.isPending}>
 *     {mutation.isPending ? "جارٍ الحفظ…" : "حفظ"}
 *   </Button>
 *   ```
 * — بلا `<Loader2 />` بصريّ ولا `aria-busy` لقارئ الشاشة. ١٢٥ صفحة تكرّر هذا النمط.
 *
 * الالتزامات:
 *  - `<Loader2 className="animate-spin" />` عند `pending=true` — دلالة بصريّة صريحة
 *  - `disabled` تلقائيّ عند `pending=true` — يمنع النقر المزدوج (يرسل الطلب مرّتَين)
 *  - `aria-busy={pending}` — قارئ الشاشة يعلن الحالة
 *  - `type="submit"` افتراضيّ — أنسب لنماذج react-hook-form
 *  - يقبل كل props الـButton (variant/size/…) — لا يقيّد التصميم
 *
 * الاستعمال:
 *   ```tsx
 *   <SubmitButton pending={m.isPending} pendingText="جارٍ الحفظ…">
 *     حفظ التعديلات
 *   </SubmitButton>
 *   ```
 *
 * أُنشئ في S7 (٢٧/٨/٢٦) — استُهلك تدريجياً في نماذج CRUD الرئيسية.
 */
export interface SubmitButtonProps
  extends Omit<React.ComponentProps<"button">, "disabled">,
    VariantProps<typeof buttonVariants> {
  /** الحالة العليا: `true` أثناء الطلب — يعطّل الزرّ ويُظهر Loader2 + aria-busy. */
  pending?: boolean;
  /** نصّ يظهر بديلاً عن `children` أثناء الانتظار. الافتراضي «جارٍ الحفظ…». */
  pendingText?: React.ReactNode;
  /** تعطيل يدويّ (خارج نطاق `pending`). الحالتان تُدمَجان: أيّ منهما `true` يعطّل. */
  disabled?: boolean;
}

export function SubmitButton({
  pending = false,
  pendingText = "جارٍ الحفظ…",
  disabled = false,
  children,
  type = "submit",
  variant,
  size,
  className,
  ...rest
}: SubmitButtonProps) {
  return (
    <Button
      type={type}
      variant={variant}
      size={size}
      className={className}
      disabled={pending || disabled}
      aria-busy={pending || undefined}
      {...rest}
    >
      {pending ? (
        <>
          <Loader2 aria-hidden className="size-4 animate-spin" />
          {pendingText}
        </>
      ) : (
        children
      )}
    </Button>
  );
}
