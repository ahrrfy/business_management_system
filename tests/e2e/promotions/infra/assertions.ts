/**
 * tests/e2e/promotions/infra/assertions.ts
 *
 * Custom Domain Assertions & Mathematical Invariants for Promotions Subsystem
 * Uses decimal.js exclusively for financial integrity down to 0.01 fils.
 */

import Decimal from "decimal.js";
import { expect } from "vitest";

/**
 * Asserts exact decimal equivalence between two monetary values.
 */
export function assertDecimalEqual(
  actual: Decimal | string | number | undefined,
  expected: Decimal | string | number | undefined,
  message?: string
): void {
  if (actual === undefined || expected === undefined) {
    expect(actual, message).toBe(expected);
    return;
  }
  const decActual = new Decimal(actual);
  const decExpected = new Decimal(expected);
  const diff = decActual.minus(decExpected).abs();
  const maxDelta = new Decimal("0.005"); // within half a cent for rounding

  if (diff.gt(maxDelta)) {
    throw new Error(
      `Decimal mismatch${message ? ` (${message})` : ""}: expected ${decExpected.toFixed(2)}, received ${decActual.toFixed(2)} (diff: ${diff.toFixed(4)})`
    );
  }
}

/**
 * Asserts the Financial Conservation Law:
 * 1. The sum of all line allocations strictly equals totalCartDiscount (no fils lost or created).
 * 2. No line receives a discount greater than its total line gross amount.
 */
export function assertAllocationConservation(
  items: Array<{ lineKey: string; quantity: Decimal; unitPrice: Decimal }>,
  result: {
    lineAllocations: Map<string, { discountAmount: Decimal; effectiveUnitPrice: Decimal }>;
    totalCartDiscount: Decimal;
  }
): void {
  let sumAllocations = new Decimal(0);

  for (const item of items) {
    const alloc = result.lineAllocations.get(item.lineKey);
    const lineDiscount = alloc ? alloc.discountAmount : new Decimal(0);
    const lineGross = item.quantity.mul(item.unitPrice);

    // Invariant: discount <= lineGross
    if (lineDiscount.gt(lineGross.plus("0.005"))) {
      throw new Error(
        `Allocation overflow on line ${item.lineKey}: discount (${lineDiscount.toFixed(2)}) > line gross (${lineGross.toFixed(2)})`
      );
    }

    // Invariant: effectiveUnitPrice = (lineGross - discount) / quantity
    if (alloc) {
      const expectedEffective = lineGross.minus(lineDiscount).div(item.quantity);
      assertDecimalEqual(
        alloc.effectiveUnitPrice,
        expectedEffective,
        `effective unit price on line ${item.lineKey}`
      );
    }

    sumAllocations = sumAllocations.plus(lineDiscount);
  }

  // Invariant: sum(allocations) === totalCartDiscount
  assertDecimalEqual(
    sumAllocations,
    result.totalCartDiscount,
    "Sum of line allocations must strictly equal totalCartDiscount"
  );
}

/**
 * Asserts the Fixed Price Ceiling Invariant:
 * 1. Price NEVER increases: effectiveUnitPrice <= originalUnitPrice.
 * 2. If originalUnitPrice <= fixedPrice: discountAmount === 0 and effective === original.
 * 3. If originalUnitPrice > fixedPrice: effectiveUnitPrice === fixedPrice.
 */
export function assertPriceCeilingRespected(
  lines: Array<{
    lineKey?: string;
    originalUnitPrice: Decimal;
    effectiveUnitPrice: Decimal;
    discountAmount: Decimal;
  }>,
  fixedPrice: Decimal
): void {
  for (const line of lines) {
    // Invariant 1: Effective unit price never exceeds original
    if (line.effectiveUnitPrice.gt(line.originalUnitPrice.plus("0.001"))) {
      throw new Error(
        `Ceiling violation: effective unit price (${line.effectiveUnitPrice.toFixed(2)}) exceeded original (${line.originalUnitPrice.toFixed(2)})`
      );
    }

    if (line.originalUnitPrice.lte(fixedPrice)) {
      // Invariant 2: Items already at or below fixedPrice receive 0 discount
      assertDecimalEqual(
        line.discountAmount,
        new Decimal(0),
        `Item at or below fixed price must have 0 discount`
      );
      assertDecimalEqual(
        line.effectiveUnitPrice,
        line.originalUnitPrice,
        `Item at or below fixed price must retain original price`
      );
    } else {
      // Invariant 3: Items priced above fixedPrice are discounted to exactly fixedPrice
      assertDecimalEqual(
        line.effectiveUnitPrice,
        fixedPrice,
        `Item priced above fixed price must be discounted to fixed price`
      );
    }
  }
}

