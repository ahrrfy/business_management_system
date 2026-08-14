import { and, asc, eq, inArray } from "drizzle-orm";
import {
  branchStock,
  productPrices,
  productUnits,
  productVariants,
  products,
} from "../../../drizzle/schema";
import { getDb } from "../../db";
import {
  evaluateStorefrontProductEligibility,
  evaluateStorefrontUnitEligibility,
  type StorefrontReadinessReason,
} from "../storefrontEligibilityService";

export interface StorefrontReadinessUnit {
  productUnitId: number;
  unitName: string;
  conversionFactor: string;
  isActive: boolean;
  isStoreSaleUnit: boolean;
  retailPrice: string | null;
  /** الرصيد الحقيقي للمتغيّر بالوحدة الأساس في فرع المتجر. */
  stockBase: number;
  hasStockRow: boolean;
  /** عدد وحدات البيع الكاملة الممكنة = floor(stockBase / conversionFactor). */
  availableUnits: number;
  publishable: boolean;
  inStock: boolean;
  readinessReasons: StorefrontReadinessReason[];
}

export interface StorefrontReadinessVariant {
  variantId: number;
  sku: string;
  label: string;
  isActive: boolean;
  stockBase: number;
  hasStockRow: boolean;
  publishable: boolean;
  inStock: boolean;
  readinessReasons: StorefrontReadinessReason[];
  units: StorefrontReadinessUnit[];
}

export interface StorefrontProductReadiness {
  productId: number;
  publishable: boolean;
  inStock: boolean;
  readinessReasons: StorefrontReadinessReason[];
  variants: StorefrontReadinessVariant[];
  preferredUnit: StorefrontReadinessUnit | null;
}

interface MutableVariant {
  variantId: number;
  sku: string;
  variantName: string | null;
  color: string | null;
  size: string | null;
  isActive: boolean;
  stockBase: number;
  hasStockRow: boolean;
  units: StorefrontReadinessUnit[];
}

interface MutableProduct {
  productId: number;
  isActive: boolean;
  isService: boolean;
  showInStore: boolean;
  variants: Map<number, MutableVariant>;
}

function variantLabel(variant: MutableVariant): string {
  const parts = [variant.variantName, variant.color, variant.size]
    .map((value) => value?.trim())
    .filter(Boolean) as string[];
  return Array.from(new Set(parts)).join(" — ") || variant.sku;
}

/**
 * يحمّل حقائق الجاهزية للفرع المحدد بحبيبة variant × store sale unit.
 * لا يجمع أرصدة المتغيّرات ولا يختار MIN(variantId)، لذلك يبقى هدف أي تسوية مخزون صريحاً.
 */
