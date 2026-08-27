import { describe, it, expect } from "vitest";
import {
  KEYBOARD_SHORTCUTS,
  KEYBOARD_SHORTCUT_KEYS,
  formatShortcut,
} from "./keyboardShortcuts";

describe("قاموس اختصارات لوحة المفاتيح", () => {
  it("كل اختصار له key + label + scope", () => {
    for (const k of KEYBOARD_SHORTCUT_KEYS) {
      const s = KEYBOARD_SHORTCUTS[k];
      expect(s.key, `${k} بلا key`).toBeTruthy();
      expect(s.label, `${k} بلا label عربيّ`).toBeTruthy();
      expect(
        ["global", "pos", "reception", "crud-form", "invoice-editor"].includes(s.scope),
        `${k} scope غير معتمد`,
      ).toBe(true);
    }
  });

  it("النطاقات المعتمدة كاملة (لا تحاليل جانبية غير موثَّقة)", () => {
    const scopes = new Set(KEYBOARD_SHORTCUT_KEYS.map((k) => KEYBOARD_SHORTCUTS[k].scope));
    // كل نطاق مدرَج يجب أن يكون في القائمة المعتمدة.
    for (const scope of scopes) {
      expect(["global", "pos", "reception", "crud-form", "invoice-editor"]).toContain(scope);
    }
  });

  it("formatShortcut يعرض المعدِّلات بالترتيب Ctrl → Shift → Alt → المفتاح", () => {
    expect(formatShortcut({ key: "s", ctrl: true, label: "حفظ", scope: "crud-form" })).toBe("Ctrl+S");
    expect(formatShortcut({ key: "?", shift: true, label: "؟", scope: "global" })).toBe("Shift+?");
    expect(formatShortcut({ key: "F2", label: "F2", scope: "pos" })).toBe("F2");
    expect(formatShortcut({ key: "Escape", label: "Esc", scope: "global" })).toBe("Esc");
  });

  it("Ctrl+S = saveForm (لا اختصار آخر يتنازع)", () => {
    // الاختصار الأشيع في النظام. اختبار عدم التصادم يمنع الانحدار مستقبلاً.
    const conflicts = KEYBOARD_SHORTCUT_KEYS.filter((k) => {
      const s = KEYBOARD_SHORTCUTS[k];
      return s.key === "s" && s.ctrl && !s.shift && !s.alt && k !== "saveForm";
    });
    expect(conflicts, "Ctrl+S متنازع").toEqual([]);
  });

  it("F2/F7 في POS موثَّقة صراحةً (لا اختصارات سرّية)", () => {
    expect(KEYBOARD_SHORTCUTS.focusBarcode.key).toBe("F2");
    expect(KEYBOARD_SHORTCUTS.finalizeSale.key).toBe("F7");
    expect(KEYBOARD_SHORTCUTS.focusBarcode.description).toBeTruthy();
    expect(KEYBOARD_SHORTCUTS.finalizeSale.description).toBeTruthy();
  });
});
