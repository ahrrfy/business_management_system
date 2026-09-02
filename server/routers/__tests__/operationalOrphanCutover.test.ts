import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("operational orphan endpoint cutover", () => {
  it("retires legacy inventory wrappers in favor of governed canonical APIs", () => {
    const inventory = read("../inventoryRouter.ts");
    const baseline = JSON.parse(read("../../../scripts/orphan-endpoints-baseline.json")) as { orphans: string[] };

    expect(inventory).not.toMatch(/\n\s{2}transfer:\s*inventoryWarehouseProcedure/);
    expect(inventory).not.toContain("createManualMovement:");
    expect(inventory).not.toContain("stockByBranch:");
    expect(inventory).toContain("transferBatch: inventoryWarehouseProcedure");
    expect(inventory).toContain("onHand: inventoryReadProcedure");
    expect(baseline.orphans).not.toContain("inventory.transfer");
    expect(baseline.orphans).not.toContain("inventory.createManualMovement");
    expect(baseline.orphans).not.toContain("inventory.stockByBranch");
  });

  it("uses the POS pricing resolver instead of a duplicate active-today endpoint", () => {
    const promotions = read("../promotionsV2Router.ts");
    const posCatalog = read("../../services/catalog/pos.ts");
    const saleCreate = read("../../services/sale/create.ts");
    const baseline = JSON.parse(read("../../../scripts/orphan-endpoints-baseline.json")) as { orphans: string[] };

    expect(promotions).not.toContain("activeToday:");
    expect(posCatalog).toContain("resolvePromotionForLine");
    expect(saleCreate).toContain("resolvePromotionForLine");
    expect(baseline.orphans).not.toContain("salesPromotions.activeToday");
    expect(baseline.orphans).toEqual(["storefront.customerBenefitsPrivate"]);
  });
});
