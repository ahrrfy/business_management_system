import { describe, expect, it } from "vitest";
import {
  isAlternativeVariant,
  variantDescriptor,
  variantDisplayName,
} from "./variantDisplay";

describe("variantDisplay — اسم عرض المتغيّر الموحّد (م٣)", () => {
  it("تنويعة بلون/قياس: الواصف «لون / قياس»", () => {
    expect(
      variantDisplayName({ productName: "دفتر", color: "أحمر", size: "كبير", variantKind: "VARIANT" }),
    ).toBe("دفتر — أحمر / كبير");
    expect(variantDescriptor({ productName: "دفتر", color: "أحمر", size: null })).toBe("أحمر");
  });

  it("تنويعة بلا سمات: اسم المنتج وحده (توافق مع السلوك القائم)", () => {
    expect(variantDisplayName({ productName: "قلم", variantKind: "VARIANT" })).toBe("قلم");
    expect(variantDescriptor({ productName: "قلم" })).toBe("");
  });

  it("بديل: الواصف اسمه (variantName)", () => {
    expect(
      variantDisplayName({ productName: "قلم جاف", variantName: "ماركة النسر", variantKind: "ALTERNATIVE" }),
    ).toBe("قلم جاف — ماركة النسر");
  });

  it("بديل بلا اسم: يسقط إلى لون/قياس ثم SKU", () => {
    expect(
      variantDescriptor({ productName: "قلم", variantKind: "ALTERNATIVE", color: "أزرق" }),
    ).toBe("أزرق");
    expect(
      variantDescriptor({ productName: "قلم", variantKind: "ALTERNATIVE", sku: "PEN-X" }),
    ).toBe("PEN-X");
  });

  it("تنويعة بلا لون/قياس لكن باسم: يُستعمل الاسم", () => {
    expect(
      variantDisplayName({ productName: "دفتر", variantName: "٩٦ ورقة", variantKind: "VARIANT" }),
    ).toBe("دفتر — ٩٦ ورقة");
  });

  it("isAlternativeVariant", () => {
    expect(isAlternativeVariant("ALTERNATIVE")).toBe(true);
    expect(isAlternativeVariant("VARIANT")).toBe(false);
    expect(isAlternativeVariant(null)).toBe(false);
  });

  it("يقصّ الفراغات ولا يُخرج فواصل فارغة", () => {
    expect(variantDisplayName({ productName: "  دفتر  ", color: "  ", size: "  " })).toBe("دفتر");
  });
});
