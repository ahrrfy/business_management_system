/**
 * storeCatalogService — «الكتالوج والعرض» في لوحة hPanel: عرض منتجات المتجر بحالة المخزون/الصورة/
 * التمييز/الإظهار، وضبطها من مكانٍ واحد. المخزون يُسوّى عبر setStock + قيد ADJUST (نمط inventory.adjust
 * الذرّي — لا كتابة branchStock عارية). الصورة على مستوى المنتج (primary). كلّه بوّابة store.
 */
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { branchStock, categories, productImages, productPrices, productUnits, productVariants, products } from "../../../drizzle/schema";
import { getDb } from "../../db";
import { escLike } from "../../lib/sqlLike";
import { withTx } from "../tx";
import { requestStockAdjustment } from "../inventory/adjustmentApproval";
import { assertValidImageDataUrl } from "../../lib/imageValidation";
import {
  storefrontAvailableCondition,
  storefrontPublishableCondition,
  type StorefrontReadinessReason,
} from "../storefrontEligibilityService";
import {
  loadStorefrontReadiness,
  type StorefrontReadinessVariant,
} from "./storefrontReadinessService";

export interface StoreCatalogRow {
  productId: number;
  name: string;
  categoryName: string | null;
  isActive: boolean;
  isFeatured: boolean;
  showInStore: boolean;
  /** توافق قديم: لا يُملأ إلا إذا كان للمنتج متغيّر واحد بالضبط. */
  variantId: number | null;
  retailPrice: string | null;
  saleUnitName: string | null;
  /** توافق قديم: رصيد المتغيّر الوحيد؛ null للمنتج متعدد المتغيّرات كي لا يوحي بمجموع كاذب. */
  stockBase: number | null;
  publishable: boolean;
  inStock: boolean;
  readinessReasons: StorefrontReadinessReason[];
  variants: StorefrontReadinessVariant[];
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
): Promise<{ rows: StoreCatalogRow[]; total: number; publishableTotal: number; sellableTotal: number }> {
  const db = getDb();
  if (!db) return { rows: [], total: 0, publishableTotal: 0, sellableTotal: 0 };
  const limit = Math.min(input.limit ?? 50, 200);
  const offset = Math.max(input.offset ?? 0, 0);

  const conds = [];
  if (input.categoryId === 0 || input.categoryId === null) conds.push(isNull(products.categoryId));
  else if (input.categoryId != null) conds.push(eq(products.categoryId, input.categoryId));
  const q = input.q?.trim();
  // تدقيق ٣/٨: تهريب `%`/`_` (escLike + ESCAPE '!') — اتساقٌ مع مسارات البحث (القيمة مربوطة، لا حقن).
  const qPat = q ? `%${escLike(q)}%` : null;
  if (qPat) conds.push(sql`(${products.name} LIKE ${qPat} ESCAPE '!' OR ${products.searchNorm} LIKE ${qPat} ESCAPE '!')`);
  if (input.featuredOnly) conds.push(eq(products.isFeatured, true));
  if (input.hiddenOnly) conds.push(eq(products.showInStore, false));
  if (input.missingImageOnly) conds.push(isNull(productImages.id));
  const whereClause = conds.length ? and(...conds) : undefined;

  const base = db
    .select({
      productId: products.id,
      name: products.name,
      categoryName: sql<string | null>`MAX(${categories.name})`,
      isActive: products.isActive,
      isFeatured: products.isFeatured,
      showInStore: products.showInStore,
      imageUrl: sql<string | null>`MAX(${productImages.url})`,
    })
    .from(products)
    .leftJoin(categories, eq(categories.id, products.categoryId))
    .leftJoin(productImages, and(
      eq(productImages.productId, products.id),
      eq(productImages.isPrimary, true),
      isNull(productImages.variantId),
    ))
    .where(whereClause)
    .groupBy(products.id)
    .orderBy(desc(products.isFeatured), asc(products.name))
    .limit(limit)
    .offset(offset);

  const raw = await base;
  const productIds = raw.map((r) => Number(r.productId));
  const readiness = await loadStorefrontReadiness({ branchId: input.branchId, productIds });
  const rows: StoreCatalogRow[] = raw.map((r) => {
    const productId = Number(r.productId);
    const state = readiness.get(productId);
    const onlyVariant = state?.variants.length === 1 ? state.variants[0] : null;
    return {
      productId,
      name: r.name,
      categoryName: r.categoryName ?? null,
      isActive: r.isActive === true,
      isFeatured: !!r.isFeatured,
      showInStore: r.showInStore == null ? true : !!r.showInStore,
      variantId: onlyVariant?.variantId ?? null,
      retailPrice: state?.preferredUnit?.retailPrice ?? null,
      saleUnitName: state?.preferredUnit?.unitName ?? null,
      stockBase: onlyVariant?.stockBase ?? null,
      publishable: state?.publishable ?? false,
      inStock: state?.inStock ?? false,
      readinessReasons: state?.readinessReasons ?? ["NO_ACTIVE_VARIANT"],
      variants: state?.variants ?? [],
      hasImage: r.imageUrl != null,
      imageUrl: r.imageUrl ?? null,
    };
  });

  const [cnt] = await db
    .select({ n: sql<number>`COUNT(DISTINCT ${products.id})` })
    .from(products)
    .leftJoin(productImages, and(
      eq(productImages.productId, products.id),
      eq(productImages.isPrimary, true),
      isNull(productImages.variantId),
    ))
    .where(whereClause);

  // العدد الحقيقي «الظاهر فعلياً» — نفس شرط sellable في storefrontService، بنفس فلترة الفئة/البحث
  // (لا فلاتر العرض featuredOnly/hiddenOnly/missingImageOnly — تلك أدوات تصفّح للمدير لا معيار بيع).
  const eligibilityConds = [storefrontPublishableCondition()];
  if (input.categoryId === 0 || input.categoryId === null) eligibilityConds.push(isNull(products.categoryId));
  else if (input.categoryId != null) eligibilityConds.push(eq(products.categoryId, input.categoryId));
  if (qPat) eligibilityConds.push(sql`(${products.name} LIKE ${qPat} ESCAPE '!' OR ${products.searchNorm} LIKE ${qPat} ESCAPE '!')`);
  const [eligibilityCnt] = await db
    .select({
      publishable: sql<number>`COUNT(DISTINCT ${products.id})`,
      available: sql<number>`COUNT(DISTINCT CASE WHEN ${storefrontAvailableCondition()} THEN ${products.id} END)`,
    })
    .from(products)
    .innerJoin(productVariants, eq(productVariants.productId, products.id))
    .innerJoin(productUnits, eq(productUnits.variantId, productVariants.id))
    .innerJoin(productPrices, and(eq(productPrices.productUnitId, productUnits.id), eq(productPrices.priceTier, "RETAIL")))
    .leftJoin(branchStock, and(eq(branchStock.variantId, productVariants.id), eq(branchStock.branchId, input.branchId)))
    .where(and(...eligibilityConds));

  return {
    rows,
    total: Number(cnt?.n ?? 0),
    publishableTotal: Number(eligibilityCnt?.publishable ?? 0),
    sellableTotal: Number(eligibilityCnt?.available ?? 0),
  };
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

/** لوحة المتجر: **طلب** ضبط مخزون — يمرّ بالاعتماد الثنائيّ نفسه (فصل مهام #٦): يُنشئ طلباً معلَّقاً
 *  (بلا تغيير مخزون) يعتمده مديرٌ آخر عبر approveStockAdjustment. كان يطبّق setStock فوراً بفاعلٍ واحد
 *  (بابُ تجاوزٍ للضبط — مراجعة عدائية). */
export async function setStoreProductStock(input: { variantId: number; branchId: number; targetQuantity: number; createdBy: number; role?: string; notes?: string }) {
  return requestStockAdjustment(
    {
      variantId: input.variantId,
      branchId: input.branchId,
      targetQuantity: input.targetQuantity,
      notes: input.notes ? `لوحة المتجر — ${input.notes}` : "لوحة المتجر",
    },
    { userId: input.createdBy, branchId: input.branchId, role: input.role },
  );
}
