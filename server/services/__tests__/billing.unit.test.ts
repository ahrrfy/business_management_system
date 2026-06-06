import { describe, expect, it } from "vitest";
import { computeInvoiceCost, computeInvoiceTotals, computeLineTotal } from "../billing";
import { money, round2, toDbMoney } from "../money";
import { computeInvoiceStatus } from "../ledgerService";
import { resolveTier } from "../pricing";

describe("money rounding (HALF_UP, 2dp)", () => {
  it("rounds half up", () => {
    expect(round2("0.125").toFixed(2)).toBe("0.13");
    expect(round2("0.124").toFixed(2)).toBe("0.12");
    expect(toDbMoney("100")).toBe("100.00");
  });
  it("avoids float drift", () => {
    expect(money("0.1").plus(money("0.2")).toFixed(2)).toBe("0.30");
  });
});

describe("computeLineTotal", () => {
  it("unitPrice × quantity with no discount", () => {
    const r = computeLineTotal({ unitPrice: money("120.00"), quantity: money("1") });
    expect(r.total).toBe("120.00");
    expect(r.discountAmount).toBe("0.00");
  });
  it("percent discount", () => {
    const r = computeLineTotal({ unitPrice: money("100"), quantity: money("2"), discountPercent: "10" });
    expect(r.total).toBe("180.00");
    expect(r.discountAmount).toBe("20.00");
  });
  it("amount discount overrides percent and is clamped to gross", () => {
    const r = computeLineTotal({ unitPrice: money("50"), quantity: money("1"), discountAmount: "999" });
    expect(r.discountAmount).toBe("50.00");
    expect(r.total).toBe("0.00");
  });
});

describe("computeInvoiceTotals", () => {
  it("tax computed once on (subtotal − discount), to the cent", () => {
    const t = computeInvoiceTotals({ lineTotals: ["33.33", "33.33", "33.34"], taxRatePercent: "15" });
    expect(t.subtotal).toBe("100.00");
    expect(t.taxAmount).toBe("15.00");
    expect(t.total).toBe("115.00");
  });
  it("invoice discount reduces taxable base", () => {
    const t = computeInvoiceTotals({ lineTotals: ["200.00"], invoiceDiscount: "50", taxRatePercent: "10" });
    expect(t.subtotal).toBe("200.00");
    expect(t.discountAmount).toBe("50.00");
    expect(t.taxAmount).toBe("15.00"); // 10% of 150
    expect(t.total).toBe("165.00");
  });
  it("no tax by default", () => {
    const t = computeInvoiceTotals({ lineTotals: ["100.00"] });
    expect(t.taxAmount).toBe("0.00");
    expect(t.total).toBe("100.00");
  });
});

describe("computeInvoiceCost (COGS)", () => {
  it("Σ unitCost × baseQuantity", () => {
    expect(computeInvoiceCost([{ unitCost: "4.00", baseQuantity: 12 }])).toBe("48.00");
    expect(computeInvoiceCost([{ unitCost: "4.00", baseQuantity: 12 }, { unitCost: "2.50", baseQuantity: 4 }])).toBe("58.00");
  });
});

describe("computeInvoiceStatus", () => {
  it("maps paid amount to status", () => {
    expect(computeInvoiceStatus("100.00", "0.00")).toBe("PENDING");
    expect(computeInvoiceStatus("100.00", "40.00")).toBe("PARTIALLY_PAID");
    expect(computeInvoiceStatus("100.00", "100.00")).toBe("PAID");
    expect(computeInvoiceStatus("100.00", "130.00")).toBe("PAID");
  });
});

describe("resolveTier", () => {
  it("override → customer → RETAIL", () => {
    expect(resolveTier({ override: "WHOLESALE", customerTier: "GOVERNMENT" })).toBe("WHOLESALE");
    expect(resolveTier({ customerTier: "GOVERNMENT" })).toBe("GOVERNMENT");
    expect(resolveTier({})).toBe("RETAIL");
  });
});
