import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { assertUniqueReceiveLines, cumulativePurchaseTax } from "../purchaseService";
import { refundablePurchaseCash } from "../purchaseReturnsService";

describe("purchase financial integrity guards", () => {
  it("rejects the same PO item repeated in one receipt", () => {
    expect(() =>
      assertUniqueReceiveLines([{ purchaseOrderItemId: 7 }, { purchaseOrderItemId: 7 }]),
    ).toThrow(/تكرار بند أمر الشراء/);
  });

  it("absorbs the final partial-receipt tax remainder", () => {
    const first = cumulativePurchaseTax("1.00", "0.00", new Decimal(1), new Decimal(1).div(3), false);
    const second = cumulativePurchaseTax("1.00", first.toFixed(2), new Decimal(1), new Decimal(1).div(3), false);
    const last = cumulativePurchaseTax("1.00", first.plus(second).toFixed(2), new Decimal(1), new Decimal(1).div(3), true);
    expect(first.plus(second).plus(last).toFixed(2)).toBe("1.00");
    expect(last.toFixed(2)).toBe("0.34");
  });

  it("caps a supplier cash refund at the payment proven on the PO", () => {
    expect(refundablePurchaseCash(new Decimal(100), new Decimal(0), new Decimal(0)).toFixed(2)).toBe("0.00");
    expect(refundablePurchaseCash(new Decimal(100), new Decimal(40), new Decimal(0)).toFixed(2)).toBe("40.00");
    expect(refundablePurchaseCash(new Decimal(100), new Decimal(100), new Decimal(30)).toFixed(2)).toBe("70.00");
  });
});
