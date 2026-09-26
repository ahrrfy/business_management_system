import { and, asc, desc, eq } from "drizzle-orm";
import { categories, productPrices, productUnits, productVariants, products } from "../../drizzle/schema";
import { getDb } from "../db";
import { storefrontPublishableCondition } from "./storefrontEligibilityService";
import { storefrontProduct } from "./storefrontService";

let cachedFeedXml: string | null = null;
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

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * توليد تغذية منتجات Google Merchant Center (Google Shopping RSS 2.0 Feed)
 * تتيح إدراج منتجات المتجر مجاناً في Google Shopping وبحث جوجل وصور جوجل (Free Product Listings).
 */
export async function generateGoogleMerchantFeedXml(customOrigin?: string): Promise<string> {
  const now = Date.now();
  if (cachedFeedXml && now < cacheExpiresAt) {
    return cachedFeedXml;
  }

  const baseOrigin = (
    customOrigin ||
    process.env.PUBLIC_SITE_ORIGIN ||
    process.env.VITE_PUBLIC_SITE_ORIGIN ||
    "https://alarabiya.online"
  ).replace(/\/+$/, "");

  const db = getDb();
  if (!db) {
    const fallback = buildFallbackMerchantFeed(baseOrigin);
    cachedFeedXml = fallback;
    cacheExpiresAt = now + CACHE_TTL_MS;
    return fallback;
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

    const items: string[] = [];

    for (const row of productRows) {
      const prod = await storefrontProduct(Number(row.productId));
      if (!prod) continue;

      const title = prod.productName;
      const rawDesc = prod.description ? stripHtml(prod.description) : "";
      const description = rawDesc.length > 10
        ? rawDesc.slice(0, 1000)
        : `${title} من قسم ${prod.category || "القرطاسية والطباعة"} في المكتبة العربية. متوفر للشراء مع توصيل لكافة محافظات العراق والدفع عند الاستلام.`;

      const link = `${baseOrigin}/store/product/${prod.productId}`;

      let imageLink = `${baseOrigin}/icon-512.png`;
      if (prod.imageUrl) {
        imageLink = prod.imageUrl.startsWith("http")
          ? prod.imageUrl
          : `${baseOrigin}${prod.imageUrl.startsWith("/") ? "" : "/"}${prod.imageUrl}`;
      }

      const priceAmount = prod.salePrice || prod.price || "0";
      const availability = prod.inStock ? "in_stock" : "out_of_stock";
      const brand = prod.brand || "المكتبة العربية";
      const productType = prod.category || "قرطاسية وطباعة";

      items.push(`    <item>
      <g:id>PROD-${prod.productId}</g:id>
      <g:title>${escapeXml(title)}</g:title>
      <g:description>${escapeXml(description)}</g:description>
      <g:link>${escapeXml(link)}</g:link>
      <g:image_link>${escapeXml(imageLink)}</g:image_link>
      <g:availability>${availability}</g:availability>
      <g:price>${priceAmount} IQD</g:price>
      <g:brand>${escapeXml(brand)}</g:brand>
      <g:condition>new</g:condition>
      <g:identifier_exists>no</g:identifier_exists>
      <g:product_type>${escapeXml(productType)}</g:product_type>
      <g:shipping>
        <g:country>IQ</g:country>
        <g:service>Standard Delivery</g:service>
        <g:price>5000 IQD</g:price>
      </g:shipping>
    </item>`);
    }

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss xmlns:g="http://base.google.com/ns/1.0" version="2.0">
  <channel>
    <title>المكتبة العربية | متجر القرطاسية والطباعة في العراق</title>
    <link>${escapeXml(`${baseOrigin}/store`)}</link>
    <description>تسوّق أفضل أدوات القرطاسية المدرسية والمكتبية، خدمات الطباعة والكتب والروايات في العراق مع خدمة التوصيل والدفع عند الاستلام.</description>
${items.join("\n")}
  </channel>
</rss>`;

    cachedFeedXml = xml;
    cacheExpiresAt = now + CACHE_TTL_MS;
    return xml;
  } catch {
    const fallback = buildFallbackMerchantFeed(baseOrigin);
    cachedFeedXml = fallback;
    cacheExpiresAt = now + CACHE_TTL_MS;
    return fallback;
  }
}

function buildFallbackMerchantFeed(baseOrigin: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss xmlns:g="http://base.google.com/ns/1.0" version="2.0">
  <channel>
    <title>المكتبة العربية | متجر القرطاسية والطباعة في العراق</title>
    <link>${escapeXml(`${baseOrigin}/store`)}</link>
    <description>تسوّق أفضل أدوات القرطاسية المدرسية والمكتبية، خدمات الطباعة والكتب والروايات في العراق مع خدمة التوصيل والدفع عند الاستلام.</description>
  </channel>
</rss>`;
}

export function invalidateMerchantFeedCache(): void {
  cachedFeedXml = null;
  cacheExpiresAt = 0;
}