export async function loadStorefrontReadiness(input: {
  branchId: number;
  productIds: number[];
}): Promise<Map<number, StorefrontProductReadiness>> {
  const db = getDb();
  if (!db || !input.productIds.length) return new Map();

  const rows = await db
    .select({
      productId: products.id,
      productActive: products.isActive,
      isService: products.isService,
      showInStore: products.showInStore,
      variantId: productVariants.id,
      sku: productVariants.sku,
      variantName: productVariants.variantName,
      color: productVariants.color,
      size: productVariants.size,
      variantActive: productVariants.isActive,
      productUnitId: productUnits.id,
      unitName: productUnits.unitName,
      conversionFactor: productUnits.conversionFactor,
      unitActive: productUnits.isActive,
      isStoreSaleUnit: productUnits.isStoreSaleUnit,
      retailPrice: productPrices.price,
      stockBase: branchStock.quantity,
    })
    .from(products)
    .leftJoin(productVariants, eq(productVariants.productId, products.id))
    .leftJoin(productUnits, eq(productUnits.variantId, productVariants.id))
    .leftJoin(
      productPrices,
      and(eq(productPrices.productUnitId, productUnits.id), eq(productPrices.priceTier, "RETAIL")),
    )
    .leftJoin(
      branchStock,
      and(eq(branchStock.variantId, productVariants.id), eq(branchStock.branchId, input.branchId)),
    )
    .where(inArray(products.id, input.productIds))
    .orderBy(asc(products.id), asc(productVariants.id), asc(productUnits.conversionFactor), asc(productUnits.id));

  const grouped = new Map<number, MutableProduct>();
  for (const row of rows) {
    const productId = Number(row.productId);
    let product = grouped.get(productId);
    if (!product) {
      product = {
        productId,
        isActive: row.productActive === true,
        isService: !!row.isService,
        showInStore: row.showInStore === true,
        variants: new Map(),
      };
      grouped.set(productId, product);
    }
    if (row.variantId == null) continue;

    const variantId = Number(row.variantId);
    let variant = product.variants.get(variantId);
    if (!variant) {
      variant = {
        variantId,
        sku: row.sku ?? `#${variantId}`,
        variantName: row.variantName ?? null,
        color: row.color ?? null,
        size: row.size ?? null,
        isActive: row.variantActive === true,
        stockBase: Number(row.stockBase ?? 0),
        hasStockRow: row.stockBase != null,
        units: [],
      };
      product.variants.set(variantId, variant);
    }
    if (row.productUnitId == null) continue;

    const factor = Number(row.conversionFactor);
    const stockBase = row.stockBase == null ? null : Number(row.stockBase);
    const eligibility = evaluateStorefrontUnitEligibility({
      isActive: row.unitActive === true,
      isStoreSaleUnit: !!row.isStoreSaleUnit,
      retailPrice: row.retailPrice ?? null,
      conversionFactor: row.conversionFactor == null ? null : String(row.conversionFactor),
      stockBase,
    });
    variant.units.push({
      productUnitId: Number(row.productUnitId),
      unitName: row.unitName ?? "وحدة",
      conversionFactor: String(row.conversionFactor ?? "0"),
      isActive: row.unitActive === true,
      isStoreSaleUnit: !!row.isStoreSaleUnit,
      retailPrice: row.retailPrice ?? null,
      stockBase: stockBase ?? 0,
      hasStockRow: stockBase != null,
      availableUnits: Number.isFinite(factor) && factor > 0
        ? Math.max(0, Math.floor(Number(stockBase ?? 0) / factor))
        : 0,
      publishable: eligibility.publishable,
      inStock: eligibility.available,
      readinessReasons: eligibility.reasons,
    });
  }

  const result = new Map<number, StorefrontProductReadiness>();
  for (const product of Array.from(grouped.values())) {
    const variants = Array.from(product.variants.values()).map((variant): StorefrontReadinessVariant => {
      const variantEligibility = evaluateStorefrontProductEligibility({
        isActive: true,
        isService: false,
        showInStore: true,
        variants: [{
          isActive: variant.isActive,
          units: variant.units.map((unit) => ({
            isActive: unit.isActive,
            isStoreSaleUnit: unit.isStoreSaleUnit,
            retailPrice: unit.retailPrice,
            conversionFactor: unit.conversionFactor,
            stockBase: unit.hasStockRow ? unit.stockBase : null,
          })),
        }],
      });
      return {
        variantId: variant.variantId,
        sku: variant.sku,
        label: variantLabel(variant),
        isActive: variant.isActive,
        stockBase: variant.stockBase,
        hasStockRow: variant.hasStockRow,
        publishable: variantEligibility.publishable,
        inStock: variantEligibility.available,
        readinessReasons: variantEligibility.reasons,
        units: variant.units,
      };
    });

    const eligibility = evaluateStorefrontProductEligibility({
      isActive: product.isActive,
      isService: product.isService,
      showInStore: product.showInStore,
      variants: variants.map((variant) => ({
        isActive: variant.isActive,
        units: variant.units.map((unit) => ({
          isActive: unit.isActive,
          isStoreSaleUnit: unit.isStoreSaleUnit,
          retailPrice: unit.retailPrice,
          conversionFactor: unit.conversionFactor,
          stockBase: unit.hasStockRow ? unit.stockBase : null,
        })),
      })),
    });
    const allUnits = variants.flatMap((variant) =>
      variant.isActive ? variant.units.filter((unit) => unit.isActive && unit.isStoreSaleUnit) : [],
    );
    const preferredUnit = allUnits.find((unit) => unit.inStock)
      ?? allUnits.find((unit) => unit.publishable)
      ?? allUnits[0]
      ?? null;
    result.set(product.productId, {
      productId: product.productId,
      publishable: eligibility.publishable,
      inStock: eligibility.available,
      readinessReasons: eligibility.reasons,
      variants,
      preferredUnit,
    });
  }
  return result;
}
