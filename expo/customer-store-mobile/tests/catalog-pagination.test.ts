import { describe, expect, it } from "vitest";

import { mergeCatalogPage } from "@/lib/catalog-pagination";
import type { Product } from "@/shared/storefront";

const product = (id: number) => ({ id: String(id) }) as Product;

describe("catalog cursor pagination", () => {
  it("appends pages, deduplicates products and preserves the next cursor", () => {
    const first = mergeCatalogPage([], { items: [product(1), product(2)], hasMore: true, nextCursor: 2 });
    const next = mergeCatalogPage(first.products, { items: [product(2), product(3)], hasMore: false, nextCursor: null });
    expect(next.products.map((item) => item.id)).toEqual(["1", "2", "3"]);
    expect(next.hasMore).toBe(false);
    expect(next.nextCursor).toBeNull();
  });
});
