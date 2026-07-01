// قراءة منتج كاملاً لتغذية شاشة التعديل.
import { and, eq, inArray } from "drizzle-orm";
import { productPrices, productUnits, productVariants, products } from "../../../drizzle/schema";
import { getDb } from "../../db";
import type { PriceTier } from "../pricing";

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
