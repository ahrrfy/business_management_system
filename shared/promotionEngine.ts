/**
 * shared/promotionEngine.ts
 *
 * Deterministic Promotional Pricing Core Engine
 * Shared 100% identically between Server (salesPromotionService, sale/create)
 * and Client (Offers, POS, Reception, SalesInvoice).
 *
 * Uses decimal.js exclusively with zero IEEE-754 floating-point drift.
 * Zero Node-only dependencies.
 */

import Decimal from "decimal.js";
import {
  isPromotionActiveOnDay,
  isPromotionChannelActive,
  type PromotionChannel,
  type EvaluationChannel,
} from "./promotionScheduling";

// Ensure global precision and rounding policy
Decimal.set({ rounding: Decimal.ROUND_HALF_UP, precision: 40 });

export { isPromotionChannelActive };
export type { PromotionChannel, EvaluationChannel };

export type DecimalInput = Decimal | number | string;

// ---------------------------------------------------------------------------
// Domain Interfaces
// ---------------------------------------------------------------------------

export interface EvaluationItem {
  lineKey: string;
  productId: number;
  productName?: string;
  variantId: number;
  categoryId?: number | null;
  productUnitId?: number | null;
  unitName?: string;
  isBaseUnit: boolean;
  conversionFactor?: DecimalInput;
  unitPrice: DecimalInput;
  costPrice?: DecimalInput;
  quantity: DecimalInput;
  barcode?: string;
  isBundle?: boolean;
  isConsignment?: boolean;
  hasContractPrice?: boolean;
  isDigitalCard?: boolean;
  isGift?: boolean;
  isService?: boolean;
}

export type CartLineItem = EvaluationItem;
export type CartEvalItem = EvaluationItem;

export interface PromotionTierRule {
  minQuantity: DecimalInput;
  tierType: "PERCENT" | "AMOUNT" | "FIXED_PRICE";
  discountPercent?: DecimalInput | null;
  discountAmount?: DecimalInput | null;
  fixedPrice?: DecimalInput | null;
}

export type TierRule = PromotionTierRule;

export interface PromotionRule {
  id: number;
  name: string;
  type: "PERCENT" | "AMOUNT" | "FIXED_PRICE" | "BUNDLE_PRICE" | "BOGO" | "TIERED_QTY" | "FREE_SHIPPING";
  scope?: "ALL" | "CATEGORIES" | "PRODUCTS";
  channel: PromotionChannel | "POS" | "STORE";
  applicationMode?: "AUTO" | "COUPON" | string | null;
  branchId?: number | null;
  customerTier?: string | null;
  allowBelowCost?: boolean;
  applyToBaseUnitOnly?: boolean;
  freeShipping?: boolean | null;
  activeDays?: readonly number[] | null;
  effectiveFrom?: string | null; // YYYY-MM-DD
  effectiveTo?: string | null; // YYYY-MM-DD
  priority?: number;
  isActive?: boolean;

  discountPercent?: DecimalInput | null;
  discountAmount?: DecimalInput | null;
  fixedPrice?: DecimalInput | null;
  bundlePrice?: DecimalInput | null;
  bundleMode?: "ALL_REQUIRED" | "PICK_ANY_N" | null;
  bundleQuantity?: number | null;
  bogoBuyQuantity?: number | null;
  bogoGetQuantity?: number | null;
  bogoGetDiscountPercent?: DecimalInput | null;
  tieredMode?: "PER_ITEM" | "POOL_ACROSS_TARGETS" | null;
  tiers?: PromotionTierRule[];

  minOrderSpend?: DecimalInput | null;
  minLineAmount?: DecimalInput | null;
  maxDiscountAmount?: DecimalInput | null;

  targetProductIds?: Set<number> | readonly number[];
  targetVariantIds?: Set<number> | readonly number[];
  targetCategoryIds?: Set<number> | readonly number[];
  targetUnitIds?: Set<number> | readonly number[];
}

export type PromotionType = PromotionRule["type"];

export interface EvaluationContext {
  channel: EvaluationChannel;
  todayYmd: string; // YYYY-MM-DD
  customerTier?: string | null;
  branchId?: number | null;
}

export interface LineAllocationResult {
  lineKey: string;
  promotionId: number;
  promotionName: string;
  discountAmount: Decimal;
  effectiveUnitPrice: Decimal;
}

export type LineAllocation = LineAllocationResult;

export interface CartEvaluationOutput {
  lineAllocations: Map<string, LineAllocationResult>;
  totalCartDiscount: Decimal;
  appliedPromotionIds: Set<number>;
  freeShippingPromotion?: {
    promotionId: number;
    promotionName: string;
  } | null;
}

export type EvaluationResult = CartEvaluationOutput;

// ---------------------------------------------------------------------------
// Helper: Normalizing target collections
// ---------------------------------------------------------------------------

function toSet(val?: Set<number> | readonly number[] | null): Set<number> {
  if (!val) return new Set<number>();
  if (val instanceof Set) return val;
  return new Set<number>(val);
}

// ---------------------------------------------------------------------------
// Core Functions
// ---------------------------------------------------------------------------

/**
 * 1. Proportional Allocation by Value down to 0.01 fils.
 * Overloaded for flexible argument ordering (lines, savings) or (savings, lines).
 * Remainder fils are added to the line with the largest gross amount to preserve exact sum.
 * NEVER sets isGift = true.
 */
