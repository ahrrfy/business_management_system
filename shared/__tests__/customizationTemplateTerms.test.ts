import { expect, it } from "vitest";
import { FIELD_TYPE_LABELS, KIND_DEFAULTS, PRESET_BUTTONS } from "../customizationTemplateTerms";
it("covers all six persisted field types with distinct labels", () => {
  expect(Object.keys(FIELD_TYPE_LABELS).sort()).toEqual(["FILE", "NUMBER", "SELECT", "SWATCH", "TEXT", "TEXTAREA"]);
  expect(new Set(Object.values(FIELD_TYPE_LABELS)).size).toBe(6);
});
it("preserves the supported kinds and preset identities", () => {
  expect(Object.keys(KIND_DEFAULTS).sort()).toEqual(["GENERAL", "GIFT", "PRINT"]);
  expect(PRESET_BUTTONS.map((item) => item.preset)).toEqual(["LONG_TEXT", "SHORT_TEXT", "CHOICE", "COLOR", "DESIGN_FILE", "NUMBER"]);
});
