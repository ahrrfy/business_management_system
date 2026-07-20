// كاشف الأسماء المشابهة عند إضافة/تعديل منتج — يمنع ازدواج الكتالوج عند المصدر.
// «قلم جاف أزرق باركر» و«باركر قلم ازرق» يجب أن يتصادما هنا قبل أن يصيرا صنفين.
import { and, asc, ne, sql, type SQL } from "drizzle-orm";
import { products } from "../../../drizzle/schema";
import { normalizeSearchText, tokenizeSearchQuery } from "../../../shared/searchNormalize";
import { getDb } from "../../db";
import { escLike } from "../../lib/sqlLike";

// ⚠️ العمود المولَّد searchNorm (هجرة 0035) يطوي الهمزات/التاء/الكشيدة لكنه **لا يطوي الأرقام**
// العربية-الهندية، بينما tokenizeSearchQuery يحوّلها لاتينية ⇒ «96» لن يطابق «٩٦» المخزَّنة.
// نطوي الأرقام وقت الاستعلام فوق العمود (لا فهرس يُفقَد — المطابقة LIKE %..% مسح كامل أصلاً،
// جدول المنتجات وحده بلا joins وبحدّ ٨ نتائج لنداء مُؤجَّل).
const ARABIC_DIGITS = "٠١٢٣٤٥٦٧٨٩";
const PERSIAN_DIGITS = "۰۱۲۳۴۵۶۷۸۹";
function foldDigits(expr: SQL): SQL {
  let out = expr;
  for (let i = 0; i < 10; i++) {
    out = sql`replace(${out}, ${ARABIC_DIGITS[i]}, ${String(i)})`;
    out = sql`replace(${out}, ${PERSIAN_DIGITS[i]}, ${String(i)})`;
  }
  return out;
}

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
 * يبحث عن منتجات بأسماء مشابهة للاسم المُدخل على `products.searchNorm` (العمود المولَّد
 * بالتطبيع العربي — هجرة 0035): تُقطَّع الكلمات ويُشترط ورود **أغلبيتها** (⌊ن/٢⌋+١) لا كلّها —
 * فمطابقة الكل تُفلت الازدواج الناقص كلمةً («باركر قلم ازرق» بلا «جاف»)، ومطابقة أيّ كلمة
 * تُغرق بالضجيج («قلم» وحدها = مئات). الترتيب: التطابق التام ثم عدد الكلمات المطابقة.
 * قراءة صرفة على جدول المنتجات وحده (~١٠آلاف صف، بلا joins) — مناسبة لنداء حيّ مُؤجَّل.
 */
export async function findSimilarProductNames(
  name: string,
  opts: { excludeProductId?: number; limit?: number } = {}
): Promise<SimilarNameHit[]> {
  const limit = Math.min(Math.max(opts.limit ?? 8, 1), 20);
  const tokens = tokenizeSearchQuery(name); // ≤٥ كلمات مُطبَّعة
  if (!tokens.length) return [];
  const whole = normalizeSearchText(name);
  const db = getDb();
  if (!db) throw new Error("DATABASE_URL not set");

  const norm = foldDigits(sql`coalesce(${products.searchNorm}, '')`);
  const tokenHits = tokens.map(
    (t) => sql`(case when ${norm} LIKE ${`%${escLike(t)}%`} ESCAPE '!' then 1 else 0 end)`
  );
  const matchCount = sql`(${sql.join(tokenHits, sql` + `)})`;
  // أغلبية الكلمات: ن=١⇒١، ن=٢⇒٢، ن=٣⇒٢، ن=٤⇒٣، ن=٥⇒٣.
  const threshold = Math.floor(tokens.length / 2) + 1;
  const isExactExpr = sql<number>`case when ${norm} = ${whole} then 1 else 0 end`;

  const conds: SQL[] = [sql`${matchCount} >= ${threshold}`];
  if (opts.excludeProductId) conds.push(ne(products.id, opts.excludeProductId));

  const rows = await db
    .select({
      id: products.id,
      name: products.name,
      brand: products.brand,
      productType: products.productType,
      isActive: products.isActive,
      exact: isExactExpr,
    })
    .from(products)
    .where(and(...conds))
    .orderBy(
      sql`${isExactExpr} desc`,
      sql`${matchCount} desc`,
      sql`instr(${norm}, ${tokens[0]})`,
      asc(products.name)
    )
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
