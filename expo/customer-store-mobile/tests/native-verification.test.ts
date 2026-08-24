import { describe, expect, it } from "vitest";

import { firebasePhoneErrorMessage } from "../lib/firebase-phone-auth.native";
import { extractTurnstileToken } from "../lib/turnstile-message";

describe("تحقق التطبيق الأصلي", () => {
  it("لا يعامل رسائل WebView غير المتعلقة بـTurnstile كفشل أو رمز صالح", () => {
    expect(extractTurnstileToken("not-json")).toBeNull();
    expect(extractTurnstileToken(JSON.stringify({ type: "OTHER", token: "x" }))).toBeNull();
    expect(extractTurnstileToken(JSON.stringify({ type: "ALARABIYA_TURNSTILE_TOKEN", token: "token-123" }))).toBe("token-123");
  });

  it("يعطي خطأ Firebase الخاص بتوقيع نسخة Google Play مساراً واضحاً بلا إعادة SMS عمياء", () => {
    expect(firebasePhoneErrorMessage({ code: "auth/invalid-app-credential" })).toContain("بصمة توقيع Google Play");
    expect(firebasePhoneErrorMessage({ code: "auth/quota-exceeded" })).toContain("حصة رسائل التحقق");
    expect(firebasePhoneErrorMessage(new Error("Native module NativeRNFBTurboApp is not registered."))).toContain("أحدث بناء");
  });
});
