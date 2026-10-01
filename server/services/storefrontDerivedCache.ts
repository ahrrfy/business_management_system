/**
 * ذاكرة مشتقة قصيرة العمر لترتيب كتالوج المتجر.
 *
 * الترتيب يعتمد على ATP والصورة والتمييز، لذلك لا يصح تثبيته طويلاً ولا حفظه بلا سقف. هذه
 * الذاكرة لكل process فقط: تمنع إعادة المسح الكامل عند انتقال الزائر بين صفحات cursor، وتجمع
 * الطلبات المتزامنة لنفس المرشحات في loader واحد، بينما يبقى إنشاء الطلب هو حارس المخزون النهائي.
 */

import { scoreStorefrontSearchRelevance, normalizeArabicSearch } from "../../shared/storefrontSearchNormalize";

export const STOREFRONT_DERIVED_RANKING_LIMITS = {
  ttlMs: 5_000,
  maxEntries: 64,
  maxProductIds: 50_000,
} as const;

export interface StorefrontRankingCacheOptions {
  ttlMs: number;
  maxEntries: number;
  maxProductIds: number;
  now?: () => number;
}

interface RankingEntry {
  value: readonly number[] | null;
  pending: Promise<readonly number[]> | null;
  expiresAt: number;
  lastUsedAt: number;
}

export interface StorefrontRankingCacheSnapshot {
  hits: number;
  misses: number;
  loads: number;
  evictions: number;
  entries: number;
  productIds: number;
}

export class StorefrontDerivedRankingCache {
  private readonly entries = new Map<string, RankingEntry>();
  private readonly now: () => number;
  private hits = 0;
  private misses = 0;
  private loads = 0;
  private evictions = 0;

  constructor(private readonly options: StorefrontRankingCacheOptions = STOREFRONT_DERIVED_RANKING_LIMITS) {
    if (!Number.isSafeInteger(options.ttlMs) || options.ttlMs < 1) throw new Error("storefront ranking ttl غير صالح");
    if (!Number.isSafeInteger(options.maxEntries) || options.maxEntries < 1) throw new Error("storefront ranking entry limit غير صالح");
    if (!Number.isSafeInteger(options.maxProductIds) || options.maxProductIds < 1) throw new Error("storefront ranking id limit غير صالح");
    this.now = options.now ?? Date.now;
  }

  async getOrLoad(key: string, loader: () => Promise<readonly number[]>): Promise<readonly number[]> {
    const now = this.now();
    const existing = this.entries.get(key);
    if (existing) {
      if (existing.pending) {
        existing.lastUsedAt = now;
        this.hits += 1;
        return existing.pending;
      }
      if (existing.value && existing.expiresAt > now) {
        existing.lastUsedAt = now;
        this.hits += 1;
        return existing.value;
      }
      this.entries.delete(key);
    }

    this.misses += 1;
    this.evictExpired(now);
    // لا نكسر سقف الذاكرة من أجل مفتاح جديد حين تكون كل الخانات loaders جارية. ينفَّذ الطلب
    // بلا تخزين بدلاً من إلغاء single-flight قائم أو إبقاء عدد غير محدود من الوعود.
    if (this.entries.size >= this.options.maxEntries && !this.evictOldestResolved()) {
      this.loads += 1;
      return loader();
    }

    this.loads += 1;
    const entry: RankingEntry = { value: null, pending: null, expiresAt: 0, lastUsedAt: now };
    const pending = loader()
      .then((ids) => {
        const immutableIds = Object.freeze(Array.from(ids, Number));
        if (this.entries.get(key) !== entry) return immutableIds;
        entry.pending = null;
        entry.value = immutableIds;
        entry.expiresAt = this.now() + this.options.ttlMs;
        entry.lastUsedAt = this.now();
        if (immutableIds.length > this.options.maxProductIds) {
          this.entries.delete(key);
          return immutableIds;
        }
        this.enforceBudgets(key);
        return immutableIds;
      })
      .catch((error) => {
        if (this.entries.get(key) === entry) this.entries.delete(key);
        throw error;
      });
    entry.pending = pending;
    this.entries.set(key, entry);
    return pending;
  }

  clear(): void {
    this.entries.clear();
    this.hits = 0;
    this.misses = 0;
    this.loads = 0;
    this.evictions = 0;
  }

  snapshot(): StorefrontRankingCacheSnapshot {
    return {
      hits: this.hits,
      misses: this.misses,
      loads: this.loads,
      evictions: this.evictions,
      entries: this.entries.size,
      productIds: this.productIdCount(),
    };
  }

  private productIdCount(): number {
    let total = 0;
    this.entries.forEach((entry) => { total += entry.value?.length ?? 0; });
    return total;
  }

  private evictExpired(now: number): void {
    this.entries.forEach((entry, key) => {
      if (!entry.pending && entry.expiresAt <= now) this.entries.delete(key);
    });
  }

