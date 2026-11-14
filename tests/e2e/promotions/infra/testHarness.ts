/**
 * tests/e2e/promotions/infra/testHarness.ts
 *
 * Isolated Evaluation Harness, Promotion Engine Simulator, Cart Builder & Pipeline Driver
 * Strictly uses decimal.js for all monetary arithmetic. Zero live database dependency.
 */

import Decimal from "decimal.js";
import {
  MockDigitalCard,
  MockProduct,
  MockProductUnit,
  MockPromotionRule,
  MockPromotionTier,
  MockStaffActor,
} from "./mockFixtures";
import { assertPriceCeilingRespected } from "./assertions";

// ---------------------------------------------------------------------------
// Cart & Item Data Models
// ---------------------------------------------------------------------------

export interface CartLineItem {
  lineKey: string;
  productId: number;
  productName: string;
  variantId: number;
  categoryId: number;
  productUnitId: number;
  unitName: string;
  isBaseUnit: boolean;
  conversionFactor: Decimal;
  unitPrice: Decimal;
  costPrice: Decimal;
  quantity: Decimal;
  barcode: string;
  isConsignment?: boolean;
  hasContractPrice?: boolean;
  isDigitalCard?: boolean;
}

export interface EvaluationContext {
  channel: "POS" | "STORE";
  todayYmd: string; // YYYY-MM-DD in Baghdad time
  customerTier?: "RETAIL" | "WHOLESALE" | "GOVERNMENT" | null;
}

export interface LineAllocation {
  lineKey: string;
  promotionId: number;
  promotionName: string;
  discountAmount: Decimal; // Total line discount
  effectiveUnitPrice: Decimal; // (Gross - discount) / quantity
}

export interface EvaluationResult {
  lineAllocations: Map<string, LineAllocation>;
  totalCartDiscount: Decimal;
  appliedPromotionIds: Set<number>;
}

// ---------------------------------------------------------------------------
// Cart Builder (Fluent API)
// ---------------------------------------------------------------------------

export class CartBuilder {
  private items: CartLineItem[] = [];
  private lineCounter = 1;

  addItem(
    product: MockProduct,
    quantity: number | Decimal = 1,
    unitIndex: number = 0,
    options?: { hasContractPrice?: boolean; customUnitPrice?: number | Decimal }
  ): this {
    const unit = product.units[unitIndex] ?? product.units[0];
    const qty = new Decimal(quantity);
    const unitPrice = options?.customUnitPrice
      ? new Decimal(options.customUnitPrice)
      : unit.retailPrice;

    this.items.push({
      lineKey: `line_${this.lineCounter++}`,
      productId: product.id,
      productName: product.name,
      variantId: product.variantId,
      categoryId: product.categoryId,
      productUnitId: unit.id,
      unitName: unit.unitName,
      isBaseUnit: unit.isBaseUnit,
      conversionFactor: unit.conversionFactor,
      unitPrice,
      costPrice: unit.costPrice,
      quantity: qty,
      barcode: unit.barcode,
      isConsignment: product.isConsignment,
      hasContractPrice: options?.hasContractPrice ?? false,
    });
    return this;
  }

  addCartonItem(
    product: MockProduct,
    quantity: number | Decimal = 1
  ): this {
    const cartonUnitIndex = product.units.findIndex((u) => u.unitName === "كرتون");
    return this.addItem(product, quantity, cartonUnitIndex >= 0 ? cartonUnitIndex : 1);
  }

  addDigitalCard(
    card: MockDigitalCard,
    quantity: number | Decimal = 1
  ): this {
    const qty = new Decimal(quantity);
    this.items.push({
      lineKey: `line_${this.lineCounter++}`,
      productId: card.id,
      productName: card.name,
      variantId: card.id,
      categoryId: 99, // Digital Services
      productUnitId: card.id,
      unitName: "كرت رقمي",
      isBaseUnit: true,
      conversionFactor: new Decimal(1),
      unitPrice: card.retailPrice,
      costPrice: card.costPrice,
      quantity: qty,
      barcode: `DIG-${card.id}`,
      isDigitalCard: true,
    });
    return this;
  }

