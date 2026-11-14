/**
 * client/src/components/offers/OfferTypeCards.tsx
 *
 * Visual 6-card selector for Iraqi retail & wholesale promotion types.
 * Supports single-type selection as well as 1-click "+ إضافة كقاعدة إضافية"
 * so management can combine multiple promotion types in a single offer workflow.
 */

import React from "react";
import { Banknote, Check, Gift, Layers, Package, Percent, Plus, Tag, Truck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { PROMO_TYPE_LABELS, type PromoType } from "./offersTypes";

export interface OfferTypeCardsProps {
  value: PromoType;
  onChange: (next: PromoType) => void;
  activeTypesInOffer?: PromoType[];
  onAddAsNewRule?: (type: PromoType) => void;
  disabled?: boolean;
}

const TYPE_CARD_META: ReadonlyArray<{
  type: PromoType;
  subtitle: string;
  example: string;
  Icon: React.ComponentType<{ className?: string }>;
}> = [
  {
    type: "PERCENT",
    subtitle: "تنزيل نسبة مئوية من سعر البيع مع إمكانية وضع حد أعلى للخصم",
    example: "مثال: خصم 15% على القرطاسية",
    Icon: Percent,
  },
  {
    type: "AMOUNT",
    subtitle: "تنزيل مبلغ ثابت بالدينار من سعر كل قطعة مشمولة بالعرض",
    example: "مثال: تنزيل 1,000 د.ع من سعر كل قطعة",
    Icon: Banknote,
  },
  {
    type: "FIXED_PRICE",
    subtitle: "بيع المواد المختارة بسعر واحد ثابت (والمادة الأرخص تبقى على سعرها الأصلي)",
    example: "مثال: أي ملزمة مختارة بـ 3,000 د.ع",
    Icon: Tag,
  },
  {
    type: "BUNDLE_PRICE",
    subtitle: "سعر خاص لبكج مواد سوية، أو اختيار عدة قطع بسعر بكج واحد",
    example: "مثال: أي 3 دفاتر بـ 9,000 د.ع",
    Icon: Package,
  },
  {
    type: "BOGO",
    subtitle: "اشتري عدد معين واحصل على قطعة مجاناً أو بنصف السعر",
    example: "مثال: اشتري 2 واحصل على 1 مجاناً",
    Icon: Gift,
  },
  {
    type: "TIERED_QTY",
    subtitle: "كلما زادت الكمية ينزل السعر أو يزيد الخصم تلقائياً (مفرد وجملة)",
    example: "مثال: من 6 قطع خصم 10%، ومن 12 قطعة خصم 20%",
    Icon: Layers,
  },
  {
    type: "FREE_SHIPPING",
    subtitle: "توصيل مجاني على حساب المكتبة للطلبات المشمولة بالعرض",
    example: "مثال: توصيل مجاني للطلبات فوق 25,000 د.ع",
    Icon: Truck,
  },
];

export function OfferTypeCards({
  value,
  onChange,
  activeTypesInOffer = [],
  onAddAsNewRule,
  disabled = false,
}: OfferTypeCardsProps) {
  return (
    <div
      role="radiogroup"
      aria-label="بطاقات اختيار نوع العرض"
      className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5"
    >
      {TYPE_CARD_META.map(({ type, subtitle, example, Icon }) => {
        const selected = value === type;
        const usedCount = activeTypesInOffer.filter((t) => t === type).length;
        return (
          <div
            key={type}
            role="radio"
            aria-checked={selected}
            tabIndex={disabled ? -1 : 0}
            onClick={() => {
              if (!disabled) onChange(type);
            }}
            onKeyDown={(e) => {
              if (!disabled && (e.key === "Enter" || e.key === " ")) {
                e.preventDefault();
                onChange(type);
              }
            }}
            className={`flex flex-col justify-between gap-2 rounded-lg border p-3 text-right transition-colors ${
              selected
                ? "border-primary bg-primary/10 ring-1 ring-primary/30"
                : usedCount > 0
                ? "border-[var(--sem-pos)]/40 bg-[var(--sem-pos-bg)]/30 hover:bg-muted/40"
                : "border-border bg-card hover:bg-muted/40"
            } ${disabled ? "opacity-60 cursor-not-allowed" : "cursor-pointer"}`}
          >
            <div className="space-y-1.5">
              <div className="flex w-full items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-xs font-bold text-foreground">
                    {PROMO_TYPE_LABELS[type]}
                  </span>
                  {usedCount > 0 && (
                    <Badge
                      variant="outline"
                      className="text-[10px] py-0 px-1.5 border-[var(--sem-pos)]/40 bg-[var(--sem-pos-bg)] text-[var(--sem-pos)]"
                    >
                      <Check className="size-2.5 ml-0.5" />
                      {usedCount > 1 ? `${usedCount} مضافة` : "مضاف بالعرض"}
                    </Badge>
                  )}
                </div>
                <span
                  className={`flex size-7 shrink-0 items-center justify-center rounded-md ${
                    selected
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-muted-foreground"
                  }`}
                >
                  <Icon className="size-3.5" />
                </span>
              </div>
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                {subtitle}
              </p>
            </div>

            <div className="flex items-center justify-between gap-2 pt-1 border-t border-border/50">
              <span className="text-[10px] font-medium text-[var(--sem-info)]">
                {example}
              </span>
              {onAddAsNewRule && !disabled && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onAddAsNewRule(type);
                  }}
                  className="inline-flex items-center gap-0.5 rounded border border-primary/30 bg-background px-1.5 py-0.5 text-[10px] font-semibold text-primary hover:bg-primary hover:text-primary-foreground transition-colors shrink-0"
                  title="دمج هذا النوع مع العرض نفسه"
                >
                  <Plus className="size-2.5" /> أضفه مع العرض
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
