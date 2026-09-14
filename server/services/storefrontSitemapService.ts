import { and, asc, desc, eq, sql } from "drizzle-orm";
import { categories, productPrices, productUnits, productVariants, products } from "../../drizzle/schema";
import { getDb } from "../db";
import { storefrontPublishableCondition } from "./storefrontEligibilityService";

let cachedXml: string | null = null;
let cacheExpiresAt = 0;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

function escapeXml(unsafe: string): string {
  return unsafe.replace(/[<>&'"]/g, (c) => {
    switch (c) {
      case "<": return "&lt;";
      case ">": return "&gt;";
      case "&": return "&amp;";
      case "'": return "&apos;";
      case '"': return "&quot;";
      default: return c;
    }
  });
}

function formatDate(d: Date | string | null | undefined): string {
  if (!d) return new Date().toISOString().split("T")[0];
  const dateObj = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dateObj.getTime())) return new Date().toISOString().split("T")[0];
  return dateObj.toISOString().split("T")[0];
}

export async function generateStorefrontSitemapXml(customOrigin?: string): Promise<string> {
  const now = Date.now();
  if (cachedXml && now < cacheExpiresAt) {
    return cachedXml;
  }

  const baseOrigin = (
    customOrigin ||
    process.env.PUBLIC_SITE_ORIGIN ||
    process.env.VITE_PUBLIC_SITE_ORIGIN ||
    "https://alarabiya.online"
  ).replace(/\/+$/, "");

  const db = getDb();
  if (!db) {
    const xml = buildFallbackSitemap(baseOrigin);
    cachedXml = xml;
    cacheExpiresAt = now + CACHE_TTL_MS;
    return xml;
  }

  try {
    const productRows = await db
      .selectDistinct({
        productId: products.id,
        updatedAt: products.updatedAt,
      })
      .from(products)
      .leftJoin(categories, eq(products.categoryId, categories.id))
      .innerJoin(productVariants, eq(products.id, productVariants.productId))
      .innerJoin(productUnits, eq(productVariants.id, productUnits.variantId))
      .innerJoin(productPrices, eq(productUnits.id, productPrices.productUnitId))
      .where(storefrontPublishableCondition())
      .orderBy(desc(products.updatedAt));

    const catRows = await db
      .select({
        id: categories.id,
      })
      .from(categories)
      .where(and(eq(categories.isActive, true), eq(categories.showInStore, true)))
      .orderBy(asc(categories.id));

    const urls: string[] = [];

    // 1. الرئيسية والمتجر العام
    urls.push(`  <url>
    <loc>${escapeXml(`${baseOrigin}/store`)}</loc>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>`);

    // 2. التقديم على الوظائف
    urls.push(`  <url>
    <loc>${escapeXml(`${baseOrigin}/apply`)}</loc>
    <changefreq>monthly</changefreq>
    <priority>0.5</priority>
  </url>`);

    // 3. تصنيفات المتجر
    for (const cat of catRows) {
      urls.push(`  <url>
    <loc>${escapeXml(`${baseOrigin}/store/category/${cat.id}`)}</loc>
    <changefreq>daily</changefreq>
    <priority>0.8</priority>
  </url>`);
    }

    // 4. كل المنتجات المنشورة المؤهلة للظهور العام
    for (const prod of productRows) {
      const lastMod = formatDate(prod.updatedAt);
      urls.push(`  <url>
    <loc>${escapeXml(`${baseOrigin}/store/product/${prod.productId}`)}</loc>
    <lastmod>${lastMod}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>`);
    }

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join("\n")}
</urlset>`;

    cachedXml = xml;
    cacheExpiresAt = now + CACHE_TTL_MS;
    return xml;
  } catch (error) {
    const xml = buildFallbackSitemap(baseOrigin);
    cachedXml = xml;
    cacheExpiresAt = now + CACHE_TTL_MS;
    return xml;
  }
}

function buildFallbackSitemap(baseOrigin: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${escapeXml(`${baseOrigin}/store`)}</loc>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>${escapeXml(`${baseOrigin}/apply`)}</loc>
    <changefreq>monthly</changefreq>
    <priority>0.5</priority>
  </url>
</urlset>`;
}

export function invalidateSitemapCache(): void {
  cachedXml = null;
  cacheExpiresAt = 0;
}
