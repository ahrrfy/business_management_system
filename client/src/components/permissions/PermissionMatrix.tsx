import React, { memo, useMemo, useState, useCallback } from "react";
import {
  ALL_DOMAINS,
  DOMAIN_METADATA,
  RESOURCE_METADATA,
  ATOMIC_PERMISSION_DEFINITIONS,
  ROLE_DEFAULT_ATOMIC_PERMISSIONS,
  type AtomicPermissionKey,
  type AtomicPermissionsMap,
  type DomainKey,
  type StandardActionType,
} from "@shared/atomicPermissions";
import { normalizeSearchText } from "@shared/searchNormalize";
import { cn } from "@/lib/utils";
import { PermissionPresetsBar } from "./PermissionPresetsBar";
import { PermissionMatrixFilters } from "./PermissionMatrixFilters";
import { PermissionCategoryCard } from "./PermissionCategoryCard";
import { OperationalCapsPanel } from "./OperationalCapsPanel";
import { SensitiveMaskingPanel } from "./SensitiveMaskingPanel";
import type {
  DomainCategoryViewModel,
  OperationalPreset,
  PermissionMatrixProps,
  PermissionState,
  PermissionViewMode,
  ResourceActionSlot,
  ResourceRowViewModel,
} from "./types";

const STANDARD_ACTION_KEYS: StandardActionType[] = [
  "view",
  "create",
  "edit",
  "cancel",
  "print",
  "reprint",
  "export",
  "approve",
];

