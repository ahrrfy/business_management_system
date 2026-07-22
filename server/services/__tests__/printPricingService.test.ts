// اختبارات نواة تسعير الطباعة الرقمية — الدالّة النقيّة computePrintEstimate (بلا DB).
// تغطّي §٥ (١٠٠ نسخة A4 ملوّن وجهين + تغليف ⇒ أوجه=٢٠٠؛ فلكس ٣م×١م ⇒ مساحة=٣م²) + الرتابة
// (وضع مباشر/هامش، ورق مميّز لكل وجه/ورقة، رسم التجهيز، تقريب decimal، الحاصرات).
import { describe, expect, it } from "vitest";
import { computePrintEstimate, type ResolvedEstimateConfig } from "../printPricing/compute";
import type { PrintEstimateInput } from "@shared/printPricing";

const baseSettings = { pricingMode: "MARGIN" as const, defaultMarginPercent: "0", setupFee: "0" };

function cfg(over: Partial<ResolvedEstimateConfig> = {}): ResolvedEstimateConfig {
  return { settings: { ...baseSettings }, finishings: [], ...over };
}

describe("computePrintEstimate — صغير المقاس (بالوجه)", () => {
  it("§٥: ١٠٠ نسخة A4 ملوّن وجهين + تغليف ⇒ أوجه=٢٠٠ وكلفة وسعر صحيحة", () => {
    const input: PrintEstimateInput = {
      category: "SMALL",
      paperSize: "A4",
      colorMode: "COLOR",
      sides: 2,
      copies: 100,
      pagesPerCopy: 1,
      finishingIds: [1],
    };
    const res = computePrintEstimate(input, cfg({
      facePrice: "50",
      finishings: [{ name: "تغليف لامينيت", unit: "PER_COPY", price: "500" }],
    }));

    expect(res.faces).toBe(200); // ١٠٠ × ١ × ٢
    expect(res.sheets).toBe(100);
    expect(res.units).toBe(100);
    // طباعة: ٢٠٠ × ٥٠ = ١٠٬٠٠٠ ؛ تغليف: ٥٠٠ × ١٠٠ = ٥٠٬٠٠٠ ؛ الإجمالي ٦٠٬٠٠٠
    const print = res.lines.find((l) => l.key === "print");
    expect(print?.amount).toBe("10000.00");
    expect(res.lines.find((l) => l.key === "finishing:0")?.amount).toBe("50000.00");
    expect(res.totalCost).toBe("60000.00");
    // هامش صفر ⇒ السعر = الكلفة، سعر الوحدة = ٦٠٠
    expect(res.suggestedPrice).toBe("60000.00");
    expect(res.unitPrice).toBe("600.00");
  });

  it("هامش ٢٥٪ يُطبَّق على الكلفة كاملةً", () => {
    const input: PrintEstimateInput = {
      category: "SMALL", paperSize: "A4", colorMode: "COLOR", sides: 2, copies: 100, pagesPerCopy: 1,
      finishingIds: [1], marginPercentOverride: "25",
    };
    const res = computePrintEstimate(input, cfg({
      facePrice: "50",
      finishings: [{ name: "تغليف", unit: "PER_COPY", price: "500" }],
    }));
    // ٦٠٬٠٠٠ × ١٫٢٥ = ٧٥٬٠٠٠ ؛ الوحدة ٧٥٠
    expect(res.marginPercent).toBe("25");
    expect(res.suggestedPrice).toBe("75000.00");
    expect(res.unitPrice).toBe("750.00");
  });

  it("ورق مميّز لكل ورقة: يُحسَب بعدد الأوراق لا الأوجه", () => {
    const input: PrintEstimateInput = {
      category: "SMALL", paperSize: "A4", colorMode: "BW", sides: 2, copies: 10, pagesPerCopy: 3,
      paperUpchargeId: 5,
    };
    const res = computePrintEstimate(input, cfg({
      facePrice: "20",
      paperUpcharge: { name: "كوشيه", unit: "PER_SHEET", upcharge: "100" },
    }));
    // أوراق = ١٠ × ٣ = ٣٠ ؛ أوجه = ٦٠. الورق لكل ورقة: ١٠٠ × ٣٠ = ٣٬٠٠٠
    expect(res.sheets).toBe(30);
    expect(res.faces).toBe(60);
    expect(res.lines.find((l) => l.key === "paper-upcharge")?.amount).toBe("3000.00");
    // طباعة ٦٠ × ٢٠ = ١٬٢٠٠ ؛ الإجمالي ٤٬٢٠٠
    expect(res.totalCost).toBe("4200.00");
  });

  it("ورق مميّز لكل وجه: يُحسَب بعدد الأوجه", () => {
    const res = computePrintEstimate(
      { category: "SMALL", paperSize: "A3", colorMode: "COLOR", sides: 2, copies: 10, pagesPerCopy: 1, paperUpchargeId: 1 },
      cfg({ facePrice: "100", paperUpcharge: { name: "لاصق", unit: "PER_FACE", upcharge: "30" } }),
    );
    // أوجه = ٢٠ ؛ الورق لكل وجه: ٣٠ × ٢٠ = ٦٠٠
    expect(res.lines.find((l) => l.key === "paper-upcharge")?.amount).toBe("600.00");
  });

  it("رسم التجهيز يُضاف افتراضياً ويُلغى عند applySetupFee=false", () => {
    const base: PrintEstimateInput = { category: "SMALL", paperSize: "A4", colorMode: "BW", sides: 1, copies: 1, pagesPerCopy: 1 };
    const withFee = computePrintEstimate(base, cfg({ facePrice: "100", settings: { ...baseSettings, setupFee: "5000" } }));
    expect(withFee.lines.find((l) => l.key === "setup")?.amount).toBe("5000.00");
    expect(withFee.totalCost).toBe("5100.00");

    const noFee = computePrintEstimate({ ...base, applySetupFee: false }, cfg({ facePrice: "100", settings: { ...baseSettings, setupFee: "5000" } }));
    expect(noFee.lines.find((l) => l.key === "setup")).toBeUndefined();
    expect(noFee.totalCost).toBe("100.00");
  });

  it("خيار تشطيب لكل شغلة يُحسَب مرّة واحدة", () => {
    const res = computePrintEstimate(
      { category: "SMALL", paperSize: "A4", colorMode: "BW", sides: 1, copies: 50, pagesPerCopy: 1, finishingIds: [9] },
      cfg({ facePrice: "10", finishings: [{ name: "تجليد حلزونيّ", unit: "PER_JOB", price: "2000" }] }),
    );
    // طباعة ٥٠ × ١٠ = ٥٠٠ ؛ تجليد للشغلة ٢٬٠٠٠ (لا × ٥٠) ؛ الإجمالي ٢٬٥٠٠
    expect(res.lines.find((l) => l.key === "finishing:0")?.amount).toBe("2000.00");
    expect(res.totalCost).toBe("2500.00");
  });

  it("يرمي إن لم يوجد سعر وجه مضبوط للمقاس/النمط", () => {
    expect(() =>
      computePrintEstimate(
        { category: "SMALL", paperSize: "A4", colorMode: "COLOR", sides: 1, copies: 1, pagesPerCopy: 1 },
        cfg({ facePrice: undefined }),
      ),
    ).toThrow(/سعر وجه/);
  });
});

