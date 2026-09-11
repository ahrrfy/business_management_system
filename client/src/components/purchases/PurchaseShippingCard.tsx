import React from "react";
import { Landmark, Truck } from "lucide-react";
import { MoneyInput } from "@/components/form/MoneyInput";
import { D, fmtAr, round2 } from "@/lib/money";
import type { InvoiceLine } from "@/components/invoice";
import type { Decimal } from "decimal.js";

/** يُحلّل مبلغاً نصّياً بأمان: MoneyInput قد يُصدر قيماً وسيطة مثل «.» أثناء كتابة كسر، وD() الخام
 *  يرمي حينها فيكسر الرسم (نظير safeD في calcTotals). القيم غير المكتملة ⇒ صفر حتى الحفظ/blur. */
export function safeMoney(v: string | number | null | undefined): Decimal {
  try {
    return D(v ?? 0);
  } catch {
    return D(0);
  }
}

export interface PurchaseLandedCostResult {
  sum: Decimal;
  grand: Decimal;
  goodsIqd: Decimal;
  taxIqd: Decimal;
  uplift: Decimal;
  rate: Decimal;
  hasLanded: boolean;
  hasBase: boolean;
}

/**
 * حساب تكلفة الشحن والكمرك والتكلفة الإجمالية لأمر الشراء بنمط الخادم الموحد.
 * «المعروض = المحفوظ» (درس فاتورة الشحن ٥/٨): الخادم يترجم كلّ سطرٍ على حدة ثمّ يجمع
 * (subtotal = Σ round2(سطر$ × السعر))، والضريبة على المجموع الديناري، والشحن خارج ذمة المورد.
 */
export function calcPurchaseLandedCost({
  shippingCost,
  customsCost,
  docSubtotal,
  docGrossSubtotal,
  currency,
  agreedRate,
  items,
  taxEnabled,
  taxRatePercent,
}: {
  shippingCost: string;
  customsCost: string;
  docSubtotal: string;
  docGrossSubtotal: string;
  currency: string;
  agreedRate: string;
  items: { price: string; qty?: number | string | null }[];
  taxEnabled: boolean;
  taxRatePercent?: string | null;
}): PurchaseLandedCostResult {
  const sum = round2(safeMoney(shippingCost).plus(safeMoney(customsCost)));
  const sourceSubtotal = D(docSubtotal || 0);
  const rate = currency === "USD" ? safeMoney(agreedRate) : D(1);
  const grossDoc = D(docGrossSubtotal || 0);
  const netRatio = grossDoc.gt(0) ? sourceSubtotal.dividedBy(grossDoc) : D(1);
  const goodsIqd =
    currency === "USD"
      ? round2(
          items.reduce(
            (acc, l) =>
              acc.plus(
                round2(
                  round2(
                    round2(safeMoney(l.price).times(D(l.qty || 0))).times(netRatio),
                  ).times(rate),
                ),
              ),
            D(0),
          ),
        )
      : round2(sourceSubtotal.times(rate));
  const taxIqd = taxEnabled
    ? round2(goodsIqd.times(safeMoney(taxRatePercent || "0")).dividedBy(100))
    : D(0);
  const grand = round2(goodsIqd.plus(taxIqd));
  const uplift = D(1);
  return {
    sum,
    grand,
    goodsIqd,
    taxIqd,
    uplift,
    rate,
    hasLanded: sum.gt(0),
    hasBase: goodsIqd.gt(0),
  };
}

export interface PurchaseShippingCardProps {
  shippingCost: string;
  onShippingCostChange: (v: string) => void;
  customsCost: string;
  onCustomsCostChange: (v: string) => void;
  landed: PurchaseLandedCostResult;
  items?: InvoiceLine[];
  subtotal?: string;
  currency?: string;
  showOptionalBadge?: boolean;
  showDetailedDistribution?: boolean;
}

export function PurchaseShippingCard({
  shippingCost,
  onShippingCostChange,
  customsCost,
  onCustomsCostChange,
  landed,
  items = [],
  subtotal = "0",
  currency = "IQD",
  showOptionalBadge = false,
  showDetailedDistribution = false,
}: PurchaseShippingCardProps) {
  return (
    <section className="overflow-hidden rounded-xl border bg-card">
      <header className="flex items-center gap-2 border-b bg-muted px-4 py-2.5">
        <Truck aria-hidden className="size-5" />
        <span className="text-sm font-extrabold">تكلفة الشحن والكمرك</span>
        {showOptionalBadge && (
          <span className="ms-auto text-[11px] font-semibold text-muted-foreground">
            اختياري
          </span>
        )}
      </header>
      <div className="space-y-2 px-4 py-3">
        <label className="flex items-center justify-between gap-2">
          <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-muted-foreground">
            <Truck aria-hidden className="size-4" /> الشحن
          </span>
          <MoneyInput
            value={shippingCost}
            onChange={onShippingCostChange}
            ariaLabel="تكلفة الشحن"
            className="h-8 w-32 text-center text-sm font-bold"
          />
        </label>
        <label className="flex items-center justify-between gap-2">
          <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-muted-foreground">
            <Landmark aria-hidden className="size-4" /> الكمرك
          </span>
          <MoneyInput
            value={customsCost}
            onChange={onCustomsCostChange}
            ariaLabel="تكلفة الكمرك"
            className="h-8 w-32 text-center text-sm font-bold"
          />
        </label>

        {landed.hasLanded && landed.hasBase && (
          <div className="mt-1 rounded-lg border border-dashed bg-muted/40 p-2.5 text-xs">
            {showDetailedDistribution && items.length > 0 && (
              <>
                <div className="mb-1.5 font-bold text-foreground">
                  توزيع الشحن على البنود بنسبة القيمة (للعِلم فقط)
                </div>
                <ul className="space-y-1">
                  {items.map((l, i) => (
                    <li
                      key={i}
                      className="flex items-center justify-between gap-2"
                    >
                      <span className="min-w-0 truncate text-muted-foreground">
                        {l.name}
                      </span>
                      <span dir="ltr" className="shrink-0 font-bold tabular-nums">
                        {fmtAr(
                          round2(
                            D(subtotal).gt(0)
                              ? landed.sum
                                  .times(D(l.price).times(D(l.qty || 0)))
                                  .dividedBy(D(subtotal))
                              : D(0),
                          ).toFixed(2),
                        )}{" "}
                        د.ع شحناً
                        <span className="font-normal text-muted-foreground">
                          {" "}
                          (سعر الشراء {fmtAr(l.price)}
                          {currency === "USD" ? "$" : " د.ع"})
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
            <div className={showDetailedDistribution ? "mt-1.5 border-t pt-1.5 text-[11px] text-muted-foreground" : "text-[11px] text-muted-foreground"}>
              <strong>لا تُضاف إلى ذمّة المورّد ولا إلى تكلفة الصنف.</strong>{" "}
              تُسجَّل مصروف نقلٍ على الشركة لحظة الاستلام (يظهر في المصروفات والدفتر)، وتكلفة الصنف تبقى سعر المورّد وحده.
            </div>
          </div>
        )}
        {landed.hasLanded && !landed.hasBase && (
          <p className="text-[11px] font-semibold text-[var(--sem-warn)]">
            أضِف منتجات بقيمة موجبة لتوزيع الشحن/الكمرك عليها.
          </p>
        )}
      </div>
    </section>
  );
}