export function allocateByValue(
  lines: Array<{ lineKey: string; lineGross: DecimalInput }>,
  totalSavings: DecimalInput
): Map<string, Decimal>;
export function allocateByValue(
  totalSavings: DecimalInput,
  lines: Array<{ lineKey: string; lineGross: DecimalInput }>
): Map<string, Decimal>;
export function allocateByValue(arg1: any, arg2: any): Map<string, Decimal> {
  const isArg1Array = Array.isArray(arg1);
  const rawLines: Array<{ lineKey: string; lineGross: DecimalInput }> = isArg1Array ? arg1 : arg2;
  const savingsRaw: DecimalInput = isArg1Array ? arg2 : arg1;
  const totalSavings = new Decimal(savingsRaw ?? 0);

  const allocations = new Map<string, Decimal>();
  if (!rawLines || rawLines.length === 0 || totalSavings.lte(0)) {
    return allocations;
  }

  const lines = rawLines.map((l) => ({
    lineKey: l.lineKey,
    lineGross: new Decimal(l.lineGross ?? 0),
  }));

  const totalGross = lines.reduce((acc, l) => acc.plus(l.lineGross), new Decimal(0));
  if (totalGross.lte(0)) {
    return allocations;
  }

  // Savings capped at total gross, rounded to 2 decimal places
  const cappedSavings = Decimal.min(totalSavings, totalGross).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  if (cappedSavings.lte(0)) {
    return allocations;
  }

  // Step a: Compute floor shares (ROUND_DOWN) and fractional remainders
  let allocatedSum = new Decimal(0);
  const lineDetails = lines.map((line, index) => {
    const rawShare = cappedSavings.mul(line.lineGross).div(totalGross);
    const initialShare = rawShare.toDecimalPlaces(2, Decimal.ROUND_DOWN);
    const fractionalRemainder = rawShare.minus(initialShare);
    allocatedSum = allocatedSum.plus(initialShare);
    return {
      lineKey: line.lineKey,
      lineGross: line.lineGross,
      rawShare,
      initialShare,
      fractionalRemainder,
      finalShare: initialShare,
      index,
    };
  });

  // Step b: Compute non-negative remainder cents
  let remainderCents = Math.round(cappedSavings.minus(allocatedSum).mul(100).toNumber());

  // Step c: Distribute 0.01 cents to lines with largest fractional remainders (Hare-Niemeyer)
  if (remainderCents > 0) {
    const sortedDetails = [...lineDetails].sort((a, b) => {
      if (!b.fractionalRemainder.equals(a.fractionalRemainder)) {
        return b.fractionalRemainder.minus(a.fractionalRemainder).toNumber();
      }
      if (!b.lineGross.equals(a.lineGross)) {
        return b.lineGross.minus(a.lineGross).toNumber();
      }
      return a.index - b.index;
    });

    const oneCent = new Decimal("0.01");
    let idx = 0;
    let passes = 0;
    while (remainderCents > 0 && passes < 2) {
      const target = sortedDetails[idx];
      if (target.finalShare.plus(oneCent).lte(target.lineGross)) {
        target.finalShare = target.finalShare.plus(oneCent);
        remainderCents--;
      }
      idx++;
      if (idx >= sortedDetails.length) {
        idx = 0;
        passes++;
      }
    }
  }

  for (const item of lineDetails) {
    allocations.set(item.lineKey, item.finalShare);
  }

  return allocations;
}

/**
 * 2. Fixed Price Ceiling Invariant:
 * If originalUnitPrice <= fixedPrice: discount = 0, effective = originalUnitPrice (price NEVER increases).
 * If originalUnitPrice > fixedPrice: discount = originalUnitPrice - fixedPrice, effective = fixedPrice.
 */
export function applyFixedPriceCeiling(
  originalUnitPrice: DecimalInput,
  fixedPrice: DecimalInput
): { discountPerUnit: Decimal; effectiveUnitPrice: Decimal } {
  const orig = new Decimal(originalUnitPrice ?? 0);
  const fixed = new Decimal(fixedPrice ?? 0);
  if (orig.lte(fixed)) {
    return {
      discountPerUnit: new Decimal(0),
      effectiveUnitPrice: orig,
    };
  }
  return {
    discountPerUnit: orig.minus(fixed),
    effectiveUnitPrice: fixed,
  };
}

/**
 * 3. Packaging Base Unit Guard:
 * If rule has explicit targetUnitIds: only those unit IDs match.
 * If rule has applyToBaseUnitOnly = true: only base units (isBaseUnit = true) match.
 * Otherwise, derived units match.
 */
export function applyBaseUnitGuard(
  item: { isBaseUnit: boolean; productUnitId?: number | null },
  rule: { applyToBaseUnitOnly?: boolean; targetUnitIds?: Set<number> | readonly number[] }
): boolean {
  const targetUnitSet = toSet(rule.targetUnitIds);
  if (item.productUnitId != null && targetUnitSet.has(item.productUnitId)) {
    return true;
  }
  if (rule.applyToBaseUnitOnly) {
    return item.isBaseUnit === true;
  }
  return true;
}

/**
 * 4. Contract Price Protection:
 * Items flagged with hasContractPrice = true are strictly exempt from all promotional discounts.
 */
export function protectContractPrice(item: { hasContractPrice?: boolean }): boolean {
  return item.hasContractPrice === true;
}

/**
 * Checks whether a promotion rule is applicable to a specific cart line item.
 */
