import { describe, expect, it } from "vitest";
import { translateLoginError } from "./loginErrors";

describe("translateLoginError — ترجمة أخطاء الدخول التقنية", () => {
  it("خطأ التحويل الحرفي من @trpc/client يُترجم لإرشاد عربي", () => {
    const t = translateLoginError("Unable to transform response from server");
    expect(t).toContain("حدّ محاولات الدخول");
  });

  it("أخطاء الشبكة (Chrome/Firefox/Safari) تُترجم لرسالة اتصال", () => {
    for (const m of ["Failed to fetch", "NetworkError when attempting to fetch resource.", "Load failed"]) {
      expect(translateLoginError(m)).toContain("تعذّر الاتصال بالخادم");
    }
  });

  it("استجابة غير JSON (صفحة خطأ من nginx) تُترجم لرسالة خادم غير متاح", () => {
    for (const m of [
      "Unexpected token '<', \"<html>\" is not valid JSON",
      "JSON Parse error: Unrecognized token '<'",
      "JSON.parse: unexpected character at line 1 column 1 of the JSON data",
    ]) {
      expect(translateLoginError(m)).toContain("غير متاح مؤقتاً");
    }
  });

  it("الرسائل العربية من الخادم تمرّ كما هي (لا تحوير)", () => {
    const m = "البريد الإلكتروني أو كلمة المرور غير صحيحة";
    expect(translateLoginError(m)).toBe(m);
  });
});
