import React, { memo, useEffect, useState } from "react";
import {
  Search,
  RotateCcw,
  X,
  SlidersHorizontal,
  LayoutGrid,
  Table,
  Zap,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { AppSelect } from "@/components/ui/AppSelect";
import { cn } from "@/lib/utils";
import { ALL_DOMAINS, DOMAIN_METADATA, type DomainKey } from "@shared/atomicPermissions";
import type { PermissionViewMode } from "./types";

export interface PermissionMatrixFiltersProps {
  searchQuery: string;
  onSearchChange: (query: string) => void;
  selectedDomain: DomainKey | "all";
  onDomainChange: (domain: DomainKey | "all") => void;
  overridesOnly: boolean;
  onOverridesOnlyChange: (overridesOnly: boolean) => void;
  viewMode: PermissionViewMode;
  onViewModeChange: (mode: PermissionViewMode) => void;
  customGrantsCount: number;
  customDeniesCount: number;
  onResetToTemplate?: () => void;
  disabled?: boolean;
  expandSpecialOperations?: boolean;
  onExpandSpecialOperationsChange?: (expand: boolean) => void;
}

export const PermissionMatrixFilters = memo(function PermissionMatrixFilters({
  searchQuery,
  onSearchChange,
  selectedDomain,
  onDomainChange,
  overridesOnly,
  onOverridesOnlyChange,
  viewMode,
  onViewModeChange,
  customGrantsCount,
  customDeniesCount,
  onResetToTemplate,
  disabled = false,
  expandSpecialOperations = false,
  onExpandSpecialOperationsChange,
}: PermissionMatrixFiltersProps) {
  // Local state for 60fps fast typing while debouncing upstream change by 180ms.
  // Preserves Arabic spaces (NO trim on keystroke).
  const [localSearch, setLocalSearch] = useState(searchQuery);

  useEffect(() => {
    setLocalSearch(searchQuery);
  }, [searchQuery]);

  useEffect(() => {
    const handler = setTimeout(() => {
      onSearchChange(localSearch);
    }, 180);

    return () => clearTimeout(handler);
  }, [localSearch, onSearchChange]);

  const totalOverrides = customGrantsCount + customDeniesCount;

  return (
    <div className="flex flex-wrap items-center justify-between gap-2.5 p-2 rounded-lg bg-card border border-border shadow-xs">
      <div className="flex flex-wrap items-center gap-2 flex-1 min-w-[240px]">
        {/* Search Input */}
        <div className="relative flex-1 min-w-[180px] max-w-sm">
          <Search
            aria-hidden="true"
            className="absolute right-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground pointer-events-none"
          />
          <Input
            type="text"
            disabled={disabled}
            value={localSearch}
            onChange={(e) => setLocalSearch(e.target.value)}
            placeholder="ابحث في الصلاحيات والمفاتيح والموارد…"
            className="h-8 pr-8 pl-7 text-xs"
            aria-label="البحث في شجرة الصلاحيات"
          />
          {localSearch && (
            <button
              type="button"
              onClick={() => {
                setLocalSearch("");
                onSearchChange("");
              }}
              className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground cursor-pointer"
              aria-label="مسح البحث"
            >
              <X aria-hidden="true" className="size-3" />
            </button>
          )}
        </div>

        {/* Domain Filter Select */}
        <div className="w-[160px]">
          <AppSelect
            id="domain-filter-select"
            value={selectedDomain}
            onValueChange={(val) => onDomainChange(val as DomainKey | "all")}
            disabled={disabled}
            className="h-8 text-xs"
          >
            <option value="all">كافة القطاعات (الكل)</option>
            {ALL_DOMAINS.map((dom) => (
              <option key={dom} value={dom}>
                {DOMAIN_METADATA[dom].label}
              </option>
            ))}
          </AppSelect>
        </div>

        {/* Overrides Only Toggle */}
        <Button
          type="button"
          variant={overridesOnly ? "default" : "outline"}
          size="sm"
          disabled={disabled}
          onClick={() => onOverridesOnlyChange(!overridesOnly)}
          className={cn(
            "h-8 px-2.5 text-xs gap-1.5 transition-all select-none",
            overridesOnly
              ? "bg-primary text-primary-foreground font-semibold"
              : "bg-background text-muted-foreground hover:text-foreground",
          )}
        >
          <SlidersHorizontal aria-hidden="true" className="size-3.5" />
          <span>الاستثناءات فقط</span>
          {totalOverrides > 0 && (
            <Badge
              variant="outline"
              className={cn(
                "text-[10px] px-1 py-0 border font-mono",
                overridesOnly
                  ? "bg-primary-foreground/20 text-primary-foreground border-transparent"
                  : "bg-muted text-foreground border-border",
              )}
            >
              {totalOverrides}
            </Badge>
          )}
        </Button>
      </div>

      {/* View Mode Toggle + Overrides Summary */}
      <div className="flex items-center gap-2 flex-wrap">
        {/* Dual View Mode Switcher */}
        <div className="inline-flex items-center p-0.5 rounded-md bg-muted text-xs border border-border">
          <button
            type="button"
            onClick={() => onViewModeChange("cards")}
            className={cn(
              "flex items-center gap-1.5 px-2.5 py-1 rounded transition-all cursor-pointer",
              viewMode === "cards"
                ? "bg-background text-foreground shadow-xs font-semibold"
                : "text-muted-foreground hover:text-foreground",
            )}
            title="عرض البطاقات والشجرة (أفضل ممارسة — بدون أعمدة فارغة)"
          >
            <LayoutGrid aria-hidden="true" className="size-3.5 text-primary" />
            <span>البطاقات والشجرة</span>
          </button>
          <button
            type="button"
            onClick={() => onViewModeChange("grid")}
            className={cn(
              "flex items-center gap-1.5 px-2.5 py-1 rounded transition-all cursor-pointer",
              viewMode === "grid"
                ? "bg-background text-foreground shadow-xs font-semibold"
                : "text-muted-foreground hover:text-foreground",
            )}
            title="عرض جدول المصفوفة والمقارنة"
          >
            <Table aria-hidden="true" className="size-3.5" />
            <span>جدول المصفوفة</span>
          </button>
        </div>

        {onExpandSpecialOperationsChange && (
          <Button
            type="button"
            variant={expandSpecialOperations ? "secondary" : "outline"}
            size="sm"
            disabled={disabled}
            onClick={() => onExpandSpecialOperationsChange(!expandSpecialOperations)}
            className={cn(
              "h-8 px-2.5 text-xs gap-1.5 transition-colors cursor-pointer",
              expandSpecialOperations && "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/40 font-medium",
            )}
            title="توسيع أو طي كافة العمليات التشغيلية الاستثنائية والحساسة عبر كافة الموارد"
          >
            <Zap aria-hidden="true" className="size-3.5 text-amber-500" />
            <span>العمليات الخاصة</span>
          </Button>
        )}

        {totalOverrides > 0 && (
          <div className="flex items-center gap-1.5 text-xs font-mono">
            <span className="text-muted-foreground font-sans">الاستثناءات:</span>
            {customGrantsCount > 0 && (
              <Badge
                variant="outline"
                className="text-[10px] px-1.5 py-0 bg-[var(--sem-pos-bg)] text-[var(--sem-pos)] border-[var(--sem-pos)] font-bold"
              >
                +{customGrantsCount} منح
              </Badge>
            )}
            {customDeniesCount > 0 && (
              <Badge
                variant="outline"
                className="text-[10px] px-1.5 py-0 bg-[var(--sem-neg-bg)] text-[var(--sem-neg)] border-[var(--sem-neg)] font-bold"
              >
                −{customDeniesCount} حجب
              </Badge>
            )}
          </div>
        )}

        {totalOverrides > 0 && onResetToTemplate && !disabled && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onResetToTemplate}
            className="h-8 px-2 text-xs text-muted-foreground hover:text-foreground gap-1"
            title="إعادة ضبط كافة الصلاحيات إلى قالب الدور المعتمد"
          >
            <RotateCcw aria-hidden="true" className="size-3.5" />
            <span>إعادة لقالب الدور</span>
          </Button>
        )}
      </div>
    </div>
  );
});