  build(): CartLineItem[] {
    return [...this.items];
  }
}

export function cart(): CartBuilder {
  return new CartBuilder();
}

// ---------------------------------------------------------------------------
// Pure Promotion Engine Simulator
// ---------------------------------------------------------------------------

/**
 * Calculates day of week (0=Sun .. 6=Sat) for a Baghdad YYYY-MM-DD string.
 */
export function getDayOfWeekForYmd(ymd: string): number {
  const [y, m, d] = ymd.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  return date.getUTCDay();
}

/**
 * Distributes a total savings amount proportionally across lines based on value.
 * Remainder fils are allocated to the line with the largest gross value to ensure:
 * sum(allocations) === totalSavings down to 0.01 fils.
 */
export function allocateByValue(
  lines: Array<{ lineKey: string; lineGross: Decimal }>,
  totalSavings: Decimal
): Map<string, Decimal> {
  const allocations = new Map<string, Decimal>();
  if (lines.length === 0 || totalSavings.lte(0)) {
    return allocations;
  }

  const totalGross = lines.reduce((acc, l) => acc.plus(l.lineGross), new Decimal(0));
  if (totalGross.lte(0)) {
    return allocations;
  }

  // If total savings >= total gross, discount is capped at total gross
  const cappedSavings = Decimal.min(totalSavings, totalGross);

  let allocatedSum = new Decimal(0);
  let largestLineKey = lines[0].lineKey;
  let maxGross = lines[0].lineGross;

  for (const line of lines) {
    if (line.lineGross.gt(maxGross)) {
      maxGross = line.lineGross;
      largestLineKey = line.lineKey;
    }
    // Share = floor(cappedSavings * (lineGross / totalGross) * 100) / 100
    const rawShare = cappedSavings.mul(line.lineGross).div(totalGross);
    const roundedShare = rawShare.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    allocations.set(line.lineKey, roundedShare);
    allocatedSum = allocatedSum.plus(roundedShare);
  }

  // Adjust remainder fils to the largest line
  const remainder = cappedSavings.minus(allocatedSum);
  if (!remainder.isZero() && largestLineKey) {
    const current = allocations.get(largestLineKey) ?? new Decimal(0);
    allocations.set(largestLineKey, current.plus(remainder));
  }

  return allocations;
}

/**
 * Pure deterministic promotion evaluation function.
 */
