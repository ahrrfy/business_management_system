import { and, asc, desc, eq, sql } from "drizzle-orm";
import { categories, productImages, productPrices, productUnits, productVariants, products } from "../../drizzle/schema";
import { getDb } from "../db";
import { storefrontPublishableCondition } from "./storefrontEligibilityService";
import { imageHash } from "../imageRoute";

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
        name: products.name,
        storeTitle: products.storeTitle,
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

    // استخراج أول صورة معتمدة لكل منتج لتضمينها في خريطة صور جوجل (Google Images Sitemap)
    const approvedImages = await db
      .select({
        id: productImages.id,
        productId: productImages.productId,
        url: productImages.url,
      })
      .from(productImages)
      .where(eq(productImages.reviewStatus, "APPROVED"))
      .orderBy(desc(productImages.isPrimary), asc(productImages.sortOrder), asc(productImages.id));

    const productImageMap = new Map<number, { id: number; url: string }>();
    for (const img of approvedImages) {
      const pid = Number(img.productId);
      if (!productImageMap.has(pid)) {
        productImageMap.set(pid, { id: Number(img.id), url: img.url });
      }
    }

    const urls: string[] = [];

    // 1. الرئيسية والمتجر العام مع صورة العلامة التجارية لصور جوجل
    urls.push(`  <url>
    <loc>${escapeXml(`${baseOrigin}/store`)}</loc>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
    <image:image>
      <image:loc>${escapeXml(`${baseOrigin}/icon-512.png`)}</image:loc>
      <image:title>المكتبة العربية للقرطاسية والطباعة في العراق</image:title>
      <image:caption>المتجر الإلكتروني الرسمي للمكتبة العربية في العراق</image:caption>
    </image:image>
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

    // 4. كل المنتجات المنشورة المؤهلة مع وسوم صور جوجل
    for (const prod of productRows) {
      const lastMod = formatDate(prod.updatedAt);
      const prodTitle = prod.storeTitle || prod.name || "منتج المكتبة العربية";
      const img = productImageMap.get(Number(prod.productId));

      let imageXml = "";
      if (img) {
        let fullImgUrl = "";
        if (img.url.startsWith("http")) {
          fullImgUrl = img.url;
        } else if (img.url.startsWith("data:")) {
          fullImgUrl = `${baseOrigin}/api/img/product/${img.id}?v=${imageHash(img.url)}`;
        } else {
          fullImgUrl = `${baseOrigin}${img.url.startsWith("/") ? "" : "/"}${img.url}`;
        }
        imageXml = `
    <image:image>
      <image:loc>${escapeXml(fullImgUrl)}</image:loc>
      <image:title>${escapeXml(prodTitle)}</image:title>
      <image:caption>${escapeXml(prodTitle + " - المكتبة العربية في العراق")}</image:caption>
    </image:image>`;
      }

      urls.push(`  <url>
    <loc>${escapeXml(`${baseOrigin}/store/product/${prod.productId}`)}</loc>
    <lastmod>${lastMod}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>${imageXml}
  </url>`);
    }

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
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
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
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

