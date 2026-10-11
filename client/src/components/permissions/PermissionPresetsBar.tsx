import React, { memo } from "react";
import {
  Store,
  Briefcase,
  Boxes,
  Landmark,
  ShoppingCart,
  ClipboardList,
  ShieldCheck,
  ShieldAlert,
  Truck,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  ROLE_DEFAULT_ATOMIC_PERMISSIONS,
  ROLE_DEFAULT_OPERATIONAL_CAPS,
  ROLE_DEFAULT_DATA_MASKING,
  type AtomicPermissionsMap,
  type OperationalCaps,
  type SensitiveDataMasking,
} from "@shared/atomicPermissions";
import type { OperationalPreset } from "./types";
import type { RoleKey } from "@/lib/permissionsModel";

export interface PermissionPresetsBarProps {
  onApplyPreset: (preset: OperationalPreset) => void;
  activeRole?: string;
  disabled?: boolean;
}

const PRESET_ICONS: Record<string, LucideIcon> = {
  cashier: Store,
  sales_rep: Briefcase,
  warehouse: Boxes,
  accountant: Landmark,
  purchasing: ShoppingCart,
  reception_clerk: ClipboardList,
  manager: ShieldCheck,
  auditor: ShieldAlert,
  courier: Truck,
};

function getGrantedKeysForRole(role: string): string[] {
  const map = ROLE_DEFAULT_ATOMIC_PERMISSIONS[role] || {};
  return Object.entries(map)
    .filter(([_, granted]) => Boolean(granted))
    .map(([key]) => key);
}

