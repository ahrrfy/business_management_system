/**
 * storeCatalogService — «الكتالوج والعرض» في لوحة hPanel: عرض منتجات المتجر بحالة المخزون/الصورة/
 * التمييز/الإظهار، وضبطها من مكانٍ واحد. المخزون يُسوّى عبر setStock + قيد ADJUST (نمط inventory.adjust
 * الذرّي — لا كتابة branchStock عارية). الصورة على مستوى المنتج (primary). كلّه بوّابة store.
 */
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { branchStock, categories, productImages, productPrices, productUnits, productVariants, products } from "../../../drizzle/schema";
import { getDb } from "../../db";
import { withTx } from "../tx";
import { setStock } from "../inventoryService";
import { postEntry } from "../ledgerService";
import { money } from "../money";
import { assertValidImageDataUrl } from "../../lib/imageValidation";

export interface StoreCatalogRow {
  productId: number;
  name: string;
  categoryName: string | null;
  isActive: boolean;
  isFeatured: boolean;
  showInStore: boolean;
  variantId: number | null;
  retailPrice: string | null;
  stockBase: number;
  hasImage: boolean;
  imageUrl: string | null;
}

export interface StoreCatalogListInput {
  branchId: number;
  q?: string;
  categoryId?: number | null; // 0/null = «بلا فئة»
  featuredOnly?: boolean;
  hiddenOnly?: boolean;
  missingImageOnly?: boolean;
  limit?: number;
  offset?: number;
}

/**
 * قائمة منتجات المتجر بحبيبة المنتج (تجميع على products.id) + حالة المخزون/الصورة/الأعلام.
 *
 * `total` = عدد المنتجات المطابقة للبحث/الفئة بلا أي شرط ظهور (تشمل المعطّل/المخفيّ — تصفّحها
 * المدير هنا لضبطها)؛ `sellableTotal` = العدد الحقيقي الظاهر فعلاً لزبون المتجر العلني الآن، بنفس
 * معايير `storefrontService.sellable` (نشط + ليس خدمة + غير مخفيّ + متغيّر/وحدة نشطان + سعر مفرد
 * موجود). الفرق بين الاثنين هو ما يوضّح لماذا «منتج بالكتالوج» ≠ «ظاهر في المتجر فعلياً».
 */
export async function listStoreCatalog(
  input: StoreCatalogListInput,
): Promise<{ rows: StoreCatalogRow[]; total: number; sellableTotal: number }> {
  const db = getDb();
  if (!db) return { rows: [], total: 0, sellableTotal: 0 };
  const limit = Math.min(input.limit ?? 50, 200);
  const offset = Math.max(input.offset ?? 0, 0);

  const conds = [];
  if (input.categoryId === 0 || input.categoryId === null) conds.push(isNull(products.categoryId));
  else if (input.categoryId != null) conds.push(eq(products.categoryId, input.categoryId));
  const q = input.q?.trim();
  if (q) conds.push(sql`(${products.name} LIKE ${"%" + q + "%"} OR ${products.searchNorm} LIKE ${"%" + q + "%"})`);
  if (input.featuredOnly) conds.push(eq(products.isFeatured, true));
  if (input.hiddenOnly) conds.push(eq(products.showInStore, false));
  const whereClause = conds.length ? and(...conds) : undefined;

  const base = db
    .select({
      productId: products.id,
      name: products.name,
      categoryName: sql<string | null>`MAX(${categories.name})`,
      isActive: products.isActive,
      isFeatured: products.isFeatured,
      showInStore: products.showInStore,
      variantId: sql<number | null>`MIN(${productVariants.id})`,
      retailPrice: sql<string | null>`MAX(${productPrices.price})`,
      stockBase: sql<number>`COALESCE(SUM(${branchStock.quantity}), 0)`,
      imageUrl: sql<string | null>`MAX(${productImages.url})`,
    })
    .from(products)
    .leftJoin(categories, eq(categories.id, products.categoryId))
    .leftJoin(productVariants, and(eq(productVariants.productId, products.id), eq(productVariants.isActive, true)))
    .leftJoin(productUnits, and(eq(productUnits.variantId, productVariants.id), eq(productUnits.isBaseUnit, true)))
    .leftJoin(productPrices, and(eq(productPrices.productUnitId, productUnits.id), eq(productPrices.priceTier, "RETAIL")))
    .leftJoin(branchStock, and(eq(branchStock.variantId, productVariants.id), eq(branchStock.branchId, input.branchId)))
    .leftJoin(productImages, and(eq(productImages.productId, products.id), eq(productImages.isPrimary, true)))
    .where(whereClause)
    .groupBy(products.id)
    .orderBy(desc(products.isFeatured), asc(products.name))
    .limit(limit)
    .offset(offset);

  const raw = await base;
  let rows: StoreCatalogRow[] = raw.map((r) => ({
    productId: Number(r.productId),
    name: r.name,
    categoryName: r.categoryName ?? null,
    isActive: r.isActive == null ? true : !!r.isActive,
    isFeatured: !!r.isFeatured,
    showInStore: r.showInStore == null ? true : !!r.showInStore,
    variantId: r.variantId != null ? Number(r.variantId) : null,
    retailPrice: r.retailPrice ?? null,
    stockBase: Number(r.stockBase ?? 0),
    hasImage: r.imageUrl != null,
    imageUrl: r.imageUrl ?? null,
  }));
  if (input.missingImageOnly) rows = rows.filter((r) => !r.hasImage);

  const [cnt] = await db.select({ n: sql<number>`COUNT(*)` }).from(products).where(whereClause);

  // العدد الحقيقي «الظاهر فعلياً» — نفس شرط sellable في storefrontService، بنفس فلترة الفئة/البحث
  // (لا فلاتر العرض featuredOnly/hiddenOnly/missingImageOnly — تلك أدوات تصفّح للمدير لا معيار بيع).
  const sellableConds = [
    eq(products.isActive, true),
    eq(products.isService, false),
    eq(products.showInStore, true),
    eq(productVariants.isActive, true),
    eq(productUnits.isActive, true),
    eq(productUnits.isBaseUnit, true),
    sql`${productPrices.price} is not null`,
  ];
  if (input.categoryId === 0 || input.categoryId === null) sellableConds.push(isNull(products.categoryId));
  else if (input.categoryId != null) sellableConds.push(eq(products.categoryId, input.categoryId));
  if (q) sellableConds.push(sql`(${products.name} LIKE ${"%" + q + "%"} OR ${products.searchNorm} LIKE ${"%" + q + "%"})`);
  const [sellableCnt] = await db
    .select({ n: sql<number>`COUNT(DISTINCT ${products.id})` })
    .from(products)
    .innerJoin(productVariants, eq(productVariants.productId, products.id))
    .innerJoin(productUnits, eq(productUnits.variantId, productVariants.id))
    .innerJoin(productPrices, and(eq(productPrices.productUnitId, productUnits.id), eq(productPrices.priceTier, "RETAIL")))
    .innerJoin(branchStock, and(eq(branchStock.variantId, productVariants.id), eq(branchStock.branchId, input.branchId), gt(branchStock.quantity, 0)))
    .where(and(...sellableConds));

  return { rows, total: Number(cnt?.n ?? 0), sellableTotal: Number(sellableCnt?.n ?? 0) };
}