export function evaluatePromotions(
  cartItems: readonly CartLineItem[],
  rules: readonly MockPromotionRule[],
  context: EvaluationContext
): EvaluationResult {
  const lineAllocations = new Map<string, LineAllocation>();
  const appliedPromotionIds = new Set<number>();
  let totalCartDiscount = new Decimal(0);

  // 1. Filter active candidate rules matching context
  const activeRules = rules
    .filter((r) => r.isActive)
    .filter((r) => {
      // Channel match: ALL matches both, POS_ONLY matches POS, STORE_ONLY matches STORE
      if (r.channel === "ALL") return true;
      if (r.channel === "POS_ONLY" && context.channel === "POS") return true;
      if (r.channel === "STORE_ONLY" && context.channel === "STORE") return true;
      return false;
    })
    .filter((r) => {
      // Date validity (Y-M-D comparison)
      if (r.effectiveFrom && context.todayYmd < r.effectiveFrom) return false;
      if (r.effectiveTo && context.todayYmd > r.effectiveTo) return false;
      return true;
    })
    .filter((r) => {
      // Active days match (if specified)
      if (!r.activeDays || r.activeDays.length === 0) return true;
      const dow = getDayOfWeekForYmd(context.todayYmd);
      return r.activeDays.includes(dow);
    })
    .sort((a, b) => {
      // Sort by priority DESC, then ID ASC
      if (b.priority !== a.priority) return b.priority - a.priority;
      return a.id - b.id;
    });

  if (activeRules.length === 0 || cartItems.length === 0) {
    return { lineAllocations, totalCartDiscount, appliedPromotionIds };
  }

  // Overall cart gross (excluding digital cards)
  const physicalItems = cartItems.filter((i) => !i.isDigitalCard);
  const cartGross = physicalItems.reduce(
    (acc, i) => acc.plus(i.quantity.mul(i.unitPrice)),
    new Decimal(0)
  );

  // Track already discounted items for non-stacking
  const discountedLines = new Set<string>();

  for (const rule of activeRules) {
    // Check minimum order spend requirement
    if (rule.minOrderSpend && cartGross.lt(rule.minOrderSpend)) {
      continue;
    }

    // Filter qualifying lines for this rule
    const matchingLines = physicalItems.filter((item) => {
      if (discountedLines.has(item.lineKey)) return false;
      if (item.hasContractPrice) return false; // Contract price strictly protected
      if (rule.applyToBaseUnitOnly && !item.isBaseUnit) return false; // Base unit isolation

      // Target matching
      const matchesProduct = rule.targetProductIds.has(item.productId);
      const matchesCategory = rule.targetCategoryIds.has(item.categoryId);
      const matchesUnit = rule.targetUnitIds.has(item.productUnitId);

      const hasTargets =
        rule.targetProductIds.size > 0 ||
        rule.targetCategoryIds.size > 0 ||
        rule.targetUnitIds.size > 0;

      if (!hasTargets) return true; // Store-wide promo
      return matchesProduct || matchesCategory || matchesUnit;
    });

    if (matchingLines.length === 0) continue;

    // Evaluate by rule type
    switch (rule.type) {
      case "PERCENT": {
        const percent = rule.discountPercent ?? new Decimal(0);
        if (percent.lte(0)) break;

        for (const line of matchingLines) {
          const lineGross = line.quantity.mul(line.unitPrice);
          const rawDiscount = lineGross.mul(percent).div(100);
          const lineDiscount = Decimal.min(rawDiscount, lineGross).toDecimalPlaces(
            2,
            Decimal.ROUND_HALF_UP
          );

          if (lineDiscount.gt(0)) {
            const effectiveUnitPrice = lineGross.minus(lineDiscount).div(line.quantity);
            lineAllocations.set(line.lineKey, {
              lineKey: line.lineKey,
              promotionId: rule.id,
              promotionName: rule.name,
              discountAmount: lineDiscount,
              effectiveUnitPrice,
            });
            discountedLines.add(line.lineKey);
            appliedPromotionIds.add(rule.id);
            totalCartDiscount = totalCartDiscount.plus(lineDiscount);
          }
        }
        break;
      }

      case "AMOUNT": {
        const amountPerUnit = rule.discountAmount ?? new Decimal(0);
        if (amountPerUnit.lte(0)) break;

        for (const line of matchingLines) {
          const lineGross = line.quantity.mul(line.unitPrice);
          const rawDiscount = line.quantity.mul(amountPerUnit);
          const lineDiscount = Decimal.min(rawDiscount, lineGross).toDecimalPlaces(
            2,
            Decimal.ROUND_HALF_UP
          );

          if (lineDiscount.gt(0)) {
            const effectiveUnitPrice = lineGross.minus(lineDiscount).div(line.quantity);
            lineAllocations.set(line.lineKey, {
              lineKey: line.lineKey,
              promotionId: rule.id,
              promotionName: rule.name,
              discountAmount: lineDiscount,
              effectiveUnitPrice,
            });
            discountedLines.add(line.lineKey);
            appliedPromotionIds.add(rule.id);
            totalCartDiscount = totalCartDiscount.plus(lineDiscount);
          }
        }
        break;
      }

      case "FIXED_PRICE": {
        const fixed = rule.fixedPrice ?? new Decimal(0);
        if (fixed.lte(0)) break;

        for (const line of matchingLines) {
          const lineGross = line.quantity.mul(line.unitPrice);

          // Fixed price ceiling: if unitPrice <= fixed, discount = 0
          if (line.unitPrice.lte(fixed)) {
            continue;
          }

          const unitDiscount = line.unitPrice.minus(fixed);
          const lineDiscount = unitDiscount.mul(line.quantity).toDecimalPlaces(
            2,
            Decimal.ROUND_HALF_UP
          );

          if (lineDiscount.gt(0)) {
            const effectiveUnitPrice = fixed;
            lineAllocations.set(line.lineKey, {
              lineKey: line.lineKey,
              promotionId: rule.id,
              promotionName: rule.name,
              discountAmount: lineDiscount,
              effectiveUnitPrice,
            });
            discountedLines.add(line.lineKey);
            appliedPromotionIds.add(rule.id);
            totalCartDiscount = totalCartDiscount.plus(lineDiscount);
          }
        }
        break;
      }

      case "BUNDLE_PRICE": {
        const bundlePrice = rule.bundlePrice ?? new Decimal(0);
        const bundleQty = rule.bundleQuantity ?? 1;

        if (rule.bundleMode === "ALL_REQUIRED") {
          // Requires 1 unit of each target product
          const requiredProductIds = Array.from(rule.targetProductIds);
          const qualifyingLines: CartLineItem[] = [];

          for (const pid of requiredProductIds) {
            const line = matchingLines.find((l) => l.productId === pid && l.quantity.gte(1));
            if (line) qualifyingLines.push(line);
          }

          if (qualifyingLines.length === requiredProductIds.length && qualifyingLines.length > 0) {
            const totalOriginal = qualifyingLines.reduce(
              (acc, l) => acc.plus(l.unitPrice),
              new Decimal(0)
            );

            if (totalOriginal.gt(bundlePrice)) {
              const bundleSavings = totalOriginal.minus(bundlePrice);
              const linesForAllocation = qualifyingLines.map((l) => ({
                lineKey: l.lineKey,
                lineGross: l.unitPrice,
              }));

              const allocated = allocateByValue(linesForAllocation, bundleSavings);
              for (const [lineKey, disc] of Array.from(allocated.entries())) {
                const line = qualifyingLines.find((l) => l.lineKey === lineKey)!;
                const effectiveUnitPrice = line.quantity.mul(line.unitPrice).minus(disc).div(line.quantity);

                lineAllocations.set(lineKey, {
                  lineKey,
                  promotionId: rule.id,
                  promotionName: rule.name,
                  discountAmount: disc,
                  effectiveUnitPrice,
                });
                discountedLines.add(lineKey);
                totalCartDiscount = totalCartDiscount.plus(disc);
              }
              appliedPromotionIds.add(rule.id);
            }
          }
        } else {
          // PICK_ANY_N: bundleQty units among qualifying
          const totalUnits = matchingLines.reduce((acc, l) => acc.plus(l.quantity), new Decimal(0));
          if (totalUnits.gte(bundleQty)) {
            const totalGross = matchingLines.reduce(
              (acc, l) => acc.plus(l.quantity.mul(l.unitPrice)),
              new Decimal(0)
            );
            if (totalGross.gt(bundlePrice)) {
              const savings = totalGross.minus(bundlePrice);
              const linesForAlloc = matchingLines.map((l) => ({
                lineKey: l.lineKey,
                lineGross: l.quantity.mul(l.unitPrice),
              }));
              const allocated = allocateByValue(linesForAlloc, savings);

              for (const [lineKey, disc] of Array.from(allocated.entries())) {
                const line = matchingLines.find((l) => l.lineKey === lineKey)!;
                const lineGross = line.quantity.mul(line.unitPrice);
                const effectiveUnitPrice = lineGross.minus(disc).div(line.quantity);

                lineAllocations.set(lineKey, {
                  lineKey,
                  promotionId: rule.id,
                  promotionName: rule.name,
                  discountAmount: disc,
                  effectiveUnitPrice,
                });
                discountedLines.add(lineKey);
                totalCartDiscount = totalCartDiscount.plus(disc);
              }
              appliedPromotionIds.add(rule.id);
            }
          }
        }
        break;
      }

      case "BOGO": {
        const buyQty = rule.bogoBuyQuantity ?? 1;
        const getQty = rule.bogoGetQuantity ?? 1;
        const groupSize = buyQty + getQty;
        const getDiscountPercent = rule.bogoGetDiscountPercent ?? new Decimal(100);

        // Flatten units to find cheapest qualifying unit
        const flattenedUnits: Array<{ lineKey: string; unitPrice: Decimal }> = [];
        for (const line of matchingLines) {
          const qty = line.quantity.toNumber();
          for (let i = 0; i < qty; i++) {
            flattenedUnits.push({ lineKey: line.lineKey, unitPrice: line.unitPrice });
          }
        }

        if (flattenedUnits.length >= groupSize) {
          // Sort units by price ASC: cheapest items are discounted
          flattenedUnits.sort((a, b) => a.unitPrice.minus(b.unitPrice).toNumber());

          // How many free items: floor(total / groupSize) * getQty
          const numSets = Math.floor(flattenedUnits.length / groupSize);
          const numFreeItems = numSets * getQty;
          const freeUnits = flattenedUnits.slice(0, numFreeItems);

          // Total savings from cheapest items
          let bogoSavings = new Decimal(0);
          for (const u of freeUnits) {
            bogoSavings = bogoSavings.plus(u.unitPrice.mul(getDiscountPercent).div(100));
          }

          // Allocate proportionally across matching lines
          const linesForAlloc = matchingLines.map((l) => ({
            lineKey: l.lineKey,
            lineGross: l.quantity.mul(l.unitPrice),
          }));

          const allocated = allocateByValue(linesForAlloc, bogoSavings);
          for (const [lineKey, disc] of Array.from(allocated.entries())) {
            const line = matchingLines.find((l) => l.lineKey === lineKey)!;
            const lineGross = line.quantity.mul(line.unitPrice);
            const effectiveUnitPrice = lineGross.minus(disc).div(line.quantity);

            lineAllocations.set(lineKey, {
              lineKey,
              promotionId: rule.id,
              promotionName: rule.name,
              discountAmount: disc,
              effectiveUnitPrice,
            });
            discountedLines.add(lineKey);
            totalCartDiscount = totalCartDiscount.plus(disc);
          }
          appliedPromotionIds.add(rule.id);
        }
        break;
      }

      case "TIERED_QTY": {
        const tiers = [...(rule.tiers ?? [])].sort((a, b) =>
          b.minQuantity.minus(a.minQuantity).toNumber()
        );
        if (tiers.length === 0) break;

        for (const line of matchingLines) {
          const matchingTier = tiers.find((t) => line.quantity.gte(t.minQuantity));
          if (!matchingTier) continue;

          let lineDiscount = new Decimal(0);
          const lineGross = line.quantity.mul(line.unitPrice);

          if (matchingTier.tierType === "PERCENT") {
            const pct = matchingTier.discountPercent ?? new Decimal(0);
            lineDiscount = lineGross.mul(pct).div(100);
          } else if (matchingTier.tierType === "AMOUNT") {
            const amt = matchingTier.discountAmount ?? new Decimal(0);
            lineDiscount = line.quantity.mul(amt);
          } else if (matchingTier.tierType === "FIXED_PRICE") {
            const fixed = matchingTier.fixedPrice ?? new Decimal(0);
            if (line.unitPrice.gt(fixed)) {
              lineDiscount = line.unitPrice.minus(fixed).mul(line.quantity);
            }
          }

          lineDiscount = Decimal.min(lineDiscount, lineGross).toDecimalPlaces(
            2,
            Decimal.ROUND_HALF_UP
          );

          if (lineDiscount.gt(0)) {
            const effectiveUnitPrice = lineGross.minus(lineDiscount).div(line.quantity);
            lineAllocations.set(line.lineKey, {
              lineKey: line.lineKey,
              promotionId: rule.id,
              promotionName: rule.name,
              discountAmount: lineDiscount,
              effectiveUnitPrice,
            });
            discountedLines.add(line.lineKey);
            appliedPromotionIds.add(rule.id);
            totalCartDiscount = totalCartDiscount.plus(lineDiscount);
          }
        }
        break;
      }
    }
  }

  // Apply maximum discount cap if specified on cart level
  return { lineAllocations, totalCartDiscount, appliedPromotionIds };
}

