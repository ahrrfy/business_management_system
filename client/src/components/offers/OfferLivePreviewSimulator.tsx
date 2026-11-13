/**
 * client/src/components/offers/OfferLivePreviewSimulator.tsx
 *
 * Interactive cart simulator with dynamic quantities, basket promotion rules,
 * savings breakdown, and fixed-price ceiling previews.
 */

import React, { useMemo, useState } from "react";
import Decimal from "decimal.js";
import {
  AlertCircle,
  CheckCircle2,
  Minus,
  Plus,
  RotateCcw,
  ShoppingCart,
  Tag,
  TrendingDown,
  Truck,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { formatIqd } from "@/lib/money";
import {
  PROMO_TYPE_LABELS,
  safeDecimal,
  safePositiveDecimal,
  simulateBasketPreview as simulateBasketPreviewBase,
  type BasketPreviewOutput,
  type OfferFormData,
  type SelectedOfferItem,
  type SimulatorCartItem,
  type SimulateBasketRule,
} from "./offersTypes";
import { simulateMultiRuleBasketPreview } from "./offersMultiRuleHelpers";

/**
 * Pure function: Simulates basket preview calculation matching offers_ui_contracts.test.ts
 */
export function simulateBasketPreview(
  items: Array<{ productId: number; unitPrice: Decimal | number | string; quantity: Decimal | number | string }>,
  rule: SimulateBasketRule
): BasketPreviewOutput {
  return simulateBasketPreviewBase(items, rule);
}

export interface OfferLivePreviewSimulatorProps {
  formData: OfferFormData;
  selectedProducts: SelectedOfferItem[];
}

export function OfferLivePreviewSimulator({
  formData,
  selectedProducts,
}: OfferLivePreviewSimulatorProps) {
  // Build initial cart items from selected products (including per-rule items) or realistic Iraqi defaults
  const mergedSelectedProducts = useMemo(() => {
    const map = new Map<number, SelectedOfferItem>();
    for (const p of selectedProducts) map.set(p.variantId, p);
    if (formData.scopeSharingMode === "PER_RULE" && formData.extraRules) {
      for (const r of formData.extraRules) {
        for (const p of r.selectedProducts) {
          if (!map.has(p.variantId)) map.set(p.variantId, p);
        }
      }
    }
    return Array.from(map.values());
  }, [selectedProducts, formData.scopeSharingMode, formData.extraRules]);

  const initialItems: SimulatorCartItem[] = useMemo(() => {
    if (mergedSelectedProducts.length > 0) {
      return mergedSelectedProducts.map((p) => {
        const unit = p.units.find((u) => u.id === p.productUnitId) ?? p.units[0];
        const unitIsBase = unit?.isBaseUnit ?? p.isBaseUnit ?? true;
        return {
          productId: p.productId,
          variantId: p.variantId,
          productUnitId: unit?.id ?? p.productUnitId,
          productName: p.productName,
          unitName: unit?.unitName ?? "قطعة",
          unitPrice: safeDecimal(unit?.retailPrice ?? p.retailPrice, new Decimal(1000)),
          quantity: new Decimal(1),
          isBaseUnit: unitIsBase,
          costPrice: p.costPrice ? safeDecimal(p.costPrice) : undefined,
        };
      });
    }
    // Default sample basket items for previewing
    return [
      {
        productId: 101,
        variantId: 101,
        productUnitId: 101,
        productName: "قلم روترينج جاف",
        unitName: "قطعة",
        unitPrice: new Decimal(500),
        quantity: new Decimal(2),
        isBaseUnit: true,
      },
      {
        productId: 102,
        variantId: 102,
        productUnitId: 102,
        productName: "دفتر جامعي فابر كاستل",
        unitName: "دفتر",
        unitPrice: new Decimal(3500),
        quantity: new Decimal(1),
        isBaseUnit: true,
      },
    ];
  }, [mergedSelectedProducts]);

  const itemRowKey = (item: SimulatorCartItem) => item.variantId ?? item.productId;
  const [quantities, setQuantities] = useState<Record<number, number>>({});

  const cartItems = useMemo(() => {
    return initialItems.map((item) => {
      const k = itemRowKey(item);
      return {
        ...item,
        quantity: safeDecimal(quantities[k] ?? item.quantity.toNumber(), new Decimal(1)),
      };
    });
  }, [initialItems, quantities]);

  const updateQuantity = (rowKey: number, delta: number) => {
    setQuantities((prev) => {
      const current =
        prev[rowKey] ??
        (initialItems.find((i) => itemRowKey(i) === rowKey)?.quantity.toNumber() ?? 1);
      const next = Math.max(0, current + delta);
      return { ...prev, [rowKey]: next };
    });
  };

  const setExactQuantity = (rowKey: number, val: string) => {
    const num = Math.max(0, parseInt(val, 10) || 0);
    setQuantities((prev) => ({ ...prev, [rowKey]: num }));
  };

  const resetQuantities = () => setQuantities({});

  // Compute live preview using contract function backed by promotionEngine
  const preview = useMemo(() => {
    const hasExplicitNonBaseUnit = mergedSelectedProducts.some((p) => !p.isBaseUnit);
    const primaryRuleInput: SimulateBasketRule & { ruleName?: string } = {
      ruleName: `قاعدة 1: ${PROMO_TYPE_LABELS[formData.type]}`,
      type: formData.type,
      percent:
        formData.type === "PERCENT"
          ? safePositiveDecimal(formData.discountPercent)
          : undefined,
      maxDiscountAmount: safePositiveDecimal(formData.maxDiscountAmount),
      minLineAmount: safePositiveDecimal(formData.minLineAmount),
      discountAmount:
        formData.type === "AMOUNT"
          ? safePositiveDecimal(formData.discountAmount)
          : undefined,
      fixedPrice:
        formData.type === "FIXED_PRICE"
          ? safePositiveDecimal(formData.fixedPrice)
          : undefined,
      bundlePrice:
        formData.type === "BUNDLE_PRICE"
          ? safePositiveDecimal(formData.bundlePrice)
          : undefined,
      bundleMode: formData.bundleMode,
      bundleQuantity: formData.bundleQuantity,
      bogoBuyQuantity: formData.bogoBuyQuantity,
      bogoGetQuantity: formData.bogoGetQuantity,
      bogoGetDiscountPercent: formData.bogoGetDiscountPercent
        ? safeDecimal(formData.bogoGetDiscountPercent, new Decimal(100))
        : undefined,
      tieredMode: formData.tieredMode,
      tiers: formData.tiers,
      applyToBaseUnitOnly: hasExplicitNonBaseUnit ? false : formData.applyToBaseUnitOnly,
      targetProductIds:
        formData.scope === "PRODUCTS" && selectedProducts.length > 0
          ? selectedProducts.map((p) => p.productId)
          : initialItems.map((i) => i.productId),
      minSpend: safePositiveDecimal(formData.minOrderSpend),
    };

    const extraList = formData.extraRules ?? [];
    const allRuleInputs: Array<SimulateBasketRule & { ruleName?: string }> = [
      primaryRuleInput,
      ...extraList.map((er, i) => {
        const useOwn = formData.scopeSharingMode === "PER_RULE";
        const erItems = useOwn ? er.selectedProducts : selectedProducts;
        const erScope = useOwn ? er.scope : formData.scope;
        return {
          ruleName: er.ruleLabel.trim() || `قاعدة ${i + 2}: ${PROMO_TYPE_LABELS[er.type]}`,
          type: er.type,
          percent: er.type === "PERCENT" ? safePositiveDecimal(er.discountPercent) : undefined,
          maxDiscountAmount: safePositiveDecimal(er.maxDiscountAmount),
          minLineAmount: safePositiveDecimal(useOwn ? er.minLineAmount : formData.minLineAmount),
          discountAmount: er.type === "AMOUNT" ? safePositiveDecimal(er.discountAmount) : undefined,
          fixedPrice: er.type === "FIXED_PRICE" ? safePositiveDecimal(er.fixedPrice) : undefined,
          bundlePrice: er.type === "BUNDLE_PRICE" ? safePositiveDecimal(er.bundlePrice) : undefined,
          bundleMode: er.bundleMode,
          bundleQuantity: er.bundleQuantity,
          bogoBuyQuantity: er.bogoBuyQuantity,
          bogoGetQuantity: er.bogoGetQuantity,
          bogoGetDiscountPercent: er.bogoGetDiscountPercent
            ? safeDecimal(er.bogoGetDiscountPercent, new Decimal(100))
            : undefined,
          tieredMode: er.tieredMode,
          tiers: er.tiers,
          applyToBaseUnitOnly: hasExplicitNonBaseUnit
            ? false
            : useOwn
            ? er.applyToBaseUnitOnly
            : formData.applyToBaseUnitOnly,
          targetProductIds:
            erScope === "PRODUCTS" && erItems.length > 0
              ? erItems.map((p) => p.productId)
              : initialItems.map((it) => it.productId),
        };
      }),
    ];

    const multiRes = simulateMultiRuleBasketPreview(
      cartItems,
      allRuleInputs,
      safePositiveDecimal(formData.minOrderSpend),
      Boolean(formData.freeShipping)
    );
    return extraList.length === 0
      ? { ...multiRes, winningRuleNamesByLineKey: {} as Record<string, string> }
      : multiRes;
  }, [cartItems, formData, selectedProducts, mergedSelectedProducts, initialItems]);

  return (
    <Card className="border-border/60 bg-muted/20">
      <CardHeader className="flex flex-row items-center justify-between pb-3">
        <div className="flex items-center gap-2">
          <ShoppingCart className="size-4 text-primary" />
          <CardTitle className="text-sm font-semibold">
            تجربة العرض قبل الحفظ (سلة تجريبية)
          </CardTitle>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={resetQuantities}
          className="h-7 gap-1 text-xs text-muted-foreground"
        >
          <RotateCcw className="size-3" /> تصفير الكميات
        </Button>
      </CardHeader>

      <CardContent className="space-y-4 text-sm">
        {/* Helper Note / Minimum Spend Notice */}
        {preview.helperNote && (
          <div className="flex items-center gap-2 rounded-md border border-[var(--sem-warn)]/30 bg-[var(--sem-warn-bg)] p-2.5 text-xs text-[var(--sem-warn)]">
            <AlertCircle className="size-4 shrink-0" />
            <span>{preview.helperNote}</span>
          </div>
        )}

        {!preview.helperNote &&
          safeDecimal(formData.minOrderSpend).gt(0) && (
            <div className="flex items-center gap-2 rounded-md border border-[var(--sem-pos)]/30 bg-[var(--sem-pos-bg)] p-2.5 text-xs text-[var(--sem-pos)]">
              <CheckCircle2 className="size-4 shrink-0" />
              <span>
                تم استيفاء الحد الأدنى للطلب ({formatIqd(formData.minOrderSpend)} د.ع) بنجاح.
              </span>
            </div>
          )}

        {/* Dynamic Cart Items Table */}
        <div className="overflow-hidden rounded-md border border-border">
          <table className="w-full text-xs">
            <thead className="bg-muted/50 border-b border-border text-muted-foreground">
              <tr>
                <th className="py-2 px-3 text-right">المادة</th>
                <th className="py-2 px-3 text-center">السعر</th>
                <th className="py-2 px-3 text-center">الكمية</th>
                <th className="py-2 px-3 text-left">الإجمالي</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {cartItems.map((item) => {
                const lineGross = item.unitPrice.mul(item.quantity);
                const fixedPriceDec = safeDecimal(formData.fixedPrice);
                const isCeilingAlert =
                  formData.type === "FIXED_PRICE" &&
                  fixedPriceDec.gt(0) &&
                  item.unitPrice.lte(fixedPriceDec);

                const rowKey = itemRowKey(item);
                return (
                  <tr key={rowKey} className="hover:bg-muted/30">
                    <td className="py-2 px-3">
                      <div className="font-medium text-foreground">{item.productName}</div>
                      <div className="flex items-center gap-1.5 text-muted-foreground mt-0.5">
                        <span>{item.unitName}</span>
                        {isCeilingAlert && (
                          <Badge
                            variant="outline"
                            className="border-[var(--sem-warn)]/30 bg-[var(--sem-warn-bg)] text-[var(--sem-warn)] text-[10px] py-0 px-1"
                          >
                            يبقى على سعره الأرخص
                          </Badge>
                        )}
                        {preview.winningRuleNamesByLineKey[String(rowKey)] && (
                          <Badge
                            variant="outline"
                            className="border-[var(--sem-pos)]/30 bg-[var(--sem-pos-bg)] text-[var(--sem-pos)] text-[10px] py-0 px-1"
                          >
                            العرض المطبق: {preview.winningRuleNamesByLineKey[String(rowKey)]}
                          </Badge>
                        )}
                      </div>
                    </td>
                    <td className="py-2 px-3 text-center tabular-nums">
                      {formatIqd(item.unitPrice.toNumber())} د.ع
                    </td>
                    <td className="py-2 px-3 text-center">
                      <div className="flex items-center justify-center gap-1">
                        <Button
                          size="icon"
                          variant="outline"
                          className="size-6 h-6 w-6"
                          onClick={() => updateQuantity(rowKey, -1)}
                          disabled={item.quantity.lte(0)}
                        >
                          <Minus className="size-3" />
                        </Button>
                        <Input
                          type="number"
                          min="0"
                          value={item.quantity.toString()}
                          onChange={(e) => setExactQuantity(rowKey, e.target.value)}
                          className="h-6 w-12 text-center text-xs p-1 tabular-nums"
                        />
                        <Button
                          size="icon"
                          variant="outline"
                          className="size-6 h-6 w-6"
                          onClick={() => updateQuantity(rowKey, 1)}
                        >
                          <Plus className="size-3" />
                        </Button>
                      </div>
                    </td>
                    <td className="py-2 px-3 text-left font-medium tabular-nums">
                      {formatIqd(lineGross.toNumber())} د.ع
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Savings Breakdown & Totals */}
        <div className="rounded-md border border-border/80 bg-background p-3 space-y-2">
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>مجموع المواد قبل الخصم:</span>
            <span className="tabular-nums font-medium text-foreground">
              {formatIqd(preview.grossTotal.toNumber())} د.ع
            </span>
          </div>

          <div className="flex justify-between text-xs text-[var(--sem-pos)]">
            <span className="flex items-center gap-1">
              <Tag className="size-3" /> قيمة التخفيض من العرض:
            </span>
            <span className="tabular-nums font-medium">
              -{formatIqd(preview.discount.toNumber())} د.ع
            </span>
          </div>

          {preview.freeShippingApplied && (
            <div className="flex justify-between text-xs text-[var(--sem-pos)] font-semibold">
              <span className="flex items-center gap-1">
                <Truck className="size-3" /> التوصيل المجاني:
              </span>
              <span className="tabular-nums">مجاناً على حساب المكتبة</span>
            </div>
          )}

          <div className="border-t border-border/60 pt-2 flex justify-between items-center text-sm font-bold">
            <span>الصافي المطلوب من الزبون:</span>
            <div className="flex items-center gap-2">
              {preview.savingsPercent.gt(0) && (
                <Badge className="bg-[var(--sem-pos-bg)] text-[var(--sem-pos)] border-[var(--sem-pos)]/30 font-bold tabular-nums">
                  <TrendingDown className="size-3 ml-1" /> وفّر {preview.savingsPercent.toNumber()}%
                </Badge>
              )}
              <span className="tabular-nums text-foreground">
                {formatIqd(preview.netTotal.toNumber())} د.ع
              </span>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