export function isPromotionApplicableToItem(
  item: EvaluationItem,
  rule: PromotionRule
): boolean {
  if (item.isDigitalCard || item.isGift || item.isService) return false;
  if (protectContractPrice(item)) return false;
  if (!applyBaseUnitGuard(item, rule)) return false;

  const targetProdSet = toSet(rule.targetProductIds);
  const targetVarSet = toSet(rule.targetVariantIds);
  const targetCatSet = toSet(rule.targetCategoryIds);
  const targetUnitSet = toSet(rule.targetUnitIds);

  const hasTargets =
    targetProdSet.size > 0 ||
    targetVarSet.size > 0 ||
    targetCatSet.size > 0 ||
    targetUnitSet.size > 0;

  if (rule.scope === "ALL") {
    // Pre-packaged bundles (products.isBundle = true) are excluded from store-wide "ALL" offers to prevent double discounting.
    if (item.isBundle === true) return false;
    return true;
  }

  if (rule.scope === "CATEGORIES" || rule.scope === "PRODUCTS") {
    if (!hasTargets) return false;
  } else if (!hasTargets) {
    // Store-wide promotion (when scope is omitted) — still exclude pre-packaged bundles.
    if (item.isBundle === true) return false;
    return true;
  }

  const matchesProd = targetProdSet.has(item.productId);
  const matchesVar = targetVarSet.has(item.variantId);
  const matchesCat = item.categoryId != null && targetCatSet.has(item.categoryId);
  const matchesUnit = item.productUnitId != null && targetUnitSet.has(item.productUnitId);

  return matchesProd || matchesVar || matchesCat || matchesUnit;
}

type NormalizedEvaluationItem = Omit<EvaluationItem, "unitPrice" | "quantity"> & {
  unitPrice: Decimal;
  quantity: Decimal;
};

/**
 * Pure helper evaluating a single rule across already-filtered qualifying lines.
 * Returns per-line discounts (sum strictly conserved via Decimal / allocateByValue).
 */
