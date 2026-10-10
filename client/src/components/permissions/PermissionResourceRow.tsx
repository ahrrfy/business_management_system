import React, { memo } from "react";
import { Badge } from "@/components/ui/badge";
import { STANDARD_ACTIONS, type StandardActionType } from "@shared/atomicPermissions";
import { PermissionActionCell } from "./PermissionActionCell";
import type { ResourceRowViewModel } from "./types";

export interface PermissionResourceRowProps {
  resource: ResourceRowViewModel;
  onToggle: (key: string, nextGranted: boolean) => void;
  disabled?: boolean;
}

const ACTION_KEYS: StandardActionType[] = [
  "view",
  "create",
  "edit",
  "cancel",
  "print",
  "reprint",
  "export",
  "approve",
];

export const PermissionResourceRow = memo(function PermissionResourceRow({
  resource,
  onToggle,
  disabled = false,
}: PermissionResourceRowProps) {
  return (
    <tr className="border-t border-border hover:bg-muted/30 transition-colors">
      <td className="px-3 py-2 text-start align-middle sticky start-0 bg-background/95 backdrop-blur-xs z-10 border-e border-border min-w-[200px] max-w-[280px]">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="font-medium text-xs text-foreground">
            {resource.label}
          </span>
          {resource.hasCustomOverrides && (
            <Badge
              variant="outline"
              className="text-[10px] px-1 py-0 border-primary text-primary"
            >
              مخصّص
            </Badge>
          )}
        </div>
        {resource.description && (
          <p className="text-[11px] text-muted-foreground mt-0.5 line-clamp-1">
            {resource.description}
          </p>
        )}
      </td>

      {ACTION_KEYS.map((actionKey) => {
        const slot = resource.actions[actionKey];
        return (
          <td
            key={actionKey}
            className="px-1 py-1.5 text-center align-middle border-e border-border"
          >
            {slot ? (
              <PermissionActionCell
                slot={slot}
                onToggle={onToggle}
                disabled={disabled}
              />
            ) : (
              <div
                className="flex items-center justify-center h-8 text-center"
                aria-label="غير مدعوم"
              >
                <span className="text-muted-foreground/30 font-mono text-xs select-none">
                  —
                </span>
              </div>
            )}
          </td>
        );
      })}
    </tr>
  );
});
