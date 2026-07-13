// قائمة إدارة المنتجات + تفعيل/تعطيل منتج.
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { branchStock, categories, productPrices, productUnitBarcodes, productUnits, productVariants, products } from "../../../drizzle/schema";
import { getDb } from "../../db";
import { getProductUsage, isFkBlocked, usageBlockMessage } from "../entityUsage";
import { type Actor, withTx } from "../tx";
import { buildCatalogSearchOrder, buildCatalogSearchWhere } from "./search";

/**
 * صفّ شاشة إدارة المنتجات: حبيبة (متغيّر × وحدة) لكن عبر LEFT JOIN —
 * المنتج بلا متغيّرات/وحدات يظهر صفاً واحداً بأعمدة NULL (بخلاف POS الذي يخفيه).
 * لا يكشف التكلفة أبداً (الشاشة متاحة لكل الأدوار).
 */
export interface AdminProductRow {
  productId: number;
  productName: string;
  productIsActive: boolean;
  categoryId: number | null;
  categoryName: string | null;
  variantId: number | null;
  variantName: string | null;
  color: string | null;
  size: string | null;
  sku: string | null;
  variantIsActive: boolean | null;
  productUnitId: number | null;
  unitName: string | null;
  conversionFactor: string | null;
  barcode: string | null;
  isBaseUnit: boolean | null;
  unitIsActive: boolean | null;
  price: string | null; // RETAIL — للعرض فقط
  stockBase: number;
  /** الباركودات البديلة للوحدة (productUnitBarcodes) — تظهر في التصدير وبجوار الباركود الأساسي. */
  barcodeAliases: string[];
}

export interface ListProductsAdminInput {
  branchId: number;
  q?: string;
  includeInactive?: boolean;
  /** فلترة بالفئة: رقم موجب = فئة محدّدة، 0 = «بلا فئة» (NULL)، غياب = كل الفئات. */
  categoryId?: number;
  limit?: number;
  offset?: number;
}

/**
 * قائمة إدارة المنتجات: كل المنتجات (حتى الناقصة بلا وحدات/متغيّرات) مع بحث ذكي
 * وتقسيم صفحات خادمي + عدّ إجمالي — بديل عن posList (INNER JOIN + حدّ 500) في شاشة الإدارة.
 */
