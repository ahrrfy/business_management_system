import { describe, expect, it } from "vitest";
import { branchStock, inventoryMovements, invoiceItemServiceMaterials, workOrderMaterials } from "../../../drizzle/schema";
import { exactRecipeMaterialQuantity } from "../serviceRecipeConsumption";

describe("fractional material persistence contract", () => {
  it("executes a fractional recipe without rounding", () => {
    expect(exactRecipeMaterialQuantity("1.5000", 1)).toBe(1.5);
    expect(exactRecipeMaterialQuantity("0.0001", 1)).toBe(0.0001);
    expect(() => exactRecipeMaterialQuantity("0.00001", 1)).toThrow();
  });

  it("stores fractional balances, movements and historical material snapshots", () => {
    for (const column of [branchStock.quantity, inventoryMovements.quantity, inventoryMovements.signedDelta, invoiceItemServiceMaterials.baseQuantity, workOrderMaterials.baseQuantity]) {
      expect(column.getSQLType()).toBe("decimal(15,4)");
      expect(column.mapToDriverValue(1.5)).toBe("1.5000");
      expect(column.mapFromDriverValue("1.5000")).toBe(1.5);
    }
  });
});
