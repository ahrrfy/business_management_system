import { describe, expect, it } from "vitest";
import { barcodeString, optionalBarcodeString } from "../schemas";

describe("barcodeString / optionalBarcodeString — حدّ الإدخال يُطبّع الباركود قبل أن يبلغ الخدمة", () => {
  it("يقلّم ويطوي الأرقام على حدّ الـAPI (الجذر: مخطّطات بلا trim حفظت «10095 » فصار غير قابل للمسح)", () => {
    expect(barcodeString.parse("  10095 ")).toBe("10095");
    expect(barcodeString.parse("١٠٠٩٥")).toBe("10095");
    expect(barcodeString.parse("MLZ6A")).toBe("MLZ6A");
  });

  it("يرفض الفارغ والمسافات وحدها وما يتجاوز ٦٤ خانة بعد التقليم", () => {
    expect(barcodeString.safeParse("").success).toBe(false);
    expect(barcodeString.safeParse("   ").success).toBe(false);
    expect(barcodeString.safeParse("1".repeat(65)).success).toBe(false);
    expect(barcodeString.safeParse(` ${"1".repeat(64)} `).success).toBe(true);
  });

  it("الاختياريّ: null/undefined/فارغٌ بعد التقليم ⇒ null، وغيره مُطبَّع", () => {
    expect(optionalBarcodeString.parse(undefined)).toBeNull();
    expect(optionalBarcodeString.parse(null)).toBeNull();
    expect(optionalBarcodeString.parse("   ")).toBeNull();
    expect(optionalBarcodeString.parse(" 6001000000017 ")).toBe("6001000000017");
    expect(optionalBarcodeString.safeParse("1".repeat(65)).success).toBe(false);
  });
});