function evaluateSingleRuleDiscounts(
  matchingLines: readonly NormalizedEvaluationItem[],
  rule: PromotionRule
): Map<string, Decimal> {
  const result = new Map<string, Decimal>();
  if (matchingLines.length === 0) return result;

  const filterByMinLine = (lines: readonly NormalizedEvaluationItem[]) => {
    if (!rule.minLineAmount) return lines;
    const minLine = new Decimal(rule.minLineAmount);
    if (minLine.lte(0)) return lines;
    return lines.filter((l) => l.quantity.mul(l.unitPrice).gte(minLine));
  };

  switch (rule.type) {
    case "PERCENT": {
      const percent = new Decimal(rule.discountPercent ?? 0);
      if (percent.lte(0)) break;

      const perUnitCap =
        rule.applicationMode !== "COUPON" &&
        rule.maxDiscountAmount != null &&
        rule.maxDiscountAmount !== ""
          ? new Decimal(rule.maxDiscountAmount).toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
          : null;
      const hasPerUnitCap = perUnitCap != null && perUnitCap.gt(0);

      for (const line of filterByMinLine(matchingLines)) {
        const lineGross = line.quantity.mul(line.unitPrice);
        if (lineGross.lte(0)) continue;

        let rawDiscount: Decimal;
        if (hasPerUnitCap) {
          const unitRaw = line.unitPrice
            .mul(percent)
            .div(100)
            .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
          const unitDisc = Decimal.min(unitRaw, perUnitCap);
          rawDiscount = unitDisc.mul(line.quantity);
        } else {
          rawDiscount = lineGross.mul(percent).div(100);
        }

        const lineDiscount = Decimal.min(rawDiscount, lineGross).toDecimalPlaces(
          2,
          Decimal.ROUND_HALF_UP
        );
        if (lineDiscount.gt(0)) {
          result.set(line.lineKey, lineDiscount);
        }
      }
      break;
    }

    case "AMOUNT": {
      const amountPerUnit = new Decimal(rule.discountAmount ?? 0);
      if (amountPerUnit.lte(0)) break;

      for (const line of filterByMinLine(matchingLines)) {
        const lineGross = line.quantity.mul(line.unitPrice);
        if (lineGross.lte(0)) continue;

        const rawDiscount = line.quantity.mul(amountPerUnit);
        const lineDiscount = Decimal.min(rawDiscount, lineGross).toDecimalPlaces(
          2,
          Decimal.ROUND_HALF_UP
        );
        if (lineDiscount.gt(0)) {
          result.set(line.lineKey, lineDiscount);
        }
      }
      break;
    }

    case "FIXED_PRICE": {
      const fixed = new Decimal(rule.fixedPrice ?? 0);
      if (fixed.lte(0)) break;

      for (const line of filterByMinLine(matchingLines)) {
        if (line.unitPrice.lte(fixed)) continue;
        const lineGross = line.quantity.mul(line.unitPrice);
        if (lineGross.lte(0)) continue;

        const unitDiscount = line.unitPrice.minus(fixed);
        const lineDiscount = Decimal.min(
          unitDiscount.mul(line.quantity),
          lineGross
        ).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
        if (lineDiscount.gt(0)) {
          result.set(line.lineKey, lineDiscount);
        }
      }
      break;
    }

    case "BUNDLE_PRICE": {
      const bundlePrice = new Decimal(rule.bundlePrice ?? 0);
      if (bundlePrice.lte(0)) break;
      const eligibleLines = filterByMinLine(matchingLines);
      if (eligibleLines.length === 0) break;

      if (rule.bundleMode === "ALL_REQUIRED") {
        const reqUnits = Array.from(toSet(rule.targetUnitIds));
        const reqVariants = Array.from(toSet(rule.targetVariantIds));
        const reqProducts = Array.from(toSet(rule.targetProductIds));
        const reqCategories = Array.from(toSet(rule.targetCategoryIds));

        type TargetKey = { kind: "UNIT" | "VARIANT" | "PRODUCT" | "CATEGORY"; id: number };
        // Ordered from most specific to least specific so narrower slots claim matching
        // physical units before broader product/category slots, preventing both starvation
        // and double-counting of a single physical unit across overlapping targets.
        const requiredKeys: TargetKey[] = [
          ...reqUnits.map((id) => ({ kind: "UNIT" as const, id })),
          ...reqVariants.map((id) => ({ kind: "VARIANT" as const, id })),
          ...reqProducts.map((id) => ({ kind: "PRODUCT" as const, id })),
          ...reqCategories.map((id) => ({ kind: "CATEGORY" as const, id })),
        ];

        if (requiredKeys.length === 0) break;

        type LineBucket = {
          origIdx: number;
          lineKey: string;
          unitPrice: Decimal;
          productId: number;
          variantId: number;
          productUnitId?: number | null;
          categoryId?: number | null;
          remainingQty: number;
        };
        const buckets: LineBucket[] = [];
        let totalUnits = 0;
        for (let origIdx = 0; origIdx < eligibleLines.length; origIdx++) {
          const l = eligibleLines[origIdx]!;
          const wholeQty = Math.floor(l.quantity.toNumber());
          if (wholeQty <= 0) continue;
          totalUnits += wholeQty;
          buckets.push({
            origIdx,
            lineKey: l.lineKey,
            unitPrice: l.unitPrice,
            productId: l.productId,
            variantId: l.variantId,
            productUnitId: l.productUnitId,
            categoryId: l.categoryId,
            remainingQty: wholeQty,
          });
        }
        if (totalUnits < requiredKeys.length) break;

        // Sort descending so highest-value eligible units form qualifying bundles first
        buckets.sort((a, b) => {
          const cmp = b.unitPrice.comparedTo(a.unitPrice);
          return cmp !== 0 ? cmp : a.origIdx - b.origIdx;
        });

        const matchesKey = (b: LineBucket, rk: TargetKey): boolean => {
          switch (rk.kind) {
            case "UNIT":
              return b.productUnitId != null && b.productUnitId === rk.id;
            case "VARIANT":
              return b.variantId === rk.id;
            case "PRODUCT":
              return b.productId === rk.id;
            case "CATEGORY":
              return b.categoryId != null && b.categoryId === rk.id;
          }
        };

        const matchingBucketsBySlot: number[][] = [];
        let impossibleSlot = false;
        for (const rk of requiredKeys) {
          const indices: number[] = [];
          for (let bIdx = 0; bIdx < buckets.length; bIdx++) {
            if (matchesKey(buckets[bIdx]!, rk)) indices.push(bIdx);
          }
          if (indices.length === 0) {
            impossibleSlot = true;
            break;
          }
          matchingBucketsBySlot.push(indices);
        }
        if (impossibleSlot) break;

        const slotCursors = new Array<number>(requiredKeys.length).fill(0);
        const bundledGrossByLine = new Map<string, Decimal>();
        let totalBundleSavings = new Decimal(0);

        while (true) {
          const tentativeUsage = new Map<number, number>();
          let complete = true;

          for (let s = 0; s < requiredKeys.length; s++) {
            const matches = matchingBucketsBySlot[s]!;
            while (
              slotCursors[s]! < matches.length &&
              buckets[matches[slotCursors[s]!]!]!.remainingQty <= 0
            ) {
              slotCursors[s]! += 1;
            }

            let chosenBucketIdx = -1;
            for (let c = slotCursors[s]!; c < matches.length; c++) {
              const bIdx = matches[c]!;
              const avail =
                buckets[bIdx]!.remainingQty - (tentativeUsage.get(bIdx) ?? 0);
              if (avail > 0) {
                chosenBucketIdx = bIdx;
                break;
              }
            }

            if (chosenBucketIdx < 0) {
              complete = false;
              break;
            }
            tentativeUsage.set(
              chosenBucketIdx,
              (tentativeUsage.get(chosenBucketIdx) ?? 0) + 1
            );
          }

          if (!complete) break;

          let batchCount = Infinity;
          let setOriginal = new Decimal(0);
          for (const [bIdx, usedCount] of Array.from(tentativeUsage.entries())) {
            const bucket = buckets[bIdx]!;
            const maxRepeats = Math.floor(bucket.remainingQty / usedCount);
            if (maxRepeats < batchCount) batchCount = maxRepeats;
            setOriginal = setOriginal.plus(bucket.unitPrice.mul(usedCount));
          }
          if (!Number.isFinite(batchCount) || batchCount <= 0) break;

          for (const [bIdx, usedCount] of Array.from(tentativeUsage.entries())) {
            buckets[bIdx]!.remainingQty -= batchCount * usedCount;
          }

          // Per-set ceiling: never surcharge a cheaper set to reduce another set's discount
          if (setOriginal.gt(bundlePrice)) {
            totalBundleSavings = totalBundleSavings.plus(
              setOriginal.minus(bundlePrice).mul(batchCount)
            );
            for (const [bIdx, usedCount] of Array.from(tentativeUsage.entries())) {
              const bucket = buckets[bIdx]!;
              bundledGrossByLine.set(
                bucket.lineKey,
                (bundledGrossByLine.get(bucket.lineKey) ?? new Decimal(0)).plus(
                  bucket.unitPrice.mul(usedCount * batchCount)
                )
              );
            }
          }
        }

        if (totalBundleSavings.gt(0)) {
          const linesForAllocation = Array.from(bundledGrossByLine.entries()).map(
            ([lineKey, lineGross]) => ({ lineKey, lineGross })
          );
          const allocated = allocateByValue(linesForAllocation, totalBundleSavings);
          for (const [lineKey, disc] of Array.from(allocated.entries())) {
            if (disc.gt(0)) result.set(lineKey, disc);
          }
        }
      } else {
        // PICK_ANY_N: form floor(totalUnits / bundleQty) complete bundles only; excess units stay unbundled.
        const bundleQty = Math.max(1, Math.floor(rule.bundleQuantity ?? 1));
        const buckets: Array<{
          origIdx: number;
          lineKey: string;
          unitPrice: Decimal;
          remainingQty: number;
        }> = [];
        let totalUnits = 0;
        for (let origIdx = 0; origIdx < eligibleLines.length; origIdx++) {
          const line = eligibleLines[origIdx]!;
          const wholeQty = Math.floor(line.quantity.toNumber());
          if (wholeQty <= 0) continue;
          totalUnits += wholeQty;
          buckets.push({
            origIdx,
            lineKey: line.lineKey,
            unitPrice: line.unitPrice,
            remainingQty: wholeQty,
          });
        }

        if (totalUnits >= bundleQty) {
          // Sort descending so highest-value eligible units form bundles first (adding a cheap item never penalizes customer)
          buckets.sort((a, b) => {
            const cmp = b.unitPrice.comparedTo(a.unitPrice);
            return cmp !== 0 ? cmp : a.origIdx - b.origIdx;
          });

          let numBundlesLeft = Math.floor(totalUnits / bundleQty);
          let cursor = 0;
          const bundledGrossByLine = new Map<string, Decimal>();
          let totalBundleSavings = new Decimal(0);

          while (numBundlesLeft > 0) {
            while (cursor < buckets.length && buckets[cursor]!.remainingQty <= 0) {
              cursor += 1;
            }
            if (cursor >= buckets.length) break;

            const head = buckets[cursor]!;
            if (head.remainingQty >= bundleQty) {
              const fullFromHead = Math.min(
                numBundlesLeft,
                Math.floor(head.remainingQty / bundleQty)
              );
              const chunkOriginal = head.unitPrice.mul(bundleQty);
              // Per-set ceiling: skip any chunk whose original sum <= bundlePrice
              if (chunkOriginal.gt(bundlePrice)) {
                totalBundleSavings = totalBundleSavings.plus(
                  chunkOriginal.minus(bundlePrice).mul(fullFromHead)
                );
                bundledGrossByLine.set(
                  head.lineKey,
                  (bundledGrossByLine.get(head.lineKey) ?? new Decimal(0)).plus(
                    chunkOriginal.mul(fullFromHead)
                  )
                );
              }
              head.remainingQty -= fullFromHead * bundleQty;
              numBundlesLeft -= fullFromHead;
            } else {
              let need = bundleQty;
              let chunkOriginal = new Decimal(0);
              const chunkContribs: Array<{ lineKey: string; gross: Decimal }> = [];
              while (need > 0 && cursor < buckets.length) {
                const cur = buckets[cursor]!;
                if (cur.remainingQty <= 0) {
                  cursor += 1;
                  continue;
                }
                const take = Math.min(need, cur.remainingQty);
                const contribGross = cur.unitPrice.mul(take);
                chunkOriginal = chunkOriginal.plus(contribGross);
                chunkContribs.push({ lineKey: cur.lineKey, gross: contribGross });
                cur.remainingQty -= take;
                need -= take;
                if (cur.remainingQty <= 0) cursor += 1;
              }
              if (need === 0 && chunkOriginal.gt(bundlePrice)) {
                totalBundleSavings = totalBundleSavings.plus(
                  chunkOriginal.minus(bundlePrice)
                );
                for (const c of chunkContribs) {
                  bundledGrossByLine.set(
                    c.lineKey,
                    (bundledGrossByLine.get(c.lineKey) ?? new Decimal(0)).plus(c.gross)
                  );
                }
              }
              numBundlesLeft -= 1;
            }
          }

          if (totalBundleSavings.gt(0)) {
            const linesForAlloc = Array.from(bundledGrossByLine.entries()).map(
              ([lineKey, lineGross]) => ({ lineKey, lineGross })
            );
            const allocated = allocateByValue(linesForAlloc, totalBundleSavings);
            for (const [lineKey, disc] of Array.from(allocated.entries())) {
              if (disc.gt(0)) result.set(lineKey, disc);
            }
          }
        }
      }
      break;
    }

    case "BOGO": {
      const buyQty = Math.max(1, Math.floor(rule.bogoBuyQuantity ?? 1));
      const getQty = Math.max(1, Math.floor(rule.bogoGetQuantity ?? 1));
      const groupSize = buyQty + getQty;
      const getDiscountPercent = new Decimal(rule.bogoGetDiscountPercent ?? 100);
      if (getDiscountPercent.lte(0)) break;

      const eligibleLines = filterByMinLine(matchingLines);
      const buckets: Array<{
        origIdx: number;
        lineKey: string;
        unitPrice: Decimal;
        qty: number;
      }> = [];
      let totalUnits = 0;
      for (let origIdx = 0; origIdx < eligibleLines.length; origIdx++) {
        const line = eligibleLines[origIdx]!;
        const qty = Math.floor(line.quantity.toNumber());
        if (qty <= 0) continue;
        totalUnits += qty;
        buckets.push({ origIdx, lineKey: line.lineKey, unitPrice: line.unitPrice, qty });
      }

      if (totalUnits >= groupSize) {
        buckets.sort((a, b) => {
          const cmp = a.unitPrice.comparedTo(b.unitPrice);
          return cmp !== 0 ? cmp : a.origIdx - b.origIdx;
        });
        const numSets = Math.floor(totalUnits / groupSize);
        let remFreeItems = numSets * getQty;
        let bogoSavings = new Decimal(0);

        for (const b of buckets) {
          if (remFreeItems <= 0) break;
          const take = Math.min(remFreeItems, b.qty);
          bogoSavings = bogoSavings.plus(
            b.unitPrice.mul(getDiscountPercent).div(100).mul(take)
          );
          remFreeItems -= take;
        }

        if (rule.maxDiscountAmount != null && rule.maxDiscountAmount !== "") {
          const cap = new Decimal(rule.maxDiscountAmount);
          if (cap.gt(0) && bogoSavings.gt(cap)) bogoSavings = cap;
        }

        if (bogoSavings.gt(0)) {
          const linesForAlloc = eligibleLines.map((l) => ({
            lineKey: l.lineKey,
            lineGross: l.quantity.mul(l.unitPrice),
          }));
          const allocated = allocateByValue(linesForAlloc, bogoSavings);
          for (const [lineKey, disc] of Array.from(allocated.entries())) {
            if (disc.gt(0)) result.set(lineKey, disc);
          }
        }
      }
      break;
    }

    case "TIERED_QTY": {
      const tiers = [...(rule.tiers ?? [])].sort((a, b) =>
        new Decimal(b.minQuantity).minus(new Decimal(a.minQuantity)).toNumber()
      );
      if (tiers.length === 0) break;
      const eligibleLines = filterByMinLine(matchingLines);
      if (eligibleLines.length === 0) break;

      const applyTierToLine = (
        line: NormalizedEvaluationItem,
        matchingTier: PromotionTierRule
      ) => {
        let lineDiscount = new Decimal(0);
        const lineGross = line.quantity.mul(line.unitPrice);
        if (lineGross.lte(0)) return;

        if (matchingTier.tierType === "PERCENT") {
          const pct = new Decimal(matchingTier.discountPercent ?? 0);
          lineDiscount = lineGross.mul(pct).div(100);
        } else if (matchingTier.tierType === "AMOUNT") {
          const amt = new Decimal(matchingTier.discountAmount ?? 0);
          lineDiscount = line.quantity.mul(amt);
        } else if (matchingTier.tierType === "FIXED_PRICE") {
          const fixed = new Decimal(matchingTier.fixedPrice ?? 0);
          if (fixed.gt(0) && line.unitPrice.gt(fixed)) {
            lineDiscount = line.unitPrice.minus(fixed).mul(line.quantity);
          }
        }

        lineDiscount = Decimal.min(lineDiscount, lineGross).toDecimalPlaces(
          2,
          Decimal.ROUND_HALF_UP
        );
        if (lineDiscount.gt(0)) {
          result.set(line.lineKey, lineDiscount);
        }
      };

      if (rule.tieredMode === "POOL_ACROSS_TARGETS") {
        const totalPoolQty = eligibleLines.reduce((acc, l) => acc.plus(l.quantity), new Decimal(0));
        const matchingTier = tiers.find((t) => totalPoolQty.gte(new Decimal(t.minQuantity)));
        if (matchingTier) {
          for (const line of eligibleLines) {
            applyTierToLine(line, matchingTier);
          }
        }
      } else {
        for (const line of eligibleLines) {
          const matchingTier = tiers.find((t) => line.quantity.gte(new Decimal(t.minQuantity)));
          if (matchingTier) {
            applyTierToLine(line, matchingTier);
          }
        }
      }
      break;
    }
  }

  const usesPerUnitPercentCap =
    rule.type === "PERCENT" && rule.applicationMode !== "COUPON";
  if (
    !usesPerUnitPercentCap &&
    rule.maxDiscountAmount != null &&
    rule.maxDiscountAmount !== "" &&
    result.size > 0
  ) {
    const cap = new Decimal(rule.maxDiscountAmount).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    if (cap.gt(0)) {
      let totalUncapped = new Decimal(0);
      const entries: Array<{ lineKey: string; lineGross: Decimal }> = [];
      for (const [lineKey, disc] of Array.from(result.entries())) {
        if (disc.gt(0)) {
          totalUncapped = totalUncapped.plus(disc);
          entries.push({ lineKey, lineGross: disc });
        }
      }
      if (totalUncapped.gt(cap) && entries.length > 0) {
        const prorated = allocateByValue(cap, entries);
        result.clear();
        for (const [lineKey, disc] of Array.from(prorated.entries())) {
          if (disc.gt(0)) result.set(lineKey, disc);
        }
      }
    }
  }

  return result;
}

