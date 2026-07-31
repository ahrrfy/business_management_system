// اختبارات «المثال التعليمي» — تُثبت أنّ المثال المعروض للمستخدم يطابق محرّك الخادم
// (server/services/commissions/engine.ts → applyPlanTier). أي انحراف هنا = مثالٌ يكذب.
import { describe, expect, it } from "vitest";
import { computeExample, pickTierRank, sortTiers, type ExampleTier } from "./example";

const T = (threshold: string, ratePct: string, fixedBonus = "0"): ExampleTier => ({ threshold, ratePct, fixedBonus });

describe("commissions/example", () => {
  it("يرتّب المستويات تصاعدياً بالحدّ (نظير ORDER BY threshold ASC)", () => {
    const sorted = sortTiers([T("100", "2"), T("70", "1"), T("130", "3")]);
    expect(sorted.map((t) => t.threshold)).toEqual(["70", "100", "130"]);
  });

  it("يختار آخر مستوى حدُّه ≤ المقياس", () => {
    const sorted = sortTiers([T("70", "1"), T("100", "2"), T("130", "3")]);
    expect(pickTierRank(sorted, "69.99")).toBeNull();
    expect(pickTierRank(sorted, "70")).toBe(1); // المساواة تُبلغ المستوى
    expect(pickTierRank(sorted, "99.99")).toBe(1);
    expect(pickTierRank(sorted, "100")).toBe(2);
    expect(pickTierRank(sorted, "500")).toBe(3);
    expect(pickTierRank(sorted, null)).toBeNull();
  });

  it("نمط نسبة تحقيق الهدف: النسبة على كامل المبلغ + المكافأة الثابتة", () => {
    const r = computeExample({
      tierMode: "TARGET_PCT",
      tiers: [T("70", "1"), T("100", "2", "50000")],
      sales: "10000000",
      target: "10000000",
    });
    expect(r.achievementPct).toBe("100.00");
    expect(r.tierRank).toBe(2);
    expect(r.ratePart).toBe("200000.00"); // ١٠م × ٢٪ — على الكامل لا على الزائد عن الحدّ
    expect(r.fixedBonus).toBe("50000.00");
    expect(r.commission).toBe("250000.00");
  });

  it("دون أدنى حدّ ⇒ صفر عمولة", () => {
    const r = computeExample({
      tierMode: "TARGET_PCT",
      tiers: [T("70", "1")],
      sales: "6000000",
      target: "10000000",
    });
    expect(r.achievementPct).toBe("60.00");
    expect(r.tierRank).toBeNull();
    expect(r.commission).toBe("0.00");
  });

  it("خطة نسبة التحقيق بلا هدف ⇒ صفر + علَم noTarget (نظير detail.noTarget)", () => {
    const r = computeExample({
      tierMode: "TARGET_PCT",
      tiers: [T("70", "1")],
      sales: "9000000",
      target: "",
    });
    expect(r.noTarget).toBe(true);
    expect(r.achievementPct).toBeNull();
    expect(r.tierRank).toBeNull();
    expect(r.commission).toBe("0.00");
  });

  it("نمط مبلغ المبيعات: المقياس هو المبلغ نفسه ولا يحتاج هدفاً", () => {
    const r = computeExample({
      tierMode: "AMOUNT_SLAB",
      tiers: [T("5000000", "1"), T("15000000", "2.5")],
      sales: "15000000",
      target: "",
    });
    expect(r.noTarget).toBe(false);
    expect(r.tierRank).toBe(2);
    expect(r.ratePart).toBe("375000.00");
    expect(r.commission).toBe("375000.00");
  });

  it("صافي مبيعات سالب يُعامَل صفراً (نظير effectiveBase = max(0, gross))", () => {
    const r = computeExample({
      tierMode: "AMOUNT_SLAB",
      tiers: [T("0", "2")],
      sales: "-300000",
      target: "",
    });
    expect(r.base).toBe("0.00");
    expect(r.commission).toBe("0.00"); // حدّ 0 مُبلَغ، لكن 0 × 2٪ = 0
  });

  it("التقريب HALF_UP على منزلتين قبل جمع المكافأة (نظير round2 في المحرّك)", () => {
    const r = computeExample({
      tierMode: "AMOUNT_SLAB",
      tiers: [T("0", "0.3333")],
      sales: "1000",
      target: "",
    });
    expect(r.ratePart).toBe("3.33"); // 3.333 → 3.33
    expect(r.commission).toBe("3.33");
  });

  it("يتجاهل المستويات غير المكتملة (حقل فارغ أثناء الكتابة) بلا انهيار", () => {
    const r = computeExample({
      tierMode: "AMOUNT_SLAB",
      tiers: [T("", ""), T("1000000", "1")],
      sales: "2000000",
      target: "",
    });
    expect(r.tierRank).toBe(1);
    expect(r.commission).toBe("20000.00");
  });
});
