export type FieldType = "TEXT" | "TEXTAREA" | "SELECT" | "FILE" | "NUMBER" | "SWATCH";
export type CustomizationKind = "PRINT" | "GIFT" | "GENERAL";
export type FieldPreset = "SHORT_TEXT" | "LONG_TEXT" | "CHOICE" | "DESIGN_FILE" | "NUMBER" | "COLOR";

export type EditorField = {
  id?: number;
  fieldKey: string;
  label: string;
  fieldType: FieldType;
  isRequired: boolean;
  sortOrder: number;
  maxLength: string;
  optionsText: string;
  dependencyKey: string;
  dependencyValues: string;
  dependencyOperator: "equals" | "notEquals";
  priceDelta: string;
  isActive: boolean;
};

const PRESETS: Record<FieldPreset, Omit<EditorField, "fieldKey" | "sortOrder"> & { keyBase: string }> = {
  SHORT_TEXT: { keyBase: "text", label: "اسم أو عبارة", fieldType: "TEXT", isRequired: true, maxLength: "160", optionsText: "", dependencyKey: "", dependencyValues: "", dependencyOperator: "equals", priceDelta: "0", isActive: true },
  LONG_TEXT: { keyBase: "details", label: "تفاصيل التخصيص", fieldType: "TEXTAREA", isRequired: true, maxLength: "2000", optionsText: "", dependencyKey: "", dependencyValues: "", dependencyOperator: "equals", priceDelta: "0", isActive: true },
  CHOICE: { keyBase: "choice", label: "اختر المطلوب", fieldType: "SELECT", isRequired: true, maxLength: "", optionsText: "option_1 | الخيار الأول | 0\noption_2 | الخيار الثاني | 0", dependencyKey: "", dependencyValues: "", dependencyOperator: "equals", priceDelta: "0", isActive: true },
  DESIGN_FILE: { keyBase: "designFile", label: "ملف أو رابط التصميم", fieldType: "FILE", isRequired: false, maxLength: "", optionsText: "", dependencyKey: "", dependencyValues: "", dependencyOperator: "equals", priceDelta: "0", isActive: true },
  NUMBER: { keyBase: "number", label: "العدد المطلوب", fieldType: "NUMBER", isRequired: true, maxLength: "", optionsText: "", dependencyKey: "", dependencyValues: "", dependencyOperator: "equals", priceDelta: "0", isActive: true },
  COLOR: { keyBase: "color", label: "اختر اللون", fieldType: "SWATCH", isRequired: true, maxLength: "", optionsText: "black | أسود | 0\nblue | أزرق | 0\nred | أحمر | 0", dependencyKey: "", dependencyValues: "", dependencyOperator: "equals", priceDelta: "0", isActive: true },
};

function uniqueKey(base: string, fields: Array<Pick<EditorField, "fieldKey">>): string {
  const taken = new Set(fields.map((field) => field.fieldKey));
  if (!taken.has(base)) return base;
  let suffix = 2;
  while (taken.has(`${base}_${suffix}`)) suffix += 1;
  return `${base}_${suffix}`;
}

export function createPresetField(preset: FieldPreset, fields: EditorField[]): EditorField {
  const { keyBase, ...definition } = PRESETS[preset];
  return {
    ...definition,
    fieldKey: uniqueKey(keyBase, fields),
    sortOrder: (fields.length + 1) * 10,
  };
}

export function starterFields(kind: CustomizationKind): EditorField[] {
  if (kind === "PRINT") {
    const service: EditorField = { ...createPresetField("CHOICE", []), fieldKey: "service", label: "نوع التنفيذ", optionsText: "text | اسم أو عبارة | 0\nfile | صورة أو تصميم | 0\nfull | طباعة كاملة | 0" };
    const details = { ...createPresetField("LONG_TEXT", [service]), dependencyKey: "service", dependencyValues: "text,full" };
    const designFile = { ...createPresetField("DESIGN_FILE", [service, details]), isRequired: true, dependencyKey: "service", dependencyValues: "file,full" };
    return [service, details, designFile];
  }
  if (kind === "GIFT") {
    const packaging: EditorField = { ...createPresetField("CHOICE", []), fieldKey: "packaging", label: "التغليف", optionsText: "standard | تغليف عادي | 0\ngift | تغليف هدية | 0", isRequired: false };
    const recipient: EditorField = { ...createPresetField("SHORT_TEXT", [packaging]), fieldKey: "recipient", label: "اسم المستلم", isRequired: false };
    const message: EditorField = { ...createPresetField("LONG_TEXT", [packaging, recipient]), fieldKey: "message", label: "رسالة الإهداء", isRequired: false, maxLength: "300" };
    return [packaging, recipient, message];
  }
  return [{ ...createPresetField("LONG_TEXT", []), label: "تفاصيل الطلب" }];
}

export type EditorOption = { value: string; label: string; priceDelta: string };

export function editorOptions(optionsText: string): EditorOption[] {
  return optionsText
    .split("\n")
    .map((line) => line.trim())
    .map((line) => {
      const [value = "", label = "", priceDelta = "0"] = line.split("|").map((part) => part.trim());
      return { value, label, priceDelta };
    })
    .filter((option) => option.value);
}

function serializeOptions(options: EditorOption[]): string {
  return options.map((option) => `${option.value} | ${option.label.replaceAll("|", "-").trim()} | ${option.priceDelta}`).join("\n");
}

export function renameEditorOption(optionsText: string, value: string, label: string): string {
  return serializeOptions(editorOptions(optionsText).map((option) => option.value === value ? { ...option, label } : option));
}

export function addEditorOption(optionsText: string): string {
  const options = editorOptions(optionsText);
  const usedValues = new Set(options.map((option) => option.value));
  let suffix = options.length + 1;
  while (usedValues.has(`option_${suffix}`)) suffix += 1;
  return serializeOptions([...options, { value: `option_${suffix}`, label: "خيار جديد", priceDelta: "0" }]);
}

export function removeEditorOption(optionsText: string, value: string): string {
  return serializeOptions(editorOptions(optionsText).filter((option) => option.value !== value));
}

export function moveEditorOption(optionsText: string, value: string, direction: -1 | 1): string {
  const options = editorOptions(optionsText);
  const index = options.findIndex((option) => option.value === value);
  const nextIndex = index + direction;
  if (index < 0 || nextIndex < 0 || nextIndex >= options.length) return serializeOptions(options);
  [options[index], options[nextIndex]] = [options[nextIndex], options[index]];
  return serializeOptions(options);
}
