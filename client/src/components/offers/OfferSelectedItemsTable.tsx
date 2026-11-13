/**
 * client/src/components/offers/OfferSelectedItemsTable.tsx
 *
 * Interactive selected items table with packaging unit selector,
 * live promo price, margin %, below-cost alert, and fixed-price ceiling alert.
 */

import React, { useMemo } from "react";
import Decimal from "decimal.js";
import { AlertCircle, ArrowUpRight, Package, Trash2, TrendingUp, TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AppSelect } from "@/components/ui/AppSelect";
import { D, formatIqd } from "@/lib/money";
import {
  calculateLiveMargin,
  type PromoType,
  type SelectedOfferItem,
} from "./offersTypes";

export interface OfferSelectedItemsTableProps {
  items: SelectedOfferItem[];
  promoType: PromoType;
  promoValue?: string;
  onUpdateUnit: (variantId: number, unitId: number) => void;
  onRemoveItem: (variantId: number) => void;
  disabled?: boolean;
}

export function OfferSelectedItemsTable({
  items,
  promoType,
  promoValue = "0",
  onUpdateUnit,
  onRemoveItem,
  disabled = false,
}: OfferSelectedItemsTableProps) {
  // Parse promo value to Decimal
  const promoValueDec = useMemo(() => {
    try {
      const v = D(promoValue);
      return v.isFinite() && v.gt(0) ? v : new Decimal(0);
    } catch {
      return new Decimal(0);
    }
  }, [promoValue]);

  // Compute live calculations for all rows
  const computedRows = useMemo(() => {
    return items.map((item) => {
      const activeUnit = item.units.find((u) => u.id === item.productUnitId) ?? item.units[0];
      const retailPriceDec = new Decimal(activeUnit?.retailPrice ?? item.retailPrice ?? "0");
      const conversionFactorDec = new Decimal(activeUnit?.conversionFactor ?? item.conversionFactor ?? "1");

      const costPriceDec =
        item.costPrice != null
          ? new Decimal(item.costPrice).mul(conversionFactorDec)
          : null;

      let marginResult = null;
      if (
        promoType === "PERCENT" ||
        promoType === "AMOUNT" ||
        promoType === "FIXED_PRICE"
      ) {
        if (costPriceDec != null) {
          marginResult = calculateLiveMargin(
            retailPriceDec,
            costPriceDec,
            promoType,
            promoValueDec
          );
        } else {
          // Cost is masked by RBAC, but calculate promoPrice and ceiling rule
          let promoPrice = retailPriceDec;
          if (promoType === "PERCENT") {
            const disc = retailPriceDec.mul(promoValueDec).div(100);
            promoPrice = retailPriceDec.minus(disc);
          } else if (promoType === "AMOUNT") {
            promoPrice = Decimal.max(0, retailPriceDec.minus(promoValueDec));
          } else if (promoType === "FIXED_PRICE") {
            promoPrice = Decimal.min(retailPriceDec, promoValueDec);
          }
          const isCeilingViolated =
            promoType === "FIXED_PRICE" && retailPriceDec.lte(promoValueDec);
          marginResult = {
            promoPrice,
            marginPercent: new Decimal(0),
            isBelowCost: false,
            isCeilingViolated,
            badgeStyle: (isCeilingViolated ? "warning" : "positive") as "warning" | "positive",
          };
        }
      }

      return {
        item,
        activeUnit,
        retailPriceDec,
        costPriceDec,
        marginResult,
      };
    });
  }, [items, promoType, promoValueDec]);

  // Alert counters
  const belowCostCount = computedRows.filter(
    (r) => r.marginResult?.isBelowCost
  ).length;

  const ceilingCount = computedRows.filter(
    (r) => r.marginResult?.isCeilingViolated
  ).length;

  if (items.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border p-8 text-center text-muted-foreground">
        <Package className="mx-auto size-8 text-muted-foreground/60 mb-2" />
        <div className="text-sm font-medium text-foreground">
          لم تتم إضافة مواد بعد
        </div>
        <p className="text-xs text-muted-foreground mt-1 max-w-md mx-auto">
          امسح الباركود مباشرة أو ابحث باسم المادة أو استخدم أزرار الإضافة المتعددة بالأعلى لإدراج المواد المشمولة بالعرض.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Financial Warnings Bar */}
      {belowCostCount > 0 && (
        <div className="flex items-start gap-2.5 rounded-md border border-[var(--sem-neg)]/40 bg-[var(--sem-neg-bg)] p-3 text-xs text-[var(--sem-neg)]">
          <TriangleAlert className="size-4 shrink-0 mt-0.5" />
          <div>
            <span className="font-bold">تنبيه كلفة: </span>
            <span>
              يوجد {belowCostCount} مادة سعرها بالعرض أقل من كلفتها علينا. لحفظ العرض، فعّل خيار «السماح بالبيع جوا الكلفة (تحت التكلفة)» أسفل الجدول أو عدّل قيمة الخصم.
            </span>
          </div>
        </div>
      )}

      {ceilingCount > 0 && (
        <div className="flex items-start gap-2.5 rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] p-3 text-xs text-[var(--sem-warn)]">
          <AlertCircle className="size-4 shrink-0 mt-0.5" />
          <div>
            <span className="font-bold">تنبيه تسعير: </span>
            <span>
              يوجد {ceilingCount} مادة سعرها الأصلي أرخص من السعر الموحد، فبقيت على سعرها الأصلي تلقائياً بدون أي زيادة.
            </span>
          </div>
        </div>
      )}

      {/* Interactive Items Table */}
      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full text-xs">
          <thead className="bg-muted/50 border-b border-border text-muted-foreground">
            <tr>
              <th className="py-2.5 px-3 text-right">المادة والكود</th>
              <th className="py-2.5 px-3 text-center">نوع البضاعة</th>
              <th className="py-2.5 px-3 text-center">وحدة البيع</th>
              <th className="py-2.5 px-3 text-center">السعر الأصلي</th>
              <th className="py-2.5 px-3 text-center">الكلفة</th>
              <th className="py-2.5 px-3 text-center">سعر العرض</th>
              <th className="py-2.5 px-3 text-center">نسبة الربح</th>
              <th className="py-2.5 px-3 text-center">الحالة</th>
              <th className="py-2.5 px-3 text-center">حذف</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {computedRows.map(({ item, retailPriceDec, costPriceDec, marginResult }) => {
              return (
                <tr key={item.variantId} className="hover:bg-muted/30 transition-colors">
                  {/* 1. Name & SKU */}
                  <td className="py-2.5 px-3">
                    <div className="font-medium text-foreground">{item.productName}</div>
                    <div className="text-[11px] text-muted-foreground flex items-center gap-1.5 mt-0.5">
                      <span>{item.sku}</span>
                      {item.variantKind === "ALTERNATIVE" && (
                        <Badge variant="outline" className="text-[9px] py-0 px-1 border-muted-foreground/30">
                          بديل
                        </Badge>
                      )}
                    </div>
                  </td>

                  {/* 2. Ownership */}
                  <td className="py-2.5 px-3 text-center">
                    {item.isConsignment ? (
                      <Badge variant="outline" className="text-[10px] py-0 px-1.5 border-[var(--sem-warn)]/40 text-[var(--sem-warn)] bg-[var(--sem-warn-bg)]">
                        أمانة (تصريف)
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="text-[10px] py-0 px-1.5 border-[var(--sem-info)]/30 text-[var(--sem-info)] bg-[var(--sem-info-bg)]">
                        ملك المكتبة
                      </Badge>
                    )}
                  </td>

                  {/* 3. Packaging Unit Selector */}
                  <td className="py-2.5 px-3 text-center">
                    <AppSelect
                      value={String(item.productUnitId)}
                      onValueChange={(val) => onUpdateUnit(item.variantId, parseInt(val, 10))}
                      className="h-7 text-xs w-36"
                      disabled={disabled}
                      size="sm"
                    >
                      {item.units.map((u) => (
                        <option key={u.id} value={String(u.id)}>
                          {Number(u.conversionFactor) > 1
                            ? `${u.unitName} (${u.conversionFactor} قطعة)`
                            : u.unitName}
                        </option>
                      ))}
                    </AppSelect>
                  </td>

                  {/* 4. Retail Price */}
                  <td className="py-2.5 px-3 text-center font-medium tabular-nums">
                    {formatIqd(retailPriceDec.toNumber())} د.ع
                  </td>

                  {/* 5. Cost Price */}
                  <td className="py-2.5 px-3 text-center tabular-nums text-muted-foreground">
                    {costPriceDec != null ? `${formatIqd(costPriceDec.toNumber())} د.ع` : "—"}
                  </td>

                  {/* 6. Promo Price */}
                  <td className="py-2.5 px-3 text-center font-bold tabular-nums">
                    {marginResult ? (
                      <span className={marginResult.isBelowCost ? "text-[var(--sem-neg)]" : "text-foreground"}>
                        {formatIqd(marginResult.promoPrice.toNumber())} د.ع
                      </span>
                    ) : (
                      <span className="text-muted-foreground font-normal">حسب الكمية بالسلة</span>
                    )}
                  </td>

                  {/* 7. Profit Margin % */}
                  <td className="py-2.5 px-3 text-center tabular-nums">
                    {marginResult && costPriceDec != null ? (
                      <span
                        className={
                          marginResult.isBelowCost
                            ? "font-bold text-[var(--sem-neg)]"
                            : "font-medium text-[var(--sem-pos)]"
                        }
                      >
                        {marginResult.marginPercent.toFixed(2)}٪
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>

                  {/* 8. Status Badge */}
                  <td className="py-2.5 px-3 text-center">
                    {marginResult ? (
                      marginResult.isBelowCost ? (
                        <Badge
                          variant="outline"
                          className="bg-[var(--sem-neg-bg)] text-[var(--sem-neg)] border-[var(--sem-neg)]/30 text-[10px] py-0 px-1.5"
                        >
                          <TriangleAlert className="size-3 ml-1" /> أقل من الكلفة
                        </Badge>
                      ) : marginResult.isCeilingViolated ? (
                        <Badge
                          variant="outline"
                          className="bg-[var(--sem-warn-bg)] text-[var(--sem-warn)] border-[var(--sem-warn)]/30 text-[10px] py-0 px-1.5"
                        >
                          <AlertCircle className="size-3 ml-1" /> سعره الأصلي أرخص
                        </Badge>
                      ) : (
                        <Badge
                          variant="outline"
                          className="bg-[var(--sem-pos-bg)] text-[var(--sem-pos)] border-[var(--sem-pos)]/30 text-[10px] py-0 px-1.5"
                        >
                          <TrendingUp className="size-3 ml-1" /> ربح سليم
                        </Badge>
                      )
                    ) : (
                      <Badge variant="outline" className="text-[10px] py-0 px-1.5 text-muted-foreground">
                        {promoType === "FREE_SHIPPING" ? "مشمول بالتوصيل المجاني" : "حسب البكج / الكمية"}
                      </Badge>
                    )}
                  </td>

                  {/* 9. Action Button */}
                  <td className="py-2.5 px-3 text-center">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => onRemoveItem(item.variantId)}
                      disabled={disabled}
                      className="size-7 text-muted-foreground hover:text-destructive"
                      title="إزالة المادة من العرض"
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
