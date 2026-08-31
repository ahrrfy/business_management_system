import { describe, expect, it, vi } from "vitest";

import { addProductToCart, sanitizeCartLines } from "@/lib/cart-context";
import {
  checkoutRequestLines,
  checkoutSelectionIssue,
} from "@/lib/checkout-selection";
import {
  CUSTOMIZABLE_ORDERING_UNAVAILABLE_MESSAGE,
  validateProductSelection,
} from "@/lib/product-selection";
import type {
  CartLine,
  Product,
  ProductSelectionDetails,
} from "@/shared/storefront";

const details: ProductSelectionDetails = {
  variantId: 21,
  variantLabel: "أحمر — A5",
  variantKind: "VARIANT",
  productUnitId: 71,
  unitName: "قطعة",
  unitPrice: "5000",
  unitSalePrice: "4500",
  imageUrl: null,
  customization: null,
};

const customizableProduct = {
  id: "7",
  productId: 7,
  productUnitId: 71,
  variantId: 21,
  title: "دفتر مخصص",
  subtitle: "قطعة",
  categoryId: "3",
  description: "دفتر بطباعة الاسم",
  icon: "menu-book",
  accent: "#E7F1EC",
  availability: "متوفر",
  price: "5000",
  salePrice: "4500",
  inStock: true,
  isCustomizable: true,
  variants: [
    {
      variantId: 21,
      label: "أحمر — A5",
      variantName: null,
      variantKind: "VARIANT",
      color: "أحمر",
      colorHex: "#FF0000",
      size: "A5",
      inStock: true,
      imageUrls: [],
      imageUrl: null,
      units: [
        {
          productUnitId: 71,
          unitName: "قطعة",
          conversionFactor: "1",
          price: "5000",
          salePrice: "4500",
          promotionName: null,
          inStock: true,
          stockLeft: 3,
        },
      ],
    },
  ],
} satisfies Product;

const customizableLine = {
  lineId: "7:21:71:[]",
  product: customizableProduct,
  selectionDetails: details,
  quantity: 1,
  maxQuantity: 3,
} satisfies CartLine;

describe("customizable product online-ordering guard", () => {
  it("rejects a customizable product before a cart line can be built", () => {
    expect(validateProductSelection(customizableProduct, {
      variantId: 21,
      productUnitId: 71,
      customizationValues: {},
    })).toEqual({
      errors: [CUSTOMIZABLE_ORDERING_UNAVAILABLE_MESSAGE],
      details: null,
    });
  });

  it("rejects direct additions and removes legacy customizable lines on restore", () => {
    expect(addProductToCart([], customizableLine)).toEqual([]);
    expect(sanitizeCartLines([customizableLine])).toEqual([]);
  });

  it("produces no quote/create payload and blocks the network boundary", () => {
    const networkCall = vi.fn();
    const issue = checkoutSelectionIssue([customizableLine]);
    const requestLines = checkoutRequestLines([customizableLine]);
    if (!issue && requestLines.length === 1) networkCall(requestLines);

    expect(issue).toBe(CUSTOMIZABLE_ORDERING_UNAVAILABLE_MESSAGE);
    expect(requestLines).toEqual([]);
    expect(networkCall).not.toHaveBeenCalled();
  });
});
