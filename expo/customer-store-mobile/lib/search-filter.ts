import {
  effectiveProductMaxDiscountPercent,
  isDiscountedDealProduct,
} from "@/lib/deals-filter";
import { storefrontDisplayPrice } from "@/lib/storefront-api";
import type { Product } from "@/shared/storefront";

export type SearchAvailabilityFilter = "ALL" | "IN_STOCK" | "SALE";
export type SearchSortOrder =
  | "RELEVANCE"
  | "PRICE_ASC"
  | "PRICE_DESC"
  | "DISCOUNT";

function parseSortableDisplayPrice(product: Product): number | null {
  const raw = storefrontDisplayPrice(product);
  if (typeof raw !== "string" || !raw.trim()) return null;
  const numeric = Number(raw);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

export function filterAndSortSearchProducts(
  products: readonly Product[],
  options: {
    availability: SearchAvailabilityFilter;
    sort: SearchSortOrder;
  },
): Product[] {
  const { availability, sort } = options;
  const filtered = products.filter((product) => {
    if (availability === "SALE") {
      return isDiscountedDealProduct(product);
    }
    if (availability === "IN_STOCK") {
      return product.inStock !== false && product.availability === "متوفر";
    }
    return true;
  });

  if (sort === "RELEVANCE") {
    return filtered;
  }

  return [...filtered].sort((left, right) => {
    if (sort === "PRICE_ASC" || sort === "PRICE_DESC") {
      const leftPrice = parseSortableDisplayPrice(left);
      const rightPrice = parseSortableDisplayPrice(right);
      if (leftPrice === null && rightPrice === null) return 0;
      if (leftPrice === null) return 1;
      if (rightPrice === null) return -1;
      return sort === "PRICE_ASC"
        ? leftPrice - rightPrice
        : rightPrice - leftPrice;
    }
    if (sort === "DISCOUNT") {
      return (
        effectiveProductMaxDiscountPercent(right) -
        effectiveProductMaxDiscountPercent(left)
      );
    }
    return 0;
  });
}
