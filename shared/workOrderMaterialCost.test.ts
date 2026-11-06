import { describe, expect, it } from "vitest";
import { splitWorkOrderMaterialValue, workOrderMaterialValue } from "./workOrderMaterialCost";

describe("work-order material value snapshots", () => {
  it("carries the penny residual through a partial fractional return", () => {
    const first = splitWorkOrderMaterialValue({ baseQuantity: 0.5, unitCost: "0.01", lineCost: "0.01" }, 0.1);
    expect(first.returnedValue.toFixed(2)).toBe("0.00");
    expect(first.remainingValue.toFixed(2)).toBe("0.01");
    const last = splitWorkOrderMaterialValue({ baseQuantity: 0.4, unitCost: "0.01", lineCost: first.remainingValue }, 0.4);
    expect(last.returnedValue.toFixed(2)).toBe("0.01");
    expect(last.remainingValue.toFixed(2)).toBe("0.00");
  });

  it("never recreates value from an authoritative zero remainder", () => {
    const first = splitWorkOrderMaterialValue({ baseQuantity: 0.7, unitCost: "0.02", lineCost: "0.01" }, 0.42);
    expect(first.returnedValue.toFixed(2)).toBe("0.01");
    expect(first.remainingValue.toFixed(2)).toBe("0.00");
    expect(workOrderMaterialValue({ baseQuantity: 0.28, unitCost: "0.02", lineCost: "0.00" }).toFixed(2)).toBe("0.00");
  });

  it("reads an integer legacy batch with its original unit cost", () => {
    expect(workOrderMaterialValue({ baseQuantity: 2, unitCost: "3.33", lineCost: null }).toFixed(2)).toBe("6.66");
  });

  it("fails closed for a fractional batch without an issued-value snapshot", () => {
    expect(() => workOrderMaterialValue({ baseQuantity: 0.5, unitCost: "0.01", lineCost: null })).toThrow(/لقطة/);
  });

  it("preserves the primary material batch value when only the surplus is returned", () => {
    const split = splitWorkOrderMaterialValue({ baseQuantity: 1.5, unitCost: "0.03", lineCost: "0.05" }, 0.5);
    expect(split.returnedValue.toFixed(2)).toBe("0.02");
    expect(split.remainingValue.toFixed(2)).toBe("0.03");
  });

  it("rejects quantities outside the batch or inventory precision", () => {
    const source = { baseQuantity: 0.5, unitCost: "1.00", lineCost: "0.50" };
    for (const amount of [-0.1, 0.6, 0.00001, Number.NaN]) {
      expect(() => splitWorkOrderMaterialValue(source, amount)).toThrow();
    }
  });

  it("rejects invalid or over-precise monetary snapshots", () => {
    for (const lineCost of ["-0.01", "NaN", "Infinity", "0.001"]) {
      expect(() => workOrderMaterialValue({ baseQuantity: 1, unitCost: "1.00", lineCost })).toThrow();
    }
  });
});
