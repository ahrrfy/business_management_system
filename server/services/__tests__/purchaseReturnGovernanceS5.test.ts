import { describe, expect, it } from "vitest";
import { assertExpectedVersion, assertIndependentPurchaseReviewer, proportionalReturnAmount } from "../purchase/returnGovernance";

describe("purchase return governance S5 contracts", () => {
  it("enforces maker-checker without an admin bypass", () => {
    expect(() => assertIndependentPurchaseReviewer(7, 7)).toThrow(/فصل المهام/);
    expect(() => assertIndependentPurchaseReviewer(7, 8)).not.toThrow();
  });

  it("fails closed on stale document versions", () => {
    expect(() => assertExpectedVersion(3, 2, "فاتورة المورد")).toThrow(/تغيّرت نسخة/);
  });

  it("derives return money proportionally from the matched source", () => {
    expect(proportionalReturnAmount("100.00", 3, 10).toFixed(2)).toBe("30.00");
    expect(() => proportionalReturnAmount("100.00", 11, 10)).toThrow(/كمية المرتجع/);
  });
});
