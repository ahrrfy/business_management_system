import { describe, expect, it } from "vitest";
import {
  stripTrackingLeadingZeros,
  trackingRefsEquivalent,
} from "@shared/barcodeScanner";
import {
  normalizeExternalTrackingRef,
  requireExternalTrackingRef,
} from "./trackingRefPolicy";

describe("سياسة رقم بوليصة شركة التوصيل", () => {
  it("يلزم الشركة برقم بوليصة غير فارغ", () => {
    expect(() => requireExternalTrackingRef("COMPANY", "   ")).toThrow(/مطلوب/);
    expect(() => requireExternalTrackingRef("COMPANY", null)).toThrow(/مطلوب/);
  });

  it("يبقي الرقم كما طُبع بعد إزالة الفراغات الخارجية ويحفظ الصفر والصفرين والثلاثة أصفار البادئة", () => {
    expect(requireExternalTrackingRef("COMPANY", "  0441446  ")).toBe("0441446");
    expect(normalizeExternalTrackingRef("  0441446\r\n")).toBe("0441446");
    expect(normalizeExternalTrackingRef("00404221")).toBe("00404221");
    expect(normalizeExternalTrackingRef("000404221")).toBe("000404221");
  });

  it("يجرّد الأصفار البادئة بدقة عبر stripTrackingLeadingZeros لاستخراج النواة الرقمية", () => {
    expect(stripTrackingLeadingZeros("0404221")).toBe("404221");
    expect(stripTrackingLeadingZeros("00404221")).toBe("404221");
    expect(stripTrackingLeadingZeros("000404221")).toBe("404221");
    expect(stripTrackingLeadingZeros("404221")).toBe("404221");
    expect(stripTrackingLeadingZeros("0")).toBe("0");
    expect(stripTrackingLeadingZeros("000")).toBe("0");
    expect(stripTrackingLeadingZeros("00AB123")).toBe("AB123");
    expect(stripTrackingLeadingZeros("")).toBe("");
  });

  it("يتحقق من التكافؤ القانوني بين البوالص المتطابقة بنواتها مهما اختلفت أصفارها البادئة", () => {
    expect(trackingRefsEquivalent("404221", "0404221")).toBe(true);
    expect(trackingRefsEquivalent("00404221", "404221")).toBe(true);
    expect(trackingRefsEquivalent("000404221", "0404221")).toBe(true);
    expect(trackingRefsEquivalent("0404221", "0404221")).toBe(true);
    expect(trackingRefsEquivalent("404221", "404222")).toBe(false);
    expect(trackingRefsEquivalent("٠٤٠٤٢٢١", "404221")).toBe(true);
    expect(trackingRefsEquivalent(null, "404221")).toBe(false);
  });

  it("يسمح للمندوب الفرد بلا رقم شركة", () => {
    expect(requireExternalTrackingRef("INDIVIDUAL", "")).toBeNull();
  });
});

