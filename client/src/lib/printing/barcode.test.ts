import { describe, expect, it } from "vitest";
import {
  code128Checksum, code128Svg, eanCheckDigit, eanModules, eanSvg, internalBarcode,
  isValidEan, productBarcodeSvg,
} from "./barcode";

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
    // منطقة الهدوء بالوحدات ⇒ تتضاعف مع moduleWidth (المواصفة: ≥10×X من كل جهة).
    const mod = 2;
    const quiet = 10;
    const r = code128Svg("123456", { moduleWidth: mod, quietZone: quiet, showText: false });
    expect(r.widthPx).toBe(68 * mod + 2 * quiet * mod);
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

describe("EAN encoder", () => {
  it("رقم التحقّق: الوزن ٣ للرقم الأيمن بالتناوب (EAN-13 وEAN-8)", () => {
    expect(eanCheckDigit("400638133393")).toBe(1); // EAN-13 حقيقي (Stabilo)
    expect(eanCheckDigit("123456789012")).toBe(8);
    expect(eanCheckDigit("9638507")).toBe(4); // EAN-8 المثال المرجعي
  });

  it("isValidEan: طول + أرقام + رقم تحقّق سليم فقط", () => {
    expect(isValidEan("4006381333931")).toBe(true);
    expect(isValidEan("96385074")).toBe(true);
    expect(isValidEan("4006381333932")).toBe(false); // رقم تحقّق خاطئ
    expect(isValidEan("ALR0000042")).toBe(false);
    expect(isValidEan("400638133393")).toBe(false); // 12 خانة — تبقى Code128 (لا نغيّر ما يعيده الماسح)
  });

  it("بنية وحدات EAN-8 تطابق الحساب اليدويّ (96385074)", () => {
    const m = eanModules("96385074");
    expect(m).toBe(
      "101" + "0001011" + "0101111" + "0111101" + "0110111" +
      "01010" + "1001110" + "1110010" + "1000100" + "1011100" + "101",
    );
    expect(m.length).toBe(67);
  });

  it("بنية وحدات EAN-13 تطابق الحساب اليدويّ مع تكافؤ الرقم الأول (4006381333931)", () => {
    // الرقم الأول 4 ⇒ تكافؤ LGLLGG على الأرقام الستة اليسرى.
    const m = eanModules("4006381333931");
    expect(m).toBe(
      "101" +
      "0001101" + "0100111" + "0101111" + "0111101" + "0001001" + "0110011" +
      "01010" +
      "1000010" + "1000010" + "1000010" + "1110100" + "1000010" + "1100110" +
      "101",
    );
    expect(m.length).toBe(95);
  });

  it("عرض EAN الكلي: 95+11+7 وحدة لـEAN-13 و67+7+7 لـEAN-8 (بهدوء المواصفة)", () => {
    expect(eanSvg("4006381333931", { moduleWidth: 1, showText: false }).widthPx).toBe(113);
    expect(eanSvg("96385074", { moduleWidth: 1, showText: false }).widthPx).toBe(81);
    // منطقة الهدوء تتضاعف مع moduleWidth.
    expect(eanSvg("4006381333931", { moduleWidth: 2, showText: false }).widthPx).toBe(226);
  });

  it("eanSvg يرفض ما ليس EAN صالحة", () => {
    expect(() => eanSvg("4006381333932")).toThrow();
    expect(() => eanSvg("ALR0000042")).toThrow();
  });

  it("productBarcodeSvg يختار EAN الأكثف للصالح وCode128 لغيره", () => {
    // EAN-13 أصلية: 113 وحدة؛ نفس الأرقام بـCode128 كانت ستأخذ 143 ⇒ قضبان أثخن ~26% على نفس العرض.
    expect(productBarcodeSvg("4006381333931", { moduleWidth: 1, showText: false }).widthPx).toBe(113);
    // رقم تحقّق خاطئ ⇒ Code128: بداية C + 6 أزواج + تحويل B + رقم + checksum = 10 رموز ⇒ 123 + هدوء 20.
    expect(productBarcodeSvg("4006381333932", { moduleWidth: 1, showText: false }).widthPx).toBe(143);
    // الرمز الداخليّ يبقى Code128.
    const alr = productBarcodeSvg("ALR0000042", { moduleWidth: 1, showText: false });
    expect(alr.widthPx).toBeGreaterThan(113);
  });
});
