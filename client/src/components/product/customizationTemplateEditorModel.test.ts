import { describe, expect, it } from "vitest";
import {
  addEditorOption,
  createPresetField,
  editorOptions,
  moveEditorOption,
  removeEditorOption,
  renameEditorOption,
  starterFields,
  type EditorField,
} from "./customizationTemplateEditorModel";

describe("محرر تخصيص المنتج المبسط", () => {
  it("ينشئ للموظف حقل تفاصيل جاهزاً من دون مفتاح أو ترتيب يدوي", () => {
    const existing: EditorField[] = starterFields("GENERAL");
    const field = createPresetField("LONG_TEXT", existing);

    expect(field).toMatchObject({
      fieldKey: "details_2",
      label: "تفاصيل التخصيص",
      fieldType: "TEXTAREA",
      isRequired: true,
      sortOrder: 20,
      maxLength: "2000",
      isActive: true,
    });
  });

  it("يعرض الخيارات كصفوف ثابتة ويحفظ البيانات التقنية بعيداً عن الموظف", () => {
    const stored = "black | أسود | 250\nblue | أزرق | 0";

    expect(editorOptions(stored)).toEqual([
      { value: "black", label: "أسود", priceDelta: "250" },
      { value: "blue", label: "أزرق", priceDelta: "0" },
    ]);
    expect(renameEditorOption(stored, "blue", "أحمر")).toBe("black | أسود | 250\nblue | أحمر | 0");
  });

  it("يولد قيمة تقنية فريدة عندما يضيف الموظف خياراً", () => {
    const stored = "option_1 | الأول | 0\noption_2 | الثاني | 0";

    expect(addEditorOption(stored)).toBe("option_1 | الأول | 0\noption_2 | الثاني | 0\noption_3 | خيار جديد | 0");
  });

  it("يحافظ على القيمة التقنية والسعر عند إعادة تسمية الخيار وترتيبه في تعديل واحد", () => {
    const stored = "option_1 | A | 100\noption_2 | B | 200";
    const renamed = renameEditorOption(stored, "option_2", "B2");

    expect(moveEditorOption(renamed, "option_2", -1)).toBe(
      "option_2 | B2 | 200\noption_1 | A | 100",
    );
  });

  it("يحذف الخيار المطلوب فقط من دون تغيير بقية القيم والأسعار", () => {
    expect(removeEditorOption("black | أسود | 250\nblue | أزرق | 10", "black"))
      .toBe("blue | أزرق | 10");
  });
});
