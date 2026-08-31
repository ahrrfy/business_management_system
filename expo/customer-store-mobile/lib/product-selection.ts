import type {
  CartLine,
  Product,
  ProductSelectionDetails,
  StorefrontCustomizationField,
} from "@/shared/storefront";

export type ProductSelectionInput = {
  variantId: number | null;
  productUnitId: number | null;
  customizationValues: Record<string, string>;
};

export const DEFAULT_CUSTOMIZATION_VALUE_MAX_LENGTH = 500;
export const CUSTOMIZABLE_ORDERING_UNAVAILABLE_MESSAGE =
  "هذا المنتج يحتاج تخصيصاً يراجعه فريق المكتبة، وهو غير متاح للطلب الإلكتروني مؤقتاً. تواصل مع المكتبة لإتمام الطلب.";

export function productOnlineOrderingIssue(product: Product): string | null {
  return product.isCustomizable
    ? CUSTOMIZABLE_ORDERING_UNAVAILABLE_MESSAGE
    : null;
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
  return [...(product.customizationTemplate?.fields ?? [])]
    .sort((left, right) => left.sortOrder - right.sortOrder)
    .filter((field) => dependencyMatches(field, values));
}

export function validateProductSelection(
  product: Product,
  input: ProductSelectionInput,
): { errors: string[]; details: ProductSelectionDetails | null } {
  const onlineOrderingIssue = productOnlineOrderingIssue(product);
  if (onlineOrderingIssue) {
    return { errors: [onlineOrderingIssue], details: null };
  }
  const errors: string[] = [];
  const variants = product.variants ?? [];
  const variant = variants.find((candidate) => candidate.variantId === input.variantId);
  if (!variant) errors.push("اختر اللون أو البديل المطلوب.");
  else if (!variant.inStock) errors.push("الخيار المحدد نافد حالياً.");

  const unit = variant?.units.find((candidate) => candidate.productUnitId === input.productUnitId);
  if (variant && !unit) errors.push("اختر وحدة البيع المطلوبة.");
  else if (unit && !unit.inStock && !errors.includes("الخيار المحدد نافد حالياً.")) {
    errors.push("وحدة البيع المحددة نافدة حالياً.");
  }

  const customizationValues: ProductSelectionDetails["customization"] extends infer _T
    ? Array<{ fieldKey: string; label: string; value: string; displayValue: string }>
    : never = [];
  for (const field of activeCustomizationFields(product, input.customizationValues)) {
    const value = (input.customizationValues[field.fieldKey] ?? "").trim();
    if (field.fieldType === "FILE") {
      if (field.isRequired) errors.push(`رفع ملف «${field.label}» غير متاح حتى يجهّز الخادم قناة رفع آمنة.`);
      continue;
    }
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
    const priceDelta = Number(field.priceDelta || 0) + Number(option?.priceDelta || 0);
    if (Number.isFinite(priceDelta) && priceDelta !== 0) {
      errors.push(`لا يمكن تسعير «${field.label}» بأمان في هذا الإصدار. تواصل مع المكتبة لإكماله.`);
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
  return {
    errors,
    details: {
      variantId: variant.variantId,
      variantLabel: variant.label,
      variantKind: variant.variantKind,
      productUnitId: unit.productUnitId,
      unitName: unit.unitName,
      unitPrice: unit.price,
      unitSalePrice: unit.salePrice,
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
