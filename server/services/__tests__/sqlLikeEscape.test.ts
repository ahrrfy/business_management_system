/**
 * اختبارات شريحة «إعادة التدقيق» (٢٣/٦/٢٦) — تهريب محارف LIKE.
 *
 * SQLI-001..006: وُحِّدت كل دوال البحث على escLike (هروب بـ"!") مع ESCAPE '!'
 * في عبارة SQL — آمن بصرف النظر عن sql_mode (لا يعتمد على "\" الافتراضي الذي
 * يفشل صامتاً تحت NO_BACKSLASH_ESCAPES). هذا الاختبار يثبّت سلوك الدالة النقية.
 */
import { describe, expect, it } from "vitest";
import { escLike, escapeLike } from "../../lib/sqlLike";

describe("escLike — تهريب محارف LIKE بـ'!' (ESCAPE '!')", () => {
  it("يهرّب % إلى !%", () => {
    expect(escLike("100%")).toBe("100!%");
  });

  it("يهرّب _ إلى !_", () => {
    expect(escLike("a_b")).toBe("a!_b");
  });

  it("يهرّب ! نفسه إلى !! (وإلا انكسر الهروب)", () => {
    expect(escLike("a!b")).toBe("a!!b");
  });

  it("يهرّب كل المحارف الخاصة معاً", () => {
    expect(escLike("%_!")).toBe("!%!_!!");
  });

  it("لا يلمس النص العادي (عربي/لاتيني/أرقام)", () => {
    expect(escLike("ورق A4 123")).toBe("ورق A4 123");
  });

  it("لا يهرّب الشرطة المائلة \\ (بخلاف escapeLike القديم) — لأن ESCAPE '!' هو الحارس", () => {
    // المهم: escLike لا يعتمد على "\" إطلاقاً ⇒ يعمل تحت NO_BACKSLASH_ESCAPES.
    expect(escLike("a\\b")).toBe("a\\b");
  });

  it("نصّ فارغ يبقى فارغاً", () => {
    expect(escLike("")).toBe("");
  });

  it("escapeLike القديم (هروب بـ\\) لا يزال متاحاً للمسارات غير المُحدَّثة", () => {
    // نُبقيه مُصدَّراً (مستعمَل في employeeService/recruitmentService مع like() الذي
    // يصدر ESCAPE '\\' افتراضياً في MySQL بوضعه الطبيعي).
    expect(escapeLike("100%")).toBe("100\\%");
  });
});
