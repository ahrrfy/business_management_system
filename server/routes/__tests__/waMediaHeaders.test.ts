import { describe, expect, it } from "vitest";
import { resolveMediaHeaders } from "../waMedia";

/**
 * وحدة خالصة (بلا DB) — تتحقّق من قائمة سماح MIME لوسائط واتساب المقدَّمة عبر
 * `GET /api/wa/media/:messageId`. النوع مصدره مرفقٌ من طرفٍ خارجي غير مصادَق ⇒ أي نوعٍ
 * خطر (text/html، image/svg+xml…) يجب أن يُخدَم كتنزيلٍ `application/octet-stream` لا inline.
 */
describe("resolveMediaHeaders", () => {
  it("يسمح بنوع صورة معروف كـinline بنفس النوع الأصلي", () => {
    expect(resolveMediaHeaders("image/jpeg")).toEqual({ contentType: "image/jpeg", disposition: "inline" });
  });

  it("يسمح ببقيّة أنواع وسائط واتساب المعروفة كـinline", () => {
    expect(resolveMediaHeaders("application/pdf")).toEqual({ contentType: "application/pdf", disposition: "inline" });
    expect(resolveMediaHeaders("audio/ogg")).toEqual({ contentType: "audio/ogg", disposition: "inline" });
    expect(resolveMediaHeaders("video/mp4")).toEqual({ contentType: "video/mp4", disposition: "inline" });
  });

  it("يحوّل text/html إلى تنزيلٍ آمن (لا تفسير HTML على أصل التطبيق)", () => {
    expect(resolveMediaHeaders("text/html")).toEqual({ contentType: "application/octet-stream", disposition: "attachment" });
  });

  it("يحوّل image/svg+xml إلى تنزيلٍ آمن (SVG قد يحوي سكربتاً)", () => {
    expect(resolveMediaHeaders("image/svg+xml")).toEqual({ contentType: "application/octet-stream", disposition: "attachment" });
  });

  it("يحوّل سلسلة فارغة/غريبة إلى تنزيلٍ آمن", () => {
    expect(resolveMediaHeaders("")).toEqual({ contentType: "application/octet-stream", disposition: "attachment" });
    expect(resolveMediaHeaders("application/x-something-weird")).toEqual({
      contentType: "application/octet-stream",
      disposition: "attachment",
    });
  });
});