describe("computePrintEstimate — عريض (فلكس، بالمتر²)", () => {
  it("§٥: فلكس ٣م × ١م ⇒ المساحة = ٣م² وكلفة = المساحة × سعر المتر", () => {
    const input: PrintEstimateInput = { category: "WIDE", mediaId: 1, width: "3", height: "1", quantity: 1 };
    const res = computePrintEstimate(input, cfg({ media: { name: "فلكس", pricePerSqm: "10000" } }));
    expect(res.areaSqm).toBe("3");
    expect(res.units).toBe(1);
    expect(res.lines.find((l) => l.key === "print")?.amount).toBe("30000.00");
    expect(res.totalCost).toBe("30000.00");
    expect(res.unitPrice).toBe("30000.00");
  });

  it("المساحة تضرب في الكمية، والتشطيب لكل نسخة (× الكمية)", () => {
    const input: PrintEstimateInput = {
      category: "WIDE", mediaId: 1, width: "2", height: "1.5", quantity: 4, finishingIds: [3],
    };
    const res = computePrintEstimate(input, cfg({
      media: { name: "فينيل", pricePerSqm: "5000" },
      finishings: [{ name: "عيون تثبيت", unit: "PER_COPY", price: "1000" }],
    }));
    // مساحة = ٢ × ١٫٥ × ٤ = ١٢ م² ؛ طباعة = ١٢ × ٥٬٠٠٠ = ٦٠٬٠٠٠ ؛ تشطيب = ١٬٠٠٠ × ٤ = ٤٬٠٠٠
    expect(res.areaSqm).toBe("12");
    expect(res.lines.find((l) => l.key === "print")?.amount).toBe("60000.00");
    expect(res.lines.find((l) => l.key === "finishing:0")?.amount).toBe("4000.00");
    expect(res.totalCost).toBe("64000.00");
    expect(res.unitPrice).toBe("16000.00"); // ٦٤٬٠٠٠ ÷ ٤
  });

  it("مساحة كسرية بتقريب decimal صحيح", () => {
    // ٠٫٣٣ × ٠٫٣٣ = ٠٫١٠٨٩ م² × ٣٠٬٠٠٠ = ٣٬٢٦٧
    const res = computePrintEstimate(
      { category: "WIDE", mediaId: 1, width: "0.33", height: "0.33", quantity: 1 },
      cfg({ media: { name: "استيكر", pricePerSqm: "30000" } }),
    );
    expect(res.areaSqm).toBe("0.109"); // معروضة ٣ منازل
    expect(res.lines.find((l) => l.key === "print")?.amount).toBe("3267.00"); // بالدقّة الكاملة ثم round2
  });

  it("يرمي إن لم يُختَر وسيط صالح", () => {
    expect(() =>
      computePrintEstimate({ category: "WIDE", mediaId: 1, width: "1", height: "1", quantity: 1 }, cfg({ media: undefined })),
    ).toThrow(/وسيط/);
  });
});

