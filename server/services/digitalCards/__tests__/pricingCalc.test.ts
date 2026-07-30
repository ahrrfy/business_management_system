import { describe, expect, it } from "vitest";
import { computeSellPrice, validateMinimumMargin } from "../pricingCalc";

describe("computeSellPrice", () => {
  it("FIXED_MARGIN: يضيف هامشاً ثابتاً ثم يقرّب لأعلى", () => {
    const r = computeSellPrice({
      pricingMode: "FIXED_MARGIN",
      providerShare: "9500",
      fixedMargin: "500",
      roundingStep: "250",
    });
    expect(r.sellPrice).toBe("10000.00");
    expect(r.marginAmount).toBe("500.00");
  });

  it("FIXED_MARGIN: يقرّب لأعلى إلى مضاعف الخطوة ويرفع الهامش تبعاً", () => {
    const r = computeSellPrice({
      pricingMode: "FIXED_MARGIN",
      providerShare: "9600",
      fixedMargin: "300",
      roundingStep: "250",
    });
    // raw = 9900 → ceil(9900/250)=40 → 10000
    expect(r.sellPrice).toBe("10000.00");
    expect(r.marginAmount).toBe("400.00");
  });

  it("PERCENT_MARGIN: نسبة على حصة المزوّد", () => {
    const r = computeSellPrice({
      pricingMode: "PERCENT_MARGIN",
      providerShare: "10000",
      marginPercent: "5",
      roundingStep: "250",
    });
    expect(r.sellPrice).toBe("10500.00");
    expect(r.marginAmount).toBe("500.00");
  });

  it("FIXED_PLUS_PERCENT: ثابت + نسبة", () => {
    const r = computeSellPrice({
      pricingMode: "FIXED_PLUS_PERCENT",
      providerShare: "10000",
      fixedMargin: "250",
      marginPercent: "2",
      roundingStep: "250",
    });
    // raw = 10000 + 250 + 200 = 10450 → ceil → 10500
    expect(r.sellPrice).toBe("10500.00");
    expect(r.marginAmount).toBe("500.00");
  });

  it("FIXED_SELL_PRICE: يتجاهل الهوامش ويستعمل السعر الإداري", () => {
    const r = computeSellPrice({
      pricingMode: "FIXED_SELL_PRICE",
      providerShare: "9250",
      fixedMargin: "9999",
      marginPercent: "99",
      fixedSellPrice: "10000",
      roundingStep: "250",
    });
    expect(r.sellPrice).toBe("10000.00");
    expect(r.marginAmount).toBe("750.00");
  });

  it("خطوة تقريب صفر أو مفقودة لا تكسر الحساب", () => {
    const r = computeSellPrice({
      pricingMode: "FIXED_MARGIN",
      providerShare: "9333.33",
      fixedMargin: "100",
      roundingStep: "0",
    });
    expect(r.sellPrice).toBe("9433.33");
    expect(r.marginAmount).toBe("100.00");
  });

  it("الثابت sellPrice - providerShare = marginAmount يصمد في كل الأنماط", () => {
    const cases = [
      { pricingMode: "FIXED_MARGIN" as const, providerShare: "7777.77", fixedMargin: "333.33" },
      { pricingMode: "PERCENT_MARGIN" as const, providerShare: "1234.56", marginPercent: "7.5" },
      {
        pricingMode: "FIXED_PLUS_PERCENT" as const,
        providerShare: "4321.99",
        fixedMargin: "111.11",
        marginPercent: "3.33",
      },
      { pricingMode: "FIXED_SELL_PRICE" as const, providerShare: "500.55", fixedSellPrice: "1000" },
    ];
    for (const c of cases) {
      const r = computeSellPrice({ ...c, roundingStep: "250" });
      const diff = Number(r.sellPrice) - Number(r.providerShare);
      expect(Math.abs(diff - Number(r.marginAmount))).toBeLessThan(0.005);
    }
  });

  it("قيمة كبيرة جداً تبقى دقيقة بلا انحراف عائم", () => {
    const r = computeSellPrice({
      pricingMode: "FIXED_MARGIN",
      providerShare: "99999999.99",
      fixedMargin: "0.01",
      roundingStep: "0",
    });
    expect(r.sellPrice).toBe("100000000.00");
  });

  it("نمط غير معروف يرمي خطأً", () => {
    expect(() =>
      // @ts-expect-error اختبار حارس وقت التشغيل
      computeSellPrice({ pricingMode: "NOPE", providerShare: "100" })
    ).toThrow();
  });
});

describe("validateMinimumMargin", () => {
  it("يمرّ عند غياب الحدّ الأدنى", () => {
    const r = computeSellPrice({ pricingMode: "FIXED_MARGIN", providerShare: "100", fixedMargin: "0", roundingStep: "0" });
    expect(validateMinimumMargin(r, null)).toBe(true);
  });

  it("يرفض هامشاً أقلّ من الحدّ الأدنى", () => {
    const r = computeSellPrice({
      pricingMode: "FIXED_MARGIN",
      providerShare: "10000",
      fixedMargin: "100",
      roundingStep: "0",
    });
    expect(validateMinimumMargin(r, "250")).toBe(false);
    expect(validateMinimumMargin(r, "100")).toBe(true);
  });
});
