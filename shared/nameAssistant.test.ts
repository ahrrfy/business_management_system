// اختبارات مساعد التسمية — منظّف الصيغة (عرضيّ غير متلف) + كاشف الألوان في الاسم.
import { describe, expect, it } from "vitest";
import { findColorWordsInName, suggestCleanName } from "./nameAssistant";

describe("suggestCleanName — منظّف الصيغة العرضيّ", () => {
  it("يوحّد المسافات المتعددة ويقصّ الأطراف", () => {
    expect(suggestCleanName("  قلم   جاف  ")).toBe("قلم جاف");
  });

  it("يزيل الكشيدة والتشكيل لكن يُبقي الهمزة والتاء المربوطة (فضاء عرض لا فضاء بحث)", () => {
    expect(suggestCleanName("قـــلم أزرق")).toBe("قلم أزرق");
    expect(suggestCleanName("مِسْطَرَة")).toBe("مسطرة");
    // الهمزة تبقى كما كتبها المستخدم — لا نُسقطها كما يفعل normalizeSearchText.
    expect(suggestCleanName("أزرق")).toBe("أزرق");
  });

  it("يحوّل الأرقام العربية-الهندية والفارسية إلى لاتينية", () => {
    expect(suggestCleanName("دفتر ٩٦ ورقة")).toBe("دفتر 96 ورقة");
    expect(suggestCleanName("دفتر ۹۶ ورقة")).toBe("دفتر 96 ورقة");
  });

  it("يوحّد علامة الضرب بين رقمين (مقاسات المطبعة)", () => {
    expect(suggestCleanName("بنر 70x100")).toBe("بنر 70×100");
    expect(suggestCleanName("بنر 70 * 100")).toBe("بنر 70×100");
    expect(suggestCleanName("بنر ٧٠ x ١٠٠")).toBe("بنر 70×100");
  });

  it("يرفع قياسات الورق اللاتينية ككلمة مستقلة", () => {
    expect(suggestCleanName("ورق طباعة a4 ابيض")).toBe("ورق طباعة A4 ابيض");
    expect(suggestCleanName("دفتر رسم b5")).toBe("دفتر رسم B5");
    // لا يمسّ ما ليس كلمة مستقلة (جزء من كود/باركود).
    expect(suggestCleanName("موديل 1b5x")).toBe("موديل 1b5x");
  });

  it("يحذف الكلمة المكرّرة تكراراً متتالياً حرفياً", () => {
    expect(suggestCleanName("قلم قلم جاف")).toBe("قلم جاف");
    // غير المتتالي لا يُمسّ (قد يكون مقصوداً).
    expect(suggestCleanName("ورق ذهبي ورق")).toBe("ورق ذهبي ورق");
  });

  it("يحذف الفواصل العالقة في الأطراف", () => {
    expect(suggestCleanName("- قلم جاف ،")).toBe("قلم جاف");
  });

  it("اسم نظيف أصلاً يعود كما هو (لا اقتراح زائفاً)", () => {
    const clean = "قلم جاف أزرق باركر A4 70×100";
    expect(suggestCleanName(clean)).toBe(clean);
  });

  it("مدخل فارغ/ضجيج صرف يعود سلسلة فارغة", () => {
    expect(suggestCleanName("")).toBe("");
    expect(suggestCleanName("  - ، ")).toBe("");
  });
});

describe("findColorWordsInName — كاشف الألوان في اسم المنتج", () => {
  it("يكشف اللون المفرد بأشكاله الإملائية", () => {
    expect(findColorWordsInName("قلم جاف ازرق")).toEqual(["أزرق"]);
    expect(findColorWordsInName("قلم جاف أزرق")).toEqual(["أزرق"]);
  });

  it("يكشف المرادفات والأسماء الإنكليزية", () => {
    expect(findColorWordsInName("دفتر بينك")).toEqual(["وردي"]);
    expect(findColorWordsInName("bag red")).toEqual(["أحمر"]);
  });

  it("يكشف العبارة اللونية المركّبة (الأطول يفوز)", () => {
    expect(findColorWordsInName("محفظة كحلي غامق")).toEqual(["أزرق منتصف الليل"]);
  });

  it("يسقط «ال» التعريف للكلمة المفردة", () => {
    expect(findColorWordsInName("القلم الأزرق")).toEqual(["أزرق"]);
  });

  it("يجمع عدة ألوان بلا تكرار وبترتيب الظهور", () => {
    expect(findColorWordsInName("طقم أحمر و ازرق واحمر")).toEqual(["أحمر", "أزرق"]);
  });

  it("لا يُنبّه على أسماء بضائع مشروعة تصادف قاموس الألوان", () => {
    expect(findColorWordsInName("قلم رصاص HB")).toEqual([]);
    expect(findColorWordsInName("فحم رسم ناعم")).toEqual([]);
    expect(findColorWordsInName("طباشير ملون")).toEqual([]);
    expect(findColorWordsInName("قلم جرافيت 2B")).toEqual([]);
    expect(findColorWordsInName("مسطرة ستيل 30 سم")).toEqual([]);
    expect(findColorWordsInName("طين اصطناعي")).toEqual([]);
    expect(findColorWordsInName("قلم حبر زيتي")).toEqual([]);
  });

  it("اسم بلا لون يعود مصفوفة فارغة", () => {
    expect(findColorWordsInName("دفتر 96 ورقة مسطر")).toEqual([]);
    expect(findColorWordsInName("")).toEqual([]);
  });
});
