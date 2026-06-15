import { describe, expect, it } from "vitest";
import {
  clampLabelSize,
  DEFAULT_LABEL_SIZE,
  getLabelSize,
  LABEL_PRESETS,
  labelHeightDots,
  labelWidthDots,
  MAX_LABEL_WIDTH_MM,
  MAX_PRINT_WIDTH_DOTS,
  presetIdFor,
  setLabelSize,
} from "./labelSize";

describe("labelSize — مقاس ملصق الباركود (HPRT LPQ58)", () => {
  it("labelWidthDots لا يتجاوز عرض الطابعة الفعّال (384 نقطة) ويبقى مضاعف 8", () => {
    // 58مم × 8 = 464 لكنّ الطابعة تطبع 384 نقطة كحدّ أقصى ⇒ يُقصَر.
    expect(labelWidthDots(58)).toBe(MAX_PRINT_WIDTH_DOTS);
    expect(labelWidthDots(50)).toBe(MAX_PRINT_WIDTH_DOTS); // 400 > 384 ⇒ يُقصَر
    expect(labelWidthDots(40)).toBe(320); // 40×8=320
    expect(labelWidthDots(38)).toBe(304); // 38×8=304 (مضاعف 8)
    for (const mm of [20, 33, 40, 47, 50, 58]) {
      expect(labelWidthDots(mm) % 8).toBe(0);
      expect(labelWidthDots(mm)).toBeLessThanOrEqual(MAX_PRINT_WIDTH_DOTS);
    }
  });

  it("labelHeightDots = الارتفاع بالمم × 8 نقاط/مم", () => {
    expect(labelHeightDots(30)).toBe(240);
    expect(labelHeightDots(25)).toBe(200);
    expect(labelHeightDots(40)).toBe(320);
  });

  it("clampLabelSize يحصُر العرض ضمن [20, 58] والارتفاع ضمن [15, 120]", () => {
    expect(clampLabelSize({ widthMm: 5, heightMm: 5 })).toEqual({ widthMm: 20, heightMm: 15 });
    expect(clampLabelSize({ widthMm: 999, heightMm: 999 })).toEqual({ widthMm: MAX_LABEL_WIDTH_MM, heightMm: 120 });
    expect(clampLabelSize({ widthMm: 50.4, heightMm: 30.6 })).toEqual({ widthMm: 50, heightMm: 31 });
  });

  it("presetIdFor يميّز المقاسات الجاهزة عن المخصّصة", () => {
    expect(presetIdFor({ widthMm: 50, heightMm: 30 })).toBe("50x30");
    expect(presetIdFor({ widthMm: 40, heightMm: 30 })).toBe("40x30");
    expect(presetIdFor({ widthMm: 37, heightMm: 22 })).toBe("custom");
  });

  it("كل المقاسات الجاهزة تقع ضمن عرض الطابعة (≤58مم)", () => {
    for (const p of LABEL_PRESETS) {
      expect(p.size.widthMm).toBeLessThanOrEqual(MAX_LABEL_WIDTH_MM);
      expect(p.size.heightMm).toBeGreaterThan(0);
    }
  });

  it("get/set بلا localStorage (بيئة node): يعيد الافتراضي ويُرجِع القيمة المحصورة", () => {
    // في بيئة الاختبار (node) لا يوجد localStorage ⇒ getLabelSize يعيد الافتراضي بلا رمي.
    expect(getLabelSize()).toEqual(DEFAULT_LABEL_SIZE);
    // setLabelSize يحصُر ويعيد القيمة (الحفظ يُتجاهَل بهدوء بلا localStorage).
    expect(setLabelSize({ widthMm: 1000, heightMm: 1 })).toEqual({ widthMm: MAX_LABEL_WIDTH_MM, heightMm: 15 });
  });
});
