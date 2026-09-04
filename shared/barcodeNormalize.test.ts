import { describe, expect, it } from "vitest";
import { canonicalizeBarcodeInput } from "./barcodeNormalize";

describe("canonicalizeBarcodeInput — تطبيع مدخل الباركود (مصدر واحد للحفظ والمطابقة)", () => {
  it("يقلّم المسافات الطرفية — سببُ «الرمز الممسوح لا يطابق» على منتجٍ موجود فعلاً", () => {
    expect(canonicalizeBarcodeInput("  10095 ")).toBe("10095");
    expect(canonicalizeBarcodeInput("\t6001000000017\n")).toBe("6001000000017");
  });

  it("يطوي الأرقام العربية-الهندية والفارسية إلى لاتينية", () => {
    expect(canonicalizeBarcodeInput("١٠٠٩٥")).toBe("10095");
    expect(canonicalizeBarcodeInput("۶۰۰۱۰۰۰۰۰۰۰۱۷")).toBe("6001000000017");
    expect(canonicalizeBarcodeInput("ALR٠٠٠١٠٨٤")).toBe("ALR0001084");
  });

  it("لا يلمس حالة الأحرف ولا المسافة الداخلية (Code39 يسمح بها حرفاً معنوياً)", () => {
    expect(canonicalizeBarcodeInput("MLZ6A")).toBe("MLZ6A");
    expect(canonicalizeBarcodeInput("NASR-6A")).toBe("NASR-6A");
    expect(canonicalizeBarcodeInput("AB 12")).toBe("AB 12");
  });

  it("الفارغ والمسافات وحدها ⇒ سلسلة فارغة (يرفضها المخطّط لا الدالّة)", () => {
    expect(canonicalizeBarcodeInput("")).toBe("");
    expect(canonicalizeBarcodeInput("   ")).toBe("");
  });

  it("مُتعادِل: تطبيع المُطبَّع لا يغيّره", () => {
    for (const v of ["10095", "6001000000017", "MLZ6A", "AB 12", "ALR0001084"]) {
      expect(canonicalizeBarcodeInput(canonicalizeBarcodeInput(v))).toBe(v);
    }
  });
});