export const OPERATIONAL_PRESETS: OperationalPreset[] = [
  {
    id: "cashier",
    label: "الكاشير",
    description: "نقاط البيع وفواتير التجزئة والقبض والطباعة، حجب التكلفة والأرباح، سقف خصم 5%",
    iconName: "cashier",
    baseRole: "cashier" as RoleKey,
    grantedKeys: getGrantedKeysForRole("cashier"),
    suggestedCaps: ROLE_DEFAULT_OPERATIONAL_CAPS.cashier,
    suggestedMasking: ROLE_DEFAULT_DATA_MASKING.cashier,
  },
  {
    id: "sales_rep",
    label: "مسؤول مبيعات",
    description: "عروض الأسعار، مبيعات الجملة والعملاء التجاريين، سقف خصم 15%، سقف بيع آجل",
    iconName: "sales_rep",
    baseRole: "sales_rep" as RoleKey,
    grantedKeys: getGrantedKeysForRole("sales_rep"),
    suggestedCaps: ROLE_DEFAULT_OPERATIONAL_CAPS.sales_rep,
    suggestedMasking: ROLE_DEFAULT_DATA_MASKING.sales_rep,
  },
  {
    id: "warehouse",
    label: "أمين مخزن",
    description: "المستودعات، الجرد، المناقلات بين الفروع، حجب التكلفة وهوامش الربح",
    iconName: "warehouse",
    baseRole: "warehouse" as RoleKey,
    grantedKeys: getGrantedKeysForRole("warehouse"),
    suggestedCaps: ROLE_DEFAULT_OPERATIONAL_CAPS.warehouse,
    suggestedMasking: ROLE_DEFAULT_DATA_MASKING.warehouse,
  },
  {
    id: "accountant",
    label: "محاسب",
    description: "الخزينة، السندات، المصروفات، كشوف الحسابات، التدقيق المالي، رؤية التكلفة والربح",
    iconName: "accountant",
    baseRole: "accountant" as RoleKey,
    grantedKeys: getGrantedKeysForRole("accountant"),
    suggestedCaps: ROLE_DEFAULT_OPERATIONAL_CAPS.accountant,
    suggestedMasking: ROLE_DEFAULT_DATA_MASKING.accountant,
  },
  {
    id: "purchasing",
    label: "مسؤول مشتريات",
    description: "أوامر الشراء، سجلات الموردين، طلبات التوريد، رؤية التكلفة، حجب هواتف العملاء",
    iconName: "purchasing",
    baseRole: "purchasing" as RoleKey,
    grantedKeys: getGrantedKeysForRole("purchasing"),
    suggestedCaps: ROLE_DEFAULT_OPERATIONAL_CAPS.purchasing,
    suggestedMasking: ROLE_DEFAULT_DATA_MASKING.purchasing,
  },
  {
    id: "reception_clerk",
    label: "موظف استقبال",
    description: "استقبال طلبات العملاء، فتح أوامر الشغل، العربون، البروفات، سقف خصم 10%",
    iconName: "reception_clerk",
    baseRole: "reception_clerk" as RoleKey,
    grantedKeys: getGrantedKeysForRole("reception_clerk"),
    suggestedCaps: ROLE_DEFAULT_OPERATIONAL_CAPS.reception_clerk,
    suggestedMasking: ROLE_DEFAULT_DATA_MASKING.reception_clerk,
  },
  {
    id: "manager",
    label: "مدير فرع",
    description: "إدارة العمليات التشغيلية، الاعتمادات، تقارير الفرع، تجاوز السقوف",
    iconName: "manager",
    baseRole: "manager" as RoleKey,
    grantedKeys: getGrantedKeysForRole("manager"),
    suggestedCaps: ROLE_DEFAULT_OPERATIONAL_CAPS.manager,
    suggestedMasking: ROLE_DEFAULT_DATA_MASKING.manager,
  },
  {
    id: "auditor",
    label: "مدقق مالي",
    description: "قراءة شاملة وتقارير عبر كافة قطاعات النظام وتصدير، بدون صلاحيات تعديل أو اعتماد",
    iconName: "auditor",
    baseRole: "auditor" as RoleKey,
    grantedKeys: getGrantedKeysForRole("auditor"),
    suggestedCaps: ROLE_DEFAULT_OPERATIONAL_CAPS.auditor,
    suggestedMasking: ROLE_DEFAULT_DATA_MASKING.auditor,
  },
  {
    id: "courier",
    label: "مندوب توصيل",
    description: "شحنات التوصيل، إثبات التسليم، تحصيل مبالغ COD، حجب بقية قطاعات النظام",
    iconName: "courier",
    baseRole: "courier" as RoleKey,
    grantedKeys: getGrantedKeysForRole("courier"),
    suggestedCaps: ROLE_DEFAULT_OPERATIONAL_CAPS.courier,
    suggestedMasking: ROLE_DEFAULT_DATA_MASKING.courier,
  },
];

export const PermissionPresetsBar = memo(function PermissionPresetsBar({
  onApplyPreset,
  activeRole,
  disabled = false,
}: PermissionPresetsBarProps) {
  return (
    <div className="rounded-lg border border-border bg-muted/20 p-2.5 space-y-2">
      <div className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
        <Sparkles aria-hidden="true" className="size-3.5 text-primary" />
        <span>حزم الصلاحيات التشغيلية السريعة (بضغطة واحدة):</span>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {OPERATIONAL_PRESETS.map((preset) => {
          const IconComponent = PRESET_ICONS[preset.iconName] || Sparkles;
          const isActive = activeRole === preset.id;

          return (
            <Button
              key={preset.id}
              type="button"
              variant={isActive ? "default" : "outline"}
              size="sm"
              disabled={disabled}
              onClick={() => onApplyPreset(preset)}
              title={preset.description}
              className={cn(
                "h-7 px-2.5 text-xs font-medium gap-1.5 transition-all select-none",
                isActive
                  ? "bg-primary text-primary-foreground font-semibold shadow-xs"
                  : "bg-background hover:bg-muted text-foreground",
              )}
            >
              <IconComponent aria-hidden="true" className="size-3.5" />
              <span>{preset.label}</span>
            </Button>
          );
        })}
      </div>
    </div>
  );
});
