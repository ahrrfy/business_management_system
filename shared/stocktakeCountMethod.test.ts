import { describe, expect, it } from "vitest";
import {
  COUNT_ENTRY_METHODS,
  COUNT_METHODS,
  DEFAULT_COUNT_METHOD,
  countEntryMethodLabel,
  countMethodLabel,
  isCountEntryMethod,
  isCountMethod,
  isEntryMethodAllowed,
  isScanEntry,
  type CountEntryMethod,
} from "./stocktakeCountMethod";

describe("stocktakeCountMethod — المعجم الحاكم", () => {
  it("الافتراض للجلسة الجديدة هو المسح الإلزامي (قرار المالك ٢٢/٨)", () => {
    expect(DEFAULT_COUNT_METHOD).toBe("SCAN_REQUIRED");
  });

  it("لكل قيمةٍ تسميةٌ عربية غير فارغة", () => {
    for (const m of COUNT_METHODS) expect(countMethodLabel(m).length).toBeGreaterThan(0);
    for (const e of COUNT_ENTRY_METHODS)
      expect(countEntryMethodLabel(e).length).toBeGreaterThan(0);
  });

  it("isScanEntry يميّز المسح الفعليّ عن اليدويّ والحر", () => {
    expect(isScanEntry("SCAN_HID")).toBe(true);
    expect(isScanEntry("SCAN_CAMERA")).toBe(true);
    expect(isScanEntry("MANUAL_AUTHORIZED")).toBe(false);
    expect(isScanEntry("SEARCH_PICK")).toBe(false);
    expect(isScanEntry(null)).toBe(false);
  });

  it("FREE يقبل كل طرق الإدخال", () => {
    for (const e of COUNT_ENTRY_METHODS)
      expect(isEntryMethodAllowed("FREE", e)).toBe(true);
  });

  it("SCAN_REQUIRED يقبل المسح والاستثناء المحكوم ويرفض الاختيار الحر", () => {
    expect(isEntryMethodAllowed("SCAN_REQUIRED", "SCAN_HID")).toBe(true);
    expect(isEntryMethodAllowed("SCAN_REQUIRED", "SCAN_CAMERA")).toBe(true);
    expect(isEntryMethodAllowed("SCAN_REQUIRED", "MANUAL_AUTHORIZED")).toBe(true);
    expect(isEntryMethodAllowed("SCAN_REQUIRED", "SEARCH_PICK")).toBe(false);
  });

  it("حرّاس النوع تميّز القيم الصالحة من غيرها", () => {
    expect(isCountMethod("SCAN_REQUIRED")).toBe(true);
    expect(isCountMethod("FREE")).toBe(true);
    expect(isCountMethod("NOPE")).toBe(false);
    expect(isCountMethod(null)).toBe(false);
    expect(isCountEntryMethod("SCAN_HID")).toBe(true);
    expect(isCountEntryMethod("elsewhere")).toBe(false);
  });

  it("مجموعتا القيم بلا تكرار", () => {
    expect(new Set<string>(COUNT_METHODS).size).toBe(COUNT_METHODS.length);
    expect(new Set<CountEntryMethod>(COUNT_ENTRY_METHODS).size).toBe(
      COUNT_ENTRY_METHODS.length,
    );
  });
});
