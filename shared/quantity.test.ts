import { describe, expect, it } from "vitest";
import { addQuantities, multiplyQuantities, quantityNumber, subtractQuantities, toDbQuantity } from "./quantity";

describe("exact four-place inventory quantities", () => {
  it("preserves fractional consumption through repeated operations", () => {
    let stock = 10;
    for (let index = 0; index < 10; index++) stock = subtractQuantities(stock, "0.1");
    expect(stock).toBe(9);
    expect(subtractQuantities(10, "1.5")).toBe(8.5);
    expect(addQuantities("0.1", "0.2")).toBe(0.3);
    expect(multiplyQuantities("0.0001", 3)).toBe(0.0003);
  });

  it("round-trips storage precision without changing numeric read contracts", () => {
    for (const value of ["0.0001", "1.5000", "2147483647", "99999999999.9999", "-99999999999.9999"]) {
      expect(toDbQuantity(quantityNumber(value))).toBe(toDbQuantity(value));
    }
    expect(toDbQuantity("1.5")).toBe("1.5000");
  });

  it.each(["0.00001", "100000000000", "NaN", "Infinity", "", 0.1 + 0.2])("rejects unrepresentable quantity %s instead of rounding", (value) => {
    expect(() => quantityNumber(value)).toThrow();
  });
});
