type CustomizationDependency = {
  fieldKey: string;
  operator: "equals" | "notEquals";
  value: string | string[];
} | null;

type CustomizationField = { fieldKey: string; dependency: CustomizationDependency };

export const DEFAULT_STOREFRONT_CUSTOMIZATION_MAX_LENGTH = 2_000;

export function serializeStorefrontCustomizationIdentity(
  customization?: { templateId: number; values?: Record<string, string> },
): string {
  if (!customization) return "";
  const values = Object.fromEntries(Object.entries(customization.values ?? {})
    .flatMap(([rawKey, rawValue]) => {
      const key = rawKey.trim();
      const value = rawValue.trim();
      return key && value ? [[key, value] as const] : [];
    })
    .sort(([left], [right]) => left.localeCompare(right)));
  return JSON.stringify({ templateId: customization.templateId, values });
}

export function storefrontVisibleCustomizationFieldKeys(
  fields: readonly CustomizationField[],
  values: Record<string, string>,
): Set<string> {
  const byKey = new Map(fields.map((field) => [field.fieldKey, field]));
  const resolved = new Map<string, boolean>();
  const resolving = new Set<string>();
  const isVisible = (fieldKey: string): boolean => {
    if (resolved.has(fieldKey)) return resolved.get(fieldKey)!;
    const field = byKey.get(fieldKey);
    if (!field || resolving.has(fieldKey)) return false;
    resolving.add(fieldKey);
    const dependency = field.dependency;
    const expected = dependency == null ? [] : Array.isArray(dependency.value) ? dependency.value : [dependency.value];
    const matches = dependency == null || expected.includes(values[dependency.fieldKey] ?? "");
    const visible = dependency == null || (isVisible(dependency.fieldKey) && (dependency.operator === "notEquals" ? !matches : matches));
    resolving.delete(fieldKey);
    resolved.set(fieldKey, visible);
    return visible;
  };
  return new Set(fields.filter((field) => isVisible(field.fieldKey)).map((field) => field.fieldKey));
}