// ---------------------------------------------------------------------------
// Schema Constraint & Migration Validator (F01–F06)
// ---------------------------------------------------------------------------

export interface SchemaValidationResult {
  valid: boolean;
  errors: string[];
}

export function validatePromotionSchema(input: {
  type: string;
  channel?: string;
  discountPercent?: string | number | Decimal;
  discountAmount?: string | number | Decimal;
  fixedPrice?: string | number | Decimal;
  bundlePrice?: string | number | Decimal;
  bundleMode?: string;
  bogoBuyQuantity?: number;
  bogoGetQuantity?: number;
  tieredMode?: string;
  tiers?: MockPromotionTier[];
  allowBelowCost?: boolean;
  applyToBaseUnitOnly?: boolean;
  activeDays?: number[] | null;
  effectiveFrom?: string;
  effectiveTo?: string | null;
}): SchemaValidationResult {
  const errors: string[] = [];

  // Channel enum validation (ALL, POS_ONLY, STORE_ONLY)
  if (input.channel && !["ALL", "POS_ONLY", "STORE_ONLY"].includes(input.channel)) {
    errors.push(`Invalid channel enum: ${input.channel}`);
  }

  // Active days range validation (0..6)
  if (input.activeDays) {
    for (const d of input.activeDays) {
      if (d < 0 || d > 6 || !Number.isInteger(d)) {
        errors.push(`Invalid activeDays item: ${d} (must be integer 0..6)`);
      }
    }
  }

  // Date range validation
  if (input.effectiveFrom && input.effectiveTo && input.effectiveTo < input.effectiveFrom) {
    errors.push(`effectiveTo (${input.effectiveTo}) cannot be earlier than effectiveFrom (${input.effectiveFrom})`);
  }

  // chk_promo_shape constraints
  switch (input.type) {
    case "PERCENT": {
      const pct = new Decimal(input.discountPercent ?? 0);
      if (pct.lte(0) || pct.gt(100)) {
        errors.push("PERCENT promotion requires discountPercent > 0 and <= 100");
      }
      const amt = new Decimal(input.discountAmount ?? 0);
      if (amt.gt(0)) {
        errors.push("PERCENT promotion must not have discountAmount > 0");
      }
      break;
    }
    case "AMOUNT": {
      const amt = new Decimal(input.discountAmount ?? 0);
      if (amt.lte(0)) {
        errors.push("AMOUNT promotion requires discountAmount > 0");
      }
      const pct = new Decimal(input.discountPercent ?? 0);
      if (pct.gt(0)) {
        errors.push("AMOUNT promotion must not have discountPercent > 0");
      }
      break;
    }
    case "FIXED_PRICE": {
      const fp = new Decimal(input.fixedPrice ?? 0);
      if (fp.lte(0)) {
        errors.push("FIXED_PRICE promotion requires fixedPrice > 0");
      }
      break;
    }
    case "BUNDLE_PRICE": {
      const bp = new Decimal(input.bundlePrice ?? 0);
      if (bp.lte(0)) {
        errors.push("BUNDLE_PRICE promotion requires bundlePrice > 0");
      }
      if (!input.bundleMode || !["ALL_REQUIRED", "PICK_ANY_N"].includes(input.bundleMode)) {
        errors.push("BUNDLE_PRICE promotion requires bundleMode 'ALL_REQUIRED' or 'PICK_ANY_N'");
      }
      break;
    }
    case "BOGO": {
      if (!input.bogoBuyQuantity || input.bogoBuyQuantity <= 0) {
        errors.push("BOGO promotion requires bogoBuyQuantity > 0");
      }
      if (!input.bogoGetQuantity || input.bogoGetQuantity <= 0) {
        errors.push("BOGO promotion requires bogoGetQuantity > 0");
      }
      break;
    }
    case "TIERED_QTY": {
      if (!input.tieredMode || !["PER_ITEM", "POOL_ACROSS_TARGETS"].includes(input.tieredMode)) {
        errors.push("TIERED_QTY promotion requires tieredMode");
      }
      if (!input.tiers || input.tiers.length === 0) {
        errors.push("TIERED_QTY promotion requires at least one tier");
      }
      break;
    }
    default:
      errors.push(`Unknown promotion type: ${input.type}`);
  }

  return { valid: errors.length === 0, errors };
}

