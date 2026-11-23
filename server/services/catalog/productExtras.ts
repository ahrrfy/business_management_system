// مواد خام لمنتقي وصفة خدمة الطباعة + قراءة صور منتج.
import { and, asc, desc, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { productImages, productUnits, productVariants, products } from "../../../drizzle/schema";
import { getDb } from "../../db";
import { escLike } from "../../lib/sqlLike";
import { notPrintService } from "./search";

/** print-catalog: مواد خام لمنتقي وصفة الخدمة — متغيّرات سلعيّة فعّالة (لا خدمات طباعة) بوحدة الأساس
 *  واسم المنتج والكلفة. يَكشف الكلفة ⇒ يُستدعى من managerProcedure فقط. */
export interface MaterialRow {
  variantId: number;
  productId: number;
  productName: string;
  variantName: string | null;
  sku: string;
  unitName: string;
  costPrice: string;
  activeVariantCount: number;
}
export async function listMaterialsForRecipe(query?: string, limit = 100): Promise<MaterialRow[]> {
  const db = getDb();
  if (!db) return [];
  // مواد خامٍ حقيقيّة: سلع مخزنيّة نشطة فقط. نستثني:
  //  - الخدمات (isService=true) — بلا مخزون ذاتيّ، لا معنى لاستهلاكها كمادة.
  //  - خدمات الطباعة (productType=PRINT_SERVICE) — سبيل خاص عبر وصفتها هي.
  //  - البكج (isBundle=true) — منتج مركّب بلا رصيد ذاتيّ، مكوّناته هي المواد.
  //  - بضاعة الأمانة (isConsignment=true) — ليست ملك المكتبة، لا تُستهلَك في خدمةٍ داخلية.
  //  - المنتجات المعطَّلة (products.isActive=false) — كانت مفقودةً ⇒ مواد قديمة تظهر في الوصفة.
  const conds: SQL[] = [
    eq(products.isActive, true),
    eq(products.isService, false),
    eq(products.isBundle, false),
    eq(products.isConsignment, false),
    eq(productVariants.isActive, true),
    eq(productUnits.isBaseUnit, true),
    notPrintService,
    sql`(${products.stockUsage} IS NULL OR ${products.stockUsage} IN ('MATERIAL_ONLY', 'SALE_AND_MATERIAL'))`,
  ];
  const q = (query ?? "").trim();
  if (q) {
    // LIKE-ESCAPE (تدقيق ٢/٧): escLike يهرّب بـ«!» لكن العبارة كانت بلا ESCAPE '!' ⇒ الهروب مُعطَّل
    // (أحرف البدل %/_ تُفسَّر، وحرف «!» يُطابَق حرفياً فيكسر البحث). نضيف ESCAPE '!' كباقي الاستعلامات.
    const like = `%${escLike(q)}%`;
    conds.push(or(sql`${products.name} LIKE ${like} ESCAPE '!'`, sql`${productVariants.sku} LIKE ${like} ESCAPE '!'`)!);
  }
  const rows = await db
    .select({
      variantId: productVariants.id,
      productId: productVariants.productId,
      productName: products.name,
      variantName: productVariants.variantName,
      sku: productVariants.sku,
      unitName: productUnits.unitName,
      costPrice: productVariants.costPrice,
    })
    .from(productVariants)
    .innerJoin(products, eq(productVariants.productId, products.id))
    .innerJoin(productUnits, eq(productUnits.variantId, productVariants.id))
    .where(and(...conds))
    .orderBy(asc(products.name))
    .limit(limit);
  const productIds = Array.from(new Set(rows.map((r) => Number(r.productId))));
  const countMap = new Map<number, number>();
  if (productIds.length) {
    const cntRows = await db
      .select({
        productId: productVariants.productId,
        cnt: sql<string>`COUNT(*)`,
      })
      .from(productVariants)
      .where(and(inArray(productVariants.productId, productIds), eq(productVariants.isActive, true)))
      .groupBy(productVariants.productId);
    for (const c of cntRows) countMap.set(Number(c.productId), Number(c.cnt));
  }
  return rows.map((r) => ({
    variantId: Number(r.variantId),
    productId: Number(r.productId),
    productName: r.productName,
    variantName: r.variantName,
    sku: r.sku,
    unitName: r.unitName,
    costPrice: r.costPrice,
    activeVariantCount: countMap.get(Number(r.productId)) ?? 1,
  }));
}

/** v3-add-screens: قراءة صور منتج مرتّبة (الرئيسية أولاً). */
export async function listProductImages(productId: number) {
  const db = getDb();
  if (!db) return [];
  return db.select().from(productImages).where(eq(productImages.productId, productId)).orderBy(desc(productImages.isPrimary), asc(productImages.sortOrder));
}
