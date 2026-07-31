import { describe, it, expect } from "vitest";
import {
  detectSymbology,
  ean13CheckDigit,
  isValidEan13,
  isValidUpcA,
  isValidEan8,
  isValidItf14,
  genInternalEan13,
} from "./barcodeSymbology";

describe("خانات التحقّق", () => {
  it("EAN-13: خانة التحقّق القياسيّة", () => {
    expect(ean13CheckDigit("629104150021")).toBe(3); // 6291041500213
    expect(ean13CheckDigit("400638133393")).toBe(1); // 4006381333931
    expect(isValidEan13("6291041500213")).toBe(true);
    expect(isValidEan13("6291041500214")).toBe(false); // خانة تحقّق مقلوبة
    expect(isValidEan13("62910415002")).toBe(false);   // أقصر من ١٣
    expect(isValidEan13("")).toBe(false);
  });

  it("UPC-A: ١٢ رقماً بأوزان معكوسة عن EAN-13", () => {
    // 036000291452 — UPC-A مرجعيّ شائع (Wrigley's Doublemint gum)
    expect(isValidUpcA("036000291452")).toBe(true);
    expect(isValidUpcA("036000291453")).toBe(false);
    expect(isValidUpcA("03600029145")).toBe(false); // ١١ رقماً
  });

  it("EAN-8: ٨ أرقام", () => {
    // 96385074 — EAN-8 مثال قياسي
    expect(isValidEan8("96385074")).toBe(true);
    expect(isValidEan8("96385073")).toBe(false);
  });

  it("ITF-14: ١٤ رقماً — كراتين الشحن", () => {
    // 10012345678902 — ITF-14 قياسيّ
    expect(isValidItf14("10012345678902")).toBe(true);
    expect(isValidItf14("10012345678903")).toBe(false);
  });
});

describe("detectSymbology — كشف نوع الترميز", () => {
  it("الفارغ", () => {
    const r = detectSymbology("");
    expect(r.kind).toBe("empty");
    expect(r.valid).toBe(false);
  });

  it("EAN-13 قياسيّ مصنّعيّ (بادئة أوروبية)", () => {
    const r = detectSymbology("4006381333931");
    expect(r.kind).toBe("EAN-13");
    expect(r.valid).toBe(true);
    expect(r.label).toBe("EAN-13");
  });

  it("EAN-13 بخانة تحقّق فاسدة — يُقبل مع بادج تحذيري (قرار المالك)", () => {
    const r = detectSymbology("4006381333930"); // خانة أخيرة مقلوبة
    expect(r.kind).toBe("EAN-13");
    expect(r.valid).toBe(false);
    expect(r.reason).toBeDefined();
  });

  it("ISBN-13 يميَّز عن EAN-13 العام (بادئة 978)", () => {
    // 9780134685991 — Effective Java 3rd Ed.
    const r = detectSymbology("9780134685991");
    expect(r.kind).toBe("ISBN-13");
    expect(r.valid).toBe(true);
    expect(r.label).toBe("ISBN");
  });

  it("EAN-13-INTERNAL: نطاق 20-29 المعياريّ للاستخدام الداخلي", () => {
    // نولّد داخلياً ثم نكشف — يجب أن يكون EAN-13-INTERNAL دائماً.
    for (let i = 0; i < 20; i++) {
      const code = genInternalEan13("200");
      const r = detectSymbology(code);
      expect(r.kind).toBe("EAN-13-INTERNAL");
      expect(r.valid).toBe(true);
      expect(code.slice(0, 2) >= "20" && code.slice(0, 2) <= "29").toBe(true);
    }
  });

  it("UPC-A ١٢ رقماً", () => {
    const r = detectSymbology("036000291452");
    expect(r.kind).toBe("UPC-A");
    expect(r.valid).toBe(true);
  });

  it("EAN-8 ٨ أرقام", () => {
    const r = detectSymbology("96385074");
    expect(r.kind).toBe("EAN-8");
    expect(r.valid).toBe(true);
  });

  it("ITF-14 ١٤ رقماً — كرتون شحن", () => {
    const r = detectSymbology("10012345678902");
    expect(r.kind).toBe("ITF-14");
    expect(r.valid).toBe(true);
  });

  it("INTERNAL: بادئة ALR* (رمز داخليّ غير رقميّ)", () => {
    const r = detectSymbology("ALR0000001");
    expect(r.kind).toBe("INTERNAL");
    expect(r.valid).toBe(true);
    expect(r.label).toBe("داخلي");
  });

  it("GS1-128: بادئة (01) أو ]C1", () => {
    expect(detectSymbology("(01)04006381333931").kind).toBe("GS1-128");
    expect(detectSymbology("]C104006381333931").kind).toBe("GS1-128");
  });

  it("Code39: مجموعة محارف محدَّدة", () => {
    const r = detectSymbology("PROD-A123");
    expect(r.kind).toBe("Code39");
    expect(r.valid).toBe(true);
  });

  it("Code128: ASCII قابل للطباعة أوسع (يشمل أحرف صغيرة/رموز)", () => {
    const r = detectSymbology("Item#42_batch-b");
    expect(r.kind).toBe("Code128");
    expect(r.valid).toBe(true);
  });

  it("أرقام بطول غير معياريّ ⇒ Code128 مع سبب", () => {
    const r = detectSymbology("12345"); // ٥ أرقام — لا معياريّ
    expect(r.kind).toBe("Code128");
    expect(r.valid).toBe(true);
    expect(r.reason).toBeDefined();
  });

  it("محارف غير قابلة للطباعة ⇒ unknown", () => {
    const r = detectSymbology("abc\x00def");
    expect(r.kind).toBe("unknown");
    expect(r.valid).toBe(false);
  });

  it("يقصّ المسافات البيضاء", () => {
    expect(detectSymbology("  4006381333931  ").kind).toBe("EAN-13");
  });
});

describe("genInternalEan13 — قرار المالك: النطاق المعياريّ GS1 (20-29)", () => {
  it("يولّد باركوداً صحيحاً في النطاق الداخلي", () => {
    for (let i = 0; i < 50; i++) {
      const code = genInternalEan13();
      expect(code).toMatch(/^\d{13}$/);
      expect(isValidEan13(code)).toBe(true);
      const p2 = +code.slice(0, 2);
      expect(p2 >= 20 && p2 <= 29).toBe(true);
    }
  });

  it("يقبل بادئة مخصَّصة داخل النطاق", () => {
    const code = genInternalEan13("250");
    expect(code.startsWith("250")).toBe(true);
    expect(isValidEan13(code)).toBe(true);
  });

  it("يجبر البادئة خارج النطاق على 20-29 (حماية)", () => {
    // بادئة خاطئة مثل 621 (نطاق مصر GS1) ⇒ تُقسر إلى نطاق داخليّ.
    const code = genInternalEan13("621");
    const p2 = +code.slice(0, 2);
    expect(p2 >= 20 && p2 <= 29).toBe(true);
    expect(isValidEan13(code)).toBe(true);
  });
});
