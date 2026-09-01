import { describe, expect, it } from "vitest";
import { assertPurchaseChargeSettlementSupported } from "../purchase/purchaseCharges";

describe("purchase charge PAYABLE fail-closed P0", () => {
  it("allows atomic paid charges and rejects unlinked accruals", () => {
    expect(() => assertPurchaseChargeSettlementSupported("PAID")).not.toThrow();
    expect(() => assertPurchaseChargeSettlementSupported("PAYABLE")).toThrow(/مغلق احترازياً/);
  });
});
