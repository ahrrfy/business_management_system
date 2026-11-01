import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ product: vi.fn(), rows: vi.fn() }));
vi.mock("../../db", () => ({ getDb: () => ({ select: () => ({ from: () => ({ where: () => ({ limit: mocks.rows }) }) }) }) }));
vi.mock("../storefrontService", () => ({ storefrontProduct: mocks.product }));
import { normalizeStorefrontCartShareLines, resolveStorefrontCartShare } from "../storefrontCartShareService";
afterEach(() => vi.resetAllMocks());

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
  it("hydrates with two workers while preserving line order and current unit prices", async () => {
    mocks.rows.mockResolvedValue([{ lines: [3, 1, 2, 4].map((id) => ({ productId: id, productUnitId: id, quantity: 2 })), expiresAt: new Date(Date.now() + 60_000) }]);
    let active = 0, peak = 0;
    mocks.product.mockImplementation(async (id: number) => {
      active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, id % 2)); active--;
      return { productId: id, productName: String(id), imageUrl: null, storeUnits: [{ productUnitId: id, price: "1000.00", unitName: "piece" }] };
    });
    const result = await resolveStorefrontCartShare("synthetic-token");
    expect(peak).toBe(2); expect(result.items.map((r) => r.productId)).toEqual([3, 1, 2, 4]);
    expect(result.items.every((r) => r.price === "1000.00")).toBe(true);
  });
});
