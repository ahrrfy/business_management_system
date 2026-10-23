import { describe, expect, it } from "vitest";
import { receptionPaymentAmounts } from "./receptionPaymentAmounts";

const base = { paid: "0", expectedNow: "40000", hasExplicitAmount: false, directNet: "50000", deferred: false, quickFullPay: false, isReservation: false, method: "CARD" };

describe("reception current goods collection", () => {
  it("collects only the remaining goods after a previous deposit", () => {
    const payment = receptionPaymentAmounts(base);
    expect(payment.appliedPaidD.toFixed(2)).toBe("40000.00");
    expect(payment.appliedPaidD.plus(5000).toFixed(2)).toBe("45000.00");
  });
  it("keeps a reservation with no new goods payment at zero", () => {
    expect(receptionPaymentAmounts({ ...base, isReservation: true }).appliedPaidD.toFixed(2)).toBe("0.00");
  });
  it("preserves an explicit partial deposit for a custom work order", () => {
    expect(receptionPaymentAmounts({ ...base, paid: "10000", hasExplicitAmount: true, directNet: "0" }).appliedPaidD.toFixed(2)).toBe("10000.00");
  });
  it("caps applied cash while retaining the actual amount for change", () => {
    const payment = receptionPaymentAmounts({ ...base, method: "CASH", paid: "50000", hasExplicitAmount: true });
    expect(payment.inputPaidD.minus(payment.appliedPaidD).toFixed(2)).toBe("10000.00");
    expect(payment.appliedPaidD.toFixed(2)).toBe("40000.00");
  });
  it("switches a partial entry to full collection only for the explicit full-payment action", () => {
    expect(receptionPaymentAmounts({ ...base, paid: "10000", hasExplicitAmount: true, quickFullPay: true }).appliedPaidD.toFixed(2)).toBe("40000.00");
  });
});
