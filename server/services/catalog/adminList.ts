// قائمة إدارة المنتجات + تفعيل/تعطيل منتج.
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/mysql-core";
import Decimal from "decimal.js";
import { branchStock, categories, productPrices, productUnitBarcodes, productUnits, productVariants, products, suppliers } from "../../../drizzle/schema";
import { getDb } from "../../db";
import { getProductUsage, isFkBlocked, usageBlockMessage } from "../entityUsage";
import { type Actor, withTx } from "../tx";
import { buildCatalogSearchOrder, buildCatalogSearchWhere } from "./search";
import { loadBundleUnitCosts } from "../bundleService";
import { loadVariantAvailability, type BundleCapacity } from "./variantAvailability";

/**
 * صفّ شاشة إدارة المنتجات: حبيبة (متغيّر × وحدة) لكن عبر LEFT JOIN —
 * المنتج بلا متغيّرات/وحدات يظهر صفاً واحداً بأعمدة NULL (بخلاف POS الذي يخفيه).
 * حقول التكلفة والجملة ثابتة في العقد لكنها تبقى null ما لم يمنح الراوتر الرؤية صراحةً
 * لحساب admin/manager. هذا يجعل الحجب خادمياً لا مجرد إخفاء أعمدة في الواجهة.
 */
export interface AdminProductRow {
  /** الفرع الفعلي الذي تنتمي إليه قيمة stockBase. */
  branchId: number;
  productId: number;
  productName: string;
  productType: string | null;
  brand: string | null;
  modelName: string | null;
  description: string | null;
  productIsActive: boolean;
  categoryId: number | null;
  categoryName: string | null;
  parentProductId: number | null;
  parentProductName: string | null;
  isCustomizable: boolean;
  isService: boolean;
  showInReception: boolean;
  // ٢٤/٨ — إكمال شريحة PR #755/#757: وسم رؤية شبكة كاشير الطباعة يخرج من `products.showInPrintPos`،
  // ويظهر في التصدير الإداريّ ليعرف المدير أيّ منتجاته تظهر هناك دون فتح كل واحد.
  showInPrintPos: boolean;
  isBundle: boolean;
  isConsignment: boolean;
  consignorId: number | null;
  consignorName: string | null;
  isFeatured: boolean;
  showInStore: boolean;
  productCreatedAt: Date;
  productUpdatedAt: Date;
  variantId: number | null;
  variantName: string | null;
  /** VARIANT = لون/قياس؛ ALTERNATIVE = منتجٌ مختلف تحت اسمٍ واحد — يتيح للتطبيق وسمه بشارة مميّزة. */
  variantKind: "VARIANT" | "ALTERNATIVE" | null;
  color: string | null;
  colorHex: string | null;
  size: string | null;
  sku: string | null;
  minStock: number | null;
  reorderPoint: number | null;
  seasonTarget: number | null;
  variantIsActive: boolean | null;
  variantCreatedAt: Date | null;
  variantUpdatedAt: Date | null;
  productUnitId: number | null;
  unitName: string | null;
  conversionFactor: string | null;
  barcode: string | null;
  isBaseUnit: boolean | null;
  isStoreSaleUnit: boolean | null;
  unitIsActive: boolean | null;
  unitCreatedAt: Date | null;
  price: string | null; // RETAIL — للعرض فقط
  /** تكلفة وحدة الأساس كما هي مخزّنة؛ للتصدير/إعادة الاستيراد، null لغير المالك/المدير. */
  baseCostPrice: string | null;
  /** تكلفة وحدة الصف (تكلفة وحدة الأساس × معامل التحويل)؛ null لغير المالك/المدير. */
  costPrice: string | null;
  /** سعر الجملة لوحدة الصف؛ null لغير المالك/المدير أو عند عدم تعريفه. */
  wholesalePrice: string | null;
  /** السعر الحكومي لوحدة الصف؛ null لغير المالك/المدير أو عند عدم تعريفه. */
  governmentPrice: string | null;
  stockBase: number;
  /** الحجوزات الرسمية + تخصيص الطلبات الإلكترونية النشطة، بوحدة الأساس. */
  reservedBase: number;
  /** ATP التشغيلي = max(0, stockBase - reservedBase)، مشتق للمكوّنات والبكجات. */
  availableBase: number;
  /** الباركودات البديلة للوحدة (productUnitBarcodes) — تظهر في التصدير وبجوار الباركود الأساسي. */
  barcodeAliases: string[];
  /** للبكج وحده: تفسير طاقته (من يحدّها وهل يمنع البيع). `null` لغير البكج. */
  bundleCapacity: BundleCapacity | null;
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
export async function listProductsAdmin(
  input: ListProductsAdminInput,
  options: { includeSensitivePrices?: boolean } = {},
): Promise<{ rows: AdminProductRow[]; total: number; branchId: number }> {
  const db = getDb();
  if (!db) return { rows: [], total: 0, branchId: input.branchId };
  const includeSensitivePrices = options.includeSensitivePrices === true;
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
  // فلترة بالفئة: 0 ⇒ «بلا فئة» (NULL)، رقم موجب ⇒ تلك الفئة + فئاتها الفرعية (أقسام، ٢٩/٧) —
  // اختيار فئة رئيسية من شاشة المنتجات يُظهر منتجاتها المباشرة ومنتجات كل أقسامها الفرعية معاً.
  if (input.categoryId != null) {
    if (input.categoryId === 0) {
      conds.push(isNull(products.categoryId));
    } else {
      const children = await db.select({ id: categories.id }).from(categories).where(eq(categories.parentId, input.categoryId));
      const ids = [input.categoryId, ...children.map((c) => Number(c.id))];
      conds.push(ids.length > 1 ? inArray(products.categoryId, ids) : eq(products.categoryId, input.categoryId));
    }
  }
  const where = conds.length ? and(...conds) : undefined;

  // ترتيب حتمي للتقسيم: مفاتيح الحبيبة (variant ثم unit) تذيّل الترتيب دائماً.
  const order = search
    ? [...buildCatalogSearchOrder(input.q), asc(productVariants.id), asc(productUnits.id)]
    : [desc(products.id), asc(productVariants.id), asc(productUnits.id)];

  const wholesalePrices = alias(productPrices, "adminWholesalePrices");
  const governmentPrices = alias(productPrices, "adminGovernmentPrices");
  const parentProducts = alias(products, "adminParentProducts");
  const rows = await db
    .select({
      productId: products.id,
      productName: products.name,
      productType: products.productType,
      brand: products.brand,
      modelName: products.modelName,
      description: products.description,
      productIsActive: products.isActive,
      categoryId: products.categoryId,
      categoryName: categories.name,
      parentProductId: products.parentProductId,
      parentProductName: parentProducts.name,
      isCustomizable: products.isCustomizable,
      isService: products.isService,
      showInReception: products.showInReception,
      showInPrintPos: products.showInPrintPos,
      isBundle: products.isBundle,
      isConsignment: products.isConsignment,
      consignorId: products.consignorId,
      consignorName: suppliers.name,
      isFeatured: products.isFeatured,
      showInStore: products.showInStore,
      productCreatedAt: products.createdAt,
      productUpdatedAt: products.updatedAt,
      variantId: productVariants.id,
      variantName: productVariants.variantName,
      variantKind: productVariants.variantKind,
      color: productVariants.color,
      colorHex: productVariants.colorHex,
      size: productVariants.size,
      sku: productVariants.sku,
      minStock: productVariants.minStock,
      reorderPoint: productVariants.reorderPoint,
      seasonTarget: productVariants.seasonTarget,
      variantIsActive: productVariants.isActive,
      variantCreatedAt: productVariants.createdAt,
      variantUpdatedAt: productVariants.updatedAt,
      productUnitId: productUnits.id,
      unitName: productUnits.unitName,
      conversionFactor: productUnits.conversionFactor,
      barcode: productUnits.barcode,
      isBaseUnit: productUnits.isBaseUnit,
      isStoreSaleUnit: productUnits.isStoreSaleUnit,
      unitIsActive: productUnits.isActive,
      unitCreatedAt: productUnits.createdAt,
      price: productPrices.price,
      baseCostPrice: productVariants.costPrice,
      wholesalePrice: wholesalePrices.price,
      governmentPrice: governmentPrices.price,
      stockBase: branchStock.quantity,
    })
    .from(products)
    .leftJoin(categories, eq(categories.id, products.categoryId))
    .leftJoin(parentProducts, eq(parentProducts.id, products.parentProductId))
    .leftJoin(suppliers, eq(suppliers.id, products.consignorId))
    .leftJoin(productVariants, eq(productVariants.productId, products.id))
    .leftJoin(productUnits, eq(productUnits.variantId, productVariants.id))
    .leftJoin(
      productPrices,
      and(eq(productPrices.productUnitId, productUnits.id), eq(productPrices.priceTier, "RETAIL"))
    )
    .leftJoin(
      wholesalePrices,
      and(eq(wholesalePrices.productUnitId, productUnits.id), eq(wholesalePrices.priceTier, "WHOLESALE"))
    )
    .leftJoin(
      governmentPrices,
      and(eq(governmentPrices.productUnitId, productUnits.id), eq(governmentPrices.priceTier, "GOVERNMENT"))
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
  const pageVariantIds = rows.flatMap((row) => row.variantId == null ? [] : [Number(row.variantId)]);
  const availability = await loadVariantAvailability(db, input.branchId, pageVariantIds);
  // تكلفة البكج تُشتق من وصفته — `productVariants.costPrice` له صفرٌ بحكم التصميم (§bundleService).
  // بدونها كانت الشاشة تعرض «تكلفة ٠» وهامشاً ١٠٠٪ كاذباً لكل بكج.
  const bundleCosts = await loadBundleUnitCosts(
    db,
    rows.flatMap((row) => row.isBundle && row.variantId != null ? [Number(row.variantId)] : []),
  );

  // العدّ الإجمالي بنفس FROM/WHERE لكن بلا جوينات الأسعار/المخزون (كلاهما 1:0..1 لا يغيّر عدد الصفوف).
  const totalRow = (
    await db
      .select({ n: sql<number>`COUNT(*)` })
      .from(products)
      .leftJoin(productVariants, eq(productVariants.productId, products.id))
      .leftJoin(productUnits, eq(productUnits.variantId, productVariants.id))
      .where(where)
  )[0];

  /** البكج بلا تكلفة مخزَّنة — تكلفته مجموع وصفته الحيّ. */
  const effectiveBaseCost = (r: { isBundle: unknown; variantId: unknown; baseCostPrice: unknown }): string | null =>
    r.isBundle && r.variantId != null
      ? (bundleCosts.get(Number(r.variantId)) ?? null)
      : (r.baseCostPrice == null ? null : String(r.baseCostPrice));

  return {
    rows: rows.map((r) => ({
      branchId: input.branchId,
      productId: Number(r.productId),
      productName: r.productName,
      productType: r.productType ?? null,
      brand: r.brand ?? null,
      modelName: r.modelName ?? null,
      description: r.description ?? null,
      productIsActive: !!r.productIsActive,
      categoryId: r.categoryId != null ? Number(r.categoryId) : null,
      categoryName: r.categoryName ?? null,
      parentProductId: r.parentProductId != null ? Number(r.parentProductId) : null,
      parentProductName: r.parentProductName ?? null,
      isCustomizable: !!r.isCustomizable,
      isService: !!r.isService,
      showInReception: !!r.showInReception,
      showInPrintPos: !!r.showInPrintPos,
      isBundle: !!r.isBundle,
      isConsignment: !!r.isConsignment,
      consignorId: includeSensitivePrices && r.consignorId != null ? Number(r.consignorId) : null,
      consignorName: includeSensitivePrices ? (r.consignorName ?? null) : null,
      isFeatured: !!r.isFeatured,
      showInStore: !!r.showInStore,
      productCreatedAt: r.productCreatedAt,
      productUpdatedAt: r.productUpdatedAt,
      variantId: r.variantId != null ? Number(r.variantId) : null,
      variantName: r.variantName ?? null,
      variantKind: r.variantKind ?? null,
      color: r.color ?? null,
      colorHex: r.colorHex ?? null,
      size: r.size ?? null,
      sku: r.sku ?? null,
      minStock: r.minStock ?? null,
      reorderPoint: r.reorderPoint ?? null,
      seasonTarget: r.seasonTarget ?? null,
      variantIsActive: r.variantIsActive != null ? !!r.variantIsActive : null,
      variantCreatedAt: r.variantCreatedAt ?? null,
      variantUpdatedAt: r.variantUpdatedAt ?? null,
      productUnitId: r.productUnitId != null ? Number(r.productUnitId) : null,
      unitName: r.unitName ?? null,
      conversionFactor: r.conversionFactor ?? null,
      barcode: r.barcode ?? null,
      isBaseUnit: r.isBaseUnit != null ? !!r.isBaseUnit : null,
      isStoreSaleUnit: r.isStoreSaleUnit != null ? !!r.isStoreSaleUnit : null,
      unitIsActive: r.unitIsActive != null ? !!r.unitIsActive : null,
      unitCreatedAt: r.unitCreatedAt ?? null,
      price: r.price ?? null,
      baseCostPrice: includeSensitivePrices ? (effectiveBaseCost(r) ?? null) : null,
      costPrice:
        includeSensitivePrices && effectiveBaseCost(r) != null && r.conversionFactor != null
          ? new Decimal(effectiveBaseCost(r)!).times(new Decimal(r.conversionFactor)).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2)
          : null,
      wholesalePrice: includeSensitivePrices ? (r.wholesalePrice ?? null) : null,
      governmentPrice: includeSensitivePrices ? (r.governmentPrice ?? null) : null,
      stockBase: r.variantId != null
        ? (availability.get(Number(r.variantId))?.onHandBase ?? 0)
        : 0,
      reservedBase: r.variantId != null
        ? (availability.get(Number(r.variantId))?.reservedBase ?? 0)
        : 0,
      availableBase: r.variantId != null
        ? (availability.get(Number(r.variantId))?.availableBase ?? 0)
        : 0,
      barcodeAliases: r.productUnitId != null ? (aliasesByUnit.get(Number(r.productUnitId)) ?? []) : [],
      bundleCapacity: r.isBundle && r.variantId != null
        ? (availability.get(Number(r.variantId))?.bundleCapacity ?? null)
        : null,
    })),
    total: Number(totalRow?.n ?? 0),
    branchId: input.branchId,
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
