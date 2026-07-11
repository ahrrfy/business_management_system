/**
 * storefrontService — كتالوج آمن **علني** (بلا مصادقة) لمتجر الزبون على الجوال (B2C).
 *
 * ⚠️ أمن مالي حاكم (نفس مبدأ kioskService): هذه الدوال تُغذّي شاشةً يراها **الزبون على
 * الإنترنت**، فلا تُعيد أبداً التكلفة (costPrice) ولا كمية المخزون ولا أسعار الجملة/الحكومي —
 * فقط الحقول التسويقية الآمنة: اسم المنتج، الماركة، الفئة، **سعر المفرد (RETAIL)**، اسم
 * الوحدة، والصورة الرئيسية. كل نقاط هذا السطح **محدودة المعدّل** على مستوى المسار في
 * server/index.ts (سطح علني قابل للكشط/الإغراق) — عكس نقطة Antigravity العارية التي حُذفت.
 *
 * الكتالوج مشترك بين الفروع في هذا النشاط (كما في kioskBanner)، فلا يُقيَّد بفرع.
 * يُعرَض المنتج بوحدة الأساس التي لها سعر مفرد صريح، وبطاقةٌ واحدة لكل منتج.
 */
import { and, asc, desc, eq, like, or, sql } from "drizzle-orm";
import { categories, productImages, productPrices, productUnits, productVariants, products } from "../../drizzle/schema";
import { getDb } from "../db";

const RETAIL = "RETAIL" as const;

/** صفّ عرض آمن للزبون — لا تكلفة ولا كمية مخزون ولا أسعار جملة/حكومي. */
export interface StorefrontProduct {
  productId: number;
  /** مُعرّف وحدة الأساس — يحتاجه سطر الطلب (createOrder). مُعرّف فقط، لا حقل حسّاس. */
  productUnitId: number;
  productName: string;
  brand: string | null;
  category: string | null;
  categoryId: number | null;
  unitName: string;
  /** سعر هذه الوحدة بفئة المفرد (RETAIL)؛ null نظرياً لكنه مُستبعَد بالشرط. */
  price: string | null;
  /** صورة المنتج الرئيسية (data URL أو رابط)؛ null ⇒ خانة بديلة في الواجهة. */
  imageUrl: string | null;
}

export interface StorefrontCategory {
  id: number;
  name: string;
  productCount: number;
}

/** شرط «قابل للاقتناء والعرض للزبون»: منتج فعّال غير خدمي، بوحدة أساس فعّالة ولها سعر مفرد. */
const sellable = and(
  eq(products.isActive, true),
  eq(products.isService, false),
  eq(productVariants.isActive, true),
  eq(productUnits.isActive, true),
  eq(productUnits.isBaseUnit, true),
  sql`${productPrices.price} is not null`
);

