import { describe, it, expect } from "vitest";
import {
  digitsArabicToLatin,
  stripCurrencySymbols,
  normalizeNumberInput,
  toNormalizedNumber,
} from "./numberNormalize";

describe("digitsArabicToLatin", () => {
  it("يحوّل الأرقام الهندية-العربية", () => {
    expect(digitsArabicToLatin("١١٦٢")).toBe("1162");
    expect(digitsArabicToLatin("٠١٢٣٤٥٦٧٨٩")).toBe("0123456789");
  });
  it("يحوّل الأرقام الفارسية", () => {
    expect(digitsArabicToLatin("۱۱۶۲")).toBe("1162");
    expect(digitsArabicToLatin("۰۱۲۳۴۵۶۷۸۹")).toBe("0123456789");
  });
  it("يترك الحروف الأخرى كما هي", () => {
    expect(digitsArabicToLatin("د.ع ١٠٠")).toBe("د.ع 100");
  });
  it("يتعامل مع الفارغ", () => {
    expect(digitsArabicToLatin("")).toBe("");
  });
});

describe("stripCurrencySymbols", () => {
  // ملاحظة: هذه الدالّة تُزيل الرمز فقط ولا تشذّب الفراغات — التشذيب يحصل في normalizeNumberInput.
  it("يزيل د.ع بأشكاله", () => {
    expect(stripCurrencySymbols("1000 د.ع").trim()).toBe("1000");
    expect(stripCurrencySymbols("1000د.ع.").trim()).toBe("1000");
    expect(stripCurrencySymbols("1000 دينار").trim()).toBe("1000");
  });
  it("يزيل IQD/USD/$", () => {
    expect(stripCurrencySymbols("1000 IQD").trim()).toBe("1000");
    expect(stripCurrencySymbols("$100").trim()).toBe("100");
  });
  it("لا يمسّ الأرقام", () => {
    expect(stripCurrencySymbols("1234.56")).toBe("1234.56");
  });
});

describe("normalizeNumberInput — قلب الحماية", () => {
  it("يمرّر القيم النظيفة كما هي", () => {
    expect(normalizeNumberInput("1162.5").normalized).toBe("1162.5");
    expect(normalizeNumberInput("100").normalized).toBe("100");
    expect(normalizeNumberInput("0").normalized).toBe("0");
    expect(normalizeNumberInput("").normalized).toBe("");
  });

  it("يعالج حادثة SINARLINE (١١٦٢٫٥) عربياً", () => {
    const r = normalizeNumberInput("١١٦٢٫٥");
    expect(r.normalized).toBe("1162.5");
    expect(r.warnings).toContain("digits_converted");
    expect(r.warnings).toContain("arabic_decimal_normalized");
    expect(r.ambiguous).toBe(false);
  });

  it("يعالج «١,٢٣٤٫٥٦» — مزيج ألوف أمريكية + عشريّ عربيّ", () => {
    const r = normalizeNumberInput("١,٢٣٤٫٥٦");
    expect(r.normalized).toBe("1234.56");
    expect(r.ambiguous).toBe(false);
  });

  it("يعالج نمط أمريكي «1,162.50»", () => {
    const r = normalizeNumberInput("1,162.50");
    expect(r.normalized).toBe("1162.50");
    expect(r.ambiguous).toBe(false);
  });

  it("يعالج نمط أوروبي صريح «1.162,50»", () => {
    const r = normalizeNumberInput("1.162,50");
    expect(r.normalized).toBe("1162.50");
    expect(r.warnings).toContain("european_pattern");
    expect(r.ambiguous).toBe(false);
  });

  it("يزيل رمز العملة قبل التطبيع", () => {
    expect(normalizeNumberInput("1000 د.ع").normalized).toBe("1000");
    expect(normalizeNumberInput("١٦١٦٢ د.ع").normalized).toBe("16162");
  });

  it("يعالج الفاصلة العربية «،» بحذر", () => {
    // «1،5» بنمط الفاصلة العربية الشائع كعشريّ ⇒ يُعامَل كأمريكي «1,5» ⇒ يُقرأ عشريّاً (رقمان أو أقل).
    expect(normalizeNumberInput("1،5").normalized).toBe("1.5");
  });

  it("يعلّم «1.500» كملتبس (نقطة واحدة + ٣ خانات بعدها)", () => {
    const r = normalizeNumberInput("1.500");
    // نتعامل معه كعشريّ (النمط الإنكليزيّ)، لكن نعلّم اللبس.
    expect(r.normalized).toBe("1.500");
    expect(r.ambiguous).toBe(true);
    expect(r.warnings).toContain("ambiguous_1500_pattern");
  });

  it("يعامل «1.162.500» كنمط أوروبيّ ألوف (نقطتان أو أكثر)", () => {
    const r = normalizeNumberInput("1.162.500");
    expect(r.normalized).toBe("1162500");
    expect(r.warnings).toContain("multi_dot_treated_as_thousands");
  });

  it("يعامل «1,234» كألوف (٣ خانات بعد فاصلة واحدة)", () => {
    expect(normalizeNumberInput("1,234").normalized).toBe("1234");
  });

  it("يعامل «12,34» كعشريّ أوروبي مبسّط (خانتان بعد فاصلة)", () => {
    expect(normalizeNumberInput("12,34").normalized).toBe("12.34");
  });

  it("يعلّم «1,2,3» كملتبس", () => {
    const r = normalizeNumberInput("1,2,3");
    expect(r.ambiguous).toBe(true);
  });

  it("يزيل الفراغات غير العاديّة (NBSP)", () => {
    expect(normalizeNumberInput("1 000").normalized).toBe("1000");
  });

  it("يتعامل مع الإشارة السالبة", () => {
    expect(normalizeNumberInput("-١٦٢").normalized).toBe("-162");
    expect(normalizeNumberInput("-1,000.5").normalized).toBe("-1000.5");
  });

  it("يحذف الأصفار الأمامية", () => {
    expect(normalizeNumberInput("007").normalized).toBe("7");
    expect(normalizeNumberInput("0.5").normalized).toBe("0.5"); // يحتفظ بالصفر قبل النقطة
  });

  it("يتعامل مع الفارغ وغير الرقمي", () => {
    expect(normalizeNumberInput("").normalized).toBe("");
    expect(normalizeNumberInput("abc").normalized).toBe("");
    expect(normalizeNumberInput("---").normalized).toBe("");
  });
});

describe("toNormalizedNumber (وجه مبسَّط)", () => {
  it("يعيد النصّ فقط", () => {
    expect(toNormalizedNumber("١١٦٢٫٥")).toBe("1162.5");
    expect(toNormalizedNumber("1,000.50")).toBe("1000.50");
    expect(toNormalizedNumber("")).toBe("");
  });
});
