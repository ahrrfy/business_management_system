import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/** تبويب ورشةٍ في رأس عمود العمل (§٨.١). */
export function WsTab({ active, onClick, Icon, label, badge }: {
  active: boolean;
  onClick: () => void;
  Icon: LucideIcon;
  label: string;
  badge?: number;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-xs font-extrabold transition-colors",
        active ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:bg-muted",
      )}
    >
      <Icon aria-hidden className="size-4" />
      {label}
      {badge != null && badge > 0 && (
        <span className={cn("rounded-full px-1.5 text-[10px] tabular-nums", active ? "bg-primary-foreground/20" : "bg-muted-foreground/15")}>{badge}</span>
      )}
    </button>
  );
}
