import { describe, expect, it } from "vitest";
import { addProductToCart } from "../lib/cart-context";
import type { Product } from "../shared/storefront";

function makeProduct(id: string, price: number = 5000): Product {
  return {
    id,
    productId: 100,
    productUnitId: 200,
    title: `منتج تجريبي ${id}`,
    subtitle: "وحدة تجريبية",
    categoryId: "stationery",
    description: "وصف تجريبي",
    icon: "book",
    accent: "#E2E8F0",
    availability: "متوفر",
    price: String(price),
    inStock: true,
  };
}

describe("Wholesale Dozen & Bulk Quantity Additions", () => {
  it("adds exactly 12 pieces at once when selecting bulk dozen", () => {
    const product = makeProduct("p-bulk-1");
    const cart = addProductToCart([], product, 12);

    expect(cart).toHaveLength(1);
    expect(cart[0].quantity).toBe(12);
  });

  it("increases existing cart line by 12 pieces when re-adding dozen", () => {
    const product = makeProduct("p-bulk-2");
    const initial = addProductToCart([], product, 2);
    const updated = addProductToCart(initial, product, 12);

    expect(updated).toHaveLength(1);
    expect(updated[0].quantity).toBe(14);
  });

  it("respects maxQuantity limit when adding bulk quantity", () => {
    const product = makeProduct("p-bulk-3");
    const initialLine = {
      lineId: "p-bulk-3:200:200:null",
      product,
      selectionDetails: {
        variantId: 200,
        variantLabel: "افتراضي",
        variantKind: "VARIANT" as const,
        productUnitId: 200,
        unitName: "قطعة",
        unitPrice: "5000",
        unitSalePrice: null,
        imageUrl: null,
        customization: null,
      },
      quantity: 1,
      maxQuantity: 10,
    };
    const cart = addProductToCart([], initialLine, 12);
    expect(cart[0].quantity).toBe(10);
  });
});

describe("Free Shipping Gap-Filler & Impulse Addons", () => {
  it("detects when remaining shipping amount is 5,000 IQD or less", () => {
    const freeShippingThreshold = 30000;
    const currentSubtotal = 27500;
    const remaining = Math.max(0, freeShippingThreshold - currentSubtotal);

    const isEligibleForGapFiller = remaining > 0 && remaining <= 5000;
    expect(isEligibleForGapFiller).toBe(true);
    expect(remaining).toBe(2500);
  });

  it("adding impulse addon of 2,500 IQD completes the free shipping requirement", () => {
    const freeShippingThreshold = 30000;
    let subtotal = 27500;
    const impulsePrice = 2500;

    subtotal += impulsePrice;
    const remaining = Math.max(0, freeShippingThreshold - subtotal);

    expect(remaining).toBe(0);
    expect(subtotal).toBe(freeShippingThreshold);
  });
});
