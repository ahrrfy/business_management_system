// قراءات شاشة الشراء.
import { and, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { branchStock, productUnits, productVariants, products } from "../../../drizzle/schema";
import { getDb } from "../../db";
import { buildCatalogSearchOrder, buildCatalogSearchWhere } from "./search";

// Codex #163 P2 (Filter bundles out before stock movements): البكج بلا مخزون ذاتي ⇒ إضافته إلى
// أمر شراء تفشل عند الاستلام في `applyMovement` (يرفض تحريك مخزون البكج مباشرةً). نستبعده هنا
// كي لا يظهر في المنتقيات أصلاً بدل التعثّر متأخّراً بعد جهد إدخال. وكذلك بضاعة الأمانة تُودع عبر مسار الإيداع.
const purchasableActive = and(
  eq(products.isActive, true),
  eq(productVariants.isActive, true),
  eq(productUnits.isActive, true),
  eq(products.isService, false),
  eq(products.isBundle, false),
  eq(products.isConsignment, false),
  sql`(${products.productType} IS NULL OR ${products.productType} <> 'DIGITAL_CARD')`,
);

/** One purchasable line: a (variant × unit) with the variant's last cost (per base) and branch stock.
 *  Distinct from {@link PosRow}: it carries COST, never a sell price, so it must never feed the cashier UI. */
export interface PurchaseRow {
  productId: number;
  productName: string;
  variantId: number;
  variantName: string | null;
  color: string | null;
  size: string | null;
  colorHex?: string | null;
  variantKind?: string | null;
  sku: string;
  productUnitId: number;
  unitName: string;
  conversionFactor: string;
  isBaseUnit: boolean;
  costPriceBase: string; // variant cost per base unit
  stockBase: number;
}

export interface ListForPurchaseOptions {
  unitIds?: number[];
  materialOnly?: boolean;
  stockExpenseOnly?: boolean;
  excludeOperatingSupply?: boolean;
}

/** List purchasable (variant × unit) rows for the purchase-order screen, optionally filtered. */
export async function listForPurchase(
  branchId: number,
  query?: string,
  limit = 50,
  opts?: ListForPurchaseOptions,
): Promise<PurchaseRow[]> {
  const db = getDb();
  if (!db) return [];
  if (opts?.unitIds !== undefined && opts.unitIds.length === 0) return [];
  const conds: SQL[] = [purchasableActive!];
  if (opts?.unitIds && opts.unitIds.length > 0) {
    conds.push(inArray(productUnits.id, opts.unitIds));
  }
  if (opts?.materialOnly) {
    conds.push(sql`(${products.stockUsage} IS NULL OR ${products.stockUsage} IN ('MATERIAL_ONLY', 'SALE_AND_MATERIAL'))`);
  }
  if (opts?.stockExpenseOnly) {
    conds.push(sql`(${products.stockUsage} IS NULL OR ${products.stockUsage} = 'OPERATING_SUPPLY')`);
  }
  if (opts?.excludeOperatingSupply) {
    conds.push(sql`(${products.stockUsage} IS NULL OR ${products.stockUsage} <> 'OPERATING_SUPPLY')`);
  }
  const search = buildCatalogSearchWhere(query);
  if (search) conds.push(search);
  const where = and(...conds);
  const effectiveLimit = opts?.unitIds?.length ? Math.max(limit, opts.unitIds.length) : limit;
  const order = search ? buildCatalogSearchOrder(query) : [desc(products.id)];
  const rows = await db
    .select({
      productId: products.id,
      productName: products.name,
      variantId: productVariants.id,
      variantName: productVariants.variantName,
      color: productVariants.color,
      colorHex: productVariants.colorHex,
      size: productVariants.size,
      variantKind: productVariants.variantKind,
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
    .limit(effectiveLimit);
  return rows.map((r) => ({
    ...r,
    productId: Number(r.productId),
    variantId: Number(r.variantId),
    productUnitId: Number(r.productUnitId),
    isBaseUnit: !!r.isBaseUnit,
    stockBase: r.stockBase ?? 0,
  }));
}
