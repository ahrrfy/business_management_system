import React, { memo } from "react";
import { EyeOff, DollarSign, TrendingDown, PhoneOff, Users } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import type { SensitiveDataMasking } from "@shared/atomicPermissions";

export interface SensitiveMaskingPanelProps {
  masking?: SensitiveDataMasking | null;
  onChange: (masking: SensitiveDataMasking) => void;
  disabled?: boolean;
}

export const SensitiveMaskingPanel = memo(function SensitiveMaskingPanel({
  masking,
  onChange,
  disabled = false,
}: SensitiveMaskingPanelProps) {
  const current: SensitiveDataMasking = masking || {};

  const handleToggle = (field: keyof SensitiveDataMasking, checked: boolean) => {
    if (disabled) return;
    onChange({
      ...current,
      [field]: checked,
    });
  };

  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-4">
      <div className="flex items-center justify-between gap-2 border-b border-border pb-2.5">
        <div className="flex items-center gap-2">
          <EyeOff aria-hidden="true" className="size-4 text-primary" />
          <h4 className="text-sm font-semibold text-foreground">
            ضوابط حجب البيانات الحساسة (Data Masking)
          </h4>
        </div>
        <span className="text-[11px] text-muted-foreground">
          حماية الأسرار التجارية والبيانات المالية الحساسة
        </span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
        {/* حجب تكلفة الشراء */}
        <div className="flex items-start justify-between gap-3 p-3 rounded-md border border-border bg-muted/20">
          <div className="space-y-1">
            <Label
              htmlFor="mask-purchase-cost"
              className="text-xs font-semibold flex items-center gap-1.5 cursor-pointer"
            >
              <DollarSign aria-hidden="true" className="size-3.5 text-muted-foreground" />
              <span>حجب تكلفة الشراء والمتوسط المرجح</span>
            </Label>
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              إخفاء أسعار الشراء وتكلفة المخزون في الفواتير والتقارير لمنع الاطلاع التجاري
            </p>
          </div>
          <Switch
            id="mask-purchase-cost"
            disabled={disabled}
            checked={Boolean(current.maskPurchaseCost)}
            onCheckedChange={(c) => handleToggle("maskPurchaseCost", c)}
            aria-label="حجب تكلفة الشراء والمتوسط المرجح"
          />
        </div>

        {/* حجب هامش الربح */}
        <div className="flex items-start justify-between gap-3 p-3 rounded-md border border-border bg-muted/20">
          <div className="space-y-1">
            <Label
              htmlFor="mask-profit-margin"
              className="text-xs font-semibold flex items-center gap-1.5 cursor-pointer"
            >
              <TrendingDown aria-hidden="true" className="size-3.5 text-muted-foreground" />
              <span>حجب هامش الربح والنسب المئوية</span>
            </Label>
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              إخفاء نسب ومبالغ الأرباح المحققة عن مستخدمي نقاط البيع والمخازن
            </p>
          </div>
          <Switch
            id="mask-profit-margin"
            disabled={disabled}
            checked={Boolean(current.maskProfitMargin)}
            onCheckedChange={(c) => handleToggle("maskProfitMargin", c)}
            aria-label="حجب هامش الربح والنسب المئوية"
          />
        </div>

        {/* حجب هواتف الموردين */}
        <div className="flex items-start justify-between gap-3 p-3 rounded-md border border-border bg-muted/20">
          <div className="space-y-1">
            <Label
              htmlFor="mask-supplier-phone"
              className="text-xs font-semibold flex items-center gap-1.5 cursor-pointer"
            >
              <PhoneOff aria-hidden="true" className="size-3.5 text-muted-foreground" />
              <span>حجب هواتف الموردين</span>
            </Label>
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              إخفاء أرقام اتصال الموردين وعناوينهم لمنع التواصل المباشر غير المصرح
            </p>
          </div>
          <Switch
            id="mask-supplier-phone"
            disabled={disabled}
            checked={Boolean(current.maskSupplierPhone)}
            onCheckedChange={(c) => handleToggle("maskSupplierPhone", c)}
            aria-label="حجب هواتف الموردين"
          />
        </div>

        {/* حجب بيانات العملاء */}
        <div className="flex items-start justify-between gap-3 p-3 rounded-md border border-border bg-muted/20">
          <div className="space-y-1">
            <Label
              htmlFor="mask-customer-contact"
              className="text-xs font-semibold flex items-center gap-1.5 cursor-pointer"
            >
              <Users aria-hidden="true" className="size-3.5 text-muted-foreground" />
              <span>حجب هواتف وعناوين العملاء</span>
            </Label>
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              حجب بيانات التواصل الخاصة بالعملاء لحماية خصوصية العملاء وقاعدة البيانات
            </p>
          </div>
          <Switch
            id="mask-customer-contact"
            disabled={disabled}
            checked={Boolean(current.maskCustomerContact)}
            onCheckedChange={(c) => handleToggle("maskCustomerContact", c)}
            aria-label="حجب هواتف وعناوين العملاء"
          />
        </div>
      </div>
    </div>
  );
});
