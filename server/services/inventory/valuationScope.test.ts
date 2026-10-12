import { describe, expect, it, vi } from "vitest";
vi.mock("./valuation", () => ({ readInventoryValuation: vi.fn() }));
import { scopeHistoricalValuation, type HistoricalValuation } from "./valuationSnapshot";

describe("delegated historical valuation branch isolation", () => {
  const company: HistoricalValuation = {
    source: "SNAPSHOT", cutoffDate: "2026-09-30",
    stockValue: "1000.00", inTransitValue: "50.00", totalValue: "1050.00",
    branches: [{ branchId: 1, value: "700.00", inTransitValue: "40.00" },
      { branchId: 2, value: "300.00", inTransitValue: "10.00" }],
  };
  it.each(["SNAPSHOT", "LIVE"] as const)("recomputes all %s totals from the assigned branch", (source) => {
    expect(scopeHistoricalValuation({ ...company, source }, 2)).toMatchObject({
      source, branches: [company.branches[1]], stockValue: "300.00",
      inTransitValue: "10.00", totalValue: "310.00",
    });
    expect(company.totalValue).toBe("1050.00");
  });
  it("returns zero for a branch absent from the snapshot instead of company totals", () => {
    expect(scopeHistoricalValuation(company, 3)).toMatchObject({ branches: [], stockValue: "0.00", inTransitValue: "0.00", totalValue: "0.00" });
  });
  it("retains the complete company view for an unscoped authorized reader", () => {
    expect(scopeHistoricalValuation(company)).toBe(company);
  });
});
