import React, { memo, useMemo } from "react";
import {
  CheckCircle2,
  XCircle,
  Eye,
  RotateCcw,
  Zap,
  Check,
  Plus,
  Shield,
  Clock,
  Receipt,
  Tag,
  Percent,
  Layers,
  FileSpreadsheet,
  Boxes,
  Truck,
  Users,
  Wallet,
  Building,
  Wrench,
  Package,
  ShoppingCart,
  Send,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { getActionVisualTokens, type ResourceRowViewModel, type ResourceActionSlot } from "./types";

const RESOURCE_ICONS: Record<string, LucideIcon> = {
  Clock,
  Receipt,
  Tag,
  Percent,
  Layers,
  FileSpreadsheet,
  Boxes,
  Truck,
  Users,
  Wallet,
  Building,
  Wrench,
  Package,
  ShoppingCart,
  Send,
};

export interface PermissionResourceCardProps {
  resource: ResourceRowViewModel;
  onToggle: (key: string, nextGranted: boolean) => void;
  onBulkUpdate: (updates: Record<string, boolean>) => void;
  disabled?: boolean;
}

export const PermissionResourceCard = memo(function PermissionResourceCard({
  resource,
  onToggle,
  onBulkUpdate,
  disabled = false,
}: PermissionResourceCardProps) {
  const IconComponent = (resource.iconName && RESOURCE_ICONS[resource.iconName]) || Shield;

  const actionList = useMemo(() => {
    if (resource.allActions && resource.allActions.length > 0) {
      return resource.allActions;
    }
    return Object.values(resource.actions || {}).filter((s) => s.isSupported);
  }, [resource.allActions, resource.actions]);

  const handleGrantAll = () => {
    if (disabled) return;
    const updates: Record<string, boolean> = {};
    for (const slot of actionList) {
      updates[slot.key] = true;
    }
    onBulkUpdate(updates);
  };

  const handleViewOnly = () => {
    if (disabled) return;
    const updates: Record<string, boolean> = {};
    for (const slot of actionList) {
      const isView =
        slot.action === "view" ||
        (slot.definition?.standardAction === "view") ||
        slot.key.endsWith(".view");
      updates[slot.key] = isView;
    }
    onBulkUpdate(updates);
  };

  const handleDenyAll = () => {
    if (disabled) return;
    const updates: Record<string, boolean> = {};
    for (const slot of actionList) {
      updates[slot.key] = false;
    }
    onBulkUpdate(updates);
  };

  const handleResetToRole = () => {
    if (disabled) return;
    const updates: Record<string, boolean> = {};
    for (const slot of actionList) {
      updates[slot.key] = slot.baseGranted;
    }
    onBulkUpdate(updates);
  };

  const totalActions = resource.totalActionsCount || actionList.length;
  const grantedActions =
    resource.grantedActionsCount !== undefined
      ? resource.grantedActionsCount
      : actionList.filter((s) => s.granted).length;

  const isFullGranted = totalActions > 0 && grantedActions === totalActions;
  const isNoneGranted = grantedActions === 0;

  return (
    <div
      className={cn(
        "rounded-lg border bg-card p-3 transition-all",
        resource.hasCustomOverrides
          ? "border-primary/40 shadow-xs"
          : "border-border hover:border-border/80",
      )}
    >
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2 pb-2.5 border-b border-border/60">
        <div className="flex items-center gap-2 min-w-0">
          <div className="size-7 rounded-md bg-muted/60 flex items-center justify-center shrink-0">
            <IconComponent aria-hidden="true" className="size-4 text-primary" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold text-xs text-foreground truncate">
                {resource.label}
              </span>
              <Badge
                variant="outline"
                className={cn(
                  "text-[10px] font-mono px-1.5 py-0 border",
                  isFullGranted &&
                    "bg-[var(--sem-pos-bg)] text-[var(--sem-pos)] border-[var(--sem-pos)] font-bold",
                  isNoneGranted && "bg-muted text-muted-foreground border-border",
                  !isFullGranted &&
                    !isNoneGranted &&
                    "bg-primary/10 text-primary border-primary/30",
                )}
              >
                {resource.grantedActionsCount} / {resource.totalActionsCount}
              </Badge>
              {resource.hasCustomOverrides && (
                <Badge
                  variant="outline"
                  className="text-[10px] px-1.5 py-0 border-primary text-primary"
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
          </div>
        </div>

        {/* Row-Level Quick Controls */}
        {!disabled && (
          <div className="flex items-center gap-1 flex-wrap">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleGrantAll}
              className="h-6 px-1.5 text-[10px] text-muted-foreground hover:text-[var(--sem-pos)]"
              title="منح كافة صلاحيات هذا المورد"
            >
              <CheckCircle2 aria-hidden="true" className="size-3 me-1 text-[var(--sem-pos)]" />
              منح الكل
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleViewOnly}
              className="h-6 px-1.5 text-[10px] text-muted-foreground hover:text-primary"
              title="تفعيل العرض فقط وحجب الإضافة والتعديل"
            >
              <Eye aria-hidden="true" className="size-3 me-1 text-primary" />
              عرض فقط
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleDenyAll}
              className="h-6 px-1.5 text-[10px] text-muted-foreground hover:text-[var(--sem-neg)]"
              title="حجب كافة صلاحيات هذا المورد"
            >
              <XCircle aria-hidden="true" className="size-3 me-1 text-[var(--sem-neg)]" />
              حجب
            </Button>
            {resource.hasCustomOverrides && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={handleResetToRole}
                className="h-6 px-1.5 text-[10px] text-muted-foreground hover:text-foreground"
                title="إعادة ضبط المورد لقالب الدور"
              >
                <RotateCcw aria-hidden="true" className="size-3 me-1" />
                استعادة الدور
              </Button>
            )}
          </div>
        )}
      </div>

      {/* Action Chips / Pills Grid */}
      <div className="pt-2.5 grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
        {actionList.map((slot) => {
          const tokens = getActionVisualTokens(slot.state);
          const isSpecial =
            slot.definition?.isSpecialOperation ||
            slot.definition?.sensitivity === "critical" ||
            slot.definition?.sensitivity === "high";

          return (
            <button
              key={slot.key}
              type="button"
              disabled={disabled}
              onClick={() => onToggle(slot.key, !slot.granted)}
              className={cn(
                "flex flex-col text-start p-2 rounded-md border text-xs transition-all cursor-pointer select-none",
                slot.granted
                  ? "bg-card border-primary/40 shadow-xs hover:border-primary"
                  : "bg-muted/30 border-border/70 text-muted-foreground hover:bg-muted/50 hover:border-border",
                isSpecial && slot.granted && "border-amber-500/50 bg-amber-50/20 dark:bg-amber-950/10",
                tokens.isCustom &&
                  (slot.state === "CUSTOM_GRANT"
                    ? "ring-1 ring-[var(--sem-pos)]"
                    : "ring-1 ring-[var(--sem-neg)]"),
              )}
              title={slot.definition?.descriptionAr || slot.definition?.description}
            >
              <div className="flex items-center justify-between gap-1.5 w-full">
                <span
                  className={cn(
                    "font-medium text-xs truncate",
                    slot.granted ? "text-foreground" : "text-muted-foreground",
                  )}
                >
                  {slot.definition?.labelAr || slot.definition?.label || slot.action}
                </span>

                <div className="flex items-center gap-1 shrink-0">
                  {tokens.isCustom && (
                    <span
                      className={cn(
                        "text-[9px] font-bold px-1 rounded",
                        slot.state === "CUSTOM_GRANT"
                          ? "bg-[var(--sem-pos-bg)] text-[var(--sem-pos)]"
                          : "bg-[var(--sem-neg-bg)] text-[var(--sem-neg)]",
                      )}
                    >
                      {tokens.badgeLabel}
                    </span>
                  )}
                  <div
                    className={cn(
                      "size-4 rounded-full flex items-center justify-center transition-colors",
                      slot.granted
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-muted-foreground/60 border border-border",
                    )}
                  >
                    {slot.granted ? (
                      <Check aria-hidden="true" className="size-2.5 stroke-[3]" />
                    ) : (
                      <Plus aria-hidden="true" className="size-2.5" />
                    )}
                  </div>
                </div>
              </div>

              {isSpecial && (
                <div className="mt-1.5 flex items-center gap-1 text-[10px] text-amber-700 dark:text-amber-400 font-medium">
                  <Zap aria-hidden="true" className="size-3 shrink-0" />
                  <span>عملية تشغيلية حساسة</span>
                </div>
              )}

              {slot.definition?.descriptionAr && (
                <p className="mt-1 text-[10px] text-muted-foreground line-clamp-1">
                  {slot.definition.descriptionAr}
                </p>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
});
