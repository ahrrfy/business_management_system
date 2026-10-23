import { money } from "./money";

export type StorefrontPriceFilter =
  | "ALL"
  | "UNDER_5000"
  | "FROM_5000_TO_15000"
  | "OVER_15000";
export type StorefrontCatalogSort =
  | "RECOMMENDED"
  | "PRICE_ASC"
  | "PRICE_DESC"
  | "BEST_SELLERS";
export interface StorefrontCatalogRefinements {
  brand?: string;
  priceFilter?: StorefrontPriceFilter;
  sort?: StorefrontCatalogSort;
}

/** Catalog cards and search previews refine the same displayed, promotion-adjusted price. */
export function matchesStorefrontRefinements(
  product: {
    brand?: string | null;
    price: string | null;
    salePrice: string | null;
  },
  input: StorefrontCatalogRefinements,
): boolean {
  if (input.brand?.trim() && product.brand?.trim() !== input.brand.trim())
    return false;
  const price = money(product.salePrice ?? product.price ?? "0");
  switch (input.priceFilter) {
    case "UNDER_5000":
      return price.lt(5000);
    case "FROM_5000_TO_15000":
      return price.gte(5000) && price.lte(15000);
    case "OVER_15000":
      return price.gt(15000);
    default:
      return true;
  }
}

interface Candidate {
  productId: number;
  productUnitId: number;
  variantId: number;
  categoryId: number | null;
  brand: string | null;
  price: string | null;
  conversionFactor: string;
  availableQty: number;
}
interface Preview extends Candidate {
  salePrice: string | null;
  promotionName: string | null;
  soldCount: number;
}

/** Scalar metadata only: do not hydrate galleries, reviews, colors or descriptions to sort a catalog. */
export async function refineStorefrontProductIds(
  rows: Candidate[],
  orderedIds: readonly number[],
  input: StorefrontCatalogRefinements & { availability: "IN_STOCK" | "ALL" },
  applyPromotions: (previews: Preview[]) => Promise<void>,
  attachSoldCounts: (previews: Preview[]) => Promise<void>,
): Promise<number[]> {
  const representatives = new Map<number, Preview>();
  // Identical representative unit selection to the final card hydration (including barcode-scoped rows).
  for (const row of [...rows].sort(
    (a, b) =>
      Number(b.availableQty >= Number(b.conversionFactor)) -
        Number(a.availableQty >= Number(a.conversionFactor)) ||
      Number(a.conversionFactor) - Number(b.conversionFactor) ||
      a.variantId - b.variantId ||
      a.productUnitId - b.productUnitId,
  )) {
    if (
      input.availability !== "ALL" &&
      row.availableQty < Number(row.conversionFactor)
    )
      continue;
    if (!representatives.has(row.productId))
      representatives.set(row.productId, {
        ...row,
        salePrice: null,
        promotionName: null,
        soldCount: 0,
      });
  }
  const previews = orderedIds.flatMap((id) => {
    const row = representatives.get(id);
    return row ? [row] : [];
  });
  if (
    (input.priceFilter && input.priceFilter !== "ALL") ||
    input.sort === "PRICE_ASC" ||
    input.sort === "PRICE_DESC"
  )
    await applyPromotions(previews);
  if (input.sort === "BEST_SELLERS") await attachSoldCounts(previews);
  const filtered = previews.filter((row) =>
    matchesStorefrontRefinements(row, input),
  );
  if (!input.sort || input.sort === "RECOMMENDED")
    return filtered.map((row) => row.productId);
  // Keep availability first. Stable sorting preserves the original relevance/seed order for equal values.
  return filtered
    .sort((a, b) => {
      const stock =
        Number(b.availableQty >= Number(b.conversionFactor)) -
        Number(a.availableQty >= Number(a.conversionFactor));
      if (stock) return stock;
      if (input.sort === "BEST_SELLERS") return b.soldCount - a.soldCount;
      const price = money(a.salePrice ?? a.price ?? "0").comparedTo(
        money(b.salePrice ?? b.price ?? "0"),
      );
      return input.sort === "PRICE_ASC" ? price : -price;
    })
    .map((row) => row.productId);
}
