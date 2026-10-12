import React, { memo } from "react";
import { Check, X } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  getActionVisualTokens,
  type ResourceActionSlot,
} from "./types";

export interface PermissionActionCellProps {
  slot: ResourceActionSlot;
  onToggle: (key: string, nextGranted: boolean) => void;
  disabled?: boolean;
}

export const PermissionActionCell = memo(function PermissionActionCell({
  slot,
  onToggle,
  disabled = false,
}: PermissionActionCellProps) {
  if (!slot.isSupported) {
    return (
      <div
        className="flex items-center justify-center h-8 w-full text-center"
        aria-label="غير مدعوم لهذا المورد"
      >
        <span className="text-muted-foreground/30 font-mono text-xs select-none">
          —
        </span>
      </div>
    );
  }

  const tokens = getActionVisualTokens(slot.state);
  const def = slot.definition;
  const actionLabel = def?.labelAr || def?.label || slot.action;
  const description = def?.descriptionAr || def?.description || "";

  const handleClick = () => {
    if (disabled) return;
    onToggle(slot.key, !slot.granted);
  };

  const buttonContent = (
    <button
      type="button"
      disabled={disabled}
      onClick={handleClick}
      aria-pressed={slot.granted}
      aria-label={`${actionLabel} (${slot.key}) — ${slot.granted ? "ممنوحة" : "محجوبة"}`}
      className={cn(
        "relative inline-flex items-center justify-center size-7 rounded-md border text-xs font-semibold transition-all select-none",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
        "disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer",
        tokens.wrapperClass,
      )}
    >
      {slot.granted ? (
        <Check aria-hidden="true" className="size-3.5 stroke-[2.5]" />
      ) : (
        <X aria-hidden="true" className="size-3.5 stroke-[2]" />
      )}
      {tokens.isCustom && (
        <span
          className={cn(
            "absolute -top-1 -right-1 size-2 rounded-full border border-background",
            slot.state === "CUSTOM_GRANT"
              ? "bg-[var(--sem-pos)]"
              : "bg-[var(--sem-neg)]",
          )}
          aria-hidden="true"
        />
      )}
    </button>
  );

  return (
    <div className="flex items-center justify-center py-1">
      <Tooltip>
        <TooltipTrigger asChild>
          {buttonContent}
        </TooltipTrigger>
        <TooltipContent
          side="top"
          className="max-w-xs text-start text-xs p-2 space-y-1 z-50"
        >
          <div className="font-semibold text-foreground flex items-center justify-between gap-2">
            <span>{actionLabel}</span>
            <span
              className={cn(
                "text-[10px] px-1.5 py-0.5 rounded font-mono",
                tokens.wrapperClass,
              )}
            >
              {tokens.badgeLabel}
            </span>
          </div>
          <div className="text-[11px] font-mono text-muted-foreground direction-ltr text-left">
            {slot.key}
          </div>
          {description && (
            <div className="text-[11px] text-muted-foreground leading-relaxed">
              {description}
            </div>
          )}
          <div className="text-[10px] text-muted-foreground pt-0.5 border-t border-border/50">
            {tokens.ariaDesc}
          </div>
        </TooltipContent>
      </Tooltip>
    </div>
  );
});
