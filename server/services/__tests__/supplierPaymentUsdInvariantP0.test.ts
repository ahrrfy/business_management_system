import { describe, expect, it } from "vitest";
import { assertAgreedRateAmount, sortedUniquePurchaseOrderIds } from "../purchase/supplierPayments";

describe("supplier payment USD/race invariants P0", () => {
  it("enforces IQD = currency amount × agreed rate within final rounding", () => {
    expect(() => assertAgreedRateAmount("131000.00", "100.00", "1310.0000", "دفعة")).not.toThrow();
    expect(() => assertAgreedRateAmount("1310.01", "1.00", "1310.0000", "دفعة")).toThrow(/لا يساوي/);
    expect(() => assertAgreedRateAmount("436.67", "0.333333", "1310.0000", "تخصيص")).not.toThrow();
  });

  it("canonicalizes concurrent aggregate locks by ascending unique PO id", () => {
    expect(sortedUniquePurchaseOrderIds([9, 2, 9, 4, 0, -1])).toEqual([2, 4, 9]);
    expect(sortedUniquePurchaseOrderIds([4, 2, 9])).toEqual([2, 4, 9]);
  });
});
