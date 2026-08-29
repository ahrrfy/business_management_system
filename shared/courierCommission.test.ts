import { describe, it, expect } from "vitest";
import { computeCourierCommission, type CourierCommissionRuleInput } from "./courierCommission";

const mkRule = (over: Partial<CourierCommissionRuleInput> = {}): CourierCommissionRuleInput => ({
  id: 1,
  ruleType: "FLAT_PER_DELIVERY",
  flatAmount: "2000",
  isActive: true,
  ...over,
});

describe("computeCourierCommission — FLAT_PER_DELIVERY", () => {
  it("flatAmount ثابتٌ لكلّ إرساليّة (سياق مُهمَل)", () => {
    const q = computeCourierCommission([mkRule({ flatAmount: "2000" })], { deliveryFee: 5000, orderTotal: 100000 });
    expect(q?.commission).toBe(2000);
    expect(q?.breakdown.flatPart).toBe(2000);
    expect(q?.breakdown.percentPart).toBeUndefined();
  });
});

describe("computeCourierCommission — PERCENT_OF_FEE", () => {
  it("20٪ من أجرة توصيل 5000 ⇒ 1000", () => {
    const q = computeCourierCommission(
      [mkRule({ ruleType: "PERCENT_OF_FEE", flatAmount: null, percentValue: "20" })],
      { deliveryFee: 5000 },
    );
    expect(q?.commission).toBe(1000);
    expect(q?.breakdown.percentPart).toBe(1000);
  });

  it("أجرة صفر ⇒ عمولة صفر (لا نقسم على غياب)", () => {
    const q = computeCourierCommission(
      [mkRule({ ruleType: "PERCENT_OF_FEE", flatAmount: null, percentValue: "20" })],
      { deliveryFee: 0 },
    );
    expect(q?.commission).toBe(0);
  });
});

describe("computeCourierCommission — PERCENT_OF_ORDER", () => {
  it("3٪ من طلب 100,000 ⇒ 3,000", () => {
    const q = computeCourierCommission(
      [mkRule({ ruleType: "PERCENT_OF_ORDER", flatAmount: null, percentValue: "3" })],
      { orderTotal: 100000 },
    );
    expect(q?.commission).toBe(3000);
    expect(q?.breakdown.percentPart).toBe(3000);
  });
});

describe("computeCourierCommission — HYBRID (ثابت + نسبة)", () => {
  it("1000 ثابت + 10٪ من أجرة 5000 = 1500", () => {
    const q = computeCourierCommission(
      [mkRule({ ruleType: "HYBRID", flatAmount: "1000", percentValue: "10" })],
      { deliveryFee: 5000 },
    );
    expect(q?.commission).toBe(1500);
    expect(q?.breakdown.flatPart).toBe(1000);
    expect(q?.breakdown.percentPart).toBe(500);
  });
});

describe("computeCourierCommission — minGuarantee/maxCap", () => {
  it("minGuarantee يرفع العمولة الصغيرة للحدّ الأدنى المضمون", () => {
    const q = computeCourierCommission(
      [mkRule({ ruleType: "PERCENT_OF_FEE", flatAmount: null, percentValue: "10", minGuarantee: "3000" })],
      { deliveryFee: 5000 }, // ينتج 500 فقط قبل الحدّ الأدنى
    );
    expect(q?.commission).toBe(3000);
    expect(q?.breakdown.minApplied).toBe(true);
  });

  it("maxCap يقلّص العمولة الكبيرة", () => {
    const q = computeCourierCommission(
      [mkRule({ ruleType: "PERCENT_OF_ORDER", flatAmount: null, percentValue: "10", maxCap: "5000" })],
      { orderTotal: 1000000 }, // ينتج 100,000 قبل السقف
    );
    expect(q?.commission).toBe(5000);
    expect(q?.breakdown.maxApplied).toBe(true);
  });
});

describe("computeCourierCommission — سيناريوهات الحافّة", () => {
  it("قائمةٌ فارغة ⇒ null", () => {
    expect(computeCourierCommission([])).toBe(null);
  });

  it("كلّ القواعد غير نشطة ⇒ null", () => {
    expect(computeCourierCommission([mkRule({ isActive: false })])).toBe(null);
  });

  it("نوعٌ مجهول ⇒ null (لا احتساب صامت خاطئ)", () => {
    const q = computeCourierCommission([mkRule({ ruleType: "MYSTERY_TYPE" })]);
    expect(q).toBe(null);
  });

  it("سياق فارغ لـPERCENT_OF_FEE ⇒ 0 (لا رمي)", () => {
    const q = computeCourierCommission(
      [mkRule({ ruleType: "PERCENT_OF_FEE", flatAmount: null, percentValue: "20" })],
      {},
    );
    expect(q?.commission).toBe(0);
  });

  it("قواعدُ متعدّدة: يختار أوّلَ قاعدةٍ نشطة", () => {
    const q = computeCourierCommission([
      mkRule({ id: 1, isActive: false }),
      mkRule({ id: 2, isActive: true, flatAmount: "3000" }),
      mkRule({ id: 3, isActive: true, flatAmount: "9999" }),
    ]);
    expect(q?.ruleId).toBe(2);
    expect(q?.commission).toBe(3000);
  });
});
