import type {
  CartLine,
  Product,
  ProductSelectionDetails,
  StorefrontCustomizationField,
  StorefrontUnitOption,
} from "@/shared/storefront";

export type ProductSelectionInput = {
  variantId: number | null;
  productUnitId: number | null;
  customizationValues: Record<string, string>;
};

export const DEFAULT_CUSTOMIZATION_VALUE_MAX_LENGTH = 2_000;
export const CUSTOMIZABLE_ORDERING_UNAVAILABLE_MESSAGE =
  "إعداد حقول التخصيص غير مكتمل لهذا المنتج. تواصل مع المكتبة أو حاول لاحقاً.";

const CENTS_PER_IQD = BigInt(100);

function moneyToCents(value: string | null | undefined): bigint | null {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value ?? "");
  if (!match) return null;
  return (BigInt(match[1]) * CENTS_PER_IQD) + BigInt((match[2] ?? "").padEnd(2, "0"));
}

function centsToMoney(value: bigint): string {
  const whole = value / CENTS_PER_IQD;
  const fraction = (value % CENTS_PER_IQD).toString().padStart(2, "0");
  return `${whole}.${fraction}`;
}

export function productOnlineOrderingIssue(product: Product): string | null {
  if (!product.isCustomizable) return null;
  const template = product.customizationTemplate;
  if (!template || !product.customizationKind) {
    return CUSTOMIZABLE_ORDERING_UNAVAILABLE_MESSAGE;
  }
  return template.kind === "GENERAL" || template.kind === product.customizationKind
    ? null
    : CUSTOMIZABLE_ORDERING_UNAVAILABLE_MESSAGE;
}

function dependencyMatches(
  field: StorefrontCustomizationField,
  values: Record<string, string>,
) {
  if (!field.dependency) return true;
  const actual = values[field.dependency.fieldKey] ?? "";
  const expected = Array.isArray(field.dependency.value)
    ? field.dependency.value
    : [field.dependency.value];
  const equals = expected.includes(actual);
  return field.dependency.operator === "equals" ? equals : !equals;
}

export function activeCustomizationFields(
  product: Product,
  values: Record<string, string>,
) {
  const fields = [...(product.customizationTemplate?.fields ?? [])].sort((left, right) => left.sortOrder - right.sortOrder);
  const byKey = new Map(fields.map((field) => [field.fieldKey, field]));
  const resolved = new Map<string, boolean>();
  const resolving = new Set<string>();
  const isActive = (fieldKey: string): boolean => {
    if (resolved.has(fieldKey)) return resolved.get(fieldKey)!;
    const field = byKey.get(fieldKey);
    if (!field || resolving.has(fieldKey)) return false;
    resolving.add(fieldKey);
    const active = !field.dependency || (isActive(field.dependency.fieldKey) && dependencyMatches(field, values));
    resolving.delete(fieldKey);
    resolved.set(fieldKey, active);
    return active;
  };
  return fields.filter((field) => isActive(field.fieldKey));
}

export function pruneInactiveCustomizationValues(product: Product, values: Record<string, string>) {
  const activeKeys = new Set(activeCustomizationFields(product, values).map((field) => field.fieldKey));
  return Object.fromEntries(Object.entries(values).filter(([fieldKey]) => activeKeys.has(fieldKey)));
}

export function customizationAdjustedUnitPrices(
  product: Product,
  unit: Pick<StorefrontUnitOption, "price" | "salePrice">,
  values: Record<string, string>,
) {
  let delta = BigInt(0);
  for (const field of activeCustomizationFields(product, values)) {
    const value = (values[field.fieldKey] ?? "").trim();
    if (!value) continue;
    const option = field.options.find((candidate) => candidate.value === value);
    delta += moneyToCents(field.priceDelta) ?? BigInt(0);
    delta += moneyToCents(option?.priceDelta) ?? BigInt(0);
  }
  const addDelta = (price: string | null) => {
    const cents = moneyToCents(price);
    return cents == null ? price : centsToMoney(cents + delta);
  };
  return { price: addDelta(unit.price), salePrice: addDelta(unit.salePrice) };
}

export function validateProductSelection(
  product: Product,
  input: ProductSelectionInput,
): { errors: string[]; details: ProductSelectionDetails | null } {
  return validateSelection(product, input, false);
}

/** طلب العرض يلتقط اختيار العميل للتسعير اليدوي، لكنه لا يفتح مسار الشراء المباشر. */
export function validateProductQuoteSelection(
  product: Product,
  input: ProductSelectionInput,
): { errors: string[]; details: ProductSelectionDetails | null } {
  return validateSelection(product, input, true);
}