export const PermissionMatrix = memo(function PermissionMatrix({
  role,
  atomicPermissions,
  onChange,
  onBulkChange,
  onReset,
  baseAtomicPermissions,
  caps,
  onCapsChange,
  masking,
  onMaskingChange,
  readOnly = false,
  className,
  showPresetsBar = true,
  showCapsPanel = true,
  showMaskingPanel = true,
  defaultViewMode = "grid",
}: PermissionMatrixProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedDomain, setSelectedDomain] = useState<DomainKey | "all">("all");
  const [overridesOnly, setOverridesOnly] = useState(false);
  const [viewMode, setViewMode] = useState<PermissionViewMode>(defaultViewMode);

  // Template comparison base
  const templateMap = useMemo<AtomicPermissionsMap>(() => {
    if (baseAtomicPermissions) return baseAtomicPermissions;
    return ROLE_DEFAULT_ATOMIC_PERMISSIONS[role] || ROLE_DEFAULT_ATOMIC_PERMISSIONS.user || {};
  }, [baseAtomicPermissions, role]);

  // Handle single toggle
  const handleToggle = useCallback(
    (key: string, nextGranted: boolean) => {
      if (readOnly) return;
      onChange(key, nextGranted);
    },
    [readOnly, onChange],
  );

  // Handle bulk updates from category card or row
  const handleBulkUpdate = useCallback(
    (updates: Record<string, boolean>) => {
      if (readOnly) return;
      if (onBulkChange) {
        onBulkChange(updates);
      } else {
        for (const [key, val] of Object.entries(updates)) {
          onChange(key, val);
        }
      }
    },
    [readOnly, onBulkChange, onChange],
  );

  // Apply operational preset
  const handleApplyPreset = useCallback(
    (preset: OperationalPreset) => {
      if (readOnly) return;
      const newAtomicMap: Record<string, boolean> = {};
      const grantedSet = new Set(preset.grantedKeys);

      for (const def of ATOMIC_PERMISSION_DEFINITIONS) {
        newAtomicMap[def.key] = grantedSet.has(def.key);
      }

      if (onBulkChange) {
        onBulkChange(newAtomicMap);
      } else {
        for (const [k, v] of Object.entries(newAtomicMap)) {
          onChange(k, v);
        }
      }

      if (preset.suggestedCaps && onCapsChange) {
        onCapsChange(preset.suggestedCaps);
      }
      if (preset.suggestedMasking && onMaskingChange) {
        onMaskingChange(preset.suggestedMasking);
      }
    },
    [readOnly, onBulkChange, onChange, onCapsChange, onMaskingChange],
  );

  // Build the complete view-model hierarchy
  const { categories, totalGrants, totalDenies } = useMemo(() => {
    let customGrants = 0;
    let customDenies = 0;

    // Group definitions by domain -> resource
    const domainMap = new Map<DomainKey, Map<string, ResourceRowViewModel>>();

    for (const dom of ALL_DOMAINS) {
      domainMap.set(dom, new Map());
    }

    // Populate resource slots
    for (const def of ATOMIC_PERMISSION_DEFINITIONS) {
      const resMap = domainMap.get(def.domain);
      if (!resMap) continue;

      let resModel = resMap.get(def.resource);
      if (!resModel) {
        const metaKey = `${def.domain}.${def.resource}`;
        const resMeta = RESOURCE_METADATA[metaKey];
        const resLabel = resMeta?.labelAr || resMeta?.label || def.labelAr || def.label;
        const resDesc = resMeta?.descriptionAr || resMeta?.description || def.descriptionAr || def.description;
        const resIcon = resMeta?.iconName || "Shield";

        const initialSlots: Record<StandardActionType, ResourceActionSlot> = {
          view: { key: "", action: "view", isSupported: false, state: "INHERITED_DENY", granted: false, baseGranted: false },
          create: { key: "", action: "create", isSupported: false, state: "INHERITED_DENY", granted: false, baseGranted: false },
          edit: { key: "", action: "edit", isSupported: false, state: "INHERITED_DENY", granted: false, baseGranted: false },
          cancel: { key: "", action: "cancel", isSupported: false, state: "INHERITED_DENY", granted: false, baseGranted: false },
          print: { key: "", action: "print", isSupported: false, state: "INHERITED_DENY", granted: false, baseGranted: false },
          reprint: { key: "", action: "reprint", isSupported: false, state: "INHERITED_DENY", granted: false, baseGranted: false },
          export: { key: "", action: "export", isSupported: false, state: "INHERITED_DENY", granted: false, baseGranted: false },
          approve: { key: "", action: "approve", isSupported: false, state: "INHERITED_DENY", granted: false, baseGranted: false },
        };

        resModel = {
          resource: def.resource,
          domain: def.domain,
          label: resLabel,
          description: resDesc,
          iconName: resIcon,
          actions: initialSlots,
          allActions: [],
          specialActions: [],
          totalActionsCount: 0,
          grantedActionsCount: 0,
          hasCustomOverrides: false,
        };
        resMap.set(def.resource, resModel);
      }

      // Compute slot permission state
      const actKey = (def.standardAction || def.action) as StandardActionType;
      const baseVal = Boolean(templateMap[def.key]);
      const curVal = atomicPermissions[def.key] !== undefined ? Boolean(atomicPermissions[def.key]) : baseVal;

      let state: PermissionState = "INHERITED_DENY";
      if (curVal !== baseVal) {
        state = curVal ? "CUSTOM_GRANT" : "CUSTOM_DENY";
        resModel.hasCustomOverrides = true;
        if (curVal) customGrants++;
        else customDenies++;
      } else {
        state = curVal ? "INHERITED_GRANT" : "INHERITED_DENY";
      }

      const slot: ResourceActionSlot = {
        key: def.key,
        action: actKey,
        definition: def,
        isSupported: true,
        state,
        granted: curVal,
        baseGranted: baseVal,
      };

      resModel.allActions.push(slot);
      resModel.totalActionsCount++;
      if (curVal) resModel.grantedActionsCount++;

      // Standard Action vs Special Action
      if (STANDARD_ACTION_KEYS.includes(actKey)) {
        if (!resModel.actions[actKey].isSupported) {
          resModel.actions[actKey] = slot;
        } else {
          // Secondary action mapping to same standard slot is treated as special operation
          resModel.specialActions.push(slot);
        }
      } else {
        resModel.specialActions.push(slot);
      }

      if (def.isSpecialOperation && !resModel.specialActions.some((s) => s.key === slot.key)) {
        resModel.specialActions.push(slot);
      }
    }

    // Prepare search terms
    const normalizedQ = searchQuery.trim() ? normalizeSearchText(searchQuery.trim()) : "";
    const rawQ = searchQuery.trim().toLowerCase();

    // Build category view models with filtering
    const categoryList: DomainCategoryViewModel[] = [];

    for (const dom of ALL_DOMAINS) {
      if (selectedDomain !== "all" && selectedDomain !== dom) {
        continue;
      }

      const meta = DOMAIN_METADATA[dom];
      const resMap = domainMap.get(dom);
      const rawResources = resMap ? Array.from(resMap.values()) : [];

      // Filter resources
      const filteredResources = rawResources.filter((res) => {
        if (overridesOnly && !res.hasCustomOverrides) {
          return false;
        }

        if (!rawQ) return true;

        const textMatches =
          res.label.toLowerCase().includes(rawQ) ||
          res.resource.toLowerCase().includes(rawQ) ||
          (res.description && res.description.toLowerCase().includes(rawQ)) ||
          normalizeSearchText(res.label).includes(normalizedQ);

        if (textMatches) return true;

        // Check action definitions
        return res.allActions.some(
          (slot) =>
            slot.key.toLowerCase().includes(rawQ) ||
            (slot.definition?.labelAr && slot.definition.labelAr.toLowerCase().includes(rawQ)) ||
            (slot.definition?.label && slot.definition.label.toLowerCase().includes(rawQ)) ||
            (slot.definition?.descriptionAr && slot.definition.descriptionAr.toLowerCase().includes(rawQ)),
        );
      });

      if (filteredResources.length === 0 && (rawQ || overridesOnly)) {
        continue;
      }

      // Calculate counts
      let totalActions = 0;
      let grantedActions = 0;
      let customCount = 0;

      for (const res of rawResources) {
        totalActions += res.totalActionsCount;
        grantedActions += res.grantedActionsCount;
        if (res.hasCustomOverrides) {
          customCount++;
        }
      }

      categoryList.push({
        key: dom,
        label: meta.label,
        description: meta.description,
        iconName: meta.iconName,
        order: meta.order,
        resources: filteredResources,
        totalActions,
        grantedActions,
        customOverridesCount: customCount,
      });
    }

    return {
      categories: categoryList,
      totalGrants: customGrants,
      totalDenies: customDenies,
    };
  }, [
    templateMap,
    atomicPermissions,
    searchQuery,
    selectedDomain,
    overridesOnly,
  ]);

  return (
    <div className={cn("space-y-4", className)}>
      {/* 1. Presets Bar */}
      {showPresetsBar && !readOnly && (
        <PermissionPresetsBar
          onApplyPreset={handleApplyPreset}
          activeRole={typeof role === "string" ? role : undefined}
          disabled={readOnly}
        />
      )}

      {/* 2. Filters & Search Bar */}
      <PermissionMatrixFilters
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        selectedDomain={selectedDomain}
        onDomainChange={setSelectedDomain}
        overridesOnly={overridesOnly}
        onOverridesOnlyChange={setOverridesOnly}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        customGrantsCount={totalGrants}
        customDeniesCount={totalDenies}
        onResetToTemplate={onReset}
        disabled={readOnly}
      />

      {/* 3. Domain Categories */}
      <div className="space-y-3">
        {categories.map((cat) => (
          <PermissionCategoryCard
            key={cat.key}
            category={cat}
            onToggle={handleToggle}
            onBulkUpdate={handleBulkUpdate}
            disabled={readOnly}
            viewMode={viewMode}
          />
        ))}

        {categories.length === 0 && (
          <div className="p-8 text-center border border-dashed rounded-lg bg-card text-muted-foreground text-xs space-y-1">
            <p className="font-semibold text-foreground">لا توجد صلاحيات مطابقة لخيارات التصفية</p>
            <p>جرّب تعديل كلمة البحث أو إزالة حصر الاستثناءات الفردية.</p>
          </div>
        )}
      </div>

      {/* 4. Operational Financial Caps */}
      {showCapsPanel && onCapsChange && (
        <OperationalCapsPanel
          caps={caps}
          onChange={onCapsChange}
          disabled={readOnly}
        />
      )}

      {/* 5. Sensitive Data Masking */}
      {showMaskingPanel && onMaskingChange && (
        <SensitiveMaskingPanel
          masking={masking}
          onChange={onMaskingChange}
          disabled={readOnly}
        />
      )}
    </div>
  );
});
