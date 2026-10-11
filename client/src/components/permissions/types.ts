import type {
  AtomicPermissionDefinition,
  AtomicPermissionKey,
  AtomicPermissionsMap,
  DomainKey,
  OperationalCaps,
  SensitiveDataMasking,
  StandardActionType,
} from "@shared/atomicPermissions";
import type { RoleKey } from "@/lib/permissionsModel";

export type PermissionState =
  | "INHERITED_GRANT"
  | "INHERITED_DENY"
  | "CUSTOM_GRANT"
  | "CUSTOM_DENY";

export interface ActionVisualTokens {
  wrapperClass: string;
  badgeLabel: string;
  badgeVariant: "default" | "success" | "danger" | "muted";
  ariaDesc: string;
  isCustom: boolean;
}

export function getActionVisualTokens(state: PermissionState): ActionVisualTokens {
  switch (state) {
    case "CUSTOM_GRANT":
      return {
        wrapperClass:
          "bg-[var(--sem-pos-bg)] border-[var(--sem-pos)] text-[var(--sem-pos)] font-bold ring-1 ring-[var(--sem-pos)]",
        badgeLabel: "+ مخصّص",
        badgeVariant: "success",
        ariaDesc: "صلاحية مضافة كاستثناء فردي (+)",
        isCustom: true,
      };
    case "CUSTOM_DENY":
      return {
        wrapperClass:
          "bg-[var(--sem-neg-bg)] border-[var(--sem-neg)] text-[var(--sem-neg)] font-bold ring-1 ring-[var(--sem-neg)]",
        badgeLabel: "− محجوب",
        badgeVariant: "danger",
        ariaDesc: "صلاحية محجوبة صراحةً كاستثناء فردي (−)",
        isCustom: true,
      };
    case "INHERITED_GRANT":
      return {
        wrapperClass: "bg-primary/10 border-primary/30 text-primary",
        badgeLabel: "بالدور",
        badgeVariant: "default",
        ariaDesc: "صلاحية موروثة من الدور الأساسي",
        isCustom: false,
      };
    case "INHERITED_DENY":
    default:
      return {
        wrapperClass: "bg-muted/40 border-border text-muted-foreground opacity-60",
        badgeLabel: "معطل",
        badgeVariant: "muted",
        ariaDesc: "غير ممنوحة في قالب الدور",
        isCustom: false,
      };
  }
}

export interface ResourceActionSlot {
  key: AtomicPermissionKey;
  action: StandardActionType;
  definition?: AtomicPermissionDefinition;
  isSupported: boolean;
  state: PermissionState;
  granted: boolean;
  baseGranted: boolean;
}

export interface ResourceRowViewModel {
  resource: string;
  domain: DomainKey;
  label: string;
  description?: string;
  actions: Record<StandardActionType, ResourceActionSlot>;
  hasCustomOverrides: boolean;
}

export interface DomainCategoryViewModel {
  key: DomainKey;
  label: string;
  description: string;
  iconName: string;
  order: number;
  resources: ResourceRowViewModel[];
  totalActions: number;
  grantedActions: number;
  customOverridesCount: number;
}

export interface PermissionFilterState {
  searchQuery: string;
  domain: DomainKey | "all";
  overridesOnly: boolean;
}

export interface OperationalPreset {
  id: string;
  label: string;
  description: string;
  iconName: string;
  baseRole: RoleKey;
  grantedKeys: AtomicPermissionKey[];
  suggestedCaps?: OperationalCaps;
  suggestedMasking?: SensitiveDataMasking;
}

export interface PermissionMatrixProps {
  role: RoleKey | string;
  atomicPermissions: AtomicPermissionsMap;
  onChange: (key: AtomicPermissionKey, granted: boolean) => void;
  onBulkChange?: (updates: Record<AtomicPermissionKey, boolean>) => void;
  onReset?: () => void;
  baseAtomicPermissions?: AtomicPermissionsMap;
  caps?: OperationalCaps | null;
  onCapsChange?: (caps: OperationalCaps) => void;
  masking?: SensitiveDataMasking | null;
  onMaskingChange?: (masking: SensitiveDataMasking) => void;
  readOnly?: boolean;
  className?: string;
  showPresetsBar?: boolean;
  showCapsPanel?: boolean;
  showMaskingPanel?: boolean;
}
