import { afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ product: vi.fn(), rows: vi.fn() }));
vi.mock("../../db", () => ({
  getDb: () => ({
    select: () => ({ from: () => ({ where: () => ({ limit: mocks.rows }) }) }),
  }),
}));
vi.mock("../storefrontService", () => ({ storefrontProduct: mocks.product }));
import { resolveStorefrontWishlistShare } from "../storefrontWishlistShareService";
afterEach(() => vi.resetAllMocks());
describe("bounded wishlist hydration", () => {
  it("preserves shared product order with two workers", async () => {
    mocks.rows.mockResolvedValue([
      { productIds: [4, 3, 2, 1, 5], expiresAt: new Date(Date.now() + 60_000) },
    ]);
    let active = 0,
      peak = 0;
    mocks.product.mockImplementation(async (id: number) => {
      active++;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active--;
      return { productId: id };
    });
    const result = await resolveStorefrontWishlistShare("synthetic-token");
    expect(result.items.map((r) => r.productId)).toEqual([4, 3, 2, 1, 5]);
    expect(peak).toBe(2);
  });
  it("does not abandon a running sibling when one product fails", async () => {
    mocks.rows.mockResolvedValue([
      { productIds: [1, 2, 3], expiresAt: new Date(Date.now() + 60_000) },
    ]);
    let release!: () => void;
    const hold = new Promise<void>((r) => {
      release = r;
    });
    mocks.product.mockImplementation(async (id: number) => {
      if (id === 1) throw new Error("product unavailable");
      await hold;
      return { productId: id };
    });
    const result = resolveStorefrontWishlistShare("synthetic-token");
    let settled = false;
    void result.catch(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await expect(result).rejects.toThrow("product unavailable");
    expect(mocks.product.mock.calls.map((r) => r[0])).toEqual([1, 2]);
  });
});
