import React, { memo, useState } from "react";
import {
  ChevronDown,
  ChevronLeft,
  Store,
  ClipboardList,
  Wrench,
  Boxes,
  ShoppingCart,
  Landmark,
  Briefcase,
  Truck,
  Users,
  ShieldCheck,
  Shield,
  Eye,
  CheckCircle2,
  XCircle,
  RotateCcw,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { PermissionResourceRow } from "./PermissionResourceRow";
import { PermissionResourceCard } from "./PermissionResourceCard";
import type { DomainCategoryViewModel, PermissionViewMode } from "./types";
import { STANDARD_ACTIONS } from "@shared/atomicPermissions";

export interface PermissionCategoryCardProps {
  category: DomainCategoryViewModel;
  onToggle: (key: string, nextGranted: boolean) => void;
  onBulkUpdate: (updates: Record<string, boolean>) => void;
  disabled?: boolean;
  defaultExpanded?: boolean;
  viewMode?: PermissionViewMode;
}

const DOMAIN_ICONS: Record<string, LucideIcon> = {
  Store,
  ClipboardList,
  Wrench,
  Boxes,
  ShoppingCart,
  Landmark,
  Briefcase,
  Truck,
  Users,
  ShieldCheck,
};

export const PermissionCategoryCard = memo(function PermissionCategoryCard({
  category,
  onToggle,
  onBulkUpdate,
  disabled = false,
  defaultExpanded = true,
  viewMode = "grid",
}: PermissionCategoryCardProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);

  const IconComponent = DOMAIN_ICONS[category.iconName] || Shield;

  const handleGrantAll = () => {
    if (disabled) return;
    const updates: Record<string, boolean> = {};
    for (const res of category.resources) {
      const actions = res.allActions && res.allActions.length > 0 ? res.allActions : Object.values(res.actions || {});
      for (const slot of actions) {
        if (slot.key) updates[slot.key] = true;
      }
    }
    onBulkUpdate(updates);
  };

  const handleViewOnly = () => {
    if (disabled) return;
    const updates: Record<string, boolean> = {};
    for (const res of category.resources) {
      const actions = res.allActions && res.allActions.length > 0 ? res.allActions : Object.values(res.actions || {});
      for (const slot of actions) {
        if (!slot.key) continue;
        const isView =
          slot.action === "view" ||
          slot.definition?.standardAction === "view" ||
          slot.key.endsWith(".view");
        updates[slot.key] = isView;
      }
    }
    onBulkUpdate(updates);
  };

  const handleDenyAll = () => {
    if (disabled) return;
    const updates: Record<string, boolean> = {};
    for (const res of category.resources) {
      const actions = res.allActions && res.allActions.length > 0 ? res.allActions : Object.values(res.actions || {});
      for (const slot of actions) {
        if (slot.key) updates[slot.key] = false;
      }
    }
    onBulkUpdate(updates);
  };

  const handleResetToRole = () => {
    if (disabled) return;
    const updates: Record<string, boolean> = {};
    for (const res of category.resources) {
      const actions = res.allActions && res.allActions.length > 0 ? res.allActions : Object.values(res.actions || {});
      for (const slot of actions) {
        if (slot.key) updates[slot.key] = slot.baseGranted;
      }
    }
    onBulkUpdate(updates);
  };

  const isFullGranted =
    category.totalActions > 0 && category.grantedActions === category.totalActions;
  const isNoneGranted = category.grantedActions === 0;

  return (
    <div className="rounded-lg border border-border bg-card shadow-xs overflow-hidden transition-all">
      {/* Category Header */}
      <div className="flex flex-wrap items-center justify-between gap-2.5 bg-muted/40 px-3.5 py-2.5 border-b border-border">
        <button
          type="button"
          onClick={() => setIsExpanded((prev) => !prev)}
          className="flex items-center gap-2 text-xs font-semibold text-foreground hover:text-primary transition-colors cursor-pointer select-none"
          aria-expanded={isExpanded}
        >
          {isExpanded ? (
            <ChevronDown aria-hidden="true" className="size-4 text-muted-foreground" />
          ) : (
            <ChevronLeft aria-hidden="true" className="size-4 text-muted-foreground" />
          )}
          <IconComponent aria-hidden="true" className="size-4 text-primary shrink-0" />
          <span>{category.label}</span>
          <span className="text-[11px] font-normal text-muted-foreground hidden sm:inline">
            ({category.resources.length} موارد • {category.totalActions} مفاتيح ذرية)
          </span>
        </button>

        <div className="flex items-center gap-2 flex-wrap">
          {/* Grant Counter */}
          <Badge
            variant="outline"
            className={cn(
              "text-[10px] font-mono px-2 py-0.5 border",
              isFullGranted &&
                "bg-[var(--sem-pos-bg)] text-[var(--sem-pos)] border-[var(--sem-pos)] font-bold",
              isNoneGranted && "bg-muted text-muted-foreground border-border",
              !isFullGranted &&
                !isNoneGranted &&
                "bg-primary/10 text-primary border-primary/30",
            )}
          >
            {category.grantedActions} / {category.totalActions}
          </Badge>

          {category.customOverridesCount > 0 && (
            <Badge
              variant="outline"
              className="text-[10px] px-1.5 py-0 border-primary text-primary"
            >
              {category.customOverridesCount} مخصّص
            </Badge>
          )}

          {/* Bulk Action Controls */}
          {!disabled && (
            <div className="flex items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={handleGrantAll}
                className="h-6 px-1.5 text-[10px] text-muted-foreground hover:text-[var(--sem-pos)]"
                title="منح كل العمليات في هذا القطاع"
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
                title="تفعيل العرض فقط وحجب الإضافة والتعديل والاعتماد"
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
                title="حجب كافة العمليات في هذا القطاع"
              >
                <XCircle aria-hidden="true" className="size-3 me-1 text-[var(--sem-neg)]" />
                حجب الكل
              </Button>
              {category.customOverridesCount > 0 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={handleResetToRole}
                  className="h-6 px-1.5 text-[10px] text-muted-foreground hover:text-foreground"
                  title="استعادة قالب الدور لكافة عمليات هذا القطاع"
                >
                  <RotateCcw aria-hidden="true" className="size-3 me-1" />
                  استعادة القطاع
                </Button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Resource Content: Cards View vs Grid View */}
      {isExpanded && (
        <div className="p-3">
          {viewMode === "cards" ? (
            <div className="space-y-3">
              {category.resources.map((res) => (
                <PermissionResourceCard
                  key={res.resource}
                  resource={res}
                  onToggle={onToggle}
                  onBulkUpdate={onBulkUpdate}
                  disabled={disabled}
                />
              ))}
            </div>
          ) : (
            <div className="overflow-x-auto rounded border border-border">
              <table className="w-full text-xs border-collapse">
                <thead>
                  <tr className="bg-muted/20 border-b border-border text-[11px] text-muted-foreground font-semibold">
                    <th className="px-3 py-2 text-start sticky start-0 bg-muted/40 z-10 border-e border-border min-w-[240px] max-w-[320px]">
                      المورد / الشاشة
                    </th>
                    {STANDARD_ACTIONS.map((act) => (
                      <th
                        key={act.action}
                        className="px-1 py-2 text-center border-e border-border min-w-[56px]"
                      >
                        {act.labelAr}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {category.resources.map((res) => (
                    <PermissionResourceRow
                      key={res.resource}
                      resource={res}
                      onToggle={onToggle}
                      onBulkUpdate={onBulkUpdate}
                      disabled={disabled}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
});
