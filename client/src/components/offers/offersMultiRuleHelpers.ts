/**
 * client/src/components/offers/offersMultiRuleHelpers.ts
 *
 * Pure helpers for multi-rule promotion drafts, validation, target serialization,
 * shared product item hydration, and multi-rule live basket preview simulation.
 */

import Decimal from "decimal.js";
import { normalizeBarcodeScannerInput } from "@shared/barcodeScanner";
import {
  MAX_PROMOTION_TARGETS,
  evaluateCartPromotions,
  type PromotionRule,
} from "@shared/promotionEngine";
import { D, formatIqd } from "@/lib/money";
import {
  PROMO_TYPE_LABELS,
  calculateLiveMargin,
  deriveSimulatorTargetCollections,
  safeDecimal,
  type BasketPreviewOutput,
  type BundleMode,
  type OfferRuleDraft,
  type PromoType,
  type SelectedOfferItem,
  type SimulateBasketRule,
} from "./offersTypes";

export function addDaysYmd(baseYmd: string, days: number): string {
  const parts = baseYmd.split("-").map(Number);
  const dt = new Date(Date.UTC(parts[0] || 2026, (parts[1] || 1) - 1, (parts[2] || 1) + days));
  return dt.toISOString().slice(0, 10);
}

export function endOfMonthYmd(baseYmd: string): string {
  const parts = baseYmd.split("-").map(Number);
  const dt = new Date(Date.UTC(parts[0] || 2026, parts[1] || 1, 0));
  return dt.toISOString().slice(0, 10);
}

export function posDec(raw?: string | null): Decimal | null {
  try {
    const v = D(raw ?? "");
    return v.isFinite() && v.gt(0) ? v : null;
  } catch {
    return null;
  }
}

