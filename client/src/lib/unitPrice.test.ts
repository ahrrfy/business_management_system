import { describe, expect, it } from "vitest";
import { toUnitPriceStr } from "./money";

/**
 * بلاغ المالك (١٧/٨/٢٦): سعر الشراء الدولاريّ 3.4566 كان يُرسَل 3.46 لأنّ الشاشات كانت تُسلسل
 * كلّ سعرٍ بـ`round2(...).toFixed(2)`. هذه الحزمة تُثبت أنّ التسلسل صار **بدقّة العملة** وأنّه
 * بلا فقدٍ لما يقبله الحقل، وأنّ الدينار بقي على منزلتَيه (عمود decimal(15,2)).
 */
describe("toUnitPriceStr — تسلسل سعر الوحدة بدقّة عملته", () => {
  it("الدولار: يحفظ أربع منازل بلا قصّ (نواة البلاغ)", () => {
    expect(toUnitPriceStr("3.4566", "USD")).toBe("3.4566");
    expect(toUnitPriceStr("41.48", "USD")).toBe("41.4800");
    expect(toUnitPriceStr("0.0001", "USD")).toBe("0.0001");
  });

  it("الدينار: منزلتان — 1450.99 تمرّ كما هي (نواة البلاغ)", () => {
    expect(toUnitPriceStr("1450.99", "IQD")).toBe("1450.99");
    expect(toUnitPriceStr("1450", "IQD")).toBe("1450.00");
    expect(toUnitPriceStr("1450.9", "IQD")).toBe("1450.90");
  });

  it("لا يفقد الفارق الذي كان `round2` يبتلعه على الكميّات الكبيرة", () => {
    // ٥٠٠٠ وحدة × (3.4566 − 3.46) = فارقُ $17 كان يختفي من ذمّة المورّد ومن تكلفة الصنف.
    const kept = Number(toUnitPriceStr("3.4566", "USD")) * 5000;
    const lostByOldRounding = 3.46 * 5000;
    expect(Number((lostByOldRounding - kept).toFixed(2))).toBe(17);
  });

  it("القيم الفارغة/الناقصة ⇒ صفرٌ بدقّة العملة (لا رمي أثناء الرسم)", () => {
    expect(toUnitPriceStr("", "IQD")).toBe("0.00");
    expect(toUnitPriceStr(null, "USD")).toBe("0.0000");
    expect(toUnitPriceStr(undefined, "IQD")).toBe("0.00");
  });
});
