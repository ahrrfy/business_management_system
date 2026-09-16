import { describe, expect, it } from "vitest";

import { checkoutQuoteFingerprint, checkoutRequestLines, checkoutSelectionFingerprint, checkoutSelectionIssue, checkoutSelectionNotes } from "@/lib/checkout-selection";
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
    expect(checkoutRequestLines([line])).toEqual([{ productUnitId: 71, quantity: 2 }]);
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

  it("provides a bounded fulfillment note until the server accepts structured details", () => {
    const note = checkoutSelectionNotes([line]);
    expect(note).toContain("أحمر — A5");
    expect(note).toContain("الاسم: علي");
    expect(note).toContain("× 2");
    expect(note.length).toBeLessThanOrEqual(500);
  });

  it("blocks ambiguous merged customizations and notes that would be truncated", () => {
    const second = { ...line, lineId: `${line.lineId}:second` };
    expect(checkoutSelectionIssue([line, second])).toMatch(/طلب مستقل/);
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
    expect(checkoutSelectionIssue([long])).toMatch(/أطول من الحد/);
  });
});
