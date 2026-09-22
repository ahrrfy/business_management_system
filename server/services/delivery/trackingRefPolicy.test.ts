import { describe, expect, it } from "vitest";
import {
  normalizeExternalTrackingRef,
  requireExternalTrackingRef,
} from "./trackingRefPolicy";

describe("سياسة رقم بوليصة شركة التوصيل", () => {
  it("يلزم الشركة برقم بوليصة غير فارغ", () => {
    expect(() => requireExternalTrackingRef("COMPANY", "   ")).toThrow(/مطلوب/);
    expect(() => requireExternalTrackingRef("COMPANY", null)).toThrow(/مطلوب/);
  });

  it("يبقي الرقم كما طُبع بعد إزالة الفراغات الخارجية ويحفظ الصفر البادئ", () => {
    expect(requireExternalTrackingRef("COMPANY", "  0441446  ")).toBe("0441446");
    expect(normalizeExternalTrackingRef("  0441446\r\n")).toBe("0441446");
  });

  it("يسمح للمندوب الفرد بلا رقم شركة", () => {
    expect(requireExternalTrackingRef("INDIVIDUAL", "")).toBeNull();
  });
});
