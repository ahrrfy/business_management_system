import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
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

  it("لا يُدرِج /returns في hasLocalScanner: البحث الشامل يبقى متاحاً في شاشة السجلّ، ويتنحّى عن حقل السلة عبر ignoreInputFields", () => {
    // بوابة المرتجعات تعتمد ماسحها المحلّيّ (ProductSearchBar عبر useBarcodeInput) في شاشة الإنشاء،
    // والماسح العالميّ يتنحّى عنها لأنّها حقلٌ مركَّز (ignoreInputFields) لا لأنّها في هذه القائمة —
    // كي لا يُعطَّل مسحُ الانتقال في شاشة السجلّ (view=history) التي لا ProductSearchBar فيها.
    expect(hasLocalScanner("/returns", "")).toBe(false);
    expect(hasLocalScanner("/returns", "?view=history")).toBe(false);
  });

  it("الماسح العالميّ للوحة الأوامر يتنحّى عن الحقول المركَّز فيها (ignoreInputFields) فلا يخطف سلال ProductSearchBar", () => {
    const source = readFileSync(new URL("./CommandPalette.tsx", import.meta.url), "utf8");
    expect(/useBarcodeScanner\(\s*scanToSearch\s*,\s*\{[^}]*ignoreInputFields:\s*true/.test(source)).toBe(true);
  });

  it("يربط حقل البحث بـ useBarcodeInput لفك الرموز فيزيائياً ومنع قفزات Enter العشوائية", () => {
    const source = readFileSync(new URL("./CommandPalette.tsx", import.meta.url), "utf8");
    expect(source).toContain("useBarcodeInput(");
    expect(source).toContain("barcodeInput.handleKeyDown(e");
    expect(source).toContain("playReadyBeep()");
    expect(source).toContain("immediateTerm");
  });
});
