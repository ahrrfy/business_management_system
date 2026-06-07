import { describe, expect, it } from "vitest";
import { code128Checksum, code128Svg, internalBarcode } from "./barcode";

/** مجموع وحدات نمط الرمز يجب أن يساوي 11 لكل رمز (و13 لرمز الإيقاف). */
describe("Code128 encoder", () => {
  it("checksum ضمن المدى [0,102] وحتمي", () => {
    const a = code128Checksum("123456");
    const b = code128Checksum("123456");
    expect(a).toBe(b);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThanOrEqual(102);
  });

  it("checksum يطابق الحساب اليدوي لـ Code128-C على «123456»", () => {
    // Start C=105، الأزواج 12,34,56 ⇒ [105,12,34,56]
    // checksum = (105 + 12*1 + 34*2 + 56*3) % 103 = 353 % 103 = 44
    expect(code128Checksum("123456")).toBe(44);
  });

  it("العرض الكلي للقضبان يطابق بنية Code128 (11 وحدة/رمز + 13 للإيقاف)", () => {
    // «123456» بنمط C: رموز = بداية(1) + بيانات(3) + checksum(1) = 5 ⇒ 5*11 + 13 = 68 وحدة
    const mod = 2;
    const quiet = 10;
    const r = code128Svg("123456", { moduleWidth: mod, quietZone: quiet, showText: false });
    expect(r.widthPx).toBe(68 * mod + 2 * quiet);
  });

  it("يرمّز EAN-13 الرقمي بلا أخطاء", () => {
    const r = code128Svg("6001000000017");
    expect(r.svg).toContain("<svg");
    expect(r.svg).toContain("6001000000017");
    expect(r.widthPx).toBeGreaterThan(0);
  });

  it("يرمّز نصاً أبجدياً رقمياً (نمط B) بلا أخطاء", () => {
    const r = code128Svg("ALR0000042", { showText: true });
    expect(r.svg).toContain("<svg");
    expect(r.svg).toContain("ALR0000042");
  });

  it("يرفض الحروف خارج ASCII المطبوع", () => {
    expect(() => code128Svg("قلم")).toThrow();
  });

  it("يرفض النص الفارغ", () => {
    expect(() => code128Svg("")).toThrow();
  });

  it("internalBarcode بصيغة ALR + 7 أرقام", () => {
    expect(internalBarcode(42)).toBe("ALR0000042");
    expect(internalBarcode(1234567)).toBe("ALR1234567");
  });
});
