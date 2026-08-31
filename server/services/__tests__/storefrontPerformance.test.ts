import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import {
  STOREFRONT_DERIVED_RANKING_LIMITS,
  StorefrontDerivedRankingCache,
  buildStorefrontRankingCacheKey,
} from "../storefrontDerivedCache";

describe("storefront derived ranking performance budget", () => {
  it("يجمع 64 طلب صفحة/توصية متزامناً في تحميل ترتيب واحد لنفس المرشحات", async () => {
    const cache = new StorefrontDerivedRankingCache({ ttlMs: 5_000, maxEntries: 8, maxProductIds: 1_000 });
    const loader = vi.fn(async () => Array.from({ length: 200 }, (_, index) => index + 1));
    const key = buildStorefrontRankingCacheKey({ branchId: 1, availability: "IN_STOCK", categoryIds: [4] });

    const results = await Promise.all(Array.from({ length: 64 }, () => cache.getOrLoad(key, loader)));

    expect(loader).toHaveBeenCalledTimes(1);
    expect(results.every((ids) => ids.length === 200)).toBe(true);
    expect(cache.snapshot()).toMatchObject({ hits: 63, loads: 1, entries: 1, productIds: 200 });
  });

  it("لا يُدخل cursor في المفتاح ويحافظ على ترتيب الأقسام مع سقف ذاكرة حتمي", async () => {
    const firstPageKey = buildStorefrontRankingCacheKey({
      branchId: 2,
      availability: "ALL",
      categoryIds: [9, 3],
      search: "  دفتر  ",
    });
    const nextPageKey = buildStorefrontRankingCacheKey({
      branchId: 2,
      availability: "ALL",
      categoryIds: [3, 9],
      search: "دفتر",
    });
    expect(nextPageKey).toBe(firstPageKey);

    const cache = new StorefrontDerivedRankingCache({ ttlMs: 5_000, maxEntries: 3, maxProductIds: 5 });
    await cache.getOrLoad("a", async () => [1, 2]);
    await cache.getOrLoad("b", async () => [3, 4]);
    await cache.getOrLoad("c", async () => [5, 6]);
    await cache.getOrLoad("d", async () => [7, 8]);
    const snapshot = cache.snapshot();
    expect(snapshot.entries).toBeLessThanOrEqual(3);
    expect(snapshot.productIds).toBeLessThanOrEqual(5);
    expect(snapshot.evictions).toBeGreaterThan(0);
  });

  it("يعيد التحميل بعد TTL فقط ويعلن حدود الإنتاج القابلة للقياس", async () => {
    let now = 1_000;
    const cache = new StorefrontDerivedRankingCache({
      ttlMs: 100,
      maxEntries: 4,
      maxProductIds: 50,
      now: () => now,
    });
    const loader = vi.fn(async () => [1, 2, 3]);
    await cache.getOrLoad("catalog", loader);
    now += 99;
    await cache.getOrLoad("catalog", loader);
    now += 2;
    await cache.getOrLoad("catalog", loader);

    expect(loader).toHaveBeenCalledTimes(2);
    expect(STOREFRONT_DERIVED_RANKING_LIMITS).toEqual({ ttlMs: 5_000, maxEntries: 64, maxProductIds: 50_000 });
  });

  it("يربط catalog وrelated/category recommendations بالمشتق ولا يعيد مسح المرشحين داخل كل دالة", () => {
    const source = readFileSync(new URL("../storefrontService.ts", import.meta.url), "utf8");
    const catalog = source.slice(source.indexOf("export async function storefrontCatalog"), source.indexOf("export async function storefrontCategories"));
    const categoryRecommendations = source.slice(source.indexOf("async function storefrontCategoryRecommendations"), source.indexOf("export async function storefrontRelated"));
    const related = source.slice(source.indexOf("export async function storefrontRelated"), source.indexOf("export interface StorefrontOffer"));

    expect(catalog).toContain("loadRankedStorefrontProductIds");
    expect(categoryRecommendations).toContain("loadRankedStorefrontProductIds");
    expect(related).toContain("loadRankedStorefrontProductIds");
    expect(catalog).not.toContain("availabilityCandidateSelect(db)");
    expect(categoryRecommendations).not.toContain("availabilityCandidateSelect(db)");
    expect(related).not.toContain("availabilityCandidateSelect(db)");
  });
});
