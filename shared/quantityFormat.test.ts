import { describe, expect, it } from "vitest";
import { formatQuantity, fmtQty } from "./quantityFormat";

describe("shared/quantityFormat — تنسيق الكميات وإزالة الأصفار العشرية الزائدة", () => {
  it("يحذف الأصفار العشرية الزائدة من السلاسل النصية للأعداد الصحيحة (جوهر البلاغ)", () => {
    expect(formatQuantity("1000.000")).toBe("1,000");
    expect(formatQuantity("120.000")).toBe("120");
    expect(formatQuantity("12.000")).toBe("12");
    expect(formatQuantity("5.0000")).toBe("5");
    expect(formatQuantity("100.0")).toBe("100");
  });

  it("يتعامل مع الأعداد الرقمية (number) بشكل صحيح", () => {
    expect(formatQuantity(1000)).toBe("1,000");
    expect(formatQuantity(120)).toBe("120");
    expect(formatQuantity(0)).toBe("0");
    expect(formatQuantity(1.5)).toBe("1.5");
  });

  it("يُصيّر الصفر بنظافة دون أصفار عشرية", () => {
    expect(formatQuantity("0.000")).toBe("0");
    expect(formatQuantity("0.0")).toBe("0");
    expect(formatQuantity(0)).toBe("0");
  });

  it("يحذف الأصفار الذيليّة غير المعنوية للكسور مع إبقاء الكسر الحقيقي", () => {
    expect(formatQuantity("1.500")).toBe("1.5");
    expect(formatQuantity("0.250")).toBe("0.25");
    expect(formatQuantity("10.7500")).toBe("10.75");
  });

  it("يحفظ الكسور العشرية حتى 4 منازل بلا تقريب جائر أو فقدان دقّة (عكس round2 المالي)", () => {
    expect(formatQuantity("1.125")).toBe("1.125");
    expect(formatQuantity("0.0005")).toBe("0.0005");
    expect(formatQuantity("2.3333")).toBe("2.3333");
    expect(formatQuantity("0.1234")).toBe("0.1234");
  });

  it("يدعم الأعداد السالبة (مرتجعات/تسويات)", () => {
    expect(formatQuantity("-5.000")).toBe("-5");
    expect(formatQuantity("-1.500")).toBe("-1.5");
    expect(formatQuantity("-1000.000")).toBe("-1,000");
  });

  it("يُرجع fallback قياسي عند القيم الفارغة أو المعدومة", () => {
    expect(formatQuantity(null)).toBe("—");
    expect(formatQuantity(undefined)).toBe("—");
    expect(formatQuantity("")).toBe("—");
    expect(formatQuantity("   ")).toBe("—");
  });

  it("يقبل تخصيص fallback في الخيارات", () => {
    expect(formatQuantity(null, { fallback: "0" })).toBe("0");
    expect(formatQuantity("", { fallback: "0.00" })).toBe("0.00");
    expect(formatQuantity(undefined, { fallback: "لا يوجد" })).toBe("لا يوجد");
  });

  it("يدعم خيار إيقاف فواصل الآلاف (useGrouping: false)", () => {
    expect(formatQuantity("1000.000", { useGrouping: false })).toBe("1000");
    expect(formatQuantity("1000000.000", { useGrouping: false })).toBe(
      "1000000",
    );
  });

  it("يُعيد النص غير الرقمي كما هو بأمان", () => {
    expect(formatQuantity("abc")).toBe("abc");
    expect(formatQuantity("—")).toBe("—");
  });

  it("الاسم البديل fmtQty يطابق formatQuantity تماماً", () => {
    expect(fmtQty("120.000")).toBe("120");
    expect(fmtQty("1.500")).toBe("1.5");
    expect(fmtQty(null)).toBe("—");
  });
});