export function validateTargetGrain(target: {
  scope: string;
  categoryId?: number | null;
  productId?: number | null;
  variantId?: number | null;
  productUnitId?: number | null;
}): SchemaValidationResult {
  const errors: string[] = [];
  if (target.scope === "ALL") {
    if (target.categoryId || target.productId || target.variantId || target.productUnitId) {
      errors.push("Scope ALL must not have specific target IDs");
    }
  } else {
    const count = [
      target.categoryId,
      target.productId,
      target.variantId,
      target.productUnitId,
    ].filter((v) => v != null).length;

    if (count !== 1) {
      errors.push(`Target must specify exactly one grain level (found ${count})`);
    }
  }
  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Sales Pipeline Simulation (F19–F23)
// ---------------------------------------------------------------------------

export interface SimulatedSaleLineInput {
  lineKey: string;
  productId: number;
  variantId: number;
  productUnitId: number;
  quantity: Decimal;
  unitPrice: Decimal;
  costPrice: Decimal;
  promotionId?: number | null;
  promotionDiscount?: Decimal;
  cashierDiscountAmount?: Decimal;
  isDigitalCard?: boolean;
  isGift?: boolean;
}

export interface SimulatedSaleResult {
  success: boolean;
  invoiceId?: number;
  errorCode?: string;
  errorMessage?: string;
  lines: Array<{
    lineKey: string;
    unitPrice: Decimal;
    effectiveUnitPrice: Decimal;
    promotionDiscount: Decimal;
    cashierDiscountAmount: Decimal;
    lineTotal: Decimal;
    isGift: boolean;
    isBelowCost: boolean;
  }>;
  subtotal: Decimal;
  totalDiscount: Decimal;
  totalAmount: Decimal;
  priceOverride: boolean;
}

export function simulateSaleCreation(
  lines: SimulatedSaleLineInput[],
  actor: MockStaffActor,
  activePromos: Map<number, MockPromotionRule>
): SimulatedSaleResult {
  let subtotal = new Decimal(0);
  let totalDiscount = new Decimal(0);
  let priceOverride = false;
  const processedLines = [];

  // Check 1: Digital card isolation in mixed carts
  const hasDigitalCards = lines.some((l) => l.isDigitalCard);
  for (const line of lines) {
    if (line.isDigitalCard) {
      if (line.promotionId != null || (line.promotionDiscount && line.promotionDiscount.gt(0))) {
        return {
          success: false,
          errorCode: "BAD_REQUEST",
          errorMessage: "لا يمكن تطبيق عروض ترويجية على الكروت الرقمية",
          lines: [],
          subtotal: new Decimal(0),
          totalDiscount: new Decimal(0),
          totalAmount: new Decimal(0),
          priceOverride: false,
        };
      }
    }
  }

  for (const line of lines) {
    const lineGross = line.quantity.mul(line.unitPrice);
    subtotal = subtotal.plus(lineGross);

    let promoDiscount = line.promotionDiscount ?? new Decimal(0);
    const promo = line.promotionId ? activePromos.get(line.promotionId) : undefined;

    // Verify promotion exists if ID provided
    if (line.promotionId && !promo) {
      promoDiscount = new Decimal(0);
    }

    // Step 2: H6 Gate Fix - evaluate cashier manual discount on net price after promo
    const netAfterPromo = lineGross.minus(promoDiscount);
    const cashierManualDiscount = line.cashierDiscountAmount ?? new Decimal(0);

    if (netAfterPromo.gt(0) && cashierManualDiscount.gt(0)) {
      const cashierManualPercent = cashierManualDiscount.div(netAfterPromo).mul(100);
      if (cashierManualPercent.gt(actor.maxDiscountPercent) && actor.role !== "admin" && actor.role !== "manager") {
        return {
          success: false,
          errorCode: "FORBIDDEN",
          errorMessage: "خصم الكاشير يتجاوز 15٪ عن السعر الصافي بعد العرض ويتطلب موافقة مدير",
          lines: [],
          subtotal: new Decimal(0),
          totalDiscount: new Decimal(0),
          totalAmount: new Decimal(0),
          priceOverride: false,
        };
      }
    }

    const totalLineDiscount = promoDiscount.plus(cashierManualDiscount);
    const lineTotal = lineGross.minus(totalLineDiscount);
    const effectiveUnitPrice = lineTotal.div(line.quantity);

    // Step 3: Below-Cost Gate
    const isBelowCost = effectiveUnitPrice.lt(line.costPrice);
    if (isBelowCost) {
      priceOverride = true;
      const isExempt = promo?.allowBelowCost === true;
      if (!isExempt && actor.role !== "admin" && actor.role !== "manager") {
        return {
          success: false,
          errorCode: "FORBIDDEN",
          errorMessage: "البيع بأقل من التكلفة غير مصرح به لهذا العرض ويتطلب موافقة مدير",
          lines: [],
          subtotal: new Decimal(0),
          totalDiscount: new Decimal(0),
          totalAmount: new Decimal(0),
          priceOverride: false,
        };
      }
    }

    totalDiscount = totalDiscount.plus(totalLineDiscount);
    processedLines.push({
      lineKey: line.lineKey,
      unitPrice: line.unitPrice,
      effectiveUnitPrice,
      promotionDiscount: promoDiscount,
      cashierDiscountAmount: cashierManualDiscount,
      lineTotal,
      isGift: false, // Invariant: promotional discounts never set isGift = true
      isBelowCost,
    });
  }

  const totalAmount = subtotal.minus(totalDiscount);

  return {
    success: true,
    invoiceId: 9001,
    lines: processedLines,
    subtotal,
    totalDiscount,
    totalAmount,
    priceOverride,
  };
}

// ---------------------------------------------------------------------------
// Offline Sync & CRC32 Simulation (F24–F25)
// ---------------------------------------------------------------------------

/** Simple deterministic CRC32 hash simulation */
export function computeCrc32String(str: string): string {
  let crc = 0 ^ -1;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    crc = (crc >>> 8) ^ ((crc ^ code) & 0xff);
  }
  return ((crc ^ -1) >>> 0).toString(16).padStart(8, "0");
}

