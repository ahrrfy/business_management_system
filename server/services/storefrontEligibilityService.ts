import { and, eq, sql } from "drizzle-orm";
import {
  branchStock,
  productPrices,
  productUnits,
  productVariants,
  products,
} from "../../drizzle/schema";

/**
 * عقد أهلية موحّد بين المتجر العلني ولوحة الإدارة.
 *
 * publishable: المنتج صالح للعرض حتى لو كان نافداً.
 * available: توجد وحدة بيع واحدة على الأقل يمكن تنفيذ طلبها من رصيد الفرع.
 */
export type StorefrontReadinessReason =
  | "PRODUCT_INACTIVE"
  | "SERVICE_PRODUCT"
  | "PRODUCT_HIDDEN"
  | "NO_ACTIVE_VARIANT"
  | "NO_STORE_SALE_UNIT"
  | "NO_RETAIL_PRICE"
  | "INVALID_CONVERSION_FACTOR"
  | "NO_STOCK_ROW"
  | "NEGATIVE_STOCK"
  | "OUT_OF_STOCK"
  | "BELOW_SALE_UNIT_FACTOR";

export interface StorefrontEligibilityUnitInput {
  isActive: boolean;
  isStoreSaleUnit: boolean;
  retailPrice: string | null;
  conversionFactor: string | number | null;
  /** null يعني أنه لا يوجد صف branchStock لهذا المتغيّر في فرع المتجر. */
  stockBase: number | null;
}

export interface StorefrontEligibilityVariantInput {
  isActive: boolean;
  units: StorefrontEligibilityUnitInput[];
}

export interface StorefrontEligibilityProductInput {
  isActive: boolean;
  isService: boolean;
  showInStore: boolean;
  variants: StorefrontEligibilityVariantInput[];
}

export interface StorefrontEligibilityResult {
  publishable: boolean;
  available: boolean;
  reasons: StorefrontReadinessReason[];
}

const uniqueReasons = (reasons: StorefrontReadinessReason[]): StorefrontReadinessReason[] =>
  Array.from(new Set(reasons));

function validFactor(value: string | number | null): number | null {
  const factor = Number(value);
  return Number.isFinite(factor) && factor > 0 ? factor : null;
}

/** تقييم وحدة مفردة؛ يُستعمل لشرح سبب جاهزية كل وحدة في لوحة الإدارة. */
export function evaluateStorefrontUnitEligibility(
  input: StorefrontEligibilityUnitInput,
): StorefrontEligibilityResult {
  const reasons: StorefrontReadinessReason[] = [];
  if (!input.isActive || !input.isStoreSaleUnit) reasons.push("NO_STORE_SALE_UNIT");
  if (input.retailPrice == null) reasons.push("NO_RETAIL_PRICE");
  const factor = validFactor(input.conversionFactor);
  if (factor == null) reasons.push("INVALID_CONVERSION_FACTOR");

  const publishable = reasons.length === 0;
  if (!publishable) return { publishable: false, available: false, reasons: uniqueReasons(reasons) };

  if (input.stockBase == null) reasons.push("NO_STOCK_ROW");
  else if (input.stockBase < 0) reasons.push("NEGATIVE_STOCK");
  else if (input.stockBase === 0) reasons.push("OUT_OF_STOCK");
  else if (input.stockBase < factor!) reasons.push("BELOW_SALE_UNIT_FACTOR");

  return {
    publishable: true,
    available: reasons.length === 0,
    reasons: uniqueReasons(reasons),
  };
}

/** تقييم منتج كامل: نجاح أي متغيّر/وحدة صالحة يكفي للنشر أو الشراء. */
export function evaluateStorefrontProductEligibility(
  input: StorefrontEligibilityProductInput,
): StorefrontEligibilityResult {
  const productReasons: StorefrontReadinessReason[] = [];
  if (!input.isActive) productReasons.push("PRODUCT_INACTIVE");
  if (input.isService) productReasons.push("SERVICE_PRODUCT");
  if (!input.showInStore) productReasons.push("PRODUCT_HIDDEN");
  if (productReasons.length) {
    return { publishable: false, available: false, reasons: productReasons };
  }

  const activeVariants = input.variants.filter((variant) => variant.isActive);
  if (!activeVariants.length) {
    return { publishable: false, available: false, reasons: ["NO_ACTIVE_VARIANT"] };
  }

  const saleUnits = activeVariants.flatMap((variant) =>
    variant.units.filter((unit) => unit.isActive && unit.isStoreSaleUnit),
  );
  if (!saleUnits.length) {
    return { publishable: false, available: false, reasons: ["NO_STORE_SALE_UNIT"] };
  }

  const pricedUnits = saleUnits.filter((unit) => unit.retailPrice != null);
  if (!pricedUnits.length) {
    return { publishable: false, available: false, reasons: ["NO_RETAIL_PRICE"] };
  }

  const validUnits = pricedUnits.filter((unit) => validFactor(unit.conversionFactor) != null);
  if (!validUnits.length) {
    return { publishable: false, available: false, reasons: ["INVALID_CONVERSION_FACTOR"] };
  }

  const unitResults = validUnits.map(evaluateStorefrontUnitEligibility);
  if (unitResults.some((result) => result.available)) {
    return { publishable: true, available: true, reasons: [] };
  }

  return {
    publishable: true,
    available: false,
    reasons: uniqueReasons(unitResults.flatMap((result) => result.reasons)),
  };
}

/** شرط النشر الخادمي؛ لا يتضمن المخزون كي يستطيع availability=ALL إظهار النافد. */
export function storefrontPublishableCondition() {
  return and(
    eq(products.isActive, true),
    eq(products.isService, false),
    eq(products.showInStore, true),
    eq(productVariants.isActive, true),
    eq(productUnits.isActive, true),
    eq(productUnits.isStoreSaleUnit, true),
    sql`${productPrices.price} is not null`,
    sql`${productUnits.conversionFactor} > 0`,
  )!;
}

/** المخزون بوحدة الأساس ويجب أن يغطي معامل وحدة البيع نفسها. */
export function storefrontAvailableCondition() {
  return sql<boolean>`${branchStock.quantity} >= ${productUnits.conversionFactor}`;
}