describe("computePrintEstimate — وضع التسعير", () => {
  const input: PrintEstimateInput = {
    category: "SMALL", paperSize: "A4", colorMode: "BW", sides: 1, copies: 10, pagesPerCopy: 1,
    marginPercentOverride: "50",
  };

  it("الوضع المباشر (DIRECT): السعر = الكلفة ويتجاهل تجاوز الهامش", () => {
    const res = computePrintEstimate(input, cfg({ facePrice: "100", settings: { ...baseSettings, pricingMode: "DIRECT" } }));
    expect(res.totalCost).toBe("1000.00");
    expect(res.marginPercent).toBe("0");
    expect(res.suggestedPrice).toBe("1000.00");
  });

  it("وضع الهامش يستعمل التجاوز الحيّ حين يُمرَّر", () => {
    const res = computePrintEstimate(input, cfg({ facePrice: "100" }));
    // ١٬٠٠٠ × ١٫٥ = ١٬٥٠٠
    expect(res.suggestedPrice).toBe("1500.00");
    expect(res.marginPercent).toBe("50");
  });

  it("وضع الهامش يسقط للنسبة الافتراضية حين لا تجاوز", () => {
    const res = computePrintEstimate(
      { category: "SMALL", paperSize: "A4", colorMode: "BW", sides: 1, copies: 10, pagesPerCopy: 1 },
      cfg({ facePrice: "100", settings: { ...baseSettings, defaultMarginPercent: "10" } }),
    );
    expect(res.suggestedPrice).toBe("1100.00"); // ١٬٠٠٠ × ١٫١
    expect(res.marginPercent).toBe("10");
  });
});