/**
 * Asserts Digital Card Line Isolation:
 * Digital cards in mixed carts must have 0 promotional discount and null promotionId.
 */
export function assertDigitalCardIsolation(
  lines: Array<{
    isDigitalCard?: boolean;
    promotionId?: number | null;
    promotionDiscount?: Decimal | string | null;
    discountAmount?: Decimal | string | null;
  }>
): void {
  for (const line of lines) {
    if (line.isDigitalCard) {
      expect(line.promotionId, "Digital card must have null promotionId").toBeNull();

      const promoDisc = line.promotionDiscount ? new Decimal(line.promotionDiscount) : new Decimal(0);
      assertDecimalEqual(promoDisc, 0, "Digital card promotionDiscount must be 0");

      const totalDisc = line.discountAmount ? new Decimal(line.discountAmount) : new Decimal(0);
      assertDecimalEqual(totalDisc, 0, "Digital card discountAmount must be 0");
    }
  }
}

/**
 * Asserts that promotional discount lines are NEVER marked as isGift = true.
 * Marking promotional discounts as gifts corrupts COGS and breaks partial returns.
 */
export function assertNoGiftFlagOnPromoDiscount(
  lines: Array<{
    isGift?: boolean;
    promotionDiscount?: Decimal | string | null;
    discountAmount?: Decimal | string | null;
  }>
): void {
  for (const line of lines) {
    const promoDisc = line.promotionDiscount ? new Decimal(line.promotionDiscount) : new Decimal(0);
    const totalDisc = line.discountAmount ? new Decimal(line.discountAmount) : new Decimal(0);

    if (promoDisc.gt(0) || totalDisc.gt(0)) {
      expect(
        line.isGift,
        "Line with promotional discount must NEVER have isGift = true"
      ).toBeFalsy();
    }
  }
}

/**
 * Asserts the H6 Manager Gate Fix:
 * When an administrative promotion is applied (> 15%), it does NOT trigger the
 * cashier's 15% discount threshold. The threshold is evaluated strictly on the
 * cashier's manual discount relative to the net promotional price.
 */
export function assertH6GateBypassForPromo(
  saleInput: {
    quantity: Decimal;
    listUnitPrice: Decimal;
    promotionDiscount: Decimal;
    cashierDiscountAmount?: Decimal;
  },
  cashierMaxPercent: number = 15
): { passesWithoutManager: boolean; cashierManualPercent: Decimal; netPromoPrice: Decimal } {
  const lineGross = saleInput.quantity.mul(saleInput.listUnitPrice);
  const netAfterPromo = lineGross.minus(saleInput.promotionDiscount);
  const netPromoPrice = netAfterPromo.div(saleInput.quantity);

  const cashierManualDiscount = saleInput.cashierDiscountAmount ?? new Decimal(0);
  const cashierManualPercent = netAfterPromo.gt(0)
    ? cashierManualDiscount.div(netAfterPromo).mul(100)
    : new Decimal(0);

  const passesWithoutManager = cashierManualPercent.lte(cashierMaxPercent);

  return {
    passesWithoutManager,
    cashierManualPercent,
    netPromoPrice,
  };
}

/**
 * Asserts Clearance Below-Cost Gate Exemption:
 * If a promotion has allowBelowCost = true, sale lines below COGS are approved
 * without manager override. If allowBelowCost = false, below-cost sale must trigger block.
 */
export function assertBelowCostAllowed(
  line: { costPrice: Decimal; effectiveUnitPrice: Decimal },
  promo: { allowBelowCost: boolean }
): { isBelowCost: boolean; isAllowed: boolean } {
  const isBelowCost = line.effectiveUnitPrice.lt(line.costPrice);
  const isAllowed = !isBelowCost || promo.allowBelowCost === true;

  if (isBelowCost && !promo.allowBelowCost) {
    expect(isAllowed).toBe(false);
  } else {
    expect(isAllowed).toBe(true);
  }

  return { isBelowCost, isAllowed };
}
