/**
 * نافذة سريان ربط جهاز البصمة — الطرفان معاً (تدقيق ١٧/٨، بند ٢١ · هجرة 0205).
 *
 * العطب: إنهاءُ الخدمة كان يُصفّر `hrDeviceUsers.employeeId` **فوراً** أياً كان تاريخ الإنهاء،
 * وهو يقع طبيعياً يومَ العمل الأخير نفسه ⇒ بصماتُ ذلك اليوم تصل بلا صاحبٍ فيُسجَّل **صفر
 * ساعات** ليومِ عملٍ كامل. ولا يُكتشف: أجرُ شهر الفصل يُكتب يدوياً في تسوية نهاية الخدمة
 * بلا مطابقةٍ مع سجلّ الحضور (بند ٤٣).
 *
 * الثوابت المحروسة:
 *   ن١) الحدّان **شاملان**: يوم المباشرة ويوم الإنهاء كلاهما يومُ عملٍ مدفوع.
 *   ن٢) ما قبل المباشرة لا يُنسَب — حارس إعادة استعمال رقم الجهاز (0136) لم ينكسر.
 *   ن٣) ما بعد الإنهاء لا يُنسَب — وارثُ الرقم لا تدخل بصماتُه راتبَ المغادر.
 *   ن٤) بلا حدود ⇒ يسري دائماً (صفر انحدار على الربط العاديّ).
 */
import { describe, expect, it } from "vitest";
import { isLinkEffectiveOn } from "../punchStore";

const FROM = "2026-03-01";
const TO = "2026-08-17"; // يوم العمل الأخير

describe("نافذة سريان ربط الجهاز", () => {
  it("ن١) يوم الإنهاء نفسه يُنسَب — وهو اليوم الذي كان يضيع", () => {
    expect(isLinkEffectiveOn({ effectiveFrom: FROM, effectiveTo: TO }, TO)).toBe(true);
  });

  it("ن١) ويوم المباشرة نفسه يُنسَب", () => {
    expect(isLinkEffectiveOn({ effectiveFrom: FROM, effectiveTo: TO }, FROM)).toBe(true);
  });

  it("ن٢) ما قبل المباشرة لا يُنسَب (حارس 0136 قائم)", () => {
    expect(isLinkEffectiveOn({ effectiveFrom: FROM, effectiveTo: TO }, "2026-02-28")).toBe(false);
  });

  it("ن٣) الغد بعد الإنهاء لا يُنسَب — وارثُ الرقم لا يدخل راتب المغادر", () => {
    expect(isLinkEffectiveOn({ effectiveFrom: FROM, effectiveTo: TO }, "2026-08-18")).toBe(false);
  });

  it("ن٤) بلا حدّين ⇒ يسري دائماً (صفر انحدار)", () => {
    expect(isLinkEffectiveOn({}, "2020-01-01")).toBe(true);
    expect(isLinkEffectiveOn({ effectiveFrom: null, effectiveTo: null }, "2099-12-31")).toBe(true);
  });

  it("حدٌّ واحدٌ فقط يعمل وحده — الطرف الآخر مفتوح", () => {
    expect(isLinkEffectiveOn({ effectiveFrom: FROM }, "2099-01-01")).toBe(true);
    expect(isLinkEffectiveOn({ effectiveFrom: FROM }, "2020-01-01")).toBe(false);
    expect(isLinkEffectiveOn({ effectiveTo: TO }, "1999-01-01")).toBe(true);
    expect(isLinkEffectiveOn({ effectiveTo: TO }, "2026-08-18")).toBe(false);
  });

  it("نافذةٌ ليومٍ واحد (مباشرةٌ وإنهاءٌ في اليوم نفسه) تُنسَب فيه وحده", () => {
    const oneDay = { effectiveFrom: TO, effectiveTo: TO };
    expect(isLinkEffectiveOn(oneDay, TO)).toBe(true);
    expect(isLinkEffectiveOn(oneDay, "2026-08-16")).toBe(false);
    expect(isLinkEffectiveOn(oneDay, "2026-08-18")).toBe(false);
  });
});
