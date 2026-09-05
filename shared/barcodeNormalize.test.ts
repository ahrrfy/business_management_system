import { describe, expect, it } from "vitest";
import {
  barcodeIdentityCandidates,
  barcodesEquivalent,
  canonicalizeBarcodeInput,
  hasUnsupportedBarcodeCharacters,
} from "./barcodeNormalize";

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

  it("يزيل علامات الاتجاه غير المرئية ويكشف محارف التحكّم الداخلية", () => {
    expect(canonicalizeBarcodeInput("\u200f ١٠٠٩٥ \u2066")).toBe("10095");
    expect(hasUnsupportedBarcodeCharacters("AB 12")).toBe(false);
    expect(hasUnsupportedBarcodeCharacters("AB\t12")).toBe(true);
    expect(hasUnsupportedBarcodeCharacters("AB\u000012")).toBe(true);
    expect(canonicalizeBarcodeInput("AB\u2060\u00ad12")).toBe("AB12");
  });
});

describe("barcodeIdentityCandidates — صور الهوية التي قد تعيدها محركات المسح", () => {
  it("يعامل UPC-A الصحيح وEAN-13 ذي الصفر البادئ هويةً واحدةً بالاتجاهين", () => {
    expect(barcodeIdentityCandidates("036000291452")).toEqual(["036000291452", "0036000291452"]);
    expect(barcodeIdentityCandidates("0036000291452")).toEqual(["0036000291452", "036000291452"]);
    expect(barcodesEquivalent("036000291452", "0036000291452")).toBe(true);
  });

  it("لا يحذف صفراً من كود غير قياسي ولا يوسّع EAN-8/ITF-14/الأبجدي", () => {
    expect(barcodeIdentityCandidates("036000291453")).toEqual(["036000291453"]);
    expect(barcodeIdentityCandidates("96385074")).toEqual(["96385074"]);
    expect(barcodeIdentityCandidates("10012345678902")).toEqual(["10012345678902"]);
    expect(barcodeIdentityCandidates("ALR000123")).toEqual(["ALR000123"]);
  });
});
