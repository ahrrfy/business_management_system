import { setImmediate as yieldImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import type { StorefrontProduct } from "../storefrontService";

const catalog = vi.hoisted(() => ({
  active: 0,
  maximum: 0,
  completed: 0,
  expected: 0,
  heartbeat: false,
  items: [] as StorefrontProduct[],
}));

vi.mock("../storefrontService", () => ({
  resolveStorefrontBranchId: async (branchId: number) => branchId,
  storefrontCatalog: vi.fn(async () => {
    catalog.active += 1;
    catalog.maximum = Math.max(catalog.maximum, catalog.active);
    await Promise.resolve();
    catalog.active -= 1;
    catalog.completed += 1;
    return { items: catalog.items, hasMore: false, nextCursor: null };
  }),
}));

import { storefrontCatalog } from "../storefrontService";

import {
  computeAlgorithmicThematicCollections,
  THEMATIC_ARCHETYPES,
} from "../storefrontThematicService";

function resetCatalog(): void {
  catalog.active = catalog.maximum = catalog.completed = 0;
  catalog.heartbeat = false;
  catalog.expected =
    new Set(THEMATIC_ARCHETYPES.flatMap((a) => a.categoryIds ?? [])).size +
    new Set(THEMATIC_ARCHETYPES.flatMap((a) => a.searchQueries ?? [])).size +
    2;
  catalog.items = Array.from(
    { length: 320 },
    (_, index): StorefrontProduct => ({
      productId: index + 1,
      productUnitId: index + 1,
      variantId: index + 1,
      productName: `دفتر سلك جامعي وقلم رصاص ${index}`,
      description: "دفاتر ومفكرات للدراسة والكتابة اليومية",
      brand: null,
      category: "الدفاتر المدرسية",
      categoryId: 21,
      unitName: "قطعة",
      price: "2500.00",
      salePrice: null,
      promotionName: null,
      inStock: true,
      imageUrl: "/images/synthetic.jpg",
      isCustomizable: false,
      customizationKind: null,
      customizationTemplate: null,
      isBundle: false,
      stockLeft: null,
      soldCount: 0,
      hasAlternatives: false,
    }),
  );
}

describe("thematic rebuild leaves capacity for cashier requests", () => {
  it("bounds the cold catalog fan-out without dropping candidates", async () => {
    resetCatalog();
    const result = await computeAlgorithmicThematicCollections(101);
    expect(catalog.completed).toBe(catalog.expected);
    expect(catalog.maximum).toBeLessThanOrEqual(2);
    expect(result.find((card) => card.id === "academic")?.itemCount).toBe(320);
    await yieldImmediate();
  });

  it("services an event-loop heartbeat before scoring a cold rebuild finishes", async () => {
    resetCatalog();
    let scheduled = false;
    Object.defineProperty(catalog.items[0], "description", {
      get() {
        if (!scheduled) {
          scheduled = true;
          setImmediate(() => {
            catalog.heartbeat = true;
          });
        }
        return "دفاتر ومفكرات للدراسة والكتابة اليومية";
      },
    });
    const result = await computeAlgorithmicThematicCollections(102);
    expect(result.length).toBeGreaterThan(0);
    expect(catalog.heartbeat).toBe(true);
    await yieldImmediate();
  });

  it("drains its running peer and stops launching work after a catalog failure", async () => {
    resetCatalog();
    vi.mocked(storefrontCatalog).mockClear();
    let releasePeer!: () => void;
    const heldPeer = new Promise<{
      items: StorefrontProduct[];
      hasMore: boolean;
      nextCursor: null;
    }>((resolve) => {
      releasePeer = () =>
        resolve({ items: [], hasMore: false, nextCursor: null });
    });
    vi.mocked(storefrontCatalog)
      .mockRejectedValueOnce(new Error("synthetic catalog failure"))
      .mockImplementationOnce(() => heldPeer);
    let settled = false;
    const outcome = computeAlgorithmicThematicCollections(103).then(
      () => {
        settled = true;
        return null;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    await yieldImmediate();
    const settledWhilePeerRunning = settled;
    const callsBeforeDrain = vi.mocked(storefrontCatalog).mock.calls.length;
    releasePeer();
    const error = await outcome;
    expect(error).toEqual(new Error("synthetic catalog failure"));
    expect(settledWhilePeerRunning).toBe(false);
    expect(callsBeforeDrain).toBe(2);
  });

  it("services I/O within an archetype after an expensive product", async () => {
    resetCatalog();
    catalog.items = catalog.items.slice(0, 2);
    let scheduled = false;
    let heartbeat = false;
    let heartbeatBeforeSecondProduct: boolean | undefined;
    Object.defineProperty(catalog.items[0], "description", {
      get() {
        if (!scheduled) {
          scheduled = true;
          setImmediate(() => {
            heartbeat = true;
          });
          const until = performance.now() + 12;
          while (performance.now() < until) {
            /* bounded synthetic CPU work */
          }
        }
        return "دفتر للدراسة";
      },
    });
    Object.defineProperty(catalog.items[1], "description", {
      get() {
        heartbeatBeforeSecondProduct ??= heartbeat;
        return "دفتر للدراسة";
      },
    });
    await computeAlgorithmicThematicCollections(104);
    expect(heartbeatBeforeSecondProduct).toBe(true);
  });
});
