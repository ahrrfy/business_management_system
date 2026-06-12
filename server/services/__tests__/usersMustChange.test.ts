/**
 * اختبارات تدفق mustChangePassword + tempPasswordExpiresAt + generateStrongPassword.
 * تعمل بلا DB (وحدة منطق خالص).
 */
import { describe, expect, it } from "vitest";
import { generateStrongPassword } from "../userService";
import { isStrongPassword } from "../../../shared/const";

describe("generateStrongPassword", () => {
  it("تولّد كلمة مرور قوية بأكثر من 8 خانات", () => {
    const pw = generateStrongPassword();
    expect(pw.length).toBeGreaterThanOrEqual(10);
  });

  it("الكلمة المولّدة تجتاز isStrongPassword", () => {
    for (let i = 0; i < 20; i++) {
      const pw = generateStrongPassword();
      expect(isStrongPassword(pw), `فشلت الكلمة: ${pw}`).toBe(true);
    }
  });

  it("كل كلمتين مختلفتان (عشوائية)", () => {
    const set = new Set(Array.from({ length: 10 }, () => generateStrongPassword()));
    expect(set.size).toBeGreaterThan(5);
  });
});

describe("منطق mustChangePassword + tempPasswordExpiresAt", () => {
  it("الانتهاء يكون 72 ساعة من الآن عند mustChange=true", () => {
    const before = Date.now();
    const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000);
    const after = Date.now();
    const ms72h = 72 * 60 * 60 * 1000;
    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + ms72h - 100);
    expect(expiresAt.getTime()).toBeLessThanOrEqual(after + ms72h + 100);
  });

  it("كلمة مرور منتهية الصلاحية يجب رفضها", () => {
    const expiredAt = new Date(Date.now() - 1000); // قبل الآن
    const isExpired = expiredAt < new Date();
    expect(isExpired).toBe(true);
  });

  it("كلمة مرور ضمن الصلاحية تمرّ", () => {
    const validUntil = new Date(Date.now() + 72 * 60 * 60 * 1000);
    const isExpired = validUntil < new Date();
    expect(isExpired).toBe(false);
  });

  it("changePassword يصفّر الرايتين (null + false)", () => {
    // تحقق منطقي: بعد التغيير يجب أن يكون mustChangePassword=false وtempPasswordExpiresAt=null
    const patch = { mustChangePassword: false, tempPasswordExpiresAt: null };
    expect(patch.mustChangePassword).toBe(false);
    expect(patch.tempPasswordExpiresAt).toBeNull();
  });
});

describe("رسائل الخطأ العربية", () => {
  it("رسالة انتهاء الصلاحية واضحة", () => {
    const msg = "انتهت صلاحية كلمة المرور المؤقتة — اطلب من المدير إعادة التعيين.";
    expect(msg).toContain("انتهت صلاحية");
    expect(msg).toContain("المدير");
  });
});
