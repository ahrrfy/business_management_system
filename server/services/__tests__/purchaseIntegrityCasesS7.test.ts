import { describe, expect, it } from "vitest";
import { LEGACY_PURCHASE_MUTATION_REPLACEMENTS, rejectLegacyPurchaseMutation } from "../purchase/legacyWriteGuard";

describe("purchase S7 fail-closed contracts", () => {
  it("maps every legacy aggregate writer to its governed replacement", () => {
    expect(LEGACY_PURCHASE_MUTATION_REPLACEMENTS).toEqual({
      "purchases.receive": "goodsReceipts.create",
      "purchases.pay": "supplierPayments.requestPayment",
      "purchaseReturns.create": "purchaseReturnGovernance.requestReturn",
    });
  });

  it("returns PRECONDITION_FAILED rather than writing through a legacy path", () => {
    expect(() => rejectLegacyPurchaseMutation("purchases.pay")).toThrow(/supplierPayments\.requestPayment/);
  });
});
