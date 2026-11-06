import { describe, expect, it } from "vitest";
import {
  digitalPaymentChannel,
  parseReceptionSource,
  receptionIntentTotal,
  publicDigitalIntent,
} from "../receptionSource";

describe("reception digital source contract", () => {
  it("preserves contact identity and uses the reception evidence channel", () => {
    expect(parseReceptionSource({ version: 1, contactName: "طالب", contactPhone: "07800000000", cashRoundIQD: false }, "CARD"))
      .toMatchObject({ version: 1, contactName: "طالب", contactPhone: "07800000000" });
    expect(digitalPaymentChannel("RECEPTION")).toBe("PRINT_POS");
    expect(digitalPaymentChannel("POS")).toBe("POS");
    expect(digitalPaymentChannel("INVOICE")).toBe("POS");
  });

  it("rejects legacy/raw source payloads and credential-bearing additions", () => {
    for (const payload of [undefined, {}, { version: 2 }, { version: 1, managerApproval: { password: "secret" } }, { version: 1, delivery: {} }]) {
      expect(() => parseReceptionSource(payload, "CASH")).toThrow();
    }
    expect(() => parseReceptionSource({ version: 1 }, "CREDIT")).toThrow();
    expect(() => parseReceptionSource({ version: 1, cashRoundIQD: true }, "CARD")).toThrow();
  });

  it("freezes server cash rounding but never rounds a card payment", () => {
    expect(receptionIntentTotal("10100.00", parseReceptionSource({ version: 1, cashRoundIQD: true }, "CASH"))).toBe("10000.00");
    expect(receptionIntentTotal("10100.00", parseReceptionSource({ version: 1 }, "CARD"))).toBe("10100.00");
  });

  it("does not expose the server pricing/cost/approval snapshot to a selling station", () => {
    const result = publicDigitalIntent({ id: 7, branchId: 2, shiftId: 8, createdBy: 3, status: "PREPARED", paymentMethod: "CARD", expectedTotal: "250000.00", clientRequestId: "stable-key", expiresAt: new Date(0), invoiceId: null,
      checkoutSnapshot: { customerId: 5, priceTier: "RETAIL", sourceType: "RECEPTION", pricingGuard: { paidCostTotal: "90000.00" }, sourcePayload: { secret: "never" } }, externalPaymentAttemptId: 9, externalPaymentDeviceId: "device" });
    expect(result).toMatchObject({ id: 7, expectedTotal: "250000.00", customerId: 5, sourceType: "RECEPTION" });
    expect(JSON.stringify(result)).not.toMatch(/pricingGuard|paidCostTotal|sourcePayload|checkoutSnapshot|secret/);
  });
});
