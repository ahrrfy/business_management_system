import { describe, expect, it } from "vitest";
import {
  reconcileCustomerBalances,
  reconcileInventory,
  reconcileLedgerProfit,
} from "../reconcileService";

describe("تدقيق التوافق المالي (reconcileService)", () => {
  it("تُعيد reconcileCustomerBalances مصفوفة", async () => {
    const result = await reconcileCustomerBalances();
    expect(Array.isArray(result)).toBe(true);
  });

  it("تُعيد reconcileInventory مصفوفة", async () => {
    const result = await reconcileInventory();
    expect(Array.isArray(result)).toBe(true);
  });

  it("تُعيد reconcileLedgerProfit مصفوفة", async () => {
    const result = await reconcileLedgerProfit();
    expect(Array.isArray(result)).toBe(true);
  });

  it("لا انجراف في ذمم العملاء على بيانات البذر", async () => {
    const issues = await reconcileCustomerBalances();
    expect(issues).toHaveLength(0);
  });

  it("لا انجراف في مخزون الفروع على بيانات البذر", async () => {
    const issues = await reconcileInventory();
    expect(issues).toHaveLength(0);
  });
});