/**
 * Calculates theoretical promotional line savings for an item under a single-item rule.
 */
export function calculateLinePromotionSavings(
  item: EvaluationItem,
  rule: PromotionRule
): Decimal {
  if (!isPromotionApplicableToItem(item, rule)) return new Decimal(0);

  const normalized: NormalizedEvaluationItem = {
    ...item,
    unitPrice: new Decimal(item.unitPrice ?? 0),
    quantity: new Decimal(item.quantity ?? 0),
  };
  if (normalized.quantity.mul(normalized.unitPrice).lte(0)) return new Decimal(0);

  if (
    rule.type === "PERCENT" ||
    rule.type === "AMOUNT" ||
    rule.type === "FIXED_PRICE" ||
    rule.type === "TIERED_QTY"
  ) {
    const map = evaluateSingleRuleDiscounts([normalized], rule);
    return map.get(item.lineKey) ?? new Decimal(0);
  }
  return new Decimal(0);
}

/**
 * 4b. Deterministic Priority & Stacking Resolution.
 * Sorts promotions by: priority DESC, actual cart savings DESC (across all 6 types), id ASC.
 */
export function resolvePriorityAndStacking(
  rules: readonly PromotionRule[],
  cartItems: readonly EvaluationItem[] = []
): PromotionRule[] {
  const savingsMap = new Map<number, Decimal>();
  if (cartItems.length > 0) {
    const normalizedItems: NormalizedEvaluationItem[] = cartItems
      .filter((i) => !i.isDigitalCard)
      .map((item) => ({
        ...item,
        unitPrice: new Decimal(item.unitPrice ?? 0),
        quantity: new Decimal(item.quantity ?? 0),
      }));
    const cartGross = normalizedItems.reduce(
      (acc, i) => acc.plus(i.quantity.mul(i.unitPrice)),
      new Decimal(0)
    );

    for (const rule of rules) {
      if (rule.minOrderSpend && cartGross.lt(new Decimal(rule.minOrderSpend))) {
        savingsMap.set(rule.id, new Decimal(0));
        continue;
      }
      const matching = normalizedItems.filter((item) => isPromotionApplicableToItem(item, rule));
      const discMap = evaluateSingleRuleDiscounts(matching, rule);
      let sum = new Decimal(0);
      for (const val of Array.from(discMap.values())) {
        sum = sum.plus(val);
      }
      savingsMap.set(rule.id, sum);
    }
  }

  return [...rules].sort((a, b) => {
    const pa = a.priority ?? 0;
    const pb = b.priority ?? 0;
    if (pb !== pa) return pb - pa;

    const sa = savingsMap.get(a.id) ?? new Decimal(0);
    const sb = savingsMap.get(b.id) ?? new Decimal(0);
    if (!sb.equals(sa)) {
      return sb.minus(sa).toNumber();
    }

    return a.id - b.id;
  });
}

