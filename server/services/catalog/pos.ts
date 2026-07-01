// قراءات الكاشير (POS): مطابقة الباركود وقائمة البيع.
import { and, desc, eq } from "drizzle-orm";
import { branchStock, productPrices, productUnits, productVariants, products } from "../../../drizzle/schema";
import { getDb } from "../../db";
import type { PriceTier } from "../pricing";
import { PRINT_SERVICE_TYPE } from "../printSaleService";
import { activeOnly, buildCatalogSearchOrder, buildCatalogSearchWhere, posVisibility } from "./search";

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
  // شاشة الاستقبال الهجينة: المنتج المخصّص يفتح نافذة التخصيص بدل الإضافة المباشرة للسلّة.
  isCustomizable: boolean;
  // خدمة طباعة (productType=PRINT_SERVICE): تُباع عبر مسار createPrintSale (خصم مواد + COGS) لا sales.create.
  isPrintService: boolean;
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
      isCustomizable: products.isCustomizable,
      productType: products.productType,
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
    isCustomizable: !!r.isCustomizable,
    isPrintService: r.productType === PRINT_SERVICE_TYPE,
  }));
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

/** List sellable rows for the POS, optionally filtered by a text query.
 *  includeReceptionServices=true يُظهر خدمات الطباعة المفعَّل عليها showInReception (كاشير الاستقبال). */
export async function listForPos(
  branchId: number,
  tier: PriceTier,
  query?: string,
  limit = 200,
  opts?: { includeReceptionServices?: boolean },
): Promise<PosRow[]> {
  const db = getDb();
  if (!db) return [];
  const active = posVisibility(!!opts?.includeReceptionServices);
  const search = buildCatalogSearchWhere(query);
  const where = search ? and(active, search) : active;
  const order = search ? buildCatalogSearchOrder(query) : [desc(products.id)];
  const rows = await baseSelect(db, branchId, tier).where(where).orderBy(...order).limit(limit);
  return normalize(rows);
}
