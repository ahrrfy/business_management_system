import { matchesStorefrontRefinements as matchesRefinements } from "./storefrontCatalogRefinements";
import {
  storefrontCatalog,
  resolveStorefrontBranchId,
  applyStorefrontPromotions,
  type StorefrontProduct,
} from "./storefrontService";
import {
  loadStorefrontSearchMatches,
  type StorefrontSearchScope,
} from "./storefrontSearchIndex";
import { normalizeArabicSearch } from "../../shared/storefrontSearchNormalize";
import { resolveBarcodeOwnerResult } from "./catalog/barcodeAliases";
import { getDb } from "../db";
import { loadVariantAvailability } from "./catalog/variantAvailability";
import { evaluateStorefrontUnitEligibility } from "./storefrontEligibilityService";
import { createTtlCache } from "../lib/ttlCache";
import { storefrontReadCacheEnabled, storefrontCacheGet } from "../lib/storefrontCachePolicy";
import { getCurrentCompanyId } from "../tenancy/context";

export interface StorefrontSearchSuggestionInput extends StorefrontSearchScope {
  query: string;
  availability?: "IN_STOCK" | "ALL";
  brand?: string;
  priceFilter?: "ALL" | "UNDER_5000" | "FROM_5000_TO_15000" | "OVER_15000";
}
export interface StorefrontSearchProductSuggestion {
  productId: number;
  productName: string;
  brand: string | null;
  categoryId: number | null;
  category: string | null;
  price: string | null;
  salePrice: string | null;
  inStock: boolean;
}
export interface StorefrontSearchSuggestions {
  query: string;
  products: StorefrontSearchProductSuggestion[];
  queries: string[];
  categories: { id: number; name: string }[];
  correction: string | null;
  similar: StorefrontSearchProductSuggestion[];
}
const resultCache = createTtlCache<string, StorefrontSearchSuggestions>({
  ttlMs: 5_000,
  maxEntries: 80,
});
function publicSuggestion(
  p: StorefrontProduct,
): StorefrontSearchProductSuggestion {
  return {
    productId: p.productId,
    productName: p.productName,
    brand: p.brand,
    categoryId: p.categoryId,
    category: p.category,
    price: p.price,
    salePrice: p.salePrice,
    inStock: p.inStock,
  };
}
export async function storefrontSearchSuggestions(
  input: StorefrontSearchSuggestionInput,
): Promise<StorefrontSearchSuggestions> {
  const query = input.query.trim();
  const empty: StorefrontSearchSuggestions = {
    query,
    products: [],
    queries: [],
    categories: [],
    correction: null,
    similar: [],
  };
  if (normalizeArabicSearch(query).length < 2) return empty;
  const branchId = await resolveStorefrontBranchId();
  const key = JSON.stringify([
    getCurrentCompanyId() ?? 0,
    branchId,
    query,
    input.categoryId,
    input.productIds?.slice().sort((a, b) => a - b),
    input.availability,
    input.brand,
    input.priceFilter,
  ]);
  const load = async () => {
    const db = getDb();
    if (!db) return empty;
    const barcode = await resolveBarcodeOwnerResult(db, query, {
      allowNormalizedFallback: true,
    });
    // Barcode aliases must obey the same ambiguity/publication and exact unit contract as the catalog.
    if (barcode.status !== "NOT_FOUND") {
      const page = await storefrontCatalog({
        ...input,
        search: query,
        branchId,
        limit: 6,
      });
      return {
        ...empty,
        products: page.items
          .filter((p) => matchesRefinements(p, input))
          .map(publicSuggestion),
      };
    }
    const matched = (
      await loadStorefrontSearchMatches(query, input, true)
    ).filter((row) => !input.brand?.trim() || row.brand?.trim() === input.brand.trim());
    const availability = await loadVariantAvailability(
      db,
      branchId,
      matched.map((row) => row.variantId),
    );
    const eligible = matched
      .map((row) => {
        const state = availability.get(row.variantId);
        const inStock =
          state?.isService === true ||
          evaluateStorefrontUnitEligibility({
            isActive: true,
            isStoreSaleUnit: true,
            retailPrice: row.price,
            conversionFactor: row.conversionFactor,
            stockBase: state?.hasStockRow ? state.onHandBase : null,
            availableBase: state?.availableBase ?? 0,
          }).available;
        return {
          ...row,
          inStock,
          salePrice: null as string | null,
          promotionName: null as string | null,
        };
      })
      .filter((row) => input.availability === "ALL" || row.inStock)
      .sort(
        (a, b) =>
          b.match.score - a.match.score ||
          Number(b.inStock) - Number(a.inStock) ||
          Number(a.conversionFactor) - Number(b.conversionFactor) ||
          a.variantId - b.variantId ||
          a.productUnitId - b.productUnitId,
      );
    const best = new Map<number, (typeof eligible)[number]>();
    for (const row of eligible)
      if (!best.has(row.productId)) best.set(row.productId, row);
    const previews = Array.from(best.values());
    // Price refinements need the same current promotion result as the card, before limiting.
    // This snapshot is scalar metadata only; no image/review/color/catalog hydration here.
    if (input.priceFilter && input.priceFilter !== "ALL")
      await applyStorefrontPromotions(previews, branchId);
    const distinct = previews.filter((row) => matchesRefinements(row, input));
    const strict = distinct.filter((row) => row.match.kind !== "SIMILAR");
    const approximate = distinct.filter((row) => row.match.kind === "SIMILAR");
    const hydrate = async (
      candidates: typeof distinct,
      cap: number,
      strictMatch: boolean,
    ) => {
      const selected = candidates.slice(0, cap);
      if (!selected.length) return [];
      const page = await storefrontCatalog({
        branchId,
        categoryId: input.categoryId,
        productIds: selected.map((row) => row.productId),
        search: strictMatch ? query : undefined,
        availability: input.availability,
        limit: cap,
      });
      const byId = new Map(
        page.items
          .filter((p) => matchesRefinements(p, input))
          .map((p) => [p.productId, p]),
      );
      return selected.flatMap((row) => {
        const product = byId.get(row.productId);
        return product ? [product] : [];
      });
    };
    const exact = await hydrate(strict, 5, true);
    const similar = exact.length ? [] : await hydrate(approximate, 4, false);
    const correction = similar.length
      ? (approximate.find((row) => row.productId === similar[0].productId)
          ?.match.correction ?? null)
      : null;
    const categories = Array.from(
      new Map(
        exact
          .filter((p) => p.categoryId != null && p.category)
          .map((p) => [
            p.categoryId!,
            { id: p.categoryId!, name: p.category! },
          ]),
      ).values(),
    ).slice(0, 2);
    return {
      ...empty,
      products: exact.map(publicSuggestion),
      queries: Array.from(new Set(exact.map((p) => p.productName)))
        .filter(
          (title) =>
            normalizeArabicSearch(title) !== normalizeArabicSearch(query),
        )
        .slice(0, 2),
      categories,
      correction,
      similar: similar.map(publicSuggestion),
    };
  };
  // Publication and ATP are revalidated by the bounded catalog hydration. Result TTL is deliberately short.
  return !storefrontReadCacheEnabled() ? load() : storefrontCacheGet(resultCache, "suggestions", key, load);
}
