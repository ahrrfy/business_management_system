import { describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
}));
vi.mock("../../db", () => ({
  closeDb: async () => {}, // The integration runner also imports closeDb in its cleanup hook.
  getDb: () => {
    const query = {
      select: () => query,
      from: () => query,
      innerJoin: () => query,
      leftJoin: () => query,
      where: async () => fixture.rows,
    };
    return query;
  },
}));
import { loadStorefrontSearchMatches } from "../storefrontSearchIndex";

describe("storefront search index responsiveness", () => {
  it("serves a queued event during cold indexing instead of monopolizing the worker", async () => {
    const seen = new Set<number>();
    fixture.rows = Array.from({ length: 30_000 }, (_, index) => ({
      productId: index + 1,
      productUnitId: index + 1,
      variantId: index + 1,
      conversionFactor: "1",
      price: "1000.00",
      get productName() {
        seen.add(index);
        return `دَفْتَر ١٠٠ ورقة A5 ${index}`;
      },
      storeTitle: "دفتر مدرسي",
      categoryId: 1,
      category: "دفاتر",
      brand: "TEST",
      barcode: String(index),
    }));
    let indexedAtHeartbeat = -1;
    const heartbeat = new Promise<void>((resolve) =>
      setImmediate(() => {
        indexedAtHeartbeat = seen.size;
        resolve();
      }),
    );
    const matches = await loadStorefrontSearchMatches("دفتر", {}, true);
    await heartbeat;
    expect(indexedAtHeartbeat).toBeGreaterThan(0);
    expect(indexedAtHeartbeat).toBeLessThan(fixture.rows.length);
    expect(matches).toHaveLength(fixture.rows.length);
    expect(new Set(matches.map((row) => row.productUnitId)).size).toBe(
      fixture.rows.length,
    );
  });
});
