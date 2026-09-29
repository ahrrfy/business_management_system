import { describe, expect, it } from "vitest";
import { chooseCandidateProductIds, buildStorefrontRankingCacheKey } from "../storefrontDerivedCache";

describe("storefront candidate ranking (chooseCandidateProductIds)", () => {
  const row = (
    productId: number,
    productName: string,
    availableQty: number,
    options: {
      conversionFactor?: string;
      isFeatured?: boolean;
      storeTitle?: string | null;
      brand?: string | null;
      hasImage?: number;
    } = {}
  ) => ({
    productId,
    productName,
    conversionFactor: options.conversionFactor ?? "1",
    isFeatured: options.isFeatured ?? false,
    storeTitle: options.storeTitle ?? null,
    brand: options.brand ?? null,
    hasImage: options.hasImage ?? 0,
    availableQty,
  });

  it("prioritizes in-stock items before out-of-stock items, then ranks by relevance (R3)", () => {
    const candidates = [
      row(1, "دفتر احياء مدرسي", 0), // out of stock, exact-ish match
      row(2, "دفتر احياء متوسط", 5), // in stock, match
      row(3, "قلم حبر احمر", 10),    // in stock, no match
    ];

    const ranked = chooseCandidateProductIds(candidates, 10, "ALL", "احياء");
    // Product 2 is in-stock and relevant -> 1st
    // Product 3 is in-stock but irrelevant -> 2nd
    // Product 1 is out-of-stock -> 3rd
    expect(ranked[0]).toBe(2);
    expect(ranked[2]).toBe(1);
  });

  it("filters out out-of-stock items when availability is IN_STOCK (R4)", () => {
    const candidates = [
      row(1, "دفتر 100 ورقة", 0),
      row(2, "دفتر ١٠٠ ورقة", 5),
    ];

    const ranked = chooseCandidateProductIds(candidates, 10, "IN_STOCK", "دفتر 100");
    expect(ranked).toEqual([2]);
  });

  it("ranks exact match higher than prefix match, and prefix higher than infix match (R3)", () => {
    const candidates = [
      row(1, "دفتر رسم كبير", 5),
      row(2, "دفتر", 5),
      row(3, "مجموعة اقلام مع دفتر", 5),
    ];

    const ranked = chooseCandidateProductIds(candidates, 10, "ALL", "دفتر");
    // Exact match (2) first, prefix match (1) second, infix match (3) third
    expect(ranked).toEqual([2, 1, 3]);
  });

  it("matches multi-word tokens in any order with normalized digits (R1)", () => {
    const candidates = [
      row(1, "كتاب احياء اول متوسط متميزين", 5),
      row(2, "دفتر ١٠٠ ورقة متميز", 5),
      row(3, "كتاب كيمياء اول متوسط", 5),
    ];

    // Multi-word in different order
    const rankedTokens = chooseCandidateProductIds(candidates, 10, "ALL", "متميزين احياء");
    expect(rankedTokens[0]).toBe(1);

    // Eastern Arabic digit search matching Western digit product
    const rankedDigits = chooseCandidateProductIds(candidates, 10, "ALL", "دفتر 100");
    expect(rankedDigits[0]).toBe(2);
  });

  it("respects the cap limit", () => {
    const candidates = [
      row(1, "دفتر A", 5),
      row(2, "دفتر B", 5),
      row(3, "دفتر C", 5),
    ];

    const ranked = chooseCandidateProductIds(candidates, 2, "ALL", "دفتر");
    expect(ranked).toHaveLength(2);
  });

  it("buildStorefrontRankingCacheKey generates identical keys for equivalent normalized Arabic and digit queries", () => {
    const key1 = buildStorefrontRankingCacheKey({ branchId: 1, availability: "IN_STOCK", search: "دفتر 100" });
    const key2 = buildStorefrontRankingCacheKey({ branchId: 1, availability: "IN_STOCK", search: "دفتر ١٠٠" });
    expect(key1).toBe(key2);

    const keyAlef1 = buildStorefrontRankingCacheKey({ branchId: 1, availability: "IN_STOCK", search: "أوراق" });
    const keyAlef2 = buildStorefrontRankingCacheKey({ branchId: 1, availability: "IN_STOCK", search: "اوراق" });
    expect(keyAlef1).toBe(keyAlef2);

    const keyTaa1 = buildStorefrontRankingCacheKey({ branchId: 1, availability: "IN_STOCK", search: "مكتبة" });
    const keyTaa2 = buildStorefrontRankingCacheKey({ branchId: 1, availability: "IN_STOCK", search: "مكتبه" });
    expect(keyTaa1).toBe(keyTaa2);
  });

  describe("seed-based dynamic product ordering", () => {
    const generateCatalog = (count: number) =>
      Array.from({ length: count }, (_, i) =>
        row(i + 1, `منتج تجريبي رقم ${i + 1}`, 10, { hasImage: 1 })
      );

    it("produces deterministic order for the same seed", () => {
      const candidates = generateCatalog(20);
      const orderA = chooseCandidateProductIds(candidates, 20, "ALL", null, "session-seed-123");
      const orderB = chooseCandidateProductIds(candidates, 20, "ALL", null, "session-seed-123");
      expect(orderA).toEqual(orderB);
    });

    it("produces different orders for different seeds to vary products on each visit/refresh", () => {
      const candidates = generateCatalog(30);
      const order1 = chooseCandidateProductIds(candidates, 30, "ALL", null, "seed-alice");
      const order2 = chooseCandidateProductIds(candidates, 30, "ALL", null, "seed-bob");
      expect(order1).not.toEqual(order2);
      // Both should contain all candidate IDs
      expect(new Set(order1)).toEqual(new Set(order2));
    });

    it("maintains in-stock, featured, and image priority even when seed is provided", () => {
      const candidates = [
        row(1, "منتج عادي متوفر", 10, { hasImage: 1 }),
        row(2, "منتج مميز متوفر", 10, { isFeatured: true, hasImage: 1 }),
        row(3, "منتج نافد", 0, { hasImage: 1 }),
        row(4, "منتج متوفر بلا صورة", 10, { hasImage: 0 }),
      ];

      const ranked = chooseCandidateProductIds(candidates, 10, "ALL", null, "any-random-seed");
      // 1. Featured in-stock (2)
      // 2. In-stock with image (1)
      // 3. In-stock without image (4)
      // 4. Out of stock (3)
      expect(ranked).toEqual([2, 1, 4, 3]);
    });

    it("prioritizes search relevance over seed when search term is active", () => {
      const candidates = [
        row(1, "قلم رصاص", 10, { hasImage: 1 }),
        row(2, "دفتر رسم مدرسي", 10, { hasImage: 1 }),
        row(3, "ممحاة قلم", 10, { hasImage: 1 }),
      ];

      // When searching for "دفتر", product 2 must be ranked 1st regardless of seed
      const ranked = chooseCandidateProductIds(candidates, 10, "ALL", "دفتر", "seed-xyz");
      expect(ranked[0]).toBe(2);
    });
  });
});

