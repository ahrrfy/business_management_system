// كاشف الأسماء المشابهة عند إضافة/تعديل منتج — يمنع ازدواج الكتالوج عند المصدر.
// «قلم جاف أزرق باركر» و«باركر قلم ازرق» يجب أن يتصادما هنا قبل أن يصيرا صنفين.
// المطابقة (أغلبية الكلمات + طيّ الأرقام + isExact) في النواة المشتركة server/lib/similarMatch.ts
// — نفسها المستعملة لكاشفَي العميل/المورّد.
import { and, asc, ne, sql, type SQL } from "drizzle-orm";
import { products } from "../../../drizzle/schema";
import { getDb } from "../../db";
import { majorityTokenMatch } from "../../lib/similarMatch";

export interface SimilarNameHit {
  id: number;
  name: string;
  brand: string | null;
  productType: string | null;
  isActive: boolean;
  /** تطابق تام في الفضاء المُطبَّع (همزات/تاء مربوطة/أرقام) — تحذير أقوى من مجرد تشابه. */
  isExact: boolean;
}

/**
 * يبحث عن منتجات بأسماء مشابهة للاسم المُدخل على `products.searchNorm`.
 * قراءة صرفة على جدول المنتجات وحده (~١٠آلاف صف، بلا joins) — مناسبة لنداء حيّ مُؤجَّل.
 */
export async function findSimilarProductNames(
  name: string,
  opts: { excludeProductId?: number; limit?: number } = {}
): Promise<SimilarNameHit[]> {
  const limit = Math.min(Math.max(opts.limit ?? 8, 1), 20);
  const match = majorityTokenMatch(sql`${products.searchNorm}`, name);
  if (!match) return [];
  const db = getDb();
  if (!db) throw new Error("DATABASE_URL not set");

  const conds: SQL[] = [match.where];
  if (opts.excludeProductId) conds.push(ne(products.id, opts.excludeProductId));

  const rows = await db
    .select({
      id: products.id,
      name: products.name,
      brand: products.brand,
      productType: products.productType,
      isActive: products.isActive,
      exact: match.isExact,
    })
    .from(products)
    .where(and(...conds))
    .orderBy(...match.orderBy, asc(products.name))
    .limit(limit);

  return rows.map((r) => ({
    id: Number(r.id),
    name: r.name,
    brand: r.brand ?? null,
    productType: r.productType ?? null,
    isActive: !!r.isActive,
    isExact: Number(r.exact) === 1,
  }));
}
