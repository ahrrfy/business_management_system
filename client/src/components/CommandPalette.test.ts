import { describe, expect, it } from "vitest";
import { hasLocalScanner } from "./CommandPalette";

describe("hasLocalScanner", () => {
  it("يمنح تبويب الأرصدة ماسحه المحلي كي لا يسرق البحث الشامل باركود التسوية", () => {
    expect(hasLocalScanner("/inventory", "")).toBe(true);
    expect(hasLocalScanner("/inventory", "?tab=stock&q=6290000041041")).toBe(true);
  });

  it("يبقي تبويب الملصقات محلياً ولا يعطل البحث الشامل في بقية تبويبات المخزون", () => {
    expect(hasLocalScanner("/inventory", "?tab=barcodes")).toBe(true);
    expect(hasLocalScanner("/inventory", "?tab=products")).toBe(false);
    expect(hasLocalScanner("/inventory", "?tab=stocktakes")).toBe(false);
  });
});
