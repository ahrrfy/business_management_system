import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, inArray, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import type { MySqlColumn } from "drizzle-orm/mysql-core";
import { branchStock, categories, productImages, productPrices, productUnits, productVariants, products } from "../../drizzle/schema";
import { ARABIC_FOLD_PAIRS, escapeLikePattern, tokenizeSearchQuery } from "../../shared/searchNormalize";
import { getDb } from "../db";
import { toDbMoney } from "./money";
import type { PriceTier } from "./pricing";
import { PRINT_SERVICE_TYPE } from "./printSaleService";
import { setStock } from "./inventoryService";
import { withTx, type Actor } from "./tx";
import type { Tx } from "../db";
import { extractInsertId } from "../lib/insertId";

/** One sellable line for the POS: a (variant × unit) with its tier price and branch stock. */
export interface PosRow {
  productId: number;
  productName: string;
  variantId: number;
  variantName: string | null;
  color: string | null;
  size: string | null;
  sku: string;
  productUnitId: number;
  unitName: string;
  conversionFactor: string;
  barcode: string | null;
  isBaseUnit: boolean;
  price: string | null; // null = no price defined for this unit×tier
  stockBase: number; // variant stock in base units at the branch
  isService: boolean; // مُنتج خِدمي: لا مَخزون، POS يَتجاوز فَحص نَقص المَخزون.
}

