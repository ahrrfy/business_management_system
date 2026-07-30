import { cn } from "@/lib/utils";
import * as React from "react";

export interface FilterFieldProps {
  label: string;
  children: React.ReactNode;
  className?: string;
}

/**
 * غلاف تسمية موحّد لفلاتر القوائم.
 * يمنع الاعتماد على placeholder وحده، والذي يختفي بعد الاختيار ولا يشرح وظيفة الحقل.
 */
export function FilterField({ label, children, className }: FilterFieldProps) {
  return (
    <label className={cn("flex min-w-0 flex-col gap-1", className)}>
      <span className="px-0.5 text-[11px] font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}
