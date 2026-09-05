import { describe, expect, it } from "vitest";

import {
  buildCartLine,
  cartLineKey,
  CUSTOMIZABLE_ORDERING_UNAVAILABLE_MESSAGE,
  validateProductSelection,
} from "@/lib/product-selection";
import { mapApiProduct, type ApiProduct } from "@/lib/storefront-api";

const apiProduct: ApiProduct = {
  productId: 7,
  productUnitId: 71,
  variantId: 21,
  productName: "دفتر مخصص",
  description: "دفتر بطباعة الاسم",
  brand: "العربية",
  category: "قرطاسية",
  categoryId: 3,
  unitName: "قطعة",
  price: "5000",
  salePrice: "4500",
  promotionName: "عرض العودة",
  inStock: true,
  imageUrl: "/images/cover.jpg",
  imageUrls: ["/images/cover.jpg", "/images/back.jpg"],
  isCustomizable: true,
  customizationKind: "PRINT",
  customizationTemplate: {
    id: 4,
    kind: "PRINT",
    title: "بيانات الطباعة",
    description: null,
    fields: [
      {
        fieldKey: "name",
        label: "الاسم",
        fieldType: "TEXT",
        isRequired: true,
        sortOrder: 1,
        maxLength: 20,
        options: [],
        dependency: null,
        priceDelta: "0",
      },
      {
        fieldKey: "color",
        label: "لون الطباعة",
        fieldType: "SELECT",
        isRequired: true,
        sortOrder: 2,
        maxLength: null,
        options: [{ value: "gold", label: "ذهبي", priceDelta: "0" }],
        dependency: { fieldKey: "name", operator: "notEquals", value: "" },
        priceDelta: "0",
      },
    ],
  },
  isBundle: false,
  stockLeft: 3,
  soldCount: 9,
  colors: [{ name: "أحمر", hex: "#FF0000", inStock: true }],
  storeUnits: [],
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
      imageUrls: ["/images/red.jpg"],
      imageUrl: "/images/red.jpg",
      units: [
        {
          productUnitId: 71,
          unitName: "قطعة",
          conversionFactor: "1",
          price: "5000",
          salePrice: "4500",
          promotionName: "عرض العودة",
          inStock: true,
          stockLeft: 3,
        },
      ],
    },
    {
      variantId: 22,
      label: "أزرق — A5",
      variantName: null,
      variantKind: "VARIANT",
      color: "أزرق",
      colorHex: "#0000FF",
      size: "A5",
      inStock: false,
      imageUrls: [],
      imageUrl: null,
      units: [
        {
          productUnitId: 72,
          unitName: "قطعة",
          conversionFactor: "1",
          price: "5000",
          salePrice: null,
          promotionName: null,
          inStock: false,
          stockLeft: 0,
        },
      ],
    },
  ],
  hasAlternatives: false,
};

const orderableApiProduct: ApiProduct = {
  ...apiProduct,
  productName: "دفتر",
  description: "دفتر غير مخصص",
  isCustomizable: false,
  customizationKind: null,
  customizationTemplate: null,
};

describe("product selection contract", () => {
  it("preserves description, galleries, variants, units and customization", () => {
    const product = mapApiProduct(apiProduct);
    expect(product.description).toBe("دفتر بطباعة الاسم");
    expect(product.imageUrls).toEqual([
      "https://alarabiya.online/images/cover.jpg",
      "https://alarabiya.online/images/back.jpg",
    ]);
    expect(product.variants).toHaveLength(2);
    expect(product.variants?.[0]?.units[0]?.productUnitId).toBe(71);
    expect(product.customizationTemplate?.fields).toHaveLength(2);
  });

  it("rejects unavailable stock for an orderable product", () => {
    const product = mapApiProduct(orderableApiProduct);
    expect(validateProductSelection(product, {
      variantId: 22,
      productUnitId: 72,
      customizationValues: {},
    }).errors).toContain("الخيار المحدد نافد حالياً.");
  });

  it("persists the chosen unit in a stable cart line", () => {
    const product = mapApiProduct(orderableApiProduct);
    const selection = validateProductSelection(product, {
      variantId: 21,
      productUnitId: 71,
      customizationValues: {},
    });
    expect(selection.errors).toEqual([]);
    expect(selection.details?.customization).toBeNull();
    const first = buildCartLine(product, selection.details!);
    const secondKey = cartLineKey(7, {
      ...selection.details!,
      productUnitId: 72,
    });
    expect(first.lineId).not.toBe(secondKey);
    expect(first.maxQuantity).toBe(3);
  });

  it("fails closed for every customizable product until the server contract supports it", () => {
    const product = mapApiProduct(apiProduct);
    expect(validateProductSelection(product, {
      variantId: 21,
      productUnitId: 71,
      customizationValues: { name: "علي", color: "gold" },
    }).errors).toEqual([CUSTOMIZABLE_ORDERING_UNAVAILABLE_MESSAGE]);
  });
});
