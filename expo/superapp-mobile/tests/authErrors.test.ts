import { describe, expect, it } from "vitest";

import { readableAuthError } from "../lib/authErrors";

describe("readableAuthError", () => {
  it.each([
    "Invalid login identifier",
    "Invalid login password",
    "البريد أو كلمة المرور غير صحيحة",
  ])(
    "classifies invalid credentials without exposing server detail: %s",
    (message) => {
      expect(readableAuthError(new Error(message))).toBe(
        "تحقق من بيانات الدخول ثم حاول مرة أخرى.",
      );
    },
  );

  it("classifies the plain native-module error shape returned by Expo", () => {
    expect(
      readableAuthError({
        code: "E_SECURE_TRANSPORT_REMOTE",
        message: "البريد أو كلمة المرور غير صحيحة",
      }),
    ).toBe("تحقق من بيانات الدخول ثم حاول مرة أخرى.");
  });

  it("classifies protected connection failures", () => {
    expect(
      readableAuthError(
        new Error("The protected connection could not be completed."),
      ),
    ).toBe(
      "تعذر إتمام الاتصال المحمي الآن. تحقق من الشبكة أو أعد المحاولة لاحقاً.",
    );
  });

  it("explains when the device itself needs a secure lock", () => {
    expect(readableAuthError({ code: "E_LOCAL_PROTECTION_REQUIRED" })).toBe(
      "فعّل قفل الشاشة أو البصمة في إعدادات الجهاز، ثم أعد المحاولة لحماية جلسة العمل.",
    );
  });

  it.each([
    "E_LOCAL_PROTECTION_CANCELLED",
    "E_LOCAL_PROTECTION_FAILED",
    "E_SECURE_TRANSPORT_SESSION_LOCKED",
  ])("keeps local protection failures actionable: %s", (code) => {
    expect(readableAuthError({ code })).toBe(
      "لم تُفتح حماية الجهاز. استخدم البصمة أو رمز قفل الجهاز ثم أعد المحاولة.",
    );
  });

  it("keeps unknown failures generic and never repeats their contents", () => {
    expect(readableAuthError(new Error("sensitive backend detail"))).toBe(
      "تعذر إتمام الطلب الآن. لم يتم حفظ كلمة المرور في التطبيق.",
    );
  });
});
