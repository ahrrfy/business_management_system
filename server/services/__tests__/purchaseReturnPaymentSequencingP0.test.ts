import { describe, expect, it } from "vitest";
import { requiresCashShift, reversalAmountWithFinalResidual, usdAtAgreedRate } from "../purchase/returnGovernance";
import { effectiveInvoicePayable } from "../purchase/supplierPayments";

describe("purchase return/payment sequencing P0", () => {
  it("reduces payable by net CREDIT returns and restores it on reversal", () => {
    expect(effectiveInvoicePayable("1000.00", "250.00").toFixed(2)).toBe("750.00");
    expect(effectiveInvoicePayable("1000.00", "0.00").toFixed(2)).toBe("1000.00");
    expect(effectiveInvoicePayable("100.00", "150.00").toFixed(2)).toBe("0.00");
  });

  it("keeps cash custody context exclusive to physical cash", () => {
    expect(requiresCashShift("CASH", "CASH")).toBe(true);
    expect(requiresCashShift("CASH", "TRANSFER")).toBe(false);
    expect(requiresCashShift("CREDIT", "CASH")).toBe(false);
  });

  it("derives USD balance movements at the invoice agreed rate", () => {
    expect(usdAtAgreedRate("131000.00", "1310.0000").toFixed(2)).toBe("100.00");
    expect(() => usdAtAgreedRate("100", null)).toThrow(/سعر صرف/);
  });

  it("absorbs proportional cents in the final reversal instead of leaving AP dust", () => {
    const first = reversalAmountWithFinalResidual("100.00", 3, 1, 0, "0.00");
    const second = reversalAmountWithFinalResidual("100.00", 3, 1, 1, first);
    const final = reversalAmountWithFinalResidual("100.00", 3, 1, 2, first.plus(second));
    expect([first, second, final].map((amount) => amount.toFixed(2))).toEqual(["33.33", "33.33", "33.34"]);
    expect(first.plus(second).plus(final).toFixed(2)).toBe("100.00");
  });
});
