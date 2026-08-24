import { describe, expect, it } from "vitest";

import { extractTurnstileToken } from "../lib/turnstile-message";

/**
 * WebView تحدّي Cloudflare يرسل postMessage للتطبيق. المُستخرج يجب أن يقبل
 * الشكل الصحيح فقط وأن يرفض أيّ حمولةٍ خبيثة/مشوّهة بلا رميٍ للاستثناء
 * (لأنّه يُستدعى من onMessage الذي يجب ألا يُسقط الشاشة).
 */
describe("extractTurnstileToken", () => {
  it("يستخرج رمزاً صحيحاً من الحمولة القياسيّة", () => {
    const message = JSON.stringify({ type: "ALARABIYA_TURNSTILE_TOKEN", token: "cf-token-abc-123" });
    expect(extractTurnstileToken(message)).toBe("cf-token-abc-123");
  });

  it("يرفض حمولةً بنوعٍ مختلف حتى لو حملت token", () => {
    const message = JSON.stringify({ type: "OTHER_MESSAGE", token: "hijacked" });
    expect(extractTurnstileToken(message)).toBeNull();
  });

  it("يرفض حمولةً بلا حقل type", () => {
    const message = JSON.stringify({ token: "no-type" });
    expect(extractTurnstileToken(message)).toBeNull();
  });

  it("يرفض حمولةً برمزٍ فارغ", () => {
    const message = JSON.stringify({ type: "ALARABIYA_TURNSTILE_TOKEN", token: "" });
    expect(extractTurnstileToken(message)).toBeNull();
  });

  it("يرفض رمزاً أطول من ٢٠٤٨ محرفاً (سطح حشو محتمل)", () => {
    const message = JSON.stringify({ type: "ALARABIYA_TURNSTILE_TOKEN", token: "x".repeat(2049) });
    expect(extractTurnstileToken(message)).toBeNull();
  });

  it("يقبل رمزاً بطول ٢٠٤٨ محرفاً بالضبط (الحدّ الأعلى)", () => {
    const token = "x".repeat(2048);
    const message = JSON.stringify({ type: "ALARABIYA_TURNSTILE_TOKEN", token });
    expect(extractTurnstileToken(message)).toBe(token);
  });

  it("يرفض JSON غير صالح بلا رمي استثناء", () => {
    expect(extractTurnstileToken("not-json-at-all")).toBeNull();
    expect(extractTurnstileToken("")).toBeNull();
    expect(extractTurnstileToken("{invalid}")).toBeNull();
  });

  it("يرفض حمولةً بنوعٍ ليس نصّاً", () => {
    const message = JSON.stringify({ type: 42, token: "numeric-type-attack" });
    expect(extractTurnstileToken(message)).toBeNull();
  });

  it("يرفض حمولةً برمزٍ ليس نصّاً", () => {
    const message = JSON.stringify({ type: "ALARABIYA_TURNSTILE_TOKEN", token: 12345 });
    expect(extractTurnstileToken(message)).toBeNull();
    const message2 = JSON.stringify({ type: "ALARABIYA_TURNSTILE_TOKEN", token: null });
    expect(extractTurnstileToken(message2)).toBeNull();
  });
});
