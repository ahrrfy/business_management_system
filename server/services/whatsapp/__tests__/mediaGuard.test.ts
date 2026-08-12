import { describe, expect, it } from "vitest";
import { guardMediaUrl } from "../mediaService";

/**
 * تدقيق ٣/٨ (SSRF + تسريب Bearer) — حارس رابط تنزيل وسائط واتساب القادم من استجابة Graph.
 * دالة نقيّة (بلا DB) لكنها تُشغَّل ضمن مجموعة vitest المُهيّأة بقاعدة اختبار (setupFiles).
 */
describe("guardMediaUrl", () => {
  it("يرفض ما ليس https (منع تنزيل عبر بروتوكول غير آمن)", () => {
    expect(guardMediaUrl("http://lookaside.fbsbx.com/x").ok).toBe(false);
    expect(guardMediaUrl("ftp://lookaside.fbsbx.com/x").ok).toBe(false);
    expect(guardMediaUrl("not-a-url").ok).toBe(false);
  });

  it("يرفض المضيفات الداخلية/الخاصة (SSRF)", () => {
    for (const u of [
      "https://127.0.0.1/x",
      "https://10.0.0.5/x",
      "https://192.168.1.1/x",
      "https://172.16.0.1/x",
      "https://169.254.169.254/x", // link-local (metadata)
      "https://localhost/x",
      "https://db.internal/x",
      "https://[::1]/x",
    ]) {
      expect(guardMediaUrl(u).ok, u).toBe(false);
    }
  });

  it("يسمح لمضيفات Meta الموثوقة ويرسل التوكن", () => {
    for (const u of [
      "https://lookaside.fbsbx.com/file",
      "https://scontent.xx.fbcdn.net/v/x",
      "https://mmg.whatsapp.net/x",
    ]) {
      const r = guardMediaUrl(u);
      expect(r.ok, u).toBe(true);
      expect(r.ok && r.sendAuth, u).toBe(true);
    }
  });

  it("يسمح بمضيف عام غير موثوق لكن بلا توكن (منع تسريب Bearer)", () => {
    const r = guardMediaUrl("https://evil.example.com/steal");
    expect(r.ok).toBe(true);
    expect(r.ok && r.sendAuth).toBe(false);
  });

  it("يثق بمضيف apiBaseUrl المُهيّأ ومضيفٍ فرعيٍّ منه (حياديّة المزوّد BSP) فيرسل التوكن", () => {
    // نفس مضيف apiBaseUrl.
    const same = guardMediaUrl("https://api.mybsp.io/file", "https://api.mybsp.io");
    expect(same.ok && same.sendAuth).toBe(true);
    // مضيف فرعيّ من apiHost.
    const sub = guardMediaUrl("https://cdn.api.mybsp.io/file", "https://api.mybsp.io");
    expect(sub.ok && sub.sendAuth).toBe(true);
    // مضيف مختلف (حتى بأصلٍ مشترك) يبقى بلا توكن — مطابقة فرعيّة صارمة.
    const other = guardMediaUrl("https://media.other.io/file", "https://api.mybsp.io");
    expect(other.ok).toBe(true);
    expect(other.ok && other.sendAuth).toBe(false);
  });
});
