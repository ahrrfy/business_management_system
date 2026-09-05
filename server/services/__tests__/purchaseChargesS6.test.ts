import { describe, expect, it } from "vitest";
import { assertChargeAllocationTotal, assertExpenseOnlyAccount } from "../purchase/purchaseCharges";

describe("purchase ancillary charge S6 contracts", () => {
  it("rejects capitalization and non-expense accounts", () => {
    expect(() => assertExpenseOnlyAccount({ type: "ASSET", isActive: true, systemRole: "INVENTORY" }, "PAID")).toThrow(/EXPENSE/);
    expect(assertExpenseOnlyAccount({ type: "EXPENSE", isActive: true, systemRole: "OPERATING_EXPENSE" }, "PAYABLE")).toBe("OPERATING_EXPENSE");
    expect(() => assertExpenseOnlyAccount({ type: "EXPENSE", isActive: true, systemRole: "COGS" }, "PAYABLE")).toThrow(/غير مدعوم/);
  });

  it("requires allocations to consume the full charge exactly", () => {
    expect(() => assertChargeAllocationTotal("125.00", [{ allocatedAmount: "25" }, { allocatedAmount: "100" }])).not.toThrow();
    expect(() => assertChargeAllocationTotal("125.00", [{ allocatedAmount: "124.99" }])).toThrow(/مجموع التوزيعات/);
  });
});
