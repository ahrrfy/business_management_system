// قراءات شاشة الشراء.
import { and, desc, eq } from "drizzle-orm";
import { branchStock, productUnits, productVariants, products } from "../../../drizzle/schema";
import { getDb } from "../../db";
import { activeOnly, buildCatalogSearchOrder, buildCatalogSearchWhere } from "./search";

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
