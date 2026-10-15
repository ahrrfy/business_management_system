import React, { memo } from "react";
import { Sliders, Percent, CreditCard, Receipt, Undo2, Banknote } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { MoneyInput } from "@/components/form/MoneyInput";
import type { OperationalCaps } from "@shared/atomicPermissions";

export interface OperationalCapsPanelProps {
  caps?: OperationalCaps | null;
  onChange: (caps: OperationalCaps) => void;
  disabled?: boolean;
  /** In individual-user editors, an empty field removes the override and inherits the role cap. */
  inheritOnClear?: boolean;
  inheritedCaps?: OperationalCaps | null;
}

export const OperationalCapsPanel = memo(function OperationalCapsPanel({
  caps,
  onChange,
  disabled = false,
  inheritOnClear = false,
  inheritedCaps,
}: OperationalCapsPanelProps) {
  const current: OperationalCaps = caps || {};

  const handleUpdate = (field: keyof OperationalCaps, value: unknown) => {
    if (disabled) return;
    const next = { ...current };
    if (inheritOnClear && (value === null || value === "")) delete next[field];
    else next[field] = value as never;
    onChange(next);
  };

  const inheritedLabel = (field: keyof OperationalCaps): string => {
    const value = inheritedCaps?.[field];
    return value == null ? "بلا سقف" : String(value);
  };

  const handlePercentChange = (valStr: string) => {
    if (valStr.trim() === "") {
      handleUpdate("maxDiscountPercent", null);
      return;
    }
    const num = Number(valStr);
    if (!isNaN(num) && num >= 0 && num <= 100) {
      handleUpdate("maxDiscountPercent", num);
    }
  };

  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-4">
      <div className="flex items-center justify-between gap-2 border-b border-border pb-2.5">
        <div className="flex items-center gap-2">
          <Sliders aria-hidden="true" className="size-4 text-primary" />
          <h4 className="text-sm font-semibold text-foreground">
            سقوف التنفيذ والاعتماد
          </h4>
        </div>
        <span className="text-[11px] text-muted-foreground">
          الحدود العليا للعمليات قبل طلب موافقة المدير
        </span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {/* سقف نسبة الخصم */}
        <div className="space-y-1.5">
          <Label htmlFor="cap-discount-percent" className="text-xs flex items-center gap-1.5">
            <Percent aria-hidden="true" className="size-3.5 text-muted-foreground" />
            <span>سقف نسبة الخصم المسموح (%)</span>
          </Label>
          <div className="relative">
            <Input
              id="cap-discount-percent"
              type="number"
              min={0}
              max={100}
              step={1}
              disabled={disabled}
              value={
                current.maxDiscountPercent !== undefined && current.maxDiscountPercent !== null
                  ? String(current.maxDiscountPercent)
                  : ""
              }
              onChange={(e) => handlePercentChange(e.target.value)}
              placeholder="مثال: 10"
              className="h-8 text-xs font-mono pr-7"
            />
            <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
              %
            </span>
          </div>
          <p className="text-[10px] text-muted-foreground">
            {current.maxDiscountPercent === 0
              ? "ممنوع من الخصم كلياً (0%)"
              : current.maxDiscountPercent
                ? `الحد الأقصى للخصم اليدوي ${current.maxDiscountPercent}%`
                : "غير محدد (يتبع قالب الدور)"}
          </p>
        </div>

        {/* سقف مبلغ الخصم بالدينار */}
        <div className="space-y-1.5">
          <Label htmlFor="cap-discount-amount" className="text-xs flex items-center gap-1.5">
            <Banknote aria-hidden="true" className="size-3.5 text-muted-foreground" />
            <span>سقف مبلغ الخصم (د.ع)</span>
          </Label>
          <MoneyInput
            id="cap-discount-amount"
            disabled={disabled}
            value={current.maxDiscountAmountIqd || ""}
            onChange={(val) => handleUpdate("maxDiscountAmountIqd", val || null)}
            placeholder="مثال: 50,000"
            className="h-8 text-xs font-mono"
          />
          <p className="text-[10px] text-muted-foreground">
            أقصى مبلغ خصم دينار للفاتورة الواحدة
          </p>
        </div>

        {/* سقف البيع الآجل */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-1">
            <Label htmlFor="cap-credit-sale" className="text-xs flex items-center gap-1.5">
              <CreditCard aria-hidden="true" className="size-3.5 text-muted-foreground" />
              <span>سقف البيع الآجل (د.ع)</span>
            </Label>
            <div className="flex items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={disabled}
                onClick={() => handleUpdate("maxCreditSaleLimitIqd", "0.00")}
                className="h-5 px-1 text-[10px] text-muted-foreground"
              >
                نقدي فقط
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={disabled}
                onClick={() => handleUpdate("maxCreditSaleLimitIqd", null)}
                className="h-5 px-1 text-[10px] text-muted-foreground"
              >
                {inheritOnClear ? "وراثة الدور" : "بلا سقف"}
              </Button>
            </div>
          </div>
          <MoneyInput
            id="cap-credit-sale"
            disabled={disabled}
            value={current.maxCreditSaleLimitIqd || ""}
            onChange={(val) => handleUpdate("maxCreditSaleLimitIqd", val || null)}
            placeholder={inheritOnClear ? `يرث: ${inheritedLabel("maxCreditSaleLimitIqd")}` : "0 = نقدي فقط"}
            className="h-8 text-xs font-mono"
          />
          <p className="text-[10px] text-muted-foreground">
            الحد الائتماني المباشر للعميل بدون اعتماد مدير
          </p>
        </div>

        {/* سقف سند الصرف المالي */}
        <div className="space-y-1.5">
          <Label htmlFor="cap-expense-voucher" className="text-xs flex items-center gap-1.5">
            <Receipt aria-hidden="true" className="size-3.5 text-muted-foreground" />
            <span>سقف سند الصرف / المصروف (د.ع)</span>
          </Label>
          <MoneyInput
            id="cap-expense-voucher"
            disabled={disabled}
            value={
              current.maxExpenseVoucherAmountIqd ||
              current.maxPaymentVoucherAmountIqd ||
              ""
            }
            onChange={(val) => {
              if (disabled) return;
              const next = { ...current };
              if (inheritOnClear && !val) {
                delete next.maxExpenseVoucherAmountIqd;
                delete next.maxPaymentVoucherAmountIqd;
              } else {
                next.maxExpenseVoucherAmountIqd = val || null;
                next.maxPaymentVoucherAmountIqd = val || null;
              }
              onChange(next);
            }}
            placeholder="مثال: 500,000"
            className="h-8 text-xs font-mono"
          />
          <p className="text-[10px] text-muted-foreground">
            الحد الأقصى للصرف النقدي المباشر من الصندوق
          </p>
        </div>

        {/* سقف استرجاع المبيعات */}
        <div className="space-y-1.5">
          <Label htmlFor="cap-refund-amount" className="text-xs flex items-center gap-1.5">
            <Undo2 aria-hidden="true" className="size-3.5 text-muted-foreground" />
            <span>سقف مرتجع المبيعات النقدي (د.ع)</span>
          </Label>
          <MoneyInput
            id="cap-refund-amount"
            disabled={disabled}
            value={current.maxRefundAmountIqd || ""}
            onChange={(val) => handleUpdate("maxRefundAmountIqd", val || null)}
            placeholder={inheritOnClear ? `يرث: ${inheritedLabel("maxRefundAmountIqd")}` : "مثال: 25,000"}
            className="h-8 text-xs font-mono"
          />
          <p className="text-[10px] text-muted-foreground">
            أقصى مبلغ استرجاع نقدي فوري بدون موافقة مدير
          </p>
        </div>
      </div>
    </div>
  );
});