export function generateOfflinePromotionSnapshot(
  rules: MockPromotionRule[]
): {
  promotions: MockPromotionRule[];
  checksum: string;
  version: string;
} {
  // Snapshot includes active promotions for ALL or POS_ONLY (STORE_ONLY excluded)
  const posPromos = rules
    .filter((r) => r.isActive && (r.channel === "ALL" || r.channel === "POS_ONLY"))
    .sort((a, b) => a.id - b.id);

  const serialized = JSON.stringify(
    posPromos.map((r) => ({
      id: r.id,
      name: r.name,
      type: r.type,
      channel: r.channel,
      discountPercent: r.discountPercent?.toString(),
      discountAmount: r.discountAmount?.toString(),
      fixedPrice: r.fixedPrice?.toString(),
      activeDays: r.activeDays,
    }))
  );

  const checksum = computeCrc32String(serialized);
  return {
    promotions: posPromos,
    checksum,
    version: `cat_snap_${checksum}`,
  };
}

/** F16: Promotion Duplication Simulator */
export function duplicatePromotionRule(
  rule: MockPromotionRule,
  newId: number = 9999,
  effectiveFrom: string = "2026-06-15"
): MockPromotionRule {
  return {
    ...rule,
    id: newId,
    name: `نسخة من ${rule.name}`,
    effectiveFrom,
    effectiveTo: null,
    isActive: false, // Invariant: Duplicated promotion drafts default to inactive
  };
}

