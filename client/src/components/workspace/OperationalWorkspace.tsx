import * as React from "react";
import { cn } from "@/lib/utils";

type WorkspaceBarVariant = "command" | "filters" | "status";

const BAR_CLASS: Record<WorkspaceBarVariant, string> = {
  command:
    "workspace-command-bar min-h-[var(--workspace-command-h)] border-b border-border/70 bg-background py-1",
  filters:
    "workspace-filter-bar min-h-[var(--workspace-toolbar-h)] rounded-md border border-border/70 bg-card py-0",
  status:
    "workspace-status-bar sticky bottom-0 z-20 min-h-[var(--workspace-status-h)] border-t border-border/80 bg-card/95 py-0 shadow-[0_-1px_4px_rgb(15_23_42/0.06)] backdrop-blur-sm",
};

export interface WorkspaceBarProps extends React.HTMLAttributes<HTMLDivElement> {
  variant: WorkspaceBarVariant;
  /** اسم واضح لقارئ الشاشة حين يعمل الشريط كـtoolbar أو navigation. */
  label?: string;
}

/**
 * الشريط التشغيلي القانوني للقوائم والتقارير.
 *
 * - command: عنوان الصفحة وإجراءاتها الأساسية (44px).
 * - filters: البحث والفلاتر السريعة (40px).
 * - status: العدّاد/الإجماليات/الترقيم أسفل مساحة البيانات (40px).
 *
 * لا يفرض محتوى بعينه؛ إنما يثبت الارتفاع والمسافة والسطح والدلالة في مكان واحد.
 */
export function WorkspaceBar({
  variant,
  label,
  className,
  children,
  role,
  ...props
}: WorkspaceBarProps) {
  const resolvedRole = role ?? (variant === "status" ? "status" : "toolbar");
  return (
    <div
      data-workspace-bar={variant}
      role={resolvedRole}
      aria-label={label}
      className={cn(
        "flex min-w-0 items-center gap-[var(--workspace-gap)] px-[var(--workspace-pad-x)]",
        BAR_CLASS[variant],
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export function WorkspaceStatusBar({
  label = "حالة البيانات",
  className,
  children,
  ...props
}: Omit<WorkspaceBarProps, "variant">) {
  return (
    <WorkspaceBar
      variant="status"
      label={label}
      className={cn("justify-between text-xs text-muted-foreground", className)}
      {...props}
    >
      {children}
    </WorkspaceBar>
  );
}
