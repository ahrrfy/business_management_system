import { AppSelect } from "@/components/ui/AppSelect";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { BundleRequirementMode } from "@shared/bundleProductionTypes";

interface BundleKitParametersBarProps {
  bundlesList: Array<{ bundleVariantId: number; name: string; sku: string }>;
  selectedBundleId: number | null;
  onSelectBundleId: (id: number) => void;
  initialBundleVariantId?: number;
  bundleName?: string;
  bundleQuantity: number;
  onBundleQuantityChange: (qty: number) => void;
  mode: BundleRequirementMode;
  onModeChange: (mode: BundleRequirementMode) => void;
}

export function BundleKitParametersBar({
  bundlesList,
  selectedBundleId,
  onSelectBundleId,
  initialBundleVariantId,
  bundleName,
  bundleQuantity,
  onBundleQuantityChange,
  mode,
  onModeChange,
}: BundleKitParametersBarProps) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 rounded-lg border bg-muted/20 p-3" dir="rtl">
      {/* منتقي البكج */}
      <div className="space-y-1">
        <Label className="text-xs">البكج المطلوب</Label>
        {initialBundleVariantId ? (
          <div className="h-9 px-3 rounded-md border bg-muted flex items-center text-xs font-semibold truncate">
            {bundleName ?? `#${initialBundleVariantId}`}
          </div>
        ) : (
          <AppSelect
            value={selectedBundleId ? String(selectedBundleId) : ""}
            onValueChange={(val) => onSelectBundleId(Number(val))}
            className="h-9 text-xs"
          >
            {bundlesList.map((b) => (
              <option key={b.bundleVariantId} value={b.bundleVariantId}>
                {b.name} ({b.sku})
              </option>
            ))}
          </AppSelect>
        )}
      </div>

      {/* كمية الأطقم المطلوبة */}
      <div className="space-y-1">
        <Label className="text-xs">كمية الأطقم المطلوبة</Label>
        <Input
          type="number"
          min="1"
          className="h-9 text-xs font-bold font-mono"
          value={bundleQuantity}
          onChange={(e) => {
            const q = parseInt(e.target.value, 10);
            if (Number.isFinite(q) && q > 0) onBundleQuantityChange(q);
          }}
        />
      </div>

      {/* وضع الحساب (صافي العجز مقابل الكمية كاملة) */}
      <div className="space-y-1">
        <Label className="text-xs">سياسة تشغيل الدفعة</Label>
        <AppSelect
          value={mode}
          onValueChange={(val) => onModeChange(val as BundleRequirementMode)}
          className="h-9 text-xs"
        >
          <option value="NET_SHORTAGE">صافي العجز (خصم المتاح بالفرع)</option>
          <option value="FULL_QUANTITY">الكمية كاملة (تجاهل المتوفر)</option>
        </AppSelect>
      </div>
    </div>
  );
}
