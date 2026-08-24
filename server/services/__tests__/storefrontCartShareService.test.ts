import { describe, expect, it } from "vitest";

import { normalizeStorefrontCartShareLines } from "../storefrontCartShareService";

describe("storefront cart share normalization", () => {
  it("rejects invalid IDs, merges duplicate units, and caps quantities", () => {
    expect(normalizeStorefrontCartShareLines([
      { productId: 0, productUnitId: 1, quantity: 1 },
      { productId: 10, productUnitId: 0, quantity: 1 },
      { productId: 10, productUnitId: 101, quantity: 900 },
      { productId: 10, productUnitId: 101, quantity: 200 },
      { productId: 11, productUnitId: 102, quantity: 2 },
    ])).toEqual([
      { productId: 10, productUnitId: 101, quantity: 999 },
      { productId: 11, productUnitId: 102, quantity: 2 },
    ]);
  });
});
