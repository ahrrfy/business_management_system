import { describe, it, expect } from "vitest";
import { normalizeNational, toE164, parseE164 } from "../intlPhone";

describe("normalizeNational — تطبيع الأرقام العربية-الهندية عند اللصق", () => {
  it("يقبل الأرقام العربية-الهندية ويحوّلها إلى لاتينية (لصق من واتساب/رسائل)", () => {
    // الجذر (S5، ٢٥/٨/٢٦): كان `\D+` يبتلعها صامتاً ⇒ سلسلة فارغة ومستخدم محبَط.
    expect(normalizeNational("٠٧٧٠١٢٣٤٥٦٧")).toBe("7701234567");
    expect(normalizeNational("٧٧٠١٢٣٤٥٦٧")).toBe("7701234567");
  });

  it("يقبل الأرقام الفارسية-العربية أيضاً (بعض ملفات Excel/رسائل)", () => {
    expect(normalizeNational("۰۷۷۰۱۲۳۴۵۶۷")).toBe("7701234567");
  });

  it("يقبل خليط لاتيني+عربي في نفس السلسلة", () => {
    expect(normalizeNational("077٠١٢٣٤٥٦٧")).toBe("7701234567");
  });

  it("يحذف الصفر البادئ (سياق العراق: 0770 ⇒ 770)", () => {
    expect(normalizeNational("07701234567")).toBe("7701234567");
    expect(normalizeNational("0007701234567")).toBe("7701234567");
  });

  it("يزيل المسافات والفواصل والشرطات ورموز التنسيق", () => {
    expect(normalizeNational("077-012-3456 7")).toBe("7701234567");
    expect(normalizeNational("077 012 3 4567")).toBe("7701234567");
    expect(normalizeNational("(0770) 123-4567")).toBe("7701234567");
  });

  it("يقصّ ما يزيد على ١٥ رقماً (حدّ E.164)", () => {
    expect(normalizeNational("77012345678901234567").length).toBe(15);
  });

  it("مدخل فارغ/null ⇒ سلسلة فارغة", () => {
    expect(normalizeNational("")).toBe("");
    expect(normalizeNational(null as unknown as string)).toBe("");
    expect(normalizeNational(undefined as unknown as string)).toBe("");
  });
});

describe("toE164 — بناء E.164 من مفتاح ورقم مقيول", () => {
  it("يُنتج +964… من مفتاح عراق + رقم عربي-هندي بلا خلط", () => {
    expect(toE164("+964", "٠٧٧٠١٢٣٤٥٦٧")).toBe("+9647701234567");
  });

  it("رقم فارغ ⇒ سلسلة فارغة (لا مفتاح وحده)", () => {
    expect(toE164("+964", "")).toBe("");
    expect(toE164("+964", "٠٠٠")).toBe(""); // كل الأصفار تُحذف
  });
});

describe("parseE164 — قبول E.164 بأرقام عربية-هندية", () => {
  it("يفكّك رقماً بمفتاح دولة صحيح", () => {
    expect(parseE164("+9647701234567")).toEqual({ dial: "+964", national: "7701234567" });
  });

  it("يقبل رقماً بأرقام عربية-هندية بعد المفتاح", () => {
    expect(parseE164("+964٧٧٠١٢٣٤٥٦٧")).toEqual({ dial: "+964", national: "7701234567" });
  });

  it("رقم بلا `+` يُعتبر وطنياً بمفتاح افتراضي +964", () => {
    expect(parseE164("07701234567")).toEqual({ dial: "+964", national: "7701234567" });
  });

  it("null/undefined/فارغ ⇒ افتراضي بلا رقم", () => {
    expect(parseE164(null)).toEqual({ dial: "+964", national: "" });
    expect(parseE164(undefined)).toEqual({ dial: "+964", national: "" });
    expect(parseE164("")).toEqual({ dial: "+964", national: "" });
  });
});