  private evictOldestResolved(exceptKey?: string): boolean {
    let oldest: { key: string; at: number } | null = null;
    for (const [key, entry] of Array.from(this.entries.entries())) {
      if (key === exceptKey || entry.pending) continue;
      if (!oldest || entry.lastUsedAt < oldest.at) oldest = { key, at: entry.lastUsedAt };
    }
    if (!oldest) return false;
    this.entries.delete(oldest.key);
    this.evictions += 1;
    return true;
  }

  private enforceBudgets(currentKey: string): void {
    while (this.entries.size > this.options.maxEntries || this.productIdCount() > this.options.maxProductIds) {
      if (!this.evictOldestResolved(currentKey)) {
        const current = this.entries.get(currentKey);
        if (current?.pending) return;
        if (this.entries.delete(currentKey)) this.evictions += 1;
        return;
      }
    }
  }
}

/**
 * دالة تجزئة حتمية سريعة وخفيفة (32-bit FNV-1a + Murmur3 avalanche) لترتيب المنتجات عشوائياً وحتمياً
 * وفقاً لـ seed الجلسة، ما يضمن تنوع المنتجات في كل زيارة أو تحديث للصفحة، مع ثبات الترتيب لنفس الـ seed
 * أثناء تصفح الصفحات اللاحقة بالـ cursor.
 */
export function hashProductSeed(id: number, seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= id & 0xffffffff;
  h = Math.imul(h, 0x01000193);
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

export function buildStorefrontRankingCacheKey(input: {
  branchId: number;
  availability: "IN_STOCK" | "ALL";
  categoryIds?: readonly number[] | null;
  search?: string | null;
  seed?: string | null;
}): string {
  const categoryIds = Array.from(new Set((input.categoryIds ?? []).map(Number)))
    .filter((id) => Number.isSafeInteger(id) && id > 0)
    .sort((a, b) => a - b);
  const search = normalizeArabicSearch(input.search ?? "");
  const seed = (input.seed ?? "").trim();
  return `${input.branchId}|${input.availability}|${categoryIds.join(",") || "*"}|${search}|${seed}`;
}

export function chooseCandidateProductIds(
  rows: Array<{
    productId: number;
    conversionFactor: string;
    isFeatured: boolean | null;
    productName: string;
    storeTitle?: string | null;
    brand?: string | null;
    hasImage: number;
    availableQty: number;
  }>,
  cap: number,
  availabilityFilter: "IN_STOCK" | "ALL",
  searchTerm?: string | null,
  seed?: string | null,
): number[] {
  const productsById = new Map<number, {
    id: number;
    inStock: boolean;
    featured: boolean;
    hasImage: boolean;
    name: string;
    storeTitle: string | null;
    brand: string | null;
    relevanceScore: number;
  }>();
  for (const row of rows) {
    const id = Number(row.productId);
    const inStock = row.availableQty >= Number(row.conversionFactor);
    const current = productsById.get(id);
    if (current) {
      current.inStock ||= inStock;
      current.hasImage ||= Boolean(row.hasImage);
    } else {
      const p = {
        productName: row.productName,
        storeTitle: row.storeTitle ?? null,
        brand: row.brand ?? null,
      };
      const relevanceScore = searchTerm ? scoreStorefrontSearchRelevance(p, searchTerm) : 0;
      productsById.set(id, {
        id,
        inStock,
        featured: row.isFeatured === true,
        hasImage: Boolean(row.hasImage),
        name: row.productName,
        storeTitle: row.storeTitle ?? null,
        brand: row.brand ?? null,
        relevanceScore,
      });
    }
  }
  const isSearch = Boolean(searchTerm && searchTerm.trim());
  const trimmedSeed = (seed ?? "").trim();
  return Array.from(productsById.values())
    .filter((product) => availabilityFilter === "ALL" || product.inStock)
    .sort((a, b) => {
      // 1. المتوفر أولاً دائماً
      const stockDiff = Number(b.inStock) - Number(a.inStock);
      if (stockDiff !== 0) return stockDiff;

      // 2. إذا كان بحثاً: مطابقة الصلة بالبحث أولاً
      if (isSearch) {
        const scoreDiff = b.relevanceScore - a.relevanceScore;
        if (scoreDiff !== 0) return scoreDiff;
      }

      // 3. المنتجات المميزة (featured) أولاً
      const featDiff = Number(b.featured) - Number(a.featured);
      if (featDiff !== 0) return featDiff;

      // 4. المنتجات ذات الصور تسبق المنتجات بلا صور
      const imgDiff = Number(b.hasImage) - Number(a.hasImage);
      if (imgDiff !== 0) return imgDiff;

      // 5. إذا توفر seed ولم يكن بحثاً: ترتيب عشوائي حتمي ومتجدد يغير ترتيب المنتجات في كل زيارة
      if (trimmedSeed && !isSearch) {
        const hashA = hashProductSeed(a.id, trimmedSeed);
        const hashB = hashProductSeed(b.id, trimmedSeed);
        if (hashA !== hashB) return hashA < hashB ? -1 : 1;
      }

      // 6. الترتيب الافتراضي (المحافظ على الأبجدية القديمة كـ fallback)
      return (
        a.name.localeCompare(b.name, "ar") ||
        a.id - b.id
      );
    })
    .slice(0, cap)
    .map((product) => product.id);
}