/**
 * 5. Deterministic Cart Promotion Evaluator across all 6 promotion types.
 * Pure TypeScript, zero float math, zero MySQL dependency.
 */
export function evaluateCartPromotions(
  cartItems: readonly EvaluationItem[],
  rules: readonly PromotionRule[],
  context: EvaluationContext
): CartEvaluationOutput {
  const lineAllocations = new Map<string, LineAllocationResult>();
  const appliedPromotionIds = new Set<number>();
  let totalCartDiscount = new Decimal(0);
  let freeShippingPromotion: { promotionId: number; promotionName: string } | null = null;

  if (!cartItems || cartItems.length === 0 || !rules || rules.length === 0) {
    return { lineAllocations, totalCartDiscount, appliedPromotionIds, freeShippingPromotion };
  }

  // 1. Filter eligible rules matching channel, branch, tier, date range, and day-of-week schedule
  const eligibleRules = rules
    .filter((r) => r.isActive !== false)
    .filter((r) => isPromotionChannelActive(r.channel, context.channel))
    .filter((r) => {
      if (r.branchId != null && r.branchId !== context.branchId) {
        return false;
      }
      if (r.customerTier && r.customerTier !== context.customerTier) {
        return false;
      }
      return true;
    })
    .filter((r) => {
      if (r.effectiveFrom && context.todayYmd < r.effectiveFrom) return false;
      if (r.effectiveTo && context.todayYmd > r.effectiveTo) return false;
      return true;
    })
    .filter((r) => isPromotionActiveOnDay(r.activeDays, context.todayYmd));

  if (eligibleRules.length === 0) {
    return { lineAllocations, totalCartDiscount, appliedPromotionIds, freeShippingPromotion };
  }

  // Overall cart gross (excluding digital cards)
  const physicalItems: NormalizedEvaluationItem[] = cartItems
    .filter((i) => !i.isDigitalCard)
    .map((item) => ({
      ...item,
      unitPrice: new Decimal(item.unitPrice ?? 0),
      quantity: new Decimal(item.quantity ?? 0),
    }));

  // Sort candidate rules by (priority DESC, savings DESC, id ASC)
  const candidateRules = resolvePriorityAndStacking(eligibleRules, physicalItems);

  const cartGross = physicalItems.reduce(
    (acc, i) => (i.isGift ? acc : acc.plus(i.quantity.mul(i.unitPrice))),
    new Decimal(0)
  );

  // Track already discounted items for non-stacking across merchandise rules
  const discountedLines = new Set<string>();

  for (const rule of candidateRules) {
    if (rule.minOrderSpend) {
      const minSpend = new Decimal(rule.minOrderSpend);
      if (cartGross.lt(minSpend)) continue;
    }

    const isShippingOnlyRule =
      rule.type === "FREE_SHIPPING" ||
      (rule.type === "AMOUNT" &&
        new Decimal(rule.discountAmount ?? 0).lte(0) &&
        rule.freeShipping === true);
    if (isShippingOnlyRule) {
      const minLine = rule.minLineAmount ? new Decimal(rule.minLineAmount) : null;
      const anyEligibleForShipping = physicalItems.some((item) => {
        if (!isPromotionApplicableToItem(item, rule)) return false;
        if (minLine && minLine.gt(0) && item.quantity.mul(item.unitPrice).lt(minLine)) {
          return false;
        }
        return true;
      });
      if (anyEligibleForShipping) {
        if (!freeShippingPromotion) {
          freeShippingPromotion = {
            promotionId: rule.id,
            promotionName: rule.name,
          };
        }
        appliedPromotionIds.add(rule.id);
      }
      continue;
    }

    const matchingLines = physicalItems.filter((item) => {
      if (discountedLines.has(item.lineKey)) return false;
      return isPromotionApplicableToItem(item, rule);
    });

    if (matchingLines.length === 0) continue;

    const ruleDiscounts = evaluateSingleRuleDiscounts(matchingLines, rule);
    if (ruleDiscounts.size === 0) continue;

    let ruleAppliedAny = false;
    for (const [lineKey, lineDiscount] of Array.from(ruleDiscounts.entries())) {
      if (lineDiscount.lte(0)) continue;
      const line = matchingLines.find((l) => l.lineKey === lineKey);
      if (!line || line.quantity.lte(0)) continue;

      const lineGross = line.quantity.mul(line.unitPrice);
      const hasDiscountCap =
        rule.maxDiscountAmount != null &&
        rule.maxDiscountAmount !== "" &&
        new Decimal(rule.maxDiscountAmount).gt(0);
      const effectiveUnitPrice =
        rule.type === "FIXED_PRICE" && rule.fixedPrice != null && !hasDiscountCap
          ? new Decimal(rule.fixedPrice)
          : lineGross.minus(lineDiscount).div(line.quantity);

      lineAllocations.set(lineKey, {
        lineKey,
        promotionId: rule.id,
        promotionName: rule.name,
        discountAmount: lineDiscount,
        effectiveUnitPrice,
      });
      discountedLines.add(lineKey);
      appliedPromotionIds.add(rule.id);
      totalCartDiscount = totalCartDiscount.plus(lineDiscount);
      ruleAppliedAny = true;
    }

    if (ruleAppliedAny && rule.freeShipping && !freeShippingPromotion) {
      freeShippingPromotion = {
        promotionId: rule.id,
        promotionName: rule.name,
      };
    }
  }

  return { lineAllocations, totalCartDiscount, appliedPromotionIds, freeShippingPromotion };
}

