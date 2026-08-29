import { describe, it, expect } from "vitest";
import { computeDeliveryFee, type DeliveryPricingRuleInput } from "./deliveryPricing";

const mkRule = (over: Partial<DeliveryPricingRuleInput> = {}): DeliveryPricingRuleInput => ({
  id: 1,
  ruleType: "FLAT_FEE",
  baseFee: "5000",
  isActive: true,
  ...over,
});

describe("computeDeliveryFee — FLAT_FEE", () => {
  it("baseFee فقط بلا سياق ⇒ يعيد baseFee", () => {
    const q = computeDeliveryFee([mkRule({ baseFee: "5000" })]);
    expect(q?.fee).toBe(5000);
    expect(q?.ruleId).toBe(1);
    expect(q?.breakdown.baseFee).toBe(5000);
  });

  it("distanceKm يُتَجاهل مع FLAT_FEE (النوع لا يستعمله)", () => {
    const q = computeDeliveryFee([mkRule({ baseFee: "5000" })], { distanceKm: 10 });
    expect(q?.fee).toBe(5000);
    expect(q?.breakdown.distanceFee).toBeUndefined();
  });

  it("baseFee كنصّ (من MySQL decimal) ⇒ يُحلَّل رقماً", () => {
    const q = computeDeliveryFee([mkRule({ baseFee: "8000.00" })]);
    expect(q?.fee).toBe(8000);
  });
});

describe("computeDeliveryFee — PER_KM", () => {
  it("baseFee + (perKmFee × distanceKm)", () => {
    const q = computeDeliveryFee(
      [mkRule({ ruleType: "PER_KM", baseFee: "2000", perKmFee: "500" })],
      { distanceKm: 10 },
    );
    expect(q?.fee).toBe(7000);
    expect(q?.breakdown.baseFee).toBe(2000);
    expect(q?.breakdown.distanceFee).toBe(5000);
  });

  it("distanceKm غائب ⇒ baseFee فقط (يُبقي السلوك آمناً)", () => {
    const q = computeDeliveryFee(
      [mkRule({ ruleType: "PER_KM", baseFee: "2000", perKmFee: "500" })],
      { distanceKm: null },
    );
    expect(q?.fee).toBe(2000);
    expect(q?.breakdown.distanceFee).toBeUndefined();
  });

  it("distanceKm=0 ⇒ لا يُضاف الرسم المسافيّ", () => {
    const q = computeDeliveryFee(
      [mkRule({ ruleType: "PER_KM", baseFee: "2000", perKmFee: "500" })],
      { distanceKm: 0 },
    );
    expect(q?.fee).toBe(2000);
  });
});

describe("computeDeliveryFee — WEIGHT", () => {
  it("baseFee + (perKgFee × weightKg)", () => {
    const q = computeDeliveryFee(
      [mkRule({ ruleType: "WEIGHT", baseFee: "3000", perKgFee: "100" })],
      { weightKg: 5 },
    );
    expect(q?.fee).toBe(3500);
    expect(q?.breakdown.weightFee).toBe(500);
  });
});

describe("computeDeliveryFee — minFee/maxFee", () => {
  it("minFee يرفع الأجرةَ الحاصلَ حسابها للحدّ الأدنى", () => {
    const q = computeDeliveryFee([mkRule({ baseFee: "1000", minFee: "3000" })]);
    expect(q?.fee).toBe(3000);
    expect(q?.breakdown.minApplied).toBe(true);
  });

  it("maxFee يقلّص الأجرة العالية للسقف", () => {
    const q = computeDeliveryFee(
      [mkRule({ ruleType: "PER_KM", baseFee: "1000", perKmFee: "5000", maxFee: "10000" })],
      { distanceKm: 100 }, // ينتج 501000 قبل السقف
    );
    expect(q?.fee).toBe(10000);
    expect(q?.breakdown.maxApplied).toBe(true);
  });

  it("min < حاصل < max ⇒ لا تطبيقٌ لأيٍّ منهما", () => {
    const q = computeDeliveryFee([mkRule({ baseFee: "5000", minFee: "1000", maxFee: "10000" })]);
    expect(q?.fee).toBe(5000);
    expect(q?.breakdown.minApplied).toBeUndefined();
    expect(q?.breakdown.maxApplied).toBeUndefined();
  });
});

describe("computeDeliveryFee — عدم وجود قواعد نشطة", () => {
  it("قائمةٌ فارغة ⇒ null", () => {
    expect(computeDeliveryFee([])).toBe(null);
  });

  it("كلّ القواعد غير نشطة ⇒ null", () => {
    const q = computeDeliveryFee([mkRule({ isActive: false })]);
    expect(q).toBe(null);
  });

  it("قواعدُ متعدّدة: يختار أوّلَ قاعدةٍ نشطة (تصميم قاعدةٍ لكلّ نمط)", () => {
    const q = computeDeliveryFee([
      mkRule({ id: 1, isActive: false, baseFee: "1000" }),
      mkRule({ id: 2, isActive: true, baseFee: "3000" }),
      mkRule({ id: 3, isActive: true, baseFee: "9999" }),
    ]);
    expect(q?.ruleId).toBe(2);
    expect(q?.fee).toBe(3000);
  });
});
