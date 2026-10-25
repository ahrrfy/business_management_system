import {
  productDiscountPercent,
  storefrontDisplayPrice,
} from "@/lib/storefront-api";
import type { Product, StorefrontUnitOption } from "@/shared/storefront";

export type DealFilter = "ALL" | "FLASH" | "UNDER_10K" | "DISCOUNTED";

function unitDiscountPercent(
  price: string | null | undefined,
  salePrice: string | null | undefined,
): number | null {
  const original = Number(price);
  if (typeof salePrice !== "string" || !salePrice.trim()) return null;
  const current = Number(salePrice);
  if (
    !Number.isFinite(original) ||
    !Number.isFinite(current) ||
    original <= 0 ||
    current <= 0 ||
    current >= original
  ) {
    return null;
  }
  const percent = Math.round(((original - current) / original) * 100);
  return percent > 0 && percent < 100 ? percent : null;
}

function collectInStockUnits(product: Product): StorefrontUnitOption[] {
  const direct = (product.storeUnits ?? []).filter((unit) => unit.inStock);
  const variantUnits = (product.variants ?? []).flatMap((variant) =>
    variant.inStock ? variant.units.filter((unit) => unit.inStock) : [],
  );
  return [...direct, ...variantUnits];
}

export function effectiveProductMaxDiscountPercent(product: Product): number {
  let maxPercent = productDiscountPercent(product) ?? 0;
  for (const unit of collectInStockUnits(product)) {
    const unitPercent = unitDiscountPercent(unit.price, unit.salePrice) ?? 0;
    if (unitPercent > maxPercent) {
      maxPercent = unitPercent;
    }
  }
  return maxPercent;
}

function hasActiveNamedPromotion(product: Product): boolean {
  const displayPrice = storefrontDisplayPrice(product);
  const hasValidTopPrice =
    typeof displayPrice === "string" &&
    displayPrice.trim().length > 0 &&
    Number(displayPrice) > 0;
  if (
    hasValidTopPrice &&
    typeof product.promotionName === "string" &&
    product.promotionName.trim().length > 0
  ) {
    return true;
  }
  return collectInStockUnits(product).some(
    (unit) =>
      typeof unit.promotionName === "string" &&
      unit.promotionName.trim().length > 0 &&
      typeof unit.price === "string" &&
      Number(unit.price) > 0,
  );
}

export function isDiscountedDealProduct(product: Product): boolean {
  return (
    effectiveProductMaxDiscountPercent(product) > 0 ||
    hasActiveNamedPromotion(product)
  );
}

export function isUnder10kDealProduct(product: Product): boolean {
  const displayPrice = storefrontDisplayPrice(product);
  if (typeof displayPrice !== "string" || !displayPrice.trim()) return false;
  const numericPrice = Number(displayPrice);
  return (
    Number.isFinite(numericPrice) && numericPrice > 0 && numericPrice < 10000
  );
}

export function filterDealsProducts(
  products: readonly Product[],
  filter: DealFilter,
): Product[] {
  switch (filter) {
    case "FLASH":
      return products.filter(isDiscountedDealProduct);
    case "UNDER_10K":
      return products.filter(isUnder10kDealProduct);
    case "DISCOUNTED":
      return products
        .filter(isDiscountedDealProduct)
        .sort(
          (left, right) =>
            effectiveProductMaxDiscountPercent(right) -
            effectiveProductMaxDiscountPercent(left),
        );
    case "ALL":
    default:
      return products.filter(
        (product) =>
          isDiscountedDealProduct(product) || isUnder10kDealProduct(product),
      );
  }
}
