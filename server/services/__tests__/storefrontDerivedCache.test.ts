import { describe, expect, it } from "vitest";
import * as ranking from "../storefrontDerivedCache";

describe("cooperative storefront candidate ranking", () => {
  it("admits queued requests while ranking a large cold catalog and preserves every id", async () => {
    const seen = new Set<number>();
    const rows = Array.from({ length: 30_000 }, (_, index) => ({
      productId: index + 1,
      conversionFactor: "1",
      isFeatured: false,
      get productName() {
        seen.add(index);
        return `دفتر مدرسي ${index}`;
      },
      storeTitle: null,
      brand: null,
      hasImage: 1,
      availableQty: 10,
    }));
    let processed = -1;
    const heartbeat = new Promise<void>((resolve) =>
      setImmediate(() => {
        processed = seen.size;
        resolve();
      }),
    );
    // Running against the original synchronous implementation demonstrates the starvation first.
    const rank =
      Reflect.get(ranking, "chooseCandidateProductIdsAsync") ??
      ranking.chooseCandidateProductIds;
    const ids: number[] = await rank(rows, rows.length, "ALL", "دفتر");
    await heartbeat;
    expect(processed).toBeGreaterThan(0);
    expect(processed).toBeLessThan(rows.length);
    expect(ids).toEqual(
      ranking.chooseCandidateProductIds(rows, rows.length, "ALL", "دفتر"),
    );
    expect(new Set(ids).size).toBe(rows.length);
  });
});
