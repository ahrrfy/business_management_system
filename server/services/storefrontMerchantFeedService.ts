import { and, asc, desc, eq } from "drizzle-orm";
import { categories, productImages, productPrices, productUnits, productVariants, products } from "../../drizzle/schema";
import { getDb } from "../db";
import { storefrontPublishableCondition } from "./storefrontEligibilityService";

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
        name: products.name,
        storeTitle: products.storeTitle,
        description: products.description,
        categoryName: categories.name,
        price: productPrices.price,
        updatedAt: products.updatedAt,
      })
      .from(products)
      .leftJoin(categories, eq(products.categoryId, categories.id))
      .innerJoin(productVariants, eq(products.id, productVariants.productId))
      .innerJoin(productUnits, eq(productVariants.id, productUnits.variantId))
      .innerJoin(productPrices, and(eq(productUnits.id, productPrices.productUnitId), eq(productPrices.priceTier, "RETAIL")))
      .where(storefrontPublishableCondition())
      .orderBy(desc(products.updatedAt));

    // استخراج أول صورة معتمدة لكل منتج لتضمينها في خلاصة جوجل للتسوق
    const approvedImages = await db
      .select({
        productId: productImages.productId,
        url: productImages.url,
      })
      .from(productImages)
      .where(eq(productImages.reviewStatus, "APPROVED"))
      .orderBy(desc(productImages.isPrimary), asc(productImages.sortOrder), asc(productImages.id));

    const imageMap = new Map<number, string>();
    for (const img of approvedImages) {
      const pid = Number(img.productId);
      if (!imageMap.has(pid) && img.url) {
        imageMap.set(pid, img.url);
      }
    }

    const productMap = new Map<number, {
      productId: number;
      title: string;
      description: string;
      categoryName: string;
      price: string;
    }>();

    for (const row of productRows) {
      const pid = Number(row.productId);
      if (!productMap.has(pid)) {
        const title = row.storeTitle || row.name;
        const rawDesc = row.description ? stripHtml(row.description) : "";
        const description = rawDesc.length > 10
          ? rawDesc.slice(0, 1000)
          : `${title} من قسم ${row.categoryName || "القرطاسية والطباعة"} في المكتبة العربية. متوفر للشراء مع توصيل لكافة محافظات العراق والدفع عند الاستلام.`;
        const price = row.price ? String(row.price) : "0";
        productMap.set(pid, {
          productId: pid,
          title,
          description,
          categoryName: row.categoryName || "قرطاسية وطباعة",
          price,
        });
      }
    }

    const items: string[] = [];

    for (const prod of Array.from(productMap.values())) {
      const link = `${baseOrigin}/store/product/${prod.productId}`;
      const imgUrl = imageMap.get(prod.productId);
      let imageLink = `${baseOrigin}/icon-512.png`;
      if (imgUrl) {
        imageLink = imgUrl.startsWith("http")
          ? imgUrl
          : `${baseOrigin}${imgUrl.startsWith("/") ? "" : "/"}${imgUrl}`;
      }

      items.push(`    <item>
      <g:id>PROD-${prod.productId}</g:id>
      <g:title>${escapeXml(prod.title)}</g:title>
      <g:description>${escapeXml(prod.description)}</g:description>
      <g:link>${escapeXml(link)}</g:link>
      <g:image_link>${escapeXml(imageLink)}</g:image_link>
      <g:availability>in_stock</g:availability>
      <g:price>${prod.price} IQD</g:price>
      <g:brand>المكتبة العربية</g:brand>
      <g:condition>new</g:condition>
      <g:identifier_exists>no</g:identifier_exists>
      <g:product_type>${escapeXml(prod.categoryName)}</g:product_type>
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
