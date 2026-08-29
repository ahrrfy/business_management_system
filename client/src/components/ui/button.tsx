import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-all disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive:
          "bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 dark:bg-destructive/60",
        outline:
          "border bg-transparent shadow-xs hover:bg-accent dark:bg-transparent dark:border-input dark:hover:bg-input/50",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost:
          "hover:bg-accent dark:hover:bg-accent/50",
        link: "text-primary underline-offset-4 hover:underline",
        /* — variants دلاليّة (٢٥/٨/٢٦) —
           استعمل كلٌّ منها بدل تركيب صنف الخلفية من اسم التوكن أو تقليل hover بألفا؛ الأوّل
           **لا يُلغي** `hover:bg-primary/90` من variant
           default (Codex #801 ×3)، والثاني يقصر اللون بألفا فيُسقط التباين إلى ~3.5:1 على
           cream background (Codex #814 P2). و`text-white` وحدها تسقط تحت 2.18:1 في الغامق
           (Codex #800/#812/#813).
           الحلّ الثلاثيّ:
             (١) صنف التعبئة الدلالي المكتمل (يُقلَب حسب الوضع)
             (٢) `text-background` = النصّ يعكس الوضع دائماً ⇒ تباين WCAG صحيح
             (٣) صنف hover الدلالي المكتمل = تعبئة opaque مختلفة (أغمق في الفاتح، أفتح
                  في الغامق) — بلا ألفا يقصر التباين. */
        success:
          "bg-[var(--sem-pos)] text-background hover:bg-[var(--sem-pos-hover)]",
        warning:
          "bg-[var(--sem-warn)] text-background hover:bg-[var(--sem-warn-hover)]",
        info:
          "bg-[var(--sem-info)] text-background hover:bg-[var(--sem-info-hover)]",
      },
      size: {
        default: "h-[var(--ui-control)] px-4 py-2 has-[>svg]:px-3",
        sm: "h-[var(--ui-control-sm)] rounded-md gap-1.5 px-3 has-[>svg]:px-2.5",
        lg: "h-[var(--ui-control-lg)] rounded-md px-6 has-[>svg]:px-4",
        icon: "size-[var(--ui-control)]",
        "icon-sm": "size-[var(--ui-control-sm)]",
        "icon-lg": "size-[var(--ui-control-lg)]",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot : "button";

  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
