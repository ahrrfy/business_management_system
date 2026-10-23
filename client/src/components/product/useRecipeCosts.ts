import { useEffect, useMemo } from "react";
import { D, moneyInput, round2 } from "@/lib/money";
import type {
  RecipeController,
  ProductRecipeSectionProps,
} from "./useProductRecipe";
type CostProps = Pick<
  RecipeController,
  | "data"
  | "currentRecipe"
  | "isEditing"
  | "priceTierMode"
  | "formLabor"
  | "formWaste"
  | "formLines"
  | "setFormLines"
  | "stockCheckQ"
  | "stockData"
>;
export function useRecipeCosts(
  {
    data,
    currentRecipe,
    isEditing,
    priceTierMode,
    formLabor,
    formWaste,
    formLines,
    setFormLines,
    stockCheckQ,
    stockData,
  }: CostProps,
  {
    sellingPrice: propSellingPrice,
    wholesalePrice: propWholesalePrice,
  }: ProductRecipeSectionProps,
) {
  // إعادة ترطيب أسعار التكلفة الحية للمواد المدخلة في النموذج فور وصولها من الخادم
  useEffect(() => {
    if (
      !isEditing ||
      stockCheckQ.isError ||
      !stockData?.components ||
      stockData.components.length === 0
    )
      return;
    const costMap = new Map<number, string>();
    for (const c of stockData.components) {
      if (c.costPrice) costMap.set(c.variantId, c.costPrice);
    }
    setFormLines((prev) => {
      let changed = false;
      const updated = prev.map((line) => {
        const liveCost = costMap.get(line.inputVariantId);
        if (liveCost && liveCost !== line.inputCostPrice) {
          changed = true;
          return { ...line, inputCostPrice: liveCost };
        }
        return line;
      });
      return changed ? updated : prev;
    });
  }, [isEditing, stockCheckQ.isError, stockData?.components]);

  // حساب التكاليف الحية بأمان ضد المُدخلات الجزئية
  const calculatedCosts = useMemo(() => {
    const linesToCompute = isEditing ? formLines : currentRecipe?.lines || [];

    // استخراج أسعار التكلفة الحية من الخادم في حال توفرها لإعادة ترطيب التكاليف عند اللصق
    const liveCostMap = new Map<number, string>();
    if (!stockCheckQ.isError && stockData?.components) {
      for (const comp of stockData.components) {
        if (comp.costPrice) {
          liveCostMap.set(comp.variantId, comp.costPrice);
        }
      }
    }

    let materialsTotal = D(0);
    for (const l of linesToCompute) {
      const qty = moneyInput(l.qtyPerOutputBase);
      const rawCost = liveCostMap.get(l.inputVariantId) ?? l.inputCostPrice;
      const unitCost = moneyInput(rawCost);
      materialsTotal = materialsTotal.plus(qty.mul(unitCost));
    }
    materialsTotal = round2(materialsTotal);

    const rawLabor = moneyInput(
      isEditing ? formLabor : currentRecipe?.laborPerOutputBase,
    );
    const labor = round2(rawLabor.isNegative() ? D(0) : rawLabor);
    const rawWaste = moneyInput(
      isEditing ? formWaste : currentRecipe?.wasteStdPct,
    );
    const wastePct = rawWaste.gt(0) && rawWaste.lt(1) ? rawWaste : D(0);
    const totalBeforeWaste = materialsTotal.plus(labor);
    const wasteFactor =
      wastePct.gt(0) && wastePct.lt(1) ? D(1).minus(wastePct) : D(1);
    const totalUnitCost = wasteFactor.gt(0)
      ? round2(totalBeforeWaste.div(wasteFactor))
      : totalBeforeWaste;

    return {
      materialsTotal,
      labor,
      wastePct,
      totalUnitCost,
    };
  }, [
    isEditing,
    formLines,
    formLabor,
    formWaste,
    currentRecipe,
    stockCheckQ.isError,
    stockData?.components,
  ]);

  const effectiveRetail =
    propSellingPrice !== undefined
      ? propSellingPrice || null
      : data?.sellingPrice || null;
  const effectiveWholesale =
    propWholesalePrice !== undefined
      ? propWholesalePrice || null
      : data?.wholesalePrice || null;

  // حساب مؤشرات الربحية وهامش الربح مع دعم فئات الأسعار (مفرق / جملة)
  const profitability = useMemo(() => {
    const hasRetail = Boolean(
      effectiveRetail && moneyInput(effectiveRetail).gt(0),
    );
    const hasWholesale = Boolean(
      effectiveWholesale && moneyInput(effectiveWholesale).gt(0),
    );

    const effectiveTier =
      (priceTierMode === "WHOLESALE" && hasWholesale) || !hasRetail
        ? "WHOLESALE"
        : "RETAIL";

    const rawPrice =
      effectiveTier === "WHOLESALE" ? effectiveWholesale : effectiveRetail;
    if (!rawPrice) return null;
    const sellP = moneyInput(rawPrice);
    if (sellP.lte(0)) return null;

    const unitCost = calculatedCosts.totalUnitCost;
    const grossProfit = round2(sellP.minus(unitCost));
    const grossMarginPct = round2(grossProfit.div(sellP).mul(100));
    const isLoss = grossProfit.lt(0);
    const isLowMargin = !isLoss && grossMarginPct.lt(15);

    return {
      priceTier: effectiveTier,
      hasBothTiers: Boolean(hasRetail && hasWholesale),
      sellingPrice: sellP,
      grossProfit,
      grossMarginPct,
      isLoss,
      isLowMargin,
    };
  }, [
    effectiveRetail,
    effectiveWholesale,
    priceTierMode,
    calculatedCosts.totalUnitCost,
  ]);

  return { calculatedCosts, profitability };
}
export type RecipeCosts = ReturnType<typeof useRecipeCosts>;