function validateSelection(
  product: Product,
  input: ProductSelectionInput,
  forQuote: boolean,
): { errors: string[]; details: ProductSelectionDetails | null } {
  const onlineOrderingIssue = productOnlineOrderingIssue(product);
  if (onlineOrderingIssue && !forQuote) {
    return { errors: [onlineOrderingIssue], details: null };
  }
  const errors: string[] = [];
  const variants = product.variants ?? [];
  const variant = variants.find((candidate) => candidate.variantId === input.variantId);
  if (!variant) errors.push("اختر اللون أو البديل المطلوب.");
  else if (!variant.inStock && !forQuote) errors.push("الخيار المحدد نافد حالياً.");

  const unit = variant?.units.find((candidate) => candidate.productUnitId === input.productUnitId);
  if (variant && !unit) errors.push("اختر وحدة البيع المطلوبة.");
  else if (unit && !unit.inStock && !forQuote && !errors.includes("الخيار المحدد نافد حالياً.")) {
    errors.push("وحدة البيع المحددة نافدة حالياً.");
  }

  const customizationValues: ProductSelectionDetails["customization"] extends infer _T
    ? Array<{ fieldKey: string; label: string; value: string; displayValue: string }>
    : never = [];
  for (const field of activeCustomizationFields(product, input.customizationValues)) {
    const value = (input.customizationValues[field.fieldKey] ?? "").trim();
    if (field.isRequired && !value) {
      errors.push(`حقل «${field.label}» مطلوب.`);
      continue;
    }
    if (!value) continue;
    const maxLength = field.maxLength ?? DEFAULT_CUSTOMIZATION_VALUE_MAX_LENGTH;
    if (value.length > maxLength) {
      errors.push(`حقل «${field.label}» يتجاوز ${maxLength} حرفاً.`);
      continue;
    }
    if (field.fieldType === "NUMBER" && !Number.isFinite(Number(value))) {
      errors.push(`حقل «${field.label}» يجب أن يكون رقماً.`);
      continue;
    }
    const option = field.options.find((candidate) => candidate.value === value);
    if ((field.fieldType === "SELECT" || field.fieldType === "SWATCH") && !option) {
      errors.push(`اختر قيمة صحيحة لحقل «${field.label}».`);
      continue;
    }
    customizationValues.push({
      fieldKey: field.fieldKey,
      label: field.label,
      value,
      displayValue: option?.label ?? value,
    });
  }

  if (!variant || !unit || errors.length) return { errors, details: null };
  const adjustedPrices = customizationAdjustedUnitPrices(product, unit, input.customizationValues);
  return {
    errors,
    details: {
      variantId: variant.variantId,
      variantLabel: variant.label,
      variantKind: variant.variantKind,
      productUnitId: unit.productUnitId,
      unitName: unit.unitName,
      unitPrice: adjustedPrices.price,
      unitSalePrice: adjustedPrices.salePrice,
      imageUrl: variant.imageUrl ?? product.imageUrl ?? null,
      customization: product.customizationTemplate
        ? {
            templateId: product.customizationTemplate.id,
            templateTitle: product.customizationTemplate.title,
            values: customizationValues,
          }
        : null,
    },
  };
}

export function cartLineKey(productId: number | string, details: ProductSelectionDetails) {
  const customization = details.customization?.values
    .map(({ fieldKey, value }) => [fieldKey, value] as const)
    .sort(([left], [right]) => left.localeCompare(right)) ?? [];
  return `${productId}:${details.variantId}:${details.productUnitId}:${JSON.stringify(customization)}`;
}

export function buildCartLine(product: Product, details: ProductSelectionDetails): CartLine {
  const selectedUnit = product.variants
    ?.find((variant) => variant.variantId === details.variantId)
    ?.units.find((unit) => unit.productUnitId === details.productUnitId);
  const disclosedStock = selectedUnit?.stockLeft;
  return {
    lineId: cartLineKey(product.productId ?? product.id, details),
    product,
    selectionDetails: details,
    quantity: 1,
    maxQuantity:
      typeof disclosedStock === "number" && disclosedStock >= 0
        ? Math.max(1, Math.floor(disclosedStock))
        : 999,
  };
}

export function selectionDescription(details: ProductSelectionDetails) {
  const parts = [details.variantLabel, details.unitName];
  for (const value of details.customization?.values ?? []) {
    parts.push(`${value.label}: ${value.displayValue}`);
  }
  return parts.join(" • ");
}
