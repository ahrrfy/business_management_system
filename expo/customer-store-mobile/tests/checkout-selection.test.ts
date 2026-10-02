import { describe, expect, it } from "vitest";

import { checkoutQuoteFingerprint, checkoutRequestLines, checkoutSelectionFingerprint, checkoutSelectionIssue } from "@/lib/checkout-selection";
import type { CartLine } from "@/shared/storefront";

const line = {
  lineId: "7:21:71:name=ali",
  product: { id: "7", title: "دفتر" },
  selectionDetails: {
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
      values: [{ fieldKey: "name", label: "الاسم", value: "علي", displayValue: "علي" }],
    },
  },
  quantity: 2,
  maxQuantity: 3,
} as CartLine;

describe("checkout selection persistence", () => {
  it("quotes the selected unit and fingerprints all selection details", () => {
    expect(checkoutRequestLines([line])).toEqual([{ productUnitId: 71, quantity: 2, customization: { templateId: 4, values: { name: "علي" } } }]);
    expect(checkoutSelectionFingerprint([line])[0]).toMatchObject({ lineId: line.lineId, selectionDetails: line.selectionDetails });
  });

  it("invalidates a price review when the quantity or chosen unit changes", () => {
    const quotedCart = checkoutQuoteFingerprint([line]);
    expect(checkoutQuoteFingerprint([{ ...line, quantity: 3 }])).not.toBe(quotedCart);
    expect(checkoutQuoteFingerprint([{
      ...line,
      selectionDetails: { ...line.selectionDetails, productUnitId: 72, unitName: "درزن" },
    } as CartLine])).not.toBe(quotedCart);
  });

  it("allows separate customizations for the same unit because each remains a distinct order line", () => {
    const second = { ...line, lineId: `${line.lineId}:second` };
    expect(checkoutSelectionIssue([line, second])).toBeNull();
    expect(checkoutRequestLines([line, second])).toEqual([{
      productUnitId: 71,
      quantity: 4,
      customization: { templateId: 4, values: { name: "علي" } },
    }]);
    const distinct = {
      ...second,
      selectionDetails: {
        ...second.selectionDetails,
        customization: {
          ...second.selectionDetails.customization!,
          values: [{ fieldKey: "name", label: "الاسم", value: "سارة", displayValue: "سارة" }],
        },
      },
    } as CartLine;
    expect(checkoutRequestLines([line, distinct])).toHaveLength(2);
    const long = {
      ...line,
      selectionDetails: {
        ...line.selectionDetails,
        customization: {
          ...line.selectionDetails.customization!,
          values: [{ fieldKey: "name", label: "الاسم", value: "ا".repeat(480), displayValue: "ا".repeat(480) }],
        },
      },
    } as CartLine;
    expect(checkoutSelectionIssue([long])).toBeNull();
  });
});