export function createDefaultRuleDraft(
  type: PromoType = "PERCENT",
  key: string = `rule_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
): OfferRuleDraft {
  return {
    key,
    ruleLabel: "",
    type,
    discountPercent: "10",
    discountAmount: "",
    maxDiscountAmount: "",
    fixedPrice: "",
    bundlePrice: "",
    bundleMode: "PICK_ANY_N",
    bundleQuantity: 3,
    bogoBuyQuantity: 2,
    bogoGetQuantity: 1,
    bogoGetDiscountPercent: "100",
    tieredMode: "PER_ITEM",
    tiers: [],
    scope: type === "FREE_SHIPPING" ? "ALL" : "PRODUCTS",
    selectedCategories: [],
    selectedProducts: [],
    allowBelowCost: false,
    applyToBaseUnitOnly: type === "FREE_SHIPPING" ? false : true,
    minLineAmount: "",
  };
}

export function summarizeRuleDraft(r: OfferRuleDraft): string {
  const baseTitle = r.ruleLabel.trim() || PROMO_TYPE_LABELS[r.type];
  switch (r.type) {
    case "PERCENT": {
      const p = safeDecimal(r.discountPercent);
      return p.gt(0) ? `${baseTitle} (${p.toString()}%)` : baseTitle;
    }
    case "AMOUNT": {
      const a = safeDecimal(r.discountAmount);
      return a.gt(0) ? `${baseTitle} (-${formatIqd(a.toNumber())} د.ع)` : baseTitle;
    }
    case "FIXED_PRICE": {
      const fp = safeDecimal(r.fixedPrice);
      return fp.gt(0) ? `${baseTitle} (${formatIqd(fp.toNumber())} د.ع)` : baseTitle;
    }
    case "BUNDLE_PRICE": {
      const bp = safeDecimal(r.bundlePrice);
      if (!bp.gt(0)) return baseTitle;
      const modeTxt = r.bundleMode === "PICK_ANY_N" ? `أي ${r.bundleQuantity} قطع` : "بكج كامل";
      return `${baseTitle} (${modeTxt} بـ ${formatIqd(bp.toNumber())} د.ع)`;
    }
    case "BOGO":
      return `${baseTitle} (${r.bogoBuyQuantity}+${r.bogoGetQuantity})`;
    case "TIERED_QTY":
      return `${baseTitle} (${r.tiers.length} كميات)`;
    case "FREE_SHIPPING":
      return baseTitle;
    default:
      return baseTitle;
  }
}

export function validateRuleTypeFields(r: OfferRuleDraft, prefix: string): string | null {
  if (r.type === "PERCENT") {
    const p = posDec(r.discountPercent);
    if (!p || p.gt(100)) return `${prefix}نسبة الخصم يجب أن تكون أكبر من صفر وأقل من أو تساوي 100%.`;
  } else if (r.type === "AMOUNT") {
    if (!posDec(r.discountAmount)) return `${prefix}مبلغ الخصم يجب أن يكون أكبر من صفر.`;
  } else if (r.type === "FIXED_PRICE") {
    if (!posDec(r.fixedPrice)) return `${prefix}السعر الموحد يجب أن يكون أكبر من صفر.`;
  } else if (r.type === "BUNDLE_PRICE") {
    if (!posDec(r.bundlePrice)) return `${prefix}سعر الباقة يجب أن يكون أكبر من صفر.`;
    if (r.bundleMode === "PICK_ANY_N" && r.bundleQuantity < 2) {
      return `${prefix}الكمية المطلوبة للباقة يجب ألا تقل عن 2.`;
    }
  } else if (r.type === "BOGO") {
    if (r.bogoBuyQuantity < 1) return `${prefix}كمية الشراء يجب أن تكون 1 على الأقل.`;
    if (r.bogoGetQuantity < 1) return `${prefix}الكمية الممنوحة يجب أن تكون 1 على الأقل.`;
  } else if (r.type === "TIERED_QTY") {
    if (r.tiers.length === 0) return `${prefix}يجب إضافة شريحة كميات واحدة على الأقل.`;
    const seenQuantities = new Set<string>();
    for (let i = 0; i < r.tiers.length; i++) {
      const t = r.tiers[i]!;
      const rowNum = i + 1;
      const minQ = posDec(t.minQuantity);
      if (!minQ) return `${prefix}شريحة الكميات (${rowNum}): الحد الأدنى للكمية يجب أن يكون أكبر من صفر.`;
      const normQ = minQ.toString();
      if (seenQuantities.has(normQ)) {
        return `${prefix}شريحة الكميات (${rowNum}): عتبة الكمية (${t.minQuantity}) مكررة.`;
      }
      seenQuantities.add(normQ);
      if (t.tierType === "PERCENT") {
        const p = posDec(t.discountPercent);
        if (!p || p.gt(100)) return `${prefix}شريحة الكميات (${rowNum}): نسبة الخصم يجب أن تكون بين 1% و100%.`;
      } else if (t.tierType === "AMOUNT" && !posDec(t.discountAmount)) {
        return `${prefix}شريحة الكميات (${rowNum}): مبلغ الخصم الثابت يجب أن يكون أكبر من صفر.`;
      } else if (t.tierType === "FIXED_PRICE" && !posDec(t.fixedPrice)) {
        return `${prefix}شريحة الكميات (${rowNum}): السعر الموحد للشريحة يجب أن يكون أكبر من صفر.`;
      }
    }
  }
  return null;
}

export function validateRuleScopeAndMargin(
  ruleVal: OfferRuleDraft,
  scopeHolder: OfferRuleDraft,
  prefix: string
): string | null {
  if (
    ruleVal.type === "BUNDLE_PRICE" &&
    (ruleVal.bundleMode ?? "ALL_REQUIRED") === "ALL_REQUIRED" &&
    scopeHolder.scope === "ALL"
  ) {
    return `${prefix}باقة «شراء كل مواد البكج سوية» تتطلب اختيار أقسام محددة أو مواد محددة لتكوين الباقة، ولا تقبل نطاق «كل بضاعة المحل».`;
  }
  if (scopeHolder.scope === "CATEGORIES" && scopeHolder.selectedCategories.length === 0) {
    return `${prefix}اختر فئة واحدة على الأقل.`;
  }
  if (
    scopeHolder.scope === "CATEGORIES" &&
    scopeHolder.selectedCategories.length > MAX_PROMOTION_TARGETS
  ) {
    return `${prefix}عدد الأقسام المختارة (${scopeHolder.selectedCategories.length}) يتجاوز الحد الأقصى المسموح (${MAX_PROMOTION_TARGETS}).`;
  }
  if (scopeHolder.scope === "PRODUCTS" && scopeHolder.selectedProducts.length === 0) {
    return `${prefix}أضف منتجاً واحداً على الأقل إلى العرض.`;
  }
  if (
    scopeHolder.scope === "PRODUCTS" &&
    scopeHolder.selectedProducts.length > MAX_PROMOTION_TARGETS
  ) {
    return `${prefix}عدد المواد المختارة (${scopeHolder.selectedProducts.length}) يتجاوز الحد الأقصى المسموح للعرض (${MAX_PROMOTION_TARGETS} مادة). قلّل المواد المختارة أو اختر نطاق «أقسام محددة».`;
  }
  if (scopeHolder.scope === "PRODUCTS" && !scopeHolder.allowBelowCost) {
    for (const item of scopeHolder.selectedProducts) {
      if (item.costPrice == null) continue;
      const activeUnit = item.units.find((u) => u.id === item.productUnitId) ?? item.units[0];
      const retailDec = safeDecimal(activeUnit?.retailPrice ?? item.retailPrice);
      const convDec = safeDecimal(activeUnit?.conversionFactor ?? item.conversionFactor, D(1));
      const unitCostDec = safeDecimal(item.costPrice).mul(convDec);
      if (retailDec.lte(0) || unitCostDec.lte(0)) continue;

      const maxCapDec = ruleVal.type === "PERCENT" ? posDec(ruleVal.maxDiscountAmount) : null;
      if (ruleVal.type === "PERCENT" || ruleVal.type === "AMOUNT" || ruleVal.type === "FIXED_PRICE") {
        const rawVal =
          ruleVal.type === "PERCENT"
            ? safeDecimal(ruleVal.discountPercent)
            : ruleVal.type === "AMOUNT"
            ? safeDecimal(ruleVal.discountAmount)
            : safeDecimal(ruleVal.fixedPrice);
        const res = calculateLiveMargin(retailDec, unitCostDec, ruleVal.type, rawVal, maxCapDec);
        if (res.promoPrice.lt(retailDec) && res.isBelowCost) {
          return `${prefix}المادة «${item.productName}» (${activeUnit?.unitName ?? item.unitName}) ينزل سعرها بالعرض أقل من كلفتها. عدّل قيمة الخصم أو فعّل خيار «السماح بالبيع جوا الكلفة (تحت التكلفة)».`;
        }
      } else if (ruleVal.type === "TIERED_QTY") {
        for (const tr of ruleVal.tiers) {
          const tierVal =
            tr.tierType === "PERCENT"
              ? safeDecimal(tr.discountPercent)
              : tr.tierType === "AMOUNT"
              ? safeDecimal(tr.discountAmount)
              : safeDecimal(tr.fixedPrice);
          const res = calculateLiveMargin(retailDec, unitCostDec, tr.tierType, tierVal, maxCapDec);
          if (res.promoPrice.lt(retailDec) && res.isBelowCost) {
            return `${prefix}إحدى كميات الجملة للمادة «${item.productName}» تنزل بسعر البيع أقل من الكلفة. عدّل السعر أو فعّل خيار «السماح بالبيع جوا الكلفة (تحت التكلفة)».`;
          }
        }
      }
    }
  }
  return null;
}

export function buildTargetsForHolder(holder: OfferRuleDraft) {
  if (holder.scope === "ALL") return undefined;
  if (holder.scope === "CATEGORIES") {
    return holder.selectedCategories.map((cid) => ({
      categoryId: cid,
      productId: null,
      variantId: null,
      productUnitId: null,
    }));
  }
  const variantCountsByProduct = new Map<number, number>();
  for (const p of holder.selectedProducts) {
    variantCountsByProduct.set(p.productId, (variantCountsByProduct.get(p.productId) ?? 0) + 1);
  }
  return holder.selectedProducts.map((p) => {
    if ((p.targetGrain === "UNIT" || !p.isBaseUnit) && p.productUnitId) {
      return {
        categoryId: null,
        productId: null,
        variantId: null,
        productUnitId: Number(p.productUnitId),
      };
    }
    if (p.targetGrain === "VARIANT" || (variantCountsByProduct.get(p.productId) ?? 0) > 1) {
      return {
        categoryId: null,
        productId: null,
        variantId: Number(p.variantId),
        productUnitId: null,
      };
    }
    return {
      categoryId: null,
      productId: Number(p.productId),
      variantId: null,
      productUnitId: null,
    };
  });
}

export function sanitizeRuleTiers(r: OfferRuleDraft) {
  return r.type === "TIERED_QTY"
    ? r.tiers.map((t) => ({
        minQuantity: t.minQuantity,
        tierType: t.tierType,
        discountPercent: t.tierType === "PERCENT" ? t.discountPercent : undefined,
        discountAmount: t.tierType === "AMOUNT" ? t.discountAmount : undefined,
        fixedPrice: t.tierType === "FIXED_PRICE" ? t.fixedPrice : undefined,
      }))
    : undefined;
}

export function buildOfferItemFromSearchProduct(
  product: any,
  matchedBarcode?: string
): SelectedOfferItem | null {
  const units = product.units ?? [];
  let selectedUnit = units[0];
  if (matchedBarcode) {
    const normScan = normalizeBarcodeScannerInput(matchedBarcode);
    const barcodeMatch = units.find((u: any) => {
      if (u.barcode && normalizeBarcodeScannerInput(String(u.barcode)) === normScan) return true;
      if (Array.isArray(u.altBarcodes)) {
        return u.altBarcodes.some(
          (alt: string) => normalizeBarcodeScannerInput(String(alt)) === normScan
        );
      }
      return false;
    });
    selectedUnit = barcodeMatch ?? units.find((u: any) => u.isBaseUnit) ?? units[0];
  } else {
    selectedUnit = units.find((u: any) => u.isBaseUnit) ?? units[0];
  }
  if (!selectedUnit) return null;

  return {
    productId: Number(product.productId),
    productName: String(product.productName ?? ""),
    productCode: String(product.productCode ?? product.sku ?? ""),
    variantId: Number(product.variantId),
    sku: String(product.sku ?? ""),
    variantKind: product.variantKind ?? "VARIANT",
    isConsignment: Boolean(product.isConsignment),
    costPrice: product.costPrice ?? null,
    productUnitId: Number(selectedUnit.id),
    unitName: String(selectedUnit.unitName ?? "قطعة"),
    conversionFactor: String(selectedUnit.conversionFactor ?? "1"),
    retailPrice: String(selectedUnit.retailPrice ?? "0"),
    barcode: selectedUnit.barcode ?? null,
    isBaseUnit: Boolean(selectedUnit.isBaseUnit),
    units: units.map((u: any) => ({
      id: Number(u.id),
      unitName: String(u.unitName ?? "قطعة"),
      conversionFactor: String(u.conversionFactor ?? "1"),
      barcode: u.barcode ?? null,
      isBaseUnit: Boolean(u.isBaseUnit),
      retailPrice: String(u.retailPrice ?? "0"),
    })),
  };
}

export interface MultiRuleBasketPreviewOutput extends BasketPreviewOutput {
  winningRuleNamesByLineKey: Record<string, string>;
  freeShippingApplied: boolean;
}

export function simulateMultiRuleBasketPreview(
  items: Array<{
    productId: number;
    variantId?: number;
    productUnitId?: number;
    isBaseUnit?: boolean;
    unitPrice: Decimal | number | string;
    quantity: Decimal | number | string;
  }>,
  rules: Array<SimulateBasketRule & { ruleName?: string }>,
  minOrderSpend?: Decimal,
  offerFreeShippingFlag?: boolean,
  applicationMode: "AUTO" | "COUPON" = "AUTO"
): MultiRuleBasketPreviewOutput {
  const grossTotal = items.reduce(
    (acc, i) => acc.plus(safeDecimal(i.unitPrice).mul(safeDecimal(i.quantity))),
    new Decimal(0)
  );

  if (items.length === 0 || grossTotal.lte(0) || rules.length === 0) {
    return {
      grossTotal,
      discount: new Decimal(0),
      netTotal: grossTotal,
      savingsPercent: new Decimal(0),
      helperNote: null,
      winningRuleNamesByLineKey: {},
      freeShippingApplied: false,
    };
  }

  const minSpend = minOrderSpend ? safeDecimal(minOrderSpend) : undefined;
  if (minSpend && minSpend.gt(0) && grossTotal.lt(minSpend)) {
    return {
      grossTotal,
      discount: new Decimal(0),
      netTotal: grossTotal,
      savingsPercent: new Decimal(0),
      helperNote: `الحد الأدنى للطلب (${minSpend.toFixed(2)} د.ع) غير مستوفى`,
      winningRuleNamesByLineKey: {},
      freeShippingApplied: false,
    };
  }

  const variantOccurrences = new Map<number, number>();
  for (const item of items) {
    const vk = item.variantId ?? item.productId;
    variantOccurrences.set(vk, (variantOccurrences.get(vk) ?? 0) + 1);
  }

  const evalItems = items
    .map((item, idx) => {
      const vk = item.variantId ?? item.productId;
      const lineKey =
        (variantOccurrences.get(vk) ?? 0) > 1
          ? String(item.productUnitId ?? `${vk}:${idx}`)
          : String(vk ?? idx);
      return {
        lineKey,
        productId: item.productId,
        variantId: item.variantId ?? item.productId,
        productUnitId: item.productUnitId ?? item.productId,
        categoryId: null,
        unitPrice: safeDecimal(item.unitPrice),
        quantity: safeDecimal(item.quantity),
        isBaseUnit: item.isBaseUnit ?? true,
        hasContractPrice: false,
        isBundle: false,
        isGift: false,
        isDigitalCard: false,
        isService: false,
      };
    })
    .filter((i) => i.quantity.gt(0));

  if (evalItems.length === 0) {
    return {
      grossTotal,
      discount: new Decimal(0),
      netTotal: grossTotal,
      savingsPercent: new Decimal(0),
      helperNote: null,
      winningRuleNamesByLineKey: {},
      freeShippingApplied: false,
    };
  }

  const engineRules: PromotionRule[] = rules.map((rule, idx) => {
    const bundleMode: BundleMode = rule.bundleMode ?? "ALL_REQUIRED";
    const hasExplicitTargets =
      (rule.targetProductIds?.length ?? 0) > 0 ||
      (rule.targetVariantIds?.length ?? 0) > 0 ||
      (rule.targetUnitIds?.length ?? 0) > 0 ||
      (rule.targetCategoryIds?.length ?? 0) > 0;
    const resolvedTargets = hasExplicitTargets
      ? {
          targetProductIds: Array.from(new Set(rule.targetProductIds ?? [])),
          targetVariantIds: Array.from(new Set(rule.targetVariantIds ?? [])),
          targetUnitIds: Array.from(new Set(rule.targetUnitIds ?? [])),
          targetCategoryIds: Array.from(new Set(rule.targetCategoryIds ?? [])),
        }
      : rule.type === "BUNDLE_PRICE"
        ? { ...deriveSimulatorTargetCollections(items), targetCategoryIds: [] as number[] }
        : null;
    const useCategoryScope =
      resolvedTargets != null &&
      resolvedTargets.targetCategoryIds.length > 0 &&
      resolvedTargets.targetProductIds.length === 0 &&
      resolvedTargets.targetVariantIds.length === 0 &&
      resolvedTargets.targetUnitIds.length === 0;
    return {
      id: idx + 1,
      name: rule.ruleName || `القاعدة ${idx + 1}: ${PROMO_TYPE_LABELS[rule.type]}`,
      type: rule.type,
      freeShipping:
        rule.freeShipping !== undefined
          ? rule.freeShipping || rule.type === "FREE_SHIPPING"
          : Boolean(offerFreeShippingFlag) || rule.type === "FREE_SHIPPING",
      scope: resolvedTargets ? (useCategoryScope ? "CATEGORIES" : "PRODUCTS") : "ALL",
      channel: "ALL",
      applicationMode,
      priority: 10,
      isActive: true,
      allowBelowCost: true,
      applyToBaseUnitOnly: rule.applyToBaseUnitOnly ?? false,
      discountPercent: rule.percent ? safeDecimal(rule.percent) : undefined,
      discountAmount: rule.discountAmount ? safeDecimal(rule.discountAmount) : undefined,
      maxDiscountAmount: rule.maxDiscountAmount ? safeDecimal(rule.maxDiscountAmount) : undefined,
      minOrderSpend: minSpend,
      minLineAmount: rule.minLineAmount ? safeDecimal(rule.minLineAmount) : undefined,
      fixedPrice: rule.fixedPrice ? safeDecimal(rule.fixedPrice) : undefined,
      bundlePrice: rule.bundlePrice ? safeDecimal(rule.bundlePrice) : undefined,
      bundleMode,
      bundleQuantity:
        bundleMode === "PICK_ANY_N" ? Math.max(1, rule.bundleQuantity ?? 2) : undefined,
      bogoBuyQuantity: Math.max(1, rule.bogoBuyQuantity ?? 2),
      bogoGetQuantity: Math.max(1, rule.bogoGetQuantity ?? 1),
      bogoGetDiscountPercent: rule.bogoGetDiscountPercent
        ? safeDecimal(rule.bogoGetDiscountPercent)
        : new Decimal(100),
      tieredMode: rule.tieredMode ?? "PER_ITEM",
      tiers: (rule.tiers ?? [])
        .filter((t) => safeDecimal(t.minQuantity).gt(0))
        .map((t) => ({
          minQuantity: safeDecimal(t.minQuantity),
          tierType: t.tierType,
          discountPercent: t.discountPercent ? safeDecimal(t.discountPercent) : undefined,
          discountAmount: t.discountAmount ? safeDecimal(t.discountAmount) : undefined,
          fixedPrice: t.fixedPrice ? safeDecimal(t.fixedPrice) : undefined,
        })),
      ...(resolvedTargets
        ? {
            ...(resolvedTargets.targetProductIds.length > 0
              ? { targetProductIds: resolvedTargets.targetProductIds }
              : {}),
            ...(resolvedTargets.targetVariantIds.length > 0
              ? { targetVariantIds: resolvedTargets.targetVariantIds }
              : {}),
            ...(resolvedTargets.targetUnitIds.length > 0
              ? { targetUnitIds: resolvedTargets.targetUnitIds }
              : {}),
            ...(resolvedTargets.targetCategoryIds.length > 0
              ? { targetCategoryIds: resolvedTargets.targetCategoryIds }
              : {}),
          }
        : {}),
    };
  });

  const evaluated = evaluateCartPromotions(evalItems, engineRules, {
    branchId: 1,
    customerTier: "RETAIL",
    channel: "POS",
    todayYmd: "2026-06-15",
  });

  const winningRuleNamesByLineKey: Record<string, string> = {};
  evaluated.lineAllocations.forEach((alloc, lineKey) => {
    if (alloc.promotionName && alloc.discountAmount.gt(0)) {
      winningRuleNamesByLineKey[lineKey] = alloc.promotionName;
    }
  });

  const discount = Decimal.min(evaluated.totalCartDiscount, grossTotal).toDecimalPlaces(
    2,
    Decimal.ROUND_HALF_UP
  );
  const netTotal = grossTotal.minus(discount);
  const savingsPercent = grossTotal.gt(0)
    ? discount.div(grossTotal).mul(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
    : new Decimal(0);

  let helperNote: string | null = null;
  if (discount.eq(0) && rules.length === 1) {
    const r0 = rules[0]!;
    const bMode = r0.bundleMode ?? "ALL_REQUIRED";
    if (r0.type === "BUNDLE_PRICE" && bMode === "ALL_REQUIRED") {
      helperNote =
        "باقة (كل المواد مطلوبة): يجب توفر كمية 1 على الأقل من جميع أصناف الباقة لتفعيل السعر الموحد.";
    } else if (r0.type === "BUNDLE_PRICE" && bMode === "PICK_ANY_N") {
      const reqQty = Math.max(1, r0.bundleQuantity ?? 2);
      helperNote = `باقة (اختر أي ${reqQty}): أضف كميات حتى تصل إلى ${reqQty} وحدات لتفعيل سعر الباقة.`;
    } else if (r0.type === "TIERED_QTY" && (r0.tiers?.length ?? 0) > 0) {
      helperNote = "لم تصل الكميات في السلة بعد إلى عتبة التفعيل الدنيا لشرائح الكميات.";
    }
  }

  return {
    grossTotal,
    discount,
    netTotal,
    savingsPercent,
    helperNote,
    winningRuleNamesByLineKey,
    freeShippingApplied: Boolean(evaluated.freeShippingPromotion),
  };
}