/** تمييز منتج (يتصدّر العرض في المتجر). */
export async function setProductFeatured(input: { productId: number; isFeatured: boolean }) {
  const db = getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "قاعدة البيانات غير متاحة" });
  const cur = (await db.select({ id: products.id }).from(products).where(eq(products.id, input.productId)).limit(1))[0];
  if (!cur) throw new TRPCError({ code: "NOT_FOUND", message: "المنتج غير موجود" });
  await db.update(products).set({ isFeatured: input.isFeatured }).where(eq(products.id, input.productId));
  return { productId: input.productId, isFeatured: input.isFeatured };
}

/** إظهار/إخفاء منتج من واجهة المتجر (لا يمسّ تفعيله في الـERP/الكاشير). */
export async function setProductStoreVisible(input: { productId: number; showInStore: boolean }) {
  const db = getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "قاعدة البيانات غير متاحة" });
  const cur = (await db.select({ id: products.id }).from(products).where(eq(products.id, input.productId)).limit(1))[0];
  if (!cur) throw new TRPCError({ code: "NOT_FOUND", message: "المنتج غير موجود" });
  await db.update(products).set({ showInStore: input.showInStore }).where(eq(products.id, input.productId));
  return { productId: input.productId, showInStore: input.showInStore };
}

/** صورة المنتج الرئيسية (يقرؤها المتجر). null ⇒ إزالة. تُضغط في العميل قبل الإرسال. */
export async function setProductPrimaryImage(input: { productId: number; url: string | null }) {
  const db = getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "قاعدة البيانات غير متاحة" });
  const cur = (await db.select({ id: products.id }).from(products).where(eq(products.id, input.productId)).limit(1))[0];
  if (!cur) throw new TRPCError({ code: "NOT_FOUND", message: "المنتج غير موجود" });
  if (input.url) assertValidImageDataUrl(input.url);
  return withTx(async (tx) => {
    await tx.delete(productImages).where(and(eq(productImages.productId, input.productId), isNull(productImages.variantId), eq(productImages.isPrimary, true)));
    if (input.url) {
      await tx.insert(productImages).values({ productId: input.productId, variantId: null, url: input.url, isPrimary: true, sortOrder: 0 });
    }
    return { productId: input.productId, hasImage: input.url != null };
  });
}

/** ضبط مخزون منتج (على متغيّره) إلى كميةٍ مستهدفة — ذرّي مع قيد ADJUST (نمط inventory.adjust). */
export async function setStoreProductStock(input: { variantId: number; branchId: number; targetQuantity: number; createdBy: number; notes?: string }) {
  return withTx(async (tx) => {
    const r = await setStock(tx, { variantId: input.variantId, branchId: input.branchId, targetQuantity: input.targetQuantity, createdBy: input.createdBy, notes: input.notes });
    if (r.delta && r.delta !== 0) {
      const v = (await tx.select({ costPrice: productVariants.costPrice }).from(productVariants).where(eq(productVariants.id, input.variantId)).limit(1))[0];
      const adjustValue = money(v?.costPrice ?? "0").times(r.delta);
      if (!adjustValue.isZero()) {
        await postEntry(tx, {
          entryType: "ADJUST",
          branchId: input.branchId,
          cost: adjustValue.neg(),
          profit: adjustValue,
          amount: money(0),
          dedupeKey: `INV_ADJUST:${r.movementId}`,
          notes: `تسوية مخزون من لوحة المتجر${input.notes ? ` — ${input.notes}` : ""}`,
        });
      }
    }
    return r;
  });
}