function baseSelect(db: NonNullable<ReturnType<typeof getDb>>, branchId: number, tier: PriceTier) {
  return db
    .select({
      productId: products.id,
      productName: products.name,
      variantId: productVariants.id,
      variantName: productVariants.variantName,
      color: productVariants.color,
      size: productVariants.size,
      sku: productVariants.sku,
      productUnitId: productUnits.id,
      unitName: productUnits.unitName,
      conversionFactor: productUnits.conversionFactor,
      barcode: productUnits.barcode,
      isBaseUnit: productUnits.isBaseUnit,
      price: productPrices.price,
      stockBase: branchStock.quantity,
      isService: products.isService,
    })
    .from(productUnits)
    .innerJoin(productVariants, eq(productUnits.variantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
    .leftJoin(
      productPrices,
      and(eq(productPrices.productUnitId, productUnits.id), eq(productPrices.priceTier, tier))
    )
    .leftJoin(
      branchStock,
      and(eq(branchStock.variantId, productVariants.id), eq(branchStock.branchId, branchId))
    );
}

function normalize(rows: any[]): PosRow[] {
  return rows.map((r) => ({
    ...r,
    productId: Number(r.productId),
    variantId: Number(r.variantId),
    productUnitId: Number(r.productUnitId),
    isBaseUnit: !!r.isBaseUnit,
    stockBase: r.stockBase ?? 0,
    isService: !!r.isService,
  }));
}

// خدمات الطباعة (productType=PRINT_SERVICE) مُستثناة من كاشير الباركود/الشراء: لا مخزون لها،
// وتُباع عبر شاشة «نقطة بيع الطباعة» فقط. (NULL = منتج عادي ⇒ يبقى ظاهراً.)
const notPrintService = sql`(${products.productType} IS NULL OR ${products.productType} <> ${PRINT_SERVICE_TYPE})`;
const activeOnly = and(
  eq(products.isActive, true),
  eq(productVariants.isActive, true),
  eq(productUnits.isActive, true),
  notPrintService
);

/* ============================ البحث الذكي (مشترك بين البيع والشراء) ============================ */

/**
 * تعبير SQL يطبّع عموداً نصياً بنفس جدول التطبيع المشترك (ARABIC_FOLD_PAIRS) —
 * الجهتان (العمود + الاستعلام) تُطبَّعان بنفس القواعد فتتم المطابقة في فضاء موحَّد:
 * «ازرق» يجد «أزرق»، و«مكتبه» تجد «مكتبة».
 */
function foldedCol(col: MySqlColumn): SQL {
  let expr = sql`lower(coalesce(${col}, ''))`;
  for (const [from, to] of ARABIC_FOLD_PAIRS) {
    expr = sql`replace(${expr}, ${from}, ${to})`;
  }
  return expr;
}

/** الأعمدة القابلة للبحث في الكتالوج — مصدر واحد لبُنية الشرط والترتيب. */
function searchableCols(): SQL[] {
  return [foldedCol(products.name), foldedCol(productVariants.sku), foldedCol(productVariants.variantName), foldedCol(productUnits.barcode)];
}

/**
 * شرط البحث الذكي: الاستعلام يُقطَّع كلماتٍ مُطبَّعة، وكل كلمة يجب أن تَرِد في
 * **أيّ** عمود (اسم/SKU/متغيّر/باركود) — والكلمات تُجمَع بـAND ⇒
 * «قلم ازرق» يجد «قلم جاف أزرق» مهما تباعدت الكلمات. يعيد null لاستعلام فارغ.
 */
function buildCatalogSearchWhere(query: string | undefined): SQL | null {
  const tokens = tokenizeSearchQuery(query ?? "");
  if (!tokens.length) return null;
  const cols = searchableCols();
  // محرف هروب LIKE الافتراضي في MySQL هو \ — escapeLikePattern يهرّب به، والأنماط
  // معاملات مربوطة (لا تمرّ بمحلّل النصوص) ⇒ لا حاجة لعبارة ESCAPE صريحة.
  const perToken = tokens.map((t) => {
    const pat = `%${escapeLikePattern(t)}%`;
    return or(...cols.map((c) => sql`${c} like ${pat}`));
  });
  return and(...perToken) ?? null;
}

/**
 * ترتيب بالملاءمة: تطابق تام (باركود/SKU) أولاً، ثم اسم يبدأ بالاستعلام،
 * ثم الأقرب لبداية الاسم، ثم أبجدياً — بدل «الأحدث أولاً» الذي يدفن المطلوب.
 */
function buildCatalogSearchOrder(query: string | undefined): SQL[] {
  const tokens = tokenizeSearchQuery(query ?? "");
  if (!tokens.length) return [];
  const whole = tokens.join(" ");
  const wholePrefix = `${escapeLikePattern(whole)}%`;
  const name = foldedCol(products.name);
  const rank = sql`case
    when ${foldedCol(productUnits.barcode)} = ${whole} then 0
    when ${foldedCol(productVariants.sku)} = ${whole} then 1
    when ${name} like ${wholePrefix} then 2
    else 3
  end`;
  return [rank, sql`instr(${name}, ${tokens[0]})`, asc(products.name)];
}

/** Resolve a scanned barcode to a single POS row. */
export async function lookupByBarcode(barcode: string, branchId: number, tier: PriceTier): Promise<PosRow | null> {
  const db = getDb();
  if (!db) return null;
  const rows = await baseSelect(db, branchId, tier)
    .where(and(activeOnly, eq(productUnits.barcode, barcode.trim())))
    .limit(1);
  return normalize(rows)[0] ?? null;
}

/** List sellable rows for the POS, optionally filtered by a text query. */
export async function listForPos(branchId: number, tier: PriceTier, query?: string, limit = 200): Promise<PosRow[]> {
  const db = getDb();
  if (!db) return [];
  const search = buildCatalogSearchWhere(query);
  const where = search ? and(activeOnly, search) : activeOnly;
  const order = search ? buildCatalogSearchOrder(query) : [desc(products.id)];
  const rows = await baseSelect(db, branchId, tier).where(where).orderBy(...order).limit(limit);
  return normalize(rows);
}

/* ============================ خدمات الطباعة (نقطة بيع الخدمات) ============================ */

/** خدمة طباعة قابلة للبيع: (متغيّر الخدمة × وحدة الأساس) بسعر الفئة + فئتها. لا تحمل كلفة/مواد
 *  (شأن إداري لا يراه الكاشير). price=null ⇒ سعر يدوي يُدخله الكاشير. */
export interface PrintServiceRow {
  productId: number;
  productName: string;
  variantId: number;
  sku: string;
  productUnitId: number;
  unitName: string;
  categoryId: number | null;
  categoryName: string | null;
  price: string | null;
}

/** قائمة خدمات قسم الطباعة (productType=PRINT_SERVICE) مع سعر الفئة + اسم الفئة — تغذّي شبكة بلاطات الشاشة. */
export async function listPrintServices(tier: PriceTier): Promise<PrintServiceRow[]> {
  const db = getDb();
  if (!db) return [];
  const rows = await db
    .select({
      productId: products.id,
      productName: products.name,
      variantId: productVariants.id,
      sku: productVariants.sku,
      productUnitId: productUnits.id,
      unitName: productUnits.unitName,
      categoryId: products.categoryId,
      categoryName: categories.name,
      price: productPrices.price,
    })
    .from(productUnits)
    .innerJoin(productVariants, eq(productUnits.variantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
    .leftJoin(categories, eq(products.categoryId, categories.id))
    .leftJoin(productPrices, and(eq(productPrices.productUnitId, productUnits.id), eq(productPrices.priceTier, tier)))
    .where(
      and(
        eq(products.isActive, true),
        eq(productVariants.isActive, true),
        eq(productUnits.isActive, true),
        eq(productUnits.isBaseUnit, true),
        eq(products.productType, PRINT_SERVICE_TYPE)
      )
    )
    .orderBy(asc(products.categoryId), asc(products.id));
  return rows.map((r) => ({
    productId: Number(r.productId),
    productName: r.productName,
    variantId: Number(r.variantId),
    sku: r.sku,
    productUnitId: Number(r.productUnitId),
    unitName: r.unitName,
    categoryId: r.categoryId != null ? Number(r.categoryId) : null,
    categoryName: r.categoryName ?? null,
    price: r.price ?? null,
  }));
}

/** One purchasable line: a (variant × unit) with the variant's last cost (per base) and branch stock.
 *  Distinct from {@link PosRow}: it carries COST, never a sell price, so it must never feed the cashier UI. */
export interface PurchaseRow {
  productId: number;
  productName: string;
  variantId: number;
  variantName: string | null;
  color: string | null;
  size: string | null;
  sku: string;
  productUnitId: number;
  unitName: string;
  conversionFactor: string;
  isBaseUnit: boolean;
  costPriceBase: string; // variant cost per base unit
  stockBase: number;
}

/** List purchasable (variant × unit) rows for the purchase-order screen, optionally filtered. */
export async function listForPurchase(branchId: number, query?: string, limit = 50): Promise<PurchaseRow[]> {
  const db = getDb();
  if (!db) return [];
  const search = buildCatalogSearchWhere(query);
  const where = search ? and(activeOnly, search) : activeOnly;
  const order = search ? buildCatalogSearchOrder(query) : [desc(products.id)];
  const rows = await db
    .select({
      productId: products.id,
      productName: products.name,
      variantId: productVariants.id,
      variantName: productVariants.variantName,
      color: productVariants.color,
      size: productVariants.size,
      sku: productVariants.sku,
      productUnitId: productUnits.id,
      unitName: productUnits.unitName,
      conversionFactor: productUnits.conversionFactor,
      isBaseUnit: productUnits.isBaseUnit,
      costPriceBase: productVariants.costPrice,
      stockBase: branchStock.quantity,
    })
    .from(productUnits)
    .innerJoin(productVariants, eq(productUnits.variantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
    .leftJoin(branchStock, and(eq(branchStock.variantId, productVariants.id), eq(branchStock.branchId, branchId)))
    .where(where)
    .orderBy(...order)
    .limit(limit);
  return rows.map((r) => ({
    ...r,
    productId: Number(r.productId),
    variantId: Number(r.variantId),
    productUnitId: Number(r.productUnitId),
    isBaseUnit: !!r.isBaseUnit,
    stockBase: r.stockBase ?? 0,
  }));
}

/* ============================ Admin product list (إدارة المنتجات) ============================ */

/**
 * صفّ شاشة إدارة المنتجات: حبيبة (متغيّر × وحدة) لكن عبر LEFT JOIN —
 * المنتج بلا متغيّرات/وحدات يظهر صفاً واحداً بأعمدة NULL (بخلاف POS الذي يخفيه).
 * لا يكشف التكلفة أبداً (الشاشة متاحة لكل الأدوار).
 */
export interface AdminProductRow {
  productId: number;
  productName: string;
  productIsActive: boolean;
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
}

export interface ListProductsAdminInput {
  branchId: number;
  q?: string;
  includeInactive?: boolean;
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

/* ============================ Product setup (catalog write) ============================ */

export interface CreateProductInput {
  name: string;
  // v3-add-screens: الاسم المركّب — يُجمَع في `name` تلقائياً إن لم يُمرّر مباشرةً.
  productType?: string | null;
  brand?: string | null;
  modelName?: string | null;
  description?: string | null;
  categoryId?: number | null;
  isCustomizable?: boolean;
  // مُنتج خِدمي (لا مَخزون): البَيع/الشِراء لا يُحرّك branchStock، رَصيد افتتاحي يُتجاهَل.
  isService?: boolean;
  variants: Array<{
    sku: string;
    variantName?: string | null;
    color?: string | null;
    size?: string | null;
    costPrice: string;
    minStock?: number;
    openingStock?: number;
    // product-variants: نقطة إعادة الطلب + ظهور المتغيّر في البيع + رصيد افتتاحي لكل فرع.
    reorderPoint?: number;
    isActive?: boolean;
    openingStockByBranch?: Array<{ branchId: number; qty: number }>;
    // product-variants: صورة مستقلّة لهذا اللون (data URL) — تُخزَّن في productImages بـvariantId.
    image?: string | null;
    units: Array<{
      unitName: string;
      conversionFactor: string;
      barcode?: string | null;
      isBaseUnit?: boolean;
      prices?: Array<{ priceTier: PriceTier; price: string }>;
    }>;
  }>;
  // v3-add-screens: صور المنتج. أوّل isPrimary=true يُعتمد، وإلا أوّل صورة.
  images?: Array<{ url: string; isPrimary?: boolean; sortOrder?: number }>;
}

/** v3-add-screens: يبني اسماً نهائياً من القطع الثلاث + يحذف الفراغات الزائدة. */
function composeProductName(input: { name?: string | null; productType?: string | null; brand?: string | null; modelName?: string | null }) {
  const composed = [input.productType, input.brand, input.modelName].map((s) => (s ?? "").trim()).filter(Boolean).join(" ");
  const fallback = (input.name ?? "").trim();
  return composed || fallback;
}

/* ============================ Product read (for edit) ============================ */

export interface ProductForEdit {
  id: number;
  name: string;
  categoryId: number | null;
  isCustomizable: boolean;
  isService: boolean;
  isActive: boolean;
  variants: Array<{
    id: number;
    sku: string;
    variantName: string | null;
    color: string | null;
    size: string | null;
    costPrice: string;
    units: Array<{
      id: number;
      unitName: string;
      conversionFactor: string;
      barcode: string | null;
      isBaseUnit: boolean;
      isActive: boolean;
      prices: Array<{ priceTier: PriceTier; price: string }>;
    }>;
  }>;
}

export async function getProductForEdit(productId: number): Promise<ProductForEdit | null> {
  const db = getDb();
  if (!db) return null;
  const p = (await db.select().from(products).where(eq(products.id, productId)).limit(1))[0];
  if (!p) return null;
  const variants = await db.select().from(productVariants).where(eq(productVariants.productId, productId));
  const variantIds = variants.map((v) => Number(v.id));
  const units = variantIds.length
    ? await db
        .select()
        .from(productUnits)
        .where(and(eq(productUnits.isActive, true), inArray(productUnits.variantId, variantIds)))
    : [];
  const myUnits = units.filter((u) => variantIds.includes(Number(u.variantId)));
  const unitIds = myUnits.map((u) => Number(u.id));
  const prices = unitIds.length
    ? await db.select().from(productPrices).where(inArray(productPrices.productUnitId, unitIds))
    : [];
  const myPrices = prices.filter((p) => unitIds.includes(Number(p.productUnitId)));

  return {
    id: Number(p.id),
    name: p.name,
    categoryId: p.categoryId != null ? Number(p.categoryId) : null,
    isCustomizable: !!p.isCustomizable,
    isService: !!p.isService,
    isActive: !!p.isActive,
    variants: variants.map((v) => ({
      id: Number(v.id),
      sku: v.sku,
      variantName: v.variantName,
      color: v.color,
      size: v.size,
      costPrice: v.costPrice,
      units: myUnits
        .filter((u) => Number(u.variantId) === Number(v.id))
        .map((u) => ({
          id: Number(u.id),
          unitName: u.unitName,
          conversionFactor: u.conversionFactor,
          barcode: u.barcode,
          isBaseUnit: !!u.isBaseUnit,
          isActive: !!u.isActive,
          prices: myPrices
            .filter((pp) => Number(pp.productUnitId) === Number(u.id))
            .map((pp) => ({ priceTier: pp.priceTier as PriceTier, price: pp.price })),
        })),
    })),
  };
}

/* ============================ Product update ============================ */

export interface UpdateProductUnitInput {
  id?: number; // existing unit id (omit for new)
  unitName: string;
  conversionFactor: string;
  barcode?: string | null;
  isBaseUnit?: boolean;
  prices?: Array<{ priceTier: PriceTier; price: string }>;
}

export interface UpdateProductVariantInput {
  id: number; // variants are not added/removed via edit for now
  sku: string;
  variantName?: string | null;
  color?: string | null;
  size?: string | null;
  costPrice: string;
  units: UpdateProductUnitInput[];
}

export interface UpdateProductInput {
  productId: number;
  name: string;
  categoryId?: number | null;
  isCustomizable?: boolean;
  isActive?: boolean;
  variants: UpdateProductVariantInput[];
}

/** Update a product header + its variant(s) + units + prices in one transaction.
 *  - Existing units (by id) are UPDATEd and their prices replaced.
 *  - New units (no id) are INSERTed with their prices.
 *  - Units present in DB but absent from input are soft-deactivated (isActive=false). */
export async function updateProduct(input: UpdateProductInput, _actor: Actor) {
  return withTx(async (tx) => {
    if (!input.name.trim()) throw new TRPCError({ code: "BAD_REQUEST", message: "اسم المنتج مطلوب" });
    if (!input.variants.length) throw new TRPCError({ code: "BAD_REQUEST", message: "المنتج يحتاج متغيّراً واحداً على الأقل" });

    const p = (await tx.select().from(products).where(eq(products.id, input.productId)).limit(1))[0];
    if (!p) throw new TRPCError({ code: "NOT_FOUND", message: "المنتج غير موجود" });

    await tx
      .update(products)
      .set({
        name: input.name.trim(),
        categoryId: input.categoryId ?? null,
        isCustomizable: input.isCustomizable ?? !!p.isCustomizable,
        ...(input.isActive != null ? { isActive: input.isActive } : {}),
      })
      .where(eq(products.id, input.productId));

    for (const v of input.variants) {
      if (!v.units.some((u) => u.isBaseUnit))
        throw new TRPCError({ code: "BAD_REQUEST", message: `المتغيّر ${v.sku} يحتاج وحدة أساس واحدة` });
      if (v.units.filter((u) => u.isBaseUnit).length > 1)
        throw new TRPCError({ code: "BAD_REQUEST", message: `المتغيّر ${v.sku} يحتاج وحدة أساس واحدة فقط` });

      // Variant header.
      await tx
        .update(productVariants)
        .set({
          sku: v.sku,
          variantName: v.variantName ?? null,
          color: v.color ?? null,
          size: v.size ?? null,
          costPrice: toDbMoney(v.costPrice),
        })
        .where(eq(productVariants.id, v.id));

      // Existing units for this variant.
      const existing = await tx.select().from(productUnits).where(eq(productUnits.variantId, v.id));
      const keepIds = new Set<number>();

      for (const u of v.units) {
        let productUnitId: number;
        if (u.id) {
          productUnitId = u.id;
          await tx
            .update(productUnits)
            .set({
              unitName: u.unitName,
              conversionFactor: u.conversionFactor,
              barcode: u.barcode ?? null,
              isBaseUnit: !!u.isBaseUnit,
              isActive: true,
            })
            .where(eq(productUnits.id, u.id));
          // Replace prices for this unit.
          await tx.delete(productPrices).where(eq(productPrices.productUnitId, u.id));
        } else {
          const uRes = await tx.insert(productUnits).values({
            variantId: v.id,
            unitName: u.unitName,
            conversionFactor: u.conversionFactor,
            barcode: u.barcode ?? null,
            isBaseUnit: !!u.isBaseUnit,
          });
          productUnitId = extractInsertId(uRes);
        }
        keepIds.add(productUnitId);
        for (const pr of u.prices ?? []) {
          await tx
            .insert(productPrices)
            .values({ productUnitId, priceTier: pr.priceTier, price: toDbMoney(pr.price) });
        }
      }

      // Soft-deactivate units that are no longer present (preserve history).
      for (const existing0 of existing) {
        if (!keepIds.has(Number(existing0.id))) {
          await tx.update(productUnits).set({ isActive: false }).where(eq(productUnits.id, Number(existing0.id)));
        }
      }
    }

    return { productId: input.productId };
  });
}

/**
 * product-variants: تحقّق مسبق من تفرّد الباركود والـSKU قبل أي إدراج —
 * يكشف التكرار داخل الحمولة وضدّ القاعدة فيرمي رسالة عربية تسمّي القيمة المخالفة،
 * بدل ترك قيد UNIQUE يفشل برسالة «قيمة مكرّرة» عامّة لا تدلّ على الباركود/الرمز.
 */
async function assertCatalogUniqueness(tx: Tx, input: CreateProductInput) {
  // الباركودات (لكل وحدة من كل متغيّر).
  const codes: string[] = [];
  for (const v of input.variants) for (const u of v.units) {
    const b = (u.barcode ?? "").trim();
    if (b) codes.push(b);
  }
  const seenCode = new Set<string>();
  for (const c of codes) {
    if (seenCode.has(c)) throw new TRPCError({ code: "CONFLICT", message: `الباركود ${c} مكرّر داخل المنتج — لكل وحدة/لون باركود فريد.` });
    seenCode.add(c);
  }
  if (seenCode.size) {
    const taken = await tx
      .select({ code: productUnits.barcode, name: products.name })
      .from(productUnits)
      .innerJoin(productVariants, eq(productUnits.variantId, productVariants.id))
      .innerJoin(products, eq(productVariants.productId, products.id))
      .where(inArray(productUnits.barcode, Array.from(seenCode)))
      .limit(1);
    if (taken[0]) throw new TRPCError({ code: "CONFLICT", message: `الباركود ${taken[0].code} مُستخدَم في «${taken[0].name}».` });
  }

  // الرموز (SKU) — واحد لكل متغيّر.
  const seenSku = new Set<string>();
  for (const v of input.variants) {
    const s = v.sku.trim();
    if (!s) continue;
    if (seenSku.has(s)) throw new TRPCError({ code: "CONFLICT", message: `الرمز ${s} (SKU) مكرّر بين المتغيّرات — لكل متغيّر رمز فريد.` });
    seenSku.add(s);
  }
  if (seenSku.size) {
    const takenSku = await tx
      .select({ sku: productVariants.sku })
      .from(productVariants)
      .where(inArray(productVariants.sku, Array.from(seenSku)))
      .limit(1);
    if (takenSku[0]) throw new TRPCError({ code: "CONFLICT", message: `الرمز ${takenSku[0].sku} (SKU) مُستخدَم لمتغيّر آخر — اختر رمزاً مختلفاً.` });
  }
}

/**
 * product-variants: أيُّ باركودات من القائمة محجوزة مسبقاً (وفي أي منتج)؟
 * يغذّي التحقّق اللحظي في شاشة الإضافة قبل الحفظ.
 */
export async function checkBarcodesTaken(codes: string[]): Promise<Array<{ code: string; takenBy: string }>> {
  const db = getDb();
  if (!db) return [];
  const clean = Array.from(new Set(codes.map((c) => c.trim()).filter(Boolean)));
  if (!clean.length) return [];
  const rows = await db
    .select({ code: productUnits.barcode, productName: products.name, sku: productVariants.sku })
    .from(productUnits)
    .innerJoin(productVariants, eq(productUnits.variantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
    .where(inArray(productUnits.barcode, clean));
  return rows
    .filter((r) => r.code)
    .map((r) => ({ code: r.code as string, takenBy: `${r.productName} (${r.sku})` }));
}

/** Create a product with its variants, units and prices in one transaction. */
export async function createProduct(input: CreateProductInput, actor: Actor) {
  if (!input.variants.length) throw new TRPCError({ code: "BAD_REQUEST", message: "المنتج يحتاج متغيّراً واحداً على الأقل" });
  return withTx(async (tx) => {
    const composedName = composeProductName(input);
    if (!composedName) throw new TRPCError({ code: "BAD_REQUEST", message: "اسم المنتج مطلوب (نوع/ماركة/موديل)" });
    await assertCatalogUniqueness(tx, input);
    const pRes = await tx.insert(products).values({
      name: composedName,
      productType: input.productType?.trim() || null,
      brand: input.brand?.trim() || null,
      modelName: input.modelName?.trim() || null,
      description: input.description?.trim() || null,
      categoryId: input.categoryId ?? null,
      isCustomizable: input.isCustomizable ?? false,
      isService: input.isService ?? false,
    });
    const productId = extractInsertId(pRes);

    for (const v of input.variants) {
      if (!v.units.some((u) => u.isBaseUnit)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `المتغيّر ${v.sku} يحتاج وحدة أساس واحدة (isBaseUnit)` });
      }
      const vRes = await tx.insert(productVariants).values({
        productId,
        sku: v.sku,
        variantName: v.variantName ?? null,
        color: v.color ?? null,
        size: v.size ?? null,
        costPrice: toDbMoney(v.costPrice),
        minStock: v.minStock != null ? Math.max(0, Math.trunc(v.minStock)) : 0,
        // product-variants: نقطة إعادة الطلب + ظهور مستقل لكل متغيّر.
        reorderPoint: v.reorderPoint != null ? Math.max(0, Math.trunc(v.reorderPoint)) : 0,
        isActive: v.isActive ?? true,
      });
      const variantId = extractInsertId(vRes);

      for (const u of v.units) {
        const uRes = await tx.insert(productUnits).values({
          variantId,
          unitName: u.unitName,
          conversionFactor: u.conversionFactor,
          barcode: u.barcode ?? null,
          isBaseUnit: u.isBaseUnit ?? false,
        });
        const productUnitId = extractInsertId(uRes);
        for (const p of u.prices ?? []) {
          await tx.insert(productPrices).values({ productUnitId, priceTier: p.priceTier, price: toDbMoney(p.price) });
        }
      }

      // المخزون الافتتاحي كحركة OPENING مُسجَّلة. product-variants: رصيد مستقل لكل فرع
      // (`openingStockByBranch`)؛ وإلا fallback لرقم أحاديّ في فرع الموظف (توافق خلفي).
      const perBranch =
        v.openingStockByBranch && v.openingStockByBranch.length
          ? v.openingStockByBranch
          : v.openingStock && v.openingStock > 0
            ? [{ branchId: actor.branchId, qty: v.openingStock }]
            : [];
      for (const ob of perBranch) {
        const qty = Math.max(0, Math.trunc(ob.qty));
        if (qty > 0) {
          await setStock(tx, {
            variantId,
            branchId: ob.branchId,
            targetQuantity: qty,
            referenceType: "OPENING",
            notes: "رصيد افتتاحي",
            createdBy: actor.userId,
          });
        }
      }

      // product-variants: صورة هذا اللون — تُخزَّن في productImages موسومة بـvariantId.
      const vImage = (v.image ?? "").trim();
      if (vImage) {
        await tx.insert(productImages).values({ productId, variantId, url: vImage, isPrimary: false, sortOrder: 0 });
      }
    }

    // v3-add-screens: صور المنتج. الأولى = الرئيسية إن لم يحدّد أيٌّ منها ذلك.
    if (input.images && input.images.length) {
      const imgs = input.images.filter((i) => i.url?.trim()).slice(0, 10);
      const anyPrimary = imgs.some((i) => i.isPrimary);
      for (let i = 0; i < imgs.length; i++) {
        const img = imgs[i];
        await tx.insert(productImages).values({
          productId,
          url: img.url.trim(),
          isPrimary: anyPrimary ? !!img.isPrimary : i === 0,
          sortOrder: img.sortOrder ?? i,
        });
      }
    }

    return { productId };
  });
}

/** v3-add-screens: قراءة صور منتج مرتّبة (الرئيسية أولاً). */
export async function listProductImages(productId: number) {
  const db = getDb();
  if (!db) return [];
  return db.select().from(productImages).where(eq(productImages.productId, productId)).orderBy(desc(productImages.isPrimary), asc(productImages.sortOrder));
}

/* ============================ Barcode assignment ============================ */

/** يسند باركوداً لوحدة بلا باركود (أو يحدّثه)، مع ضمان التفرّد عبر كل الوحدات. */
export async function assignBarcode(productUnitId: number, barcode: string) {
  return withTx(async (tx) => {
    const code = barcode.trim();
    if (!code) throw new TRPCError({ code: "BAD_REQUEST", message: "الباركود فارغ" });
    const unit = (await tx.select().from(productUnits).where(eq(productUnits.id, productUnitId)).limit(1))[0];
    if (!unit) throw new TRPCError({ code: "NOT_FOUND", message: "الوحدة غير موجودة" });
    // تفرّد الباركود.
    const clash = (
      await tx
        .select({ id: productUnits.id })
        .from(productUnits)
        .where(and(eq(productUnits.barcode, code), ne(productUnits.id, productUnitId)))
        .limit(1)
    )[0];
    if (clash) throw new TRPCError({ code: "CONFLICT", message: `الباركود ${code} مُستخدَم لوحدة أخرى` });
    await tx.update(productUnits).set({ barcode: code }).where(eq(productUnits.id, productUnitId));
    return { productUnitId, barcode: code };
  });
}
