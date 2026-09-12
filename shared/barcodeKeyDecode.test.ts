import { describe, it, expect } from "vitest";
import { decodeScannerKeyCode, scannerCharFromEvent } from "./barcodeKeyDecode";

describe("decodeScannerKeyCode — المفتاح الفيزيائيّ مستقلّ عن التخطيط", () => {
  it("يفكّ صفّ الأرقام العلويّ إلى أرقامٍ لاتينية", () => {
    expect(decodeScannerKeyCode("Digit0", false)).toBe("0");
    expect(decodeScannerKeyCode("Digit5", false)).toBe("5");
    expect(decodeScannerKeyCode("Digit9", false)).toBe("9");
  });

  it("يفكّ لوحة الأرقام الجانبية (وضع numeric keypad)", () => {
    expect(decodeScannerKeyCode("Numpad0", false)).toBe("0");
    expect(decodeScannerKeyCode("Numpad7", false)).toBe("7");
    expect(decodeScannerKeyCode("NumpadDecimal", false)).toBe(".");
    expect(decodeScannerKeyCode("NumpadSubtract", false)).toBe("-");
  });

  it("يشتقّ حالة الحرف من Shift (باركود Code39 بأحرفٍ كبيرة)", () => {
    expect(decodeScannerKeyCode("KeyA", false)).toBe("a");
    expect(decodeScannerKeyCode("KeyA", true)).toBe("A");
    expect(decodeScannerKeyCode("KeyZ", true)).toBe("Z");
  });

  it("يفكّ علامات الترقيم في بادئات المستندات والرموز", () => {
    expect(decodeScannerKeyCode("Minus", false)).toBe("-");
    expect(decodeScannerKeyCode("Slash", false)).toBe("/");
    expect(decodeScannerKeyCode("Period", false)).toBe(".");
    expect(decodeScannerKeyCode("Digit4", true)).toBe("$"); // Code39 $
    expect(decodeScannerKeyCode("Equal", true)).toBe("+"); // Code39 +
    expect(decodeScannerKeyCode("Digit5", true)).toBe("%"); // Code39 %
    expect(decodeScannerKeyCode("Space", false)).toBe(" ");
  });

  it("يعيد null للمفاتيح غير القابلة للطباعة/غير المعروفة", () => {
    expect(decodeScannerKeyCode("Enter", false)).toBeNull();
    expect(decodeScannerKeyCode("ShiftLeft", false)).toBeNull();
    expect(decodeScannerKeyCode("F5", false)).toBeNull();
    expect(decodeScannerKeyCode("", false)).toBeNull();
  });
});

describe("scannerCharFromEvent — الأولوية للمفتاح الفيزيائيّ", () => {
  it("يصحّح الرقم المشوّه بالتخطيط العربي عبر code لا key", () => {
    // تحت التخطيط العربي: القارئ يضغط موقع Digit1 لكنّ key يصل رمزاً/رقماً عربياً.
    expect(scannerCharFromEvent({ code: "Digit1", key: "١", shiftKey: false })).toBe("1");
    expect(scannerCharFromEvent({ code: "Digit1", key: "!", shiftKey: false })).toBe("1");
  });

  it("يصحّح حرف باركود المنتج المشوّه (ش⇐KeyA) عبر code", () => {
    // "ALR" تحت العربي: KeyA/KeyL/KeyR تصل ش/م/ق. code يعيدها a/l/r.
    expect(scannerCharFromEvent({ code: "KeyA", key: "ش", shiftKey: false })).toBe("a");
    expect(scannerCharFromEvent({ code: "KeyL", key: "م", shiftKey: false })).toBe("l");
    expect(scannerCharFromEvent({ code: "KeyR", key: "ق", shiftKey: false })).toBe("r");
  });

  it("يفكّ باركود EAN-13 كاملاً تحت تخطيطٍ عربيّ", () => {
    const codes = ["Digit6", "Digit2", "Digit8", "Digit1", "Digit0", "Digit0", "Digit1", "Digit2", "Digit3", "Digit4", "Digit5", "Digit6", "Digit7"];
    const arabicKeys = ["٦", "٢", "٨", "١", "٠", "٠", "١", "٢", "٣", "٤", "٥", "٦", "٧"];
    const decoded = codes.map((code, i) => scannerCharFromEvent({ code, key: arabicKeys[i], shiftKey: false })).join("");
    expect(decoded).toBe("6281001234567");
  });

  it("يعود إلى key عند غياب code (أحداث مُركَّبة/قديمة)", () => {
    expect(scannerCharFromEvent({ key: "7" })).toBe("7");
    expect(scannerCharFromEvent({ code: "", key: "A" })).toBe("A");
    // code غير معروف ⇒ احتياطيّ على key
    expect(scannerCharFromEvent({ code: "IntlBackslash", key: "\\" })).toBe("\\");
  });

  it("يبقي مدخل اللوحة اللاتينية صحيحاً (لا انحدار للتخطيط الإنجليزيّ)", () => {
    expect(scannerCharFromEvent({ code: "Digit8", key: "8", shiftKey: false })).toBe("8");
    expect(scannerCharFromEvent({ code: "KeyB", key: "b", shiftKey: false })).toBe("b");
  });
});
