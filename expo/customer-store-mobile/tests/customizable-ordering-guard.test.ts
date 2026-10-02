import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { addProductToCart, sanitizeCartLines } from "@/lib/cart-context";
import {
  checkoutRequestLines,
  checkoutSelectionIssue,
} from "@/lib/checkout-selection";
import {
  validateProductQuoteSelection,
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
  customization: {
    templateId: 4,
    templateTitle: "الطباعة",
    values: [{ fieldKey: "name", label: "الاسم المطلوب", value: "علي", displayValue: "علي" }],
  },
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
  customizationTemplate: {
    id: 4,
    kind: "PRINT",
    title: "الطباعة",
    description: "اكتب التفاصيل",
    fields: [{ fieldKey: "name", label: "الاسم المطلوب", fieldType: "TEXT", isRequired: true, sortOrder: 1, maxLength: 100, options: [], dependency: null, priceDelta: "0" }],
  },
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
  it("builds a structured selection for a customizable product", () => {
    expect(validateProductSelection(customizableProduct, {
      variantId: 21,
      productUnitId: 71,
      customizationValues: { name: "علي" },
    }).details?.customization).toEqual(details.customization);
  });

  it("keeps configured customizable lines in the cart and on restore", () => {
    expect(addProductToCart([], customizableLine)).toHaveLength(1);
    expect(sanitizeCartLines([customizableLine])).toHaveLength(1);
  });

  it("sends structured customization through the quote/create boundary", () => {
    const networkCall = vi.fn();
    const issue = checkoutSelectionIssue([customizableLine]);
    const requestLines = checkoutRequestLines([customizableLine]);
    if (!issue && requestLines.length === 1) networkCall(requestLines);

    expect(issue).toBeNull();
    expect(requestLines).toEqual([{ productUnitId: 71, quantity: 1, customization: { templateId: 4, values: { name: "علي" } } }]);
    expect(networkCall).toHaveBeenCalledOnce();
  });

  it("keeps the same structured unit available for checkout and sales quotes", () => {
    expect(validateProductQuoteSelection(customizableProduct, {
      variantId: 21,
      productUnitId: 71,
      customizationValues: { name: "علي" },
    }).details).toMatchObject({ productUnitId: 71, variantId: 21 });
    expect(checkoutRequestLines([customizableLine])).toHaveLength(1);
  });

  it("renders a writable reference input for FILE customization fields", () => {
    const source = readFileSync(fileURLToPath(new URL("../app/product/[id].tsx", import.meta.url).toString()), "utf8");
    expect(source).toContain('field.fieldType === "FILE"');
    expect(source).toContain('placeholder="اكتب رابط الملف أو اسمه أو مرجعه"');
    expect(source).toContain("onChangeText={onChange}");
  });
});
