import React, { memo, useState } from "react";
import {
  CheckCircle2,
  XCircle,
  Eye,
  RotateCcw,
  Zap,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { type StandardActionType } from "@shared/atomicPermissions";
import { PermissionActionCell } from "./PermissionActionCell";
import { getActionVisualTokens, type ResourceRowViewModel } from "./types";
import { cn } from "@/lib/utils";

export interface PermissionResourceRowProps {
  resource: ResourceRowViewModel;
  onToggle: (key: string, nextGranted: boolean) => void;
  onBulkUpdate?: (updates: Record<string, boolean>) => void;
  disabled?: boolean;
  expandSpecialOperations?: boolean;
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
  onBulkUpdate,
  disabled = false,
  expandSpecialOperations = false,
}: PermissionResourceRowProps) {
  const [showSpecialTray, setShowSpecialTray] = useState(false);
  const isTrayOpen = showSpecialTray || expandSpecialOperations;

  const handleGrantAll = () => {
    if (disabled || !onBulkUpdate) return;
    const updates: Record<string, boolean> = {};
    for (const slot of resource.allActions) {
      updates[slot.key] = true;
    }
    onBulkUpdate(updates);
  };

  const handleViewOnly = () => {
    if (disabled || !onBulkUpdate) return;
    const updates: Record<string, boolean> = {};
    for (const slot of resource.allActions) {
      const isView =
        slot.action === "view" ||
        slot.definition?.standardAction === "view" ||
        slot.key.endsWith(".view");
      updates[slot.key] = isView;
    }
    onBulkUpdate(updates);
  };

  const handleDenyAll = () => {
    if (disabled || !onBulkUpdate) return;
    const updates: Record<string, boolean> = {};
    for (const slot of resource.allActions) {
      updates[slot.key] = false;
    }
    onBulkUpdate(updates);
  };

  const handleResetToRole = () => {
    if (disabled || !onBulkUpdate) return;
    const updates: Record<string, boolean> = {};
    for (const slot of resource.allActions) {
      updates[slot.key] = slot.baseGranted;
    }
    onBulkUpdate(updates);
  };

  const hasSpecial = resource.specialActions && resource.specialActions.length > 0;

  return (
    <>
      <tr className="border-t border-border hover:bg-muted/30 transition-colors">
        <td className="px-3 py-2 text-start align-middle sticky start-0 bg-background/95 backdrop-blur-xs z-10 border-e border-border min-w-[240px] max-w-[320px]">
          <div className="flex items-center justify-between gap-1">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="font-semibold text-xs text-foreground">
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

            {/* Row Quick Action Buttons */}
            {!disabled && onBulkUpdate && (
              <div className="flex items-center gap-0.5">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={handleGrantAll}
                  className="size-5 text-muted-foreground hover:text-[var(--sem-pos)] p-0"
                  title="منح الكل لهذا المورد"
                >
                  <CheckCircle2 aria-hidden="true" className="size-3 text-[var(--sem-pos)]" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={handleViewOnly}
                  className="size-5 text-muted-foreground hover:text-primary p-0"
                  title="عرض فقط لهذا المورد"
                >
                  <Eye aria-hidden="true" className="size-3 text-primary" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={handleDenyAll}
                  className="size-5 text-muted-foreground hover:text-[var(--sem-neg)] p-0"
                  title="حجب الكل لهذا المورد"
                >
                  <XCircle aria-hidden="true" className="size-3 text-[var(--sem-neg)]" />
                </Button>
                {resource.hasCustomOverrides && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={handleResetToRole}
                    className="size-5 text-muted-foreground hover:text-foreground p-0"
                    title="استعادة قالب الدور لهذا المورد"
                  >
                    <RotateCcw aria-hidden="true" className="size-3" />
                  </Button>
                )}
              </div>
            )}
          </div>

          {resource.description && (
            <p className="text-[11px] text-muted-foreground mt-0.5 line-clamp-1">
              {resource.description}
            </p>
          )}

          {hasSpecial && (
            <div className="mt-1">
              <button
                type="button"
                onClick={() => setShowSpecialTray((prev) => !prev)}
                className="inline-flex items-center gap-1 text-[10px] text-amber-600 dark:text-amber-400 font-medium hover:underline cursor-pointer"
              >
                <Zap aria-hidden="true" className="size-2.5" />
                <span>
                  {resource.specialActions.length} عمليات إضافية / حساسة
                </span>
                {isTrayOpen ? (
                  <ChevronUp aria-hidden="true" className="size-2.5" />
                ) : (
                  <ChevronDown aria-hidden="true" className="size-2.5" />
                )}
              </button>
            </div>
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

      {/* Special Operations Drawer if expanded */}
      {isTrayOpen && hasSpecial && (
        <tr className="bg-amber-50/20 dark:bg-amber-950/10 border-b border-border">
          <td colSpan={9} className="p-2.5">
            <div className="flex flex-wrap gap-2 items-center">
              <span className="text-[11px] font-semibold text-amber-700 dark:text-amber-300 flex items-center gap-1">
                <Zap aria-hidden="true" className="size-3" />
                العمليات الاستثنائية والحساسة:
              </span>
              {resource.specialActions.map((slot) => {
                const tokens = getActionVisualTokens(slot.state);
                const sensitivity = slot.definition?.sensitivity;
                return (
                  <button
                    key={slot.key}
                    type="button"
                    disabled={disabled}
                    onClick={() => onToggle(slot.key, !slot.granted)}
                    className={cn(
                      "px-2 py-1 rounded border text-xs flex items-center gap-1.5 transition-all cursor-pointer",
                      slot.granted
                        ? "bg-card border-amber-500/60 text-foreground font-medium shadow-xs"
                        : "bg-muted/50 border-border text-muted-foreground line-through opacity-70",
                    )}
                    title={slot.definition?.descriptionAr || slot.definition?.description}
                  >
                    <span>{slot.definition?.labelAr || slot.definition?.label}</span>
                    {sensitivity === "critical" && (
                      <Badge variant="outline" className="text-[9px] px-1 py-0 bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/30">
                        حرج
                      </Badge>
                    )}
                    {sensitivity === "high" && (
                      <Badge variant="outline" className="text-[9px] px-1 py-0 bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30">
                        عالي
                      </Badge>
                    )}
                    <Badge
                      variant="outline"
                      className={cn(
                        "text-[9px] px-1 py-0",
                        slot.granted
                          ? "bg-[var(--sem-pos-bg)] text-[var(--sem-pos)] border-[var(--sem-pos)]"
                          : "bg-muted text-muted-foreground",
                      )}
                    >
                      {slot.granted ? "مفعل" : "معطل"}
                    </Badge>
                  </button>
                );
              })}
            </div>
          </td>
        </tr>
      )}
    </>
  );
});
