// تحقّق معامل التحويل (تدقيق ١٧/٧) — دالة نقيّة بلا قاعدة بيانات.
import { describe, expect, it } from "vitest";
import { assertValidUnitFactors } from "../catalog/unitFactors";

describe("assertValidUnitFactors (تدقيق ١٧/٧)", () => {
  it("يقبل: أساس معامله ١ + وحدات غير أساس بأعداد صحيحة > ١", () => {
    expect(() =>
      assertValidUnitFactors([
        { unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
        { unitName: "درزن", conversionFactor: "12", isBaseUnit: false },
        { unitName: "كرتون", conversionFactor: "144", isBaseUnit: false },
      ]),
    ).not.toThrow();
  });

  it("يرفض وحدة غير أساس بمعامل ١ (درزن يبيع ١٢ ويخصم ١) — الخطأ الجوهريّ", () => {
    expect(() =>
      assertValidUnitFactors([
        { unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
        { unitName: "درزن", conversionFactor: "1", isBaseUnit: false },
      ]),
    ).toThrow(/أكبر من ١/);
  });

  it("يرفض وحدة أساس بمعامل غير ١", () => {
    expect(() =>
      assertValidUnitFactors([{ unitName: "قطعة", conversionFactor: "5", isBaseUnit: true }]),
    ).toThrow(/معاملها ١/);
  });

  it("يرفض معاملاً غير صحيحٍ موجب (صفر/سالب/عشري/نصّ/فارغ)", () => {
    for (const bad of ["0", "-2", "1.5", "abc", ""]) {
      expect(() =>
        assertValidUnitFactors([{ unitName: "و", conversionFactor: bad, isBaseUnit: false }]),
      ).toThrow(/عدداً صحيحاً موجباً/);
    }
  });
});
