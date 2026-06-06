import { TRPCError } from "@trpc/server";
import { and, desc, eq, like, or, type SQL } from "drizzle-orm";
import { branchStock, productPrices, productUnits, productVariants, products } from "../../drizzle/schema";
import { getDb } from "../db";
import { toDbMoney } from "./money";
import type { PriceTier } from "./pricing";
import { setStock } from "./inventoryService";
import { withTx, type Actor } from "./tx";

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
  }));
}

const activeOnly = and(
  eq(products.isActive, true),
  eq(productVariants.isActive, true),
  eq(productUnits.isActive, true)
);

/** Resolve a scanned barcode to a single POS row. */
export async function lookupByBarcode(barcode: string, branchId: number, tier: PriceTier): Promise<PosRow | null> {
  const db = getDb();
  if (!db) return null;
  const rows = await baseSelect(db, branchId, tier)
    .where(and(activeOnly, eq(productUnits.barcode, barcode)))
    .limit(1);
  return normalize(rows)[0] ?? null;
}

/** List sellable rows for the POS, optionally filtered by a text query. */
export async function listForPos(branchId: number, tier: PriceTier, query?: string, limit = 200): Promise<PosRow[]> {
  const db = getDb();
  if (!db) return [];
  let where: SQL | undefined = activeOnly;
  if (query && query.trim()) {
    const q = `%${query.trim()}%`;
    where = and(
      activeOnly,
      or(like(products.name, q), like(productVariants.sku, q), like(productVariants.variantName, q), like(productUnits.barcode, q))
    );
  }
  const rows = await baseSelect(db, branchId, tier).where(where).orderBy(desc(products.id)).limit(limit);
  return normalize(rows);
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
  let where: SQL | undefined = activeOnly;
  if (query && query.trim()) {
    const q = `%${query.trim()}%`;
    where = and(
      activeOnly,
      or(like(products.name, q), like(productVariants.sku, q), like(productVariants.variantName, q), like(productUnits.barcode, q))
    );
  }
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
    .orderBy(desc(products.id))
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

/* ============================ Product setup (catalog write) ============================ */

export interface CreateProductInput {
  name: string;
  categoryId?: number | null;
  isCustomizable?: boolean;
  variants: Array<{
    sku: string;
    variantName?: string | null;
    color?: string | null;
    size?: string | null;
    costPrice: string;
    openingStock?: number;
    units: Array<{
      unitName: string;
      conversionFactor: string;
      barcode?: string | null;
      isBaseUnit?: boolean;
      prices?: Array<{ priceTier: PriceTier; price: string }>;
    }>;
  }>;
}

/** Create a product with its variants, units and prices in one transaction. */
export async function createProduct(input: CreateProductInput, actor: Actor) {
  if (!input.variants.length) throw new TRPCError({ code: "BAD_REQUEST", message: "المنتج يحتاج متغيّراً واحداً على الأقل" });
  return withTx(async (tx) => {
    const pRes = await tx.insert(products).values({
      name: input.name,
      categoryId: input.categoryId ?? null,
      isCustomizable: input.isCustomizable ?? false,
    });
    const productId = Number((pRes as any)[0]?.insertId ?? (pRes as any).insertId);

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
      });
      const variantId = Number((vRes as any)[0]?.insertId ?? (vRes as any).insertId);

      for (const u of v.units) {
        const uRes = await tx.insert(productUnits).values({
          variantId,
          unitName: u.unitName,
          conversionFactor: u.conversionFactor,
          barcode: u.barcode ?? null,
          isBaseUnit: u.isBaseUnit ?? false,
        });
        const productUnitId = Number((uRes as any)[0]?.insertId ?? (uRes as any).insertId);
        for (const p of u.prices ?? []) {
          await tx.insert(productPrices).values({ productUnitId, priceTier: p.priceTier, price: toDbMoney(p.price) });
        }
      }

      // المخزون الافتتاحي (في فرع الموظف) كحركة ADJUST مُسجَّلة.
      if (v.openingStock && v.openingStock > 0) {
        await setStock(tx, {
          variantId,
          branchId: actor.branchId,
          targetQuantity: v.openingStock,
          referenceType: "OPENING",
          notes: "رصيد افتتاحي",
          createdBy: actor.userId,
        });
      }
    }
    return { productId };
  });
}
