// مواد خام لمنتقي وصفة خدمة الطباعة + قراءة صور منتج.
import { and, asc, desc, eq, or, sql, type SQL } from "drizzle-orm";
import { productImages, productUnits, productVariants, products } from "../../../drizzle/schema";
import { getDb } from "../../db";
import { escLike } from "../../lib/sqlLike";
import { notPrintService } from "./search";

/** print-catalog: مواد خام لمنتقي وصفة الخدمة — متغيّرات سلعيّة فعّالة (لا خدمات طباعة) بوحدة الأساس
 *  واسم المنتج والكلفة. يَكشف الكلفة ⇒ يُستدعى من managerProcedure فقط. */
export interface MaterialRow {
  variantId: number;
  productName: string;
  variantName: string | null;
  sku: string;
  unitName: string;
  costPrice: string;
}
export async function listMaterialsForRecipe(query?: string, limit = 100): Promise<MaterialRow[]> {
  const db = getDb();
  if (!db) return [];
  const conds: SQL[] = [
    eq(productVariants.isActive, true),
    eq(productUnits.isBaseUnit, true),
    notPrintService,
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
  return rows.map((r) => ({
    variantId: Number(r.variantId),
    productName: r.productName,
    variantName: r.variantName,
    sku: r.sku,
    unitName: r.unitName,
    costPrice: r.costPrice,
  }));
}

/** v3-add-screens: قراءة صور منتج مرتّبة (الرئيسية أولاً). */
export async function listProductImages(productId: number) {
  const db = getDb();
  if (!db) return [];
  return db.select().from(productImages).where(eq(productImages.productId, productId)).orderBy(desc(productImages.isPrimary), asc(productImages.sortOrder));
}
