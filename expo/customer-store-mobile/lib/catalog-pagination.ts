import type { Product } from "@/shared/storefront";

export type CatalogProductPage = {
  items: Product[];
  hasMore: boolean;
  nextCursor: number | null;
};

export function mergeCatalogPage(
  current: readonly Product[],
  page: CatalogProductPage,
): { products: Product[]; hasMore: boolean; nextCursor: number | null } {
  const merged = new Map(current.map((item) => [item.id, item]));
  for (const item of page.items) merged.set(item.id, item);
  return {
    products: Array.from(merged.values()),
    hasMore: page.hasMore && page.nextCursor != null,
    nextCursor: page.hasMore ? page.nextCursor : null,
  };
}
