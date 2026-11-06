import { describe, expect, it } from "vitest";
import { digitalRefundMethodAllowed } from "../../../../shared/digitalPaymentSettlement";
import { digitalSettlementAmounts } from "../settlementMath";

describe("digital collection/refund allocations", () => {
  it("reconciles one original capture to issued cards, ordinary goods and the refund", () => {
    expect(digitalSettlementAmounts({ captured: "250000.00", issuedPrices: ["150000"], regularSubtotal: "3000", regularDisposition: "SELL", unknownCount: 0, cashRound: false }))
      .toEqual({ capturedAmount: "250000.00", saleAmount: "153000.00", refundAmount: "97000.00" });
    expect(digitalSettlementAmounts({ captured: "250000.00", issuedPrices: [], regularSubtotal: "3000", regularDisposition: "RELEASE", unknownCount: 0, cashRound: false }).refundAmount).toBe("250000.00");
  });
  it("keeps the original amount immutable and refuses unknown outcomes/over-allocation", () => {
    const base = { captured: "100", issuedPrices: ["90"], regularSubtotal: "0", regularDisposition: "SELL" as const, unknownCount: 0, cashRound: false };
    expect(() => digitalSettlementAmounts({ ...base, unknownCount: 1 })).toThrow();
    expect(() => digitalSettlementAmounts({ ...base, issuedPrices: ["101"] })).toThrow();
  });
  it("applies cash rounding to the actual sale without changing the original capture", () => {
    expect(digitalSettlementAmounts({ captured: "20250", issuedPrices: ["10100"], regularSubtotal: "0", regularDisposition: "SELL", unknownCount: 0, cashRound: true }))
      .toEqual({ capturedAmount: "20250.00", saleAmount: "10000.00", refundAmount: "10250.00" });
  });
  it("allows the approved refund directions only", () => {
    expect(digitalRefundMethodAllowed("CASH", "CASH")).toBe(true);
    expect(digitalRefundMethodAllowed("CASH", "CARD")).toBe(false);
    expect(digitalRefundMethodAllowed("CARD", "CARD")).toBe(true);
    expect(digitalRefundMethodAllowed("CARD", "CASH")).toBe(true);
    expect(digitalRefundMethodAllowed("unknown", "CASH")).toBe(false);
  });
});
