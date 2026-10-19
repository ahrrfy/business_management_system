import { and, eq } from "drizzle-orm";
import {
  categories,
  products,
  productVariants,
  productUnits,
  productPrices,
} from "../../drizzle/schema";
import { getDb } from "../db";
import { createTtlCache } from "../lib/ttlCache";
import { getCurrentCompanyId } from "../tenancy/context";
import { storefrontPublishableCondition } from "./storefrontEligibilityService";
import {
  createStorefrontSearchMatcher,
  normalizeArabicSearch,
  tokenizeSearchTerms,
} from "../../shared/storefrontSearchNormalize";

/** Only identifiers, public text and retail unit metadata; no images/descriptions or full product hydration. */
const indexCache = createTtlCache<
  string,
  Awaited<ReturnType<typeof readCandidates>>
>({ ttlMs: 5_000, maxEntries: 8 });
async function readCandidates() {
  const db = getDb();
  if (!db) return [];
  const rows = await db
    .select({
      productId: products.id,
      productUnitId: productUnits.id,
      variantId: productVariants.id,
      conversionFactor: productUnits.conversionFactor,
      price: productPrices.price,
      productName: products.name,
      storeTitle: products.storeTitle,
      brand: products.brand,
      categoryId: products.categoryId,
      category: categories.name,
      barcode: productUnits.barcode,
    })
    .from(products)
    .innerJoin(productVariants, eq(productVariants.productId, products.id))
    .innerJoin(productUnits, eq(productUnits.variantId, productVariants.id))
    .leftJoin(categories, eq(categories.id, products.categoryId))
    .innerJoin(
      productPrices,
      and(
        eq(productPrices.productUnitId, productUnits.id),
        eq(productPrices.priceTier, "RETAIL"),
      ),
    )
    .where(storefrontPublishableCondition());
  return rows.map((row) => ({
    ...row,
    searchText: normalizeArabicSearch(
      `${row.productName} ${row.storeTitle ?? ""} ${row.brand ?? ""} ${row.category ?? ""} ${row.barcode ?? ""}`,
    ),
    searchWords: tokenizeSearchTerms(
      `${row.storeTitle ?? ""} ${row.productName} ${row.brand ?? ""} ${row.category ?? ""}`,
    ),
  }));
}
export interface StorefrontSearchScope {
  categoryId?: number | null;
  productIds?: number[] | null;
}
export async function loadStorefrontSearchMatches(
  search: string,
  scope: StorefrontSearchScope = {},
  allowSimilar = false,
) {
  const rows =
    process.env.NODE_ENV === "test"
      ? await readCandidates()
      : await indexCache.get(
          String(getCurrentCompanyId() ?? 0),
          readCandidates,
        );
  const ids = scope.productIds == null ? null : new Set(scope.productIds);
  const match = createStorefrontSearchMatcher(search, allowSimilar);
  return rows
    .filter(
      (row) =>
        (scope.categoryId == null || row.categoryId === scope.categoryId) &&
        (ids == null || ids.has(row.productId)),
    )
    .flatMap((row) => {
      const result = match(row);
      return result ? [{ ...row, match: result }] : [];
    })
    .sort(
      (a, b) =>
        b.match.score - a.match.score ||
        a.productId - b.productId ||
        a.productUnitId - b.productUnitId,
    );
}
