// قراءة منتج كاملاً لتغذية شاشة التعديل.
import { and, eq, inArray } from "drizzle-orm";
import { bundleComponents, productPrices, productUnits, productVariants, products } from "../../../drizzle/schema";
import { getDb } from "../../db";
import type { PriceTier } from "../pricing";

export interface ProductForEdit {
  id: number;
  name: string;
  categoryId: number | null;
  isCustomizable: boolean;
  isService: boolean;
  isBundle: boolean;
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
  // bundles: وصفة مكوّنات البكج (فارغة للمنتجات العادية). المتغيّر الأب = variants[0].id عند isBundle=true.
  bundleComponents: Array<{
    componentVariantId: number;
    componentBaseQuantity: number;
    componentUnitId: number | null;
    sortOrder: number;
    notes: string | null;
    // معلومات عرض للواجهة — تجنّب N+1 بجلبها في نفس القراءة.
    componentProductName: string;
    componentSku: string;
    componentCostPrice: string;
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

  // bundles: قراءة الوصفة (إن كان البكج) — join مع منتجات المكوّنات لعرض الأسماء بلا N+1.
  let bundleRows: Array<{
    componentVariantId: number;
    componentBaseQuantity: number;
    componentUnitId: number | null;
    sortOrder: number;
    notes: string | null;
    componentProductName: string;
    componentSku: string;
    componentCostPrice: string;
  }> = [];
  if (p.isBundle && variantIds.length) {
    const rows = await db
      .select({
        componentVariantId: bundleComponents.componentVariantId,
        componentBaseQuantity: bundleComponents.componentBaseQuantity,
        componentUnitId: bundleComponents.componentUnitId,
        sortOrder: bundleComponents.sortOrder,
        notes: bundleComponents.notes,
        productName: products.name,
        sku: productVariants.sku,
        costPrice: productVariants.costPrice,
      })
      .from(bundleComponents)
      .innerJoin(productVariants, eq(bundleComponents.componentVariantId, productVariants.id))
      .innerJoin(products, eq(productVariants.productId, products.id))
      .where(inArray(bundleComponents.bundleVariantId, variantIds));
    bundleRows = rows
      .map((r) => ({
        componentVariantId: Number(r.componentVariantId),
        componentBaseQuantity: Number(r.componentBaseQuantity),
        componentUnitId: r.componentUnitId == null ? null : Number(r.componentUnitId),
        sortOrder: Number(r.sortOrder ?? 0),
        notes: r.notes,
        componentProductName: r.productName,
        componentSku: r.sku,
        componentCostPrice: String(r.costPrice ?? "0"),
      }))
      .sort((a, b) => a.sortOrder - b.sortOrder);
  }

  return {
    id: Number(p.id),
    name: p.name,
    categoryId: p.categoryId != null ? Number(p.categoryId) : null,
    isCustomizable: !!p.isCustomizable,
    isService: !!p.isService,
    isBundle: !!p.isBundle,
    isActive: !!p.isActive,
    bundleComponents: bundleRows,
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
