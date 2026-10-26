import React from "react";
import {
  DEFAULT_STOREFRONT_CUSTOMIZATION_MAX_LENGTH,
  serializeStorefrontCustomizationIdentity,
} from "@/pages/store/storefrontCustomization";

export function storefrontTurnstileSubmissionReady(
  orderingEnabled: boolean,
  siteKey: string | null | undefined,
  token: string | null | undefined,
): boolean {
  return orderingEnabled && !!siteKey?.trim() && !!token?.trim();
}

export function createStorefrontCatalogSeedBucket(
  now: number = Date.now(),
): string {
  return `sf-${Math.floor(now / (15 * 60 * 1000))}`;
}

export type StorefrontCustomizationKind = "PRINT" | "GIFT";

export type StorefrontCustomizationField = {
  id: number;
  fieldKey: string;
  label: string;
  fieldType: "TEXT" | "TEXTAREA" | "SELECT" | "FILE" | "NUMBER" | "SWATCH";
  isRequired: boolean;
  sortOrder: number;
  maxLength: number | null;
  options: { value: string; label: string; priceDelta: string }[];
  dependency: {
    fieldKey: string;
    operator: "equals" | "notEquals";
    value: string | string[];
  } | null;
  priceDelta: string;
  isActive?: boolean;
};

export type StorefrontCustomizationTemplate = {
  id: number;
  kind: StorefrontCustomizationKind | "GENERAL";
  title: string;
  description: string | null;
  fields: StorefrontCustomizationField[];
};

export type StorefrontCustomization = {
  templateId: number;
  kind: StorefrontCustomizationKind;
  values?: Record<string, string>;
  logoAssetKey?: string;
  previewAssetKey?: string;
  selections?: Array<{
    fieldKey: string;
    label: string;
    value: string;
    displayValue: string;
  }>;
  priceDelta?: string;
  service?: string;
  serviceLabel?: string;
  packaging?: "standard" | "gift";
  recipient?: string;
  message?: string;
  uploadName?: string;
};

export type StorefrontCustomizationOrderPayload = {
  templateId: number;
  values: Record<string, string>;
  logoAssetKey?: string;
  previewAssetKey?: string;
};

export function buildStorefrontCustomizationPayload(
  customization?: StorefrontCustomization,
): StorefrontCustomizationOrderPayload | undefined {
  if (!customization) return undefined;
  return {
    templateId: customization.templateId,
    values: customization.values ?? {},
    logoAssetKey: customization.logoAssetKey?.trim() || undefined,
    previewAssetKey: customization.previewAssetKey?.trim() || undefined,
  };
}

export type StorefrontCustomizationConfig = {
  id: number;
  kind: StorefrontCustomizationKind;
  title: string;
  description: string | null;
  fields: StorefrontCustomizationField[];
};

export function getStorefrontCustomizationConfig(
  isCustomizable: boolean,
  customizationKind: "PRINT" | "GIFT" | null | undefined,
  template?: StorefrontCustomizationTemplate | null,
): StorefrontCustomizationConfig | null {
  if (!isCustomizable || !customizationKind || !template) return null;
  if (template.kind !== customizationKind && template.kind !== "GENERAL")
    return null;
  return {
    id: template.id,
    kind: customizationKind,
    title: template.title,
    description: template.description,
    fields: template.fields
      .filter((field) => field.isActive !== false)
      .sort((a, b) => a.sortOrder - b.sortOrder),
  };
}

export function CustomizationFieldControl({
  field,
  value,
  onChange,
  controlId,
  labelId,
  describedBy,
  invalid = false,
}: {
  field: StorefrontCustomizationField;
  value: string;
  onChange: (value: string) => void;
  controlId: string;
  labelId: string;
  describedBy?: string;
  invalid?: boolean;
}) {
  const common =
    "mt-1.5 w-full rounded-xl border border-[#ead8c8] bg-white px-3 py-2 text-xs font-bold text-[#30383e] outline-none transition focus:border-[#e65f4a]";
  if (field.fieldType === "SELECT") {
    // ⛔ يبقى `<select>` خامّاً عمداً (لا AppSelect): حقول التخصيص كلّها تتقاسم `common` نفسه —
    // input/textarea/select بارتفاعٍ واحد (~٣٢px) وهويّة المتجر (rounded-xl + لوحة #ead8c8).
    // وارتفاعُ AppSelect مربوطٌ بمقياس الراحة (`--ui-control` = 44px) بأولويّةٍ لا يهزمها صنفٌ
    // من الخارج ⇒ سيصير المنتقي جزيرةً أطول من جيرانه داخل النموذج نفسه. راجع تبرير الموجة.
    return (
      <select
        id={controlId}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        required={field.isRequired}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        className={common}
      >
        <option value="">اختر {field.label}</option>
        {field.options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
            {option.priceDelta !== "0" ? ` (+${option.priceDelta} د.ع)` : ""}
          </option>
        ))}
      </select>
    );
  }
  if (field.fieldType === "SWATCH") {
    return (
      <div
        className="mt-1.5 flex flex-wrap gap-1.5"
        role="radiogroup"
        aria-labelledby={labelId}
        aria-required={field.isRequired}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
      >
        {field.options.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={value === option.value}
            onClick={() => onChange(option.value)}
            className={`min-h-11 rounded-full border px-3 py-1.5 text-xs font-bold transition ${value === option.value ? "border-[#25406f] bg-[#25406f] text-white" : "border-[#ead8c8] bg-white text-[#5b5147] hover:border-[#e65f4a]"}`}
          >
            {option.label}
            {option.priceDelta !== "0" ? ` · +${option.priceDelta}` : ""}
          </button>
        ))}
      </div>
    );
  }
  if (field.fieldType === "TEXTAREA") {
    return (
      <textarea
        id={controlId}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        required={field.isRequired}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        maxLength={
          field.maxLength ?? DEFAULT_STOREFRONT_CUSTOMIZATION_MAX_LENGTH
        }
        rows={3}
        placeholder={field.label}
        className={`${common} resize-none placeholder:text-[#6c747b]`}
      />
    );
  }
  return (
    <input
      id={controlId}
      type={field.fieldType === "NUMBER" ? "number" : "text"}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      required={field.isRequired}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      maxLength={field.maxLength ?? DEFAULT_STOREFRONT_CUSTOMIZATION_MAX_LENGTH}
      inputMode={field.fieldType === "NUMBER" ? "numeric" : undefined}
      placeholder={
        field.fieldType === "FILE" ? "اسم الملف أو مرجع التصميم" : field.label
      }
      className={`${common} placeholder:text-[#6c747b]`}
    />
  );
}

export function customizationCartKey(
  productUnitId: number,
  customization?: StorefrontCustomization,
): string {
  return `${productUnitId}:${serializeStorefrontCustomizationIdentity(customization)}`;
}

export function summarizeStorefrontCustomization(
  customization?: StorefrontCustomization,
): string | null {
  if (!customization) return null;
  if (customization.selections?.length) {
    return customization.selections
      .map((selection) => `${selection.label}: ${selection.displayValue}`)
      .join(" • ");
  }
  return (
    [
      customization.service,
      customization.packaging === "gift" ? "تغليف هدية" : null,
      customization.recipient ? `إلى: ${customization.recipient}` : null,
      customization.message ? `رسالة: ${customization.message}` : null,
      customization.uploadName ? `ملف: ${customization.uploadName}` : null,
    ]
      .filter(Boolean)
      .join(" • ") || null
  );
}
