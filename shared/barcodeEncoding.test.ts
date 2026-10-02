import { describe, expect, it } from "vitest";
import {
  calculateBarcodeBars,
  eanCheckDigit,
  isValidEan,
  buildBatchBarcodePdfFilename,
} from "./barcodeEncoding";

describe("shared/barcodeEncoding", () => {
  it("يحسب رقم التحقق EAN بدقة رياضية مطابقة للمواصفة القياسية", () => {
    // EAN-13 مع البادئة 200 (GS1 للاستخدام الداخلي)
    // 200123456789 -> يجب أن يكون رقم التحقق 0..9
    const prefix12 = "200123456789";
    const check = eanCheckDigit(prefix12);
    expect(typeof check).toBe("number");
    expect(check).toBeGreaterThanOrEqual(0);
    expect(check).toBeLessThanOrEqual(9);

    const fullCode = `${prefix12}${check}`;
    expect(isValidEan(fullCode)).toBe(true);
  });

  it("يولّد قضبان EAN-13 بدقة متّجهية ومناطق هدوء مطابقة لـ ISO/IEC 15420", () => {
    // 200123456789 مع رقم التحقق 3
    const code = "2001234567893";
    const valid = isValidEan(code);
    expect(valid).toBe(true);

    const result = calculateBarcodeBars(code, { moduleWidth: 1 });
    expect(result.symbology).toBe("EAN-13");
    // إجمالي وحدات EAN-13: 11 (هدوء يسار) + 95 (بيانات وحراس) + 7 (هدوء يمين) = 113
    expect(result.totalWidth).toBe(113);
    expect(result.quietZoneLeft).toBe(11);
    expect(result.quietZoneRight).toBe(7);
    expect(result.hriFormatted).toBe("2  001234  567893");
    expect(result.bars.length).toBeGreaterThan(20);

    // كل قضيب يجب أن يمتلك عرضاً وموقعاً موجباً
    for (const bar of result.bars) {
      expect(bar.x).toBeGreaterThanOrEqual(11);
      expect(bar.width).toBeGreaterThanOrEqual(1);
    }
  });

  it("يولّد قضبان Code 128 للرموز الأبجدية الرقمية", () => {
    const code = "ALR0001234";
    const result = calculateBarcodeBars(code, { moduleWidth: 1.5 });
    expect(result.symbology).toBe("CODE-128");
    expect(result.quietZoneLeft).toBe(15); // 10 * 1.5
    expect(result.quietZoneRight).toBe(15);
    expect(result.hriFormatted).toBe("ALR0001234");
    expect(result.bars.length).toBeGreaterThan(10);
  });

  it("يبني اسم ملف متوافق لدفعة ملصقات PDF (Batch)", () => {
    const filename = buildBatchBarcodePdfFilename({
      totalCount: 48,
      itemCount: 3,
      dateStr: "2026-10-02",
    });
    expect(filename).toBe("ملصقات باركود - 48 ملصق (3 صنف) - 2026-10-02.pdf");
  });
});

