import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "../../context";

const state = vi.hoisted(() => ({ owner: null as Record<string, unknown> | null }));
vi.mock("../../services/catalog/barcodeAliases", () => ({
  resolveBarcodeOwner: async () => state.owner,
}));
vi.mock("../../db", () => ({
  getDb: () => ({
    select: (fields: Record<string, unknown>) => {
      const rows = "variantId" in fields
        ? [{ variantId: 9, productId: 5, productName: "دفتر", sku: "NOTEBOOK-A4", costPrice: "2345.67" }]
        : "costPrice" in fields ? [{ costPrice: "2345.67" }]
        : "unitName" in fields ? [{ id: 12, unitName: "قطعة", barcode: "123456789" }]
        : "price" in fields ? [{ price: "5000.00" }]
        : "quantity" in fields ? [{ quantity: 12 }]
        : "minPrice" in fields ? [{ minPrice: "4500.00" }] : [];
      const chain: Record<string, unknown> = {
        then: (resolve: (value: unknown) => unknown) => Promise.resolve(rows).then(resolve),
      };
      for (const key of ["from", "innerJoin", "leftJoin", "where", "limit"]) chain[key] = () => chain;
      return chain;
    },
  }),
}));

import { returnRouter } from "../returnRouter";
import { router } from "../../trpc";

const api = router({ returns: returnRouter });

function caller(options: { role?: string; enabled?: boolean; purchaseCost?: boolean; profitMargin?: boolean; isOwner?: boolean } = {}) {
  return api.createCaller({
    req: { headers: {} }, res: {},
    user: {
      id: 41, role: options.role ?? "cashier", branchId: 3, isActive: true,
      isOwner: options.isOwner ?? false,
      operationPolicyEnabled: options.enabled ?? true,
      resolvedOperationPolicy: {
        version: 1,
        grants: { "operation.returns.create": true, "operation.returns.lookupItemForReturn": true },
        dataVisibility: { purchaseCost: options.purchaseCost ?? false, profitMargin: options.profitMargin ?? false },
      },
    },
  } as unknown as TrpcContext).returns;
}

beforeEach(() => { state.owner = null; });

function useBarcode() {
  state.owner = {
    productId: 5, variantId: 9, productUnitId: 12, productName: "دفتر", unitName: "قطعة",
    primaryBarcode: "123456789", sku: "NOTEBOOK-A4",
  };
}

describe("return item lookup cost privacy", () => {
  it("keeps SKU lookup operational while hiding purchase cost without its independent permission", async () => {
    const result = await caller().lookupItemForReturn({ barcode: "NOTEBOOK-A4" });
    expect(result).toMatchObject({
      variantId: 9, retailPrice: "5000.00", lowestHistoricalPrice: "4500.00", currentStock: 12,
      costPrice: null,
    });
  });

  it("also hides cost on the resolved barcode path without requiring reports access", async () => {
    useBarcode();
    const result = await caller().lookupItemForReturn({ barcode: "123456789" });
    expect(result).toMatchObject({ variantId: 9, retailPrice: "5000.00", currentStock: 12, costPrice: null });
  });

  it.each(["SKU", "BARCODE"])("honors explicit cost visibility for a delegated cashier on %s", async (path) => {
    if (path === "BARCODE") useBarcode();
    const result = await caller({ purchaseCost: true, profitMargin: true })
      .lookupItemForReturn({ barcode: path === "SKU" ? "NOTEBOOK-A4" : "123456789" });
    expect(result?.costPrice).toBe("2345.67");
  });

  it("honors a canonical visibility denial despite the managerial base role", async () => {
    const result = await caller({ role: "manager" }).lookupItemForReturn({ barcode: "NOTEBOOK-A4" });
    expect(result?.costPrice).toBeNull();
  });

  it("does not weaken the existing combined cost-and-margin visibility rule", async () => {
    const result = await caller({ purchaseCost: true, profitMargin: false })
      .lookupItemForReturn({ barcode: "NOTEBOOK-A4" });
    expect(result?.costPrice).toBeNull();
  });

  it.each(["admin", "manager"])("preserves legacy %s cost visibility", async (role) => {
    const result = await caller({ role, enabled: false }).lookupItemForReturn({ barcode: "NOTEBOOK-A4" });
    expect(result?.costPrice).toBe("2345.67");
  });

  it("preserves owner visibility", async () => {
    const result = await caller({ role: "admin", isOwner: true }).lookupItemForReturn({ barcode: "NOTEBOOK-A4" });
    expect(result?.costPrice).toBe("2345.67");
  });
});