/** SELECT موحّد بالحقول الآمنة فقط — يُغذّي الكتالوج وصفحة المنتج معاً. */
function safeSelect(db: NonNullable<ReturnType<typeof getDb>>) {
  return db
    .select({
      productId: products.id,
      productUnitId: productUnits.id,
      productName: products.name,
      brand: products.brand,
      category: categories.name,
      categoryId: products.categoryId,
      unitName: productUnits.unitName,
      price: productPrices.price,
      imageUrl: productImages.url,
    })
    .from(productUnits)
    .innerJoin(productVariants, eq(productUnits.variantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
    .leftJoin(categories, eq(products.categoryId, categories.id))
    .leftJoin(productPrices, and(eq(productPrices.productUnitId, productUnits.id), eq(productPrices.priceTier, RETAIL)))
    .leftJoin(productImages, and(eq(productImages.productId, products.id), eq(productImages.isPrimary, true)));
}

function toStorefront(r: {
  productId: number; productUnitId: number; productName: string; brand: string | null; category: string | null;
  categoryId: number | null; unitName: string; price: string | null; imageUrl: string | null;
}): StorefrontProduct {
  return {
    productId: Number(r.productId),
    productUnitId: Number(r.productUnitId),
    productName: r.productName,
    brand: r.brand ?? null,
    category: r.category ?? null,
    categoryId: r.categoryId != null ? Number(r.categoryId) : null,
    unitName: r.unitName,
    price: r.price ?? null,
    imageUrl: r.imageUrl ?? null,
  };
}

/**
 * كتالوج المتجر: منتجات قابلة للاقتناء (بطاقة لكل منتج) مع فلترة فئة وبحث نصّي اختياريين.
 * ترتيب: ذوات الصور أولاً ثم أبجدياً (نفس منطق البنر). لا صفحات keyset بعد — سقفٌ معقول
 * يستوعب كتالوج مكتبة نموذجياً؛ يُرقَّى لاحقاً (شريحة تالية) عند الحاجة.
 */
export async function storefrontCatalog(opts: {
  categoryId?: number | null;
  search?: string | null;
  limit?: number;
}): Promise<{ items: StorefrontProduct[] }> {
  const db = getDb();
  if (!db) return { items: [] };
  const cap = Math.min(Math.max(opts.limit ?? 60, 1), 120);
  const conds = [sellable];
  if (opts.categoryId != null) conds.push(eq(products.categoryId, opts.categoryId));
  const s = String(opts.search ?? "").trim();
  if (s) {
    const p = `%${s}%`;
    const searchCond = or(like(products.name, p), like(products.brand, p), like(productUnits.barcode, p));
    if (searchCond) conds.push(searchCond);
  }
  // فائض ×٣ لاستيعاب إزالة تكرار المتغيّرات (منتج بعدّة متغيّرات لكلٍّ وحدة أساس).
  const rows = await safeSelect(db)
    .where(and(...conds))
    .orderBy(desc(sql`${productImages.url} is not null`), asc(products.name))
    .limit(cap * 3);

  const seen = new Set<number>();
  const items: StorefrontProduct[] = [];
  for (const r of rows) {
    const pid = Number(r.productId);
    if (seen.has(pid)) continue;
    seen.add(pid);
    items.push(toStorefront(r));
    if (items.length >= cap) break;
  }
  return { items };
}

/** فئات المتجر: الفئات التي فيها منتج واحد على الأقل قابل للاقتناء (لأشرطة الفلترة). */
export async function storefrontCategories(): Promise<StorefrontCategory[]> {
  const db = getDb();
  if (!db) return [];
  const rows = await db
    .select({
      id: categories.id,
      name: categories.name,
      productCount: sql<number>`COUNT(DISTINCT ${products.id})`,
    })
    .from(products)
    .innerJoin(productVariants, and(eq(productVariants.productId, products.id), eq(productVariants.isActive, true)))
    .innerJoin(
      productUnits,
      and(eq(productUnits.variantId, productVariants.id), eq(productUnits.isActive, true), eq(productUnits.isBaseUnit, true))
    )
    .innerJoin(productPrices, and(eq(productPrices.productUnitId, productUnits.id), eq(productPrices.priceTier, RETAIL)))
    .innerJoin(categories, eq(products.categoryId, categories.id))
    .where(and(eq(products.isActive, true), eq(products.isService, false)))
    .groupBy(categories.id, categories.name)
    .orderBy(asc(categories.name));
  return rows.map((r) => ({ id: Number(r.id), name: r.name, productCount: Number(r.productCount) }));
}

/** صفحة منتج واحد (تفاصيل آمنة). null إن لم يُعثر عليه أو ليس قابلاً للاقتناء. */
export async function storefrontProduct(productId: number): Promise<StorefrontProduct | null> {
  const db = getDb();
  if (!db) return null;
  const rows = await safeSelect(db)
    .where(and(sellable, eq(products.id, productId)))
    .limit(1);
  return rows.length ? toStorefront(rows[0]) : null;
}
