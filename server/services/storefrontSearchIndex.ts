import { and, eq } from "drizzle-orm";
import { setImmediate as yieldToRequests } from "node:timers/promises";
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
  const indexedRows = [];
  let deadline = performance.now() + 8;
  for (const row of rows) {
    indexedRows.push({
      ...row,
      searchText: normalizeArabicSearch(
        `${row.productName} ${row.storeTitle ?? ""} ${row.brand ?? ""} ${row.category ?? ""} ${row.barcode ?? ""}`,
      ),
      searchWords: tokenizeSearchTerms(
        `${row.storeTitle ?? ""} ${row.productName} ${row.brand ?? ""} ${row.category ?? ""}`,
      ),
    });
    // A cold full index must share its worker with image requests and cashier reads.
    if (performance.now() >= deadline) {
      await yieldToRequests();
      deadline = performance.now() + 8;
    }
  }
  return indexedRows;
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
  const matches = [];
  let deadline = performance.now() + 8;
  for (const row of rows) {
    if (
      (scope.categoryId == null || row.categoryId === scope.categoryId) &&
      (ids == null || ids.has(row.productId))
    ) {
      const result = match(row);
      if (result) matches.push({ ...row, match: result });
    }
    if (performance.now() >= deadline) {
      await yieldToRequests();
      deadline = performance.now() + 8;
    }
  }
  return matches.sort(
    (a, b) =>
      b.match.score - a.match.score ||
      a.productId - b.productId ||
      a.productUnitId - b.productUnitId,
  );
}