export async function listProductsAdmin(input: ListProductsAdminInput): Promise<{ rows: AdminProductRow[]; total: number }> {
  const db = getDb();
  if (!db) return { rows: [], total: 0 };
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? 50), 1), 500);
  const offset = Math.max(Math.trunc(input.offset ?? 0), 0);

  const conds: SQL[] = [];
  if (!input.includeInactive) {
    // المعطّل يُخفى، لكن المنتج بلا متغيّرات/وحدات (NULL في LEFT JOIN) يبقى ظاهراً.
    conds.push(eq(products.isActive, true));
    const vActive = or(isNull(productVariants.id), eq(productVariants.isActive, true));
    if (vActive) conds.push(vActive);
    const uActive = or(isNull(productUnits.id), eq(productUnits.isActive, true));
    if (uActive) conds.push(uActive);
  }
  const search = buildCatalogSearchWhere(input.q);
  if (search) conds.push(search);
  // فلترة بالفئة: 0 ⇒ «بلا فئة» (NULL)، رقم موجب ⇒ تلك الفئة.
  if (input.categoryId != null) {
    conds.push(input.categoryId === 0 ? isNull(products.categoryId) : eq(products.categoryId, input.categoryId));
  }
  const where = conds.length ? and(...conds) : undefined;

  // ترتيب حتمي للتقسيم: مفاتيح الحبيبة (variant ثم unit) تذيّل الترتيب دائماً.
  const order = search
    ? [...buildCatalogSearchOrder(input.q), asc(productVariants.id), asc(productUnits.id)]
    : [desc(products.id), asc(productVariants.id), asc(productUnits.id)];

  const rows = await db
    .select({
      productId: products.id,
      productName: products.name,
      productIsActive: products.isActive,
      categoryId: products.categoryId,
      categoryName: categories.name,
      variantId: productVariants.id,
      variantName: productVariants.variantName,
      color: productVariants.color,
      size: productVariants.size,
      sku: productVariants.sku,
      variantIsActive: productVariants.isActive,
      productUnitId: productUnits.id,
      unitName: productUnits.unitName,
      conversionFactor: productUnits.conversionFactor,
      barcode: productUnits.barcode,
      isBaseUnit: productUnits.isBaseUnit,
      unitIsActive: productUnits.isActive,
      price: productPrices.price,
      stockBase: branchStock.quantity,
    })
    .from(products)
    .leftJoin(categories, eq(categories.id, products.categoryId))
    .leftJoin(productVariants, eq(productVariants.productId, products.id))
    .leftJoin(productUnits, eq(productUnits.variantId, productVariants.id))
    .leftJoin(
      productPrices,
      and(eq(productPrices.productUnitId, productUnits.id), eq(productPrices.priceTier, "RETAIL"))
    )
    .leftJoin(
      branchStock,
      and(eq(branchStock.variantId, productVariants.id), eq(branchStock.branchId, input.branchId))
    )
    .where(where)
    .orderBy(...order)
    .limit(limit)
    .offset(offset);

  // البدائل باستعلام دفعي ثانٍ على وحدات الصفحة فقط (≤500) — لا يمسّ الاستعلام الرئيسي ولا العدّ
  // (LEFT JOIN مباشر كان سيضاعف الصفوف لكل بديل فيكسر التقسيم).
  const unitIds = Array.from(
    new Set(rows.map((r) => (r.productUnitId != null ? Number(r.productUnitId) : null)).filter((id): id is number => id != null)),
  );
  const aliasRows = unitIds.length
    ? await db
        .select({ productUnitId: productUnitBarcodes.productUnitId, barcode: productUnitBarcodes.barcode })
        .from(productUnitBarcodes)
        .where(inArray(productUnitBarcodes.productUnitId, unitIds))
        .orderBy(asc(productUnitBarcodes.id))
    : [];
  const aliasesByUnit = new Map<number, string[]>();
  for (const a of aliasRows) {
    const k = Number(a.productUnitId);
    const list = aliasesByUnit.get(k);
    if (list) list.push(a.barcode);
    else aliasesByUnit.set(k, [a.barcode]);
  }

  // العدّ الإجمالي بنفس FROM/WHERE لكن بلا جوينات الأسعار/المخزون (كلاهما 1:0..1 لا يغيّر عدد الصفوف).
  const totalRow = (
    await db
      .select({ n: sql<number>`COUNT(*)` })
      .from(products)
      .leftJoin(productVariants, eq(productVariants.productId, products.id))
      .leftJoin(productUnits, eq(productUnits.variantId, productVariants.id))
      .where(where)
  )[0];

  return {
    rows: rows.map((r) => ({
      productId: Number(r.productId),
      productName: r.productName,
      productIsActive: !!r.productIsActive,
      categoryId: r.categoryId != null ? Number(r.categoryId) : null,
      categoryName: r.categoryName ?? null,
      variantId: r.variantId != null ? Number(r.variantId) : null,
      variantName: r.variantName ?? null,
      color: r.color ?? null,
      size: r.size ?? null,
      sku: r.sku ?? null,
      variantIsActive: r.variantIsActive != null ? !!r.variantIsActive : null,
      productUnitId: r.productUnitId != null ? Number(r.productUnitId) : null,
      unitName: r.unitName ?? null,
      conversionFactor: r.conversionFactor ?? null,
      barcode: r.barcode ?? null,
      isBaseUnit: r.isBaseUnit != null ? !!r.isBaseUnit : null,
      unitIsActive: r.unitIsActive != null ? !!r.unitIsActive : null,
      price: r.price ?? null,
      stockBase: r.stockBase ?? 0,
      barcodeAliases: r.productUnitId != null ? (aliasesByUnit.get(Number(r.productUnitId)) ?? []) : [],
    })),
    total: Number(totalRow?.n ?? 0),
  };
}

/**
 * تفعيل/تعطيل منتج كاملاً. التعطيل يخفيه من الكاشير تلقائياً عبر شرط activeOnly
 * في listForPos/lookupByBarcode (مقصود) — ويبقى ظاهراً في قائمة الإدارة مع includeInactive.
 */
export async function setProductActive(productId: number, isActive: boolean, _actor: Actor) {
  return withTx(async (tx) => {
    const p = (await tx.select().from(products).where(eq(products.id, productId)).for("update").limit(1))[0];
    if (!p) throw new TRPCError({ code: "NOT_FOUND", message: "المنتج غير موجود" });
    await tx.update(products).set({ isActive }).where(eq(products.id, productId));
    return { productId, isActive };
  });
}

/**
 * حذف منتج نهائياً — مسموح فقط لمنتج «نظيف» (بلا حركة مخزون/رصيد/فاتورة/أمر شراء أو شغل/جرد/إنتاج
 * أو أيّ ارتباط آخر — `getProductUsage`). غير النظيف يُمنع حذفه وتُعرض فئات الارتباط بدل ذلك؛
 * البديل الآمن القابل للتراجع هو «تعطيل» (`setProductActive`). قيد FK حارس نهائي ضدّ التيتيم.
 */
export async function deleteProduct(productId: number) {
  return withTx(async (tx) => {
    const p = (await tx.select().from(products).where(eq(products.id, productId)).for("update").limit(1))[0];
    if (!p) throw new TRPCError({ code: "NOT_FOUND", message: "المنتج غير موجود" });
    const usage = await getProductUsage(productId, tx);
    if (!usage.clean) {
      throw new TRPCError({ code: "BAD_REQUEST", message: usageBlockMessage("هذا المنتج", usage) });
    }
    try {
      await tx.delete(products).where(eq(products.id, productId));
    } catch (err) {
      if (isFkBlocked(err)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "تعذّر الحذف: المنتج مرتبط بسجلّات في النظام — عطّله بدل حذفه.",
        });
      }
      throw err;
    }
    return { productId, deleted: true };
  });
}