// Alias for seamless drop-in interoperability
export const evaluatePromotions = evaluateCartPromotions;

// ---------------------------------------------------------------------------
// Human-Readable Arabic Summary Formatter for All 6 Promotion Types
// (Strict Latin digits — complies with check:locale-numbers)
// ---------------------------------------------------------------------------

function fmtPromoNumber(val: DecimalInput | null | undefined): string {
  try {
    const d = new Decimal(val ?? 0);
    if (!d.isFinite()) return "0";
    const rounded = d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    const [intPart, fracPart] = rounded.toFixed(2).split(".");
    const sign = intPart.startsWith("-") ? "-" : "";
    const digits = sign ? intPart.slice(1) : intPart;
    const withCommas = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    const cleanFrac = (fracPart ?? "").replace(/0+$/, "");
    return cleanFrac ? `${sign}${withCommas}.${cleanFrac}` : `${sign}${withCommas}`;
  } catch {
    return "0";
  }
}

export interface PromotionSummaryInput {
  type: "PERCENT" | "AMOUNT" | "FIXED_PRICE" | "BUNDLE_PRICE" | "BOGO" | "TIERED_QTY" | "FREE_SHIPPING" | string;
  freeShipping?: boolean | null;
  discountPercent?: DecimalInput | null;
  discountAmount?: DecimalInput | null;
  maxDiscountAmount?: DecimalInput | null;
  fixedPrice?: DecimalInput | null;
  bundlePrice?: DecimalInput | null;
  bundleMode?: "ALL_REQUIRED" | "PICK_ANY_N" | string | null;
  bundleQuantity?: number | null;
  pickCount?: number | null;
  bogoBuyQuantity?: number | null;
  buyQuantity?: number | null;
  bogoGetQuantity?: number | null;
  getQuantity?: number | null;
  bogoGetDiscountPercent?: DecimalInput | null;
  getDiscountPercent?: DecimalInput | null;
  tieredMode?: "PER_ITEM" | "POOL_ACROSS_TARGETS" | string | null;
  tierMode?: "PER_ITEM" | "POOL_ACROSS_TARGETS" | string | null;
  tiers?: ReadonlyArray<{
    minQuantity: DecimalInput;
    tierType?: string;
    discountPercent?: DecimalInput | null;
    discountAmount?: DecimalInput | null;
    fixedPrice?: DecimalInput | null;
  }> | null;
}

