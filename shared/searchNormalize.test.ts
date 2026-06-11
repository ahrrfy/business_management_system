// اختبارات تطبيع البحث العربي — الجوهر النقي للبحث الذكي.
import { describe, expect, it } from "vitest";
import { escapeLikePattern, normalizeSearchText, tokenizeSearchQuery } from "./searchNormalize";

describe("normalizeSearchText — توحيد فضاء المطابقة", () => {
  it("يوحّد الهمزات إلى ألف مجردة", () => {
    expect(normalizeSearchText("أزرق")).toBe("ازرق");
    expect(normalizeSearchText("إبرة")).toBe("ابره");
    expect(normalizeSearchText("آلة")).toBe("اله");
  });

  it("يوحّد التاء المربوطة والألف المقصورة والهمزات على واو/ياء", () => {
    expect(normalizeSearchText("مكتبة")).toBe("مكتبه");
    expect(normalizeSearchText("مستشفى")).toBe("مستشفي");
    expect(normalizeSearchText("لؤلؤ")).toBe("لولو");
    expect(normalizeSearchText("طارئ")).toBe("طاري");
  });

  it("يحذف التطويل والتشكيل", () => {
    expect(normalizeSearchText("قـــلم")).toBe("قلم");
    expect(normalizeSearchText("قَلَمٌ")).toBe("قلم");
  });

  it("يحوّل الأرقام العربية-الهندية والفارسية إلى لاتينية", () => {
    expect(normalizeSearchText("٩٦ ورقة")).toBe("96 ورقه");
    expect(normalizeSearchText("۴۵")).toBe("45");
  });

  it("يخفض اللاتينية ويضغط المسافات", () => {
    expect(normalizeSearchText("  CUTTER   Knife ")).toBe("cutter knife");
  });
});

describe("tokenizeSearchQuery — كلمات مستقلة", () => {
  it("يقطّع ويطبّع كل كلمة", () => {
    expect(tokenizeSearchQuery("قلم  أزرق")).toEqual(["قلم", "ازرق"]);
  });
  it("يتجاهل الفراغات ويحدّ عدد الكلمات", () => {
    expect(tokenizeSearchQuery("ا ب ت ث ج ح خ", 3)).toEqual(["ا", "ب", "ت"]);
    expect(tokenizeSearchQuery("   ")).toEqual([]);
  });
});

describe("escapeLikePattern — سدّ حقن الأنماط", () => {
  it("يهرّب % و _ و \\", () => {
    expect(escapeLikePattern("100%")).toBe("100\\%");
    expect(escapeLikePattern("a_b")).toBe("a\\_b");
    expect(escapeLikePattern("a\\b")).toBe("a\\\\b");
  });
});
