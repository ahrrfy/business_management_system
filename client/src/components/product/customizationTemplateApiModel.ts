import type {
  EditorField,
  FieldType,
} from "./customizationTemplateEditorModel";

export function fieldFromApi(field: {
  id: number;
  fieldKey: string;
  label: string;
  fieldType: FieldType;
  isRequired: boolean;
  sortOrder: number;
  maxLength: number | null;
  options: Array<{ value: string; label: string; priceDelta?: string }>;
  dependency: {
    fieldKey: string;
    operator: "equals" | "notEquals";
    value: string | string[];
  } | null;
  priceDelta: string;
  isActive: boolean;
}): EditorField {
  return {
    id: field.id,
    fieldKey: field.fieldKey,
    label: field.label,
    fieldType: field.fieldType,
    isRequired: field.isRequired,
    sortOrder: field.sortOrder,
    maxLength: field.maxLength == null ? "" : String(field.maxLength),
    optionsText: field.options
      .map(
        (option) =>
          `${option.value} | ${option.label} | ${option.priceDelta ?? "0"}`,
      )
      .join("\n"),
    dependencyKey: field.dependency?.fieldKey ?? "",
    dependencyValues: field.dependency
      ? (Array.isArray(field.dependency.value)
          ? field.dependency.value
          : [field.dependency.value]
        ).join(",")
      : "",
    dependencyOperator: field.dependency?.operator ?? "equals",
    priceDelta: field.priceDelta,
    isActive: field.isActive,
  };
}

export function parseOptions(optionsText: string) {
  return optionsText
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [value, label, priceDelta = "0"] = line
        .split("|")
        .map((part) => part.trim());
      return { value, label, priceDelta };
    })
    .filter((option) => option.value && option.label);
}