export function formatPromotionSummary(promo: PromotionSummaryInput | null | undefined): string {
  if (!promo) return "—";
  if (promo.type === "FREE_SHIPPING") {
    return "توصيل مجاني بالكامل";
  }
  const shippingSuffix = promo.freeShipping ? " + توصيل مجاني" : "";
  switch (promo.type) {
    case "PERCENT": {
      const pct = fmtPromoNumber(promo.discountPercent);
      let cap = new Decimal(0);
      try {
        if (promo.maxDiscountAmount != null && promo.maxDiscountAmount !== "") {
          cap = new Decimal(promo.maxDiscountAmount);
        }
      } catch {
        cap = new Decimal(0);
      }
      return (cap.gt(0) ? `${pct}٪ (سقف ${fmtPromoNumber(cap)} د.ع)` : `${pct}٪`) + shippingSuffix;
    }
    case "AMOUNT":
      return `${fmtPromoNumber(promo.discountAmount)} د.ع / وحدة${shippingSuffix}`;
    case "FIXED_PRICE":
      return `سعر موحد ${fmtPromoNumber(promo.fixedPrice)} د.ع${shippingSuffix}`;
    case "BUNDLE_PRICE": {
      const bundleQty = promo.bundleQuantity ?? promo.pickCount;
      if (promo.bundleMode === "PICK_ANY_N" && bundleQty && bundleQty > 0) {
        return `أي ${bundleQty} قطع بـ ${fmtPromoNumber(promo.bundlePrice)} د.ع${shippingSuffix}`;
      }
      return `باقة موحدة بـ ${fmtPromoNumber(promo.bundlePrice)} د.ع${shippingSuffix}`;
    }
    case "BOGO": {
      const buy = promo.bogoBuyQuantity ?? promo.buyQuantity ?? 1;
      const get = promo.bogoGetQuantity ?? promo.getQuantity ?? 1;
      const rawPct = promo.bogoGetDiscountPercent ?? promo.getDiscountPercent;
      let pct = new Decimal(100);
      try {
        if (rawPct != null && rawPct !== "") {
          pct = new Decimal(rawPct);
        }
      } catch {
        pct = new Decimal(100);
      }
      return (pct.gte(100)
        ? `اشتر ${buy} واحصل على ${get} مجاناً`
        : `اشتر ${buy} واحصل على ${get} بخصم ${fmtPromoNumber(pct)}٪`) + shippingSuffix;
    }
    case "TIERED_QTY": {
      const tiers = promo.tiers ? [...promo.tiers] : [];
      if (tiers.length > 0) {
        tiers.sort((a, b) =>
          new Decimal(a.minQuantity ?? 0).minus(new Decimal(b.minQuantity ?? 0)).toNumber()
        );
        return `شرائح كميات (${tiers.length} شرائح — من ${fmtPromoNumber(tiers[0].minQuantity)}+)${shippingSuffix}`;
      }
      const tMode = promo.tieredMode ?? promo.tierMode;
      return (tMode === "POOL_ACROSS_TARGETS"
        ? "شرائح كميات (تجميعي)"
        : "شرائح كميات (لكل صنف)") + shippingSuffix;
    }
    default:
      return "—";
  }
}
