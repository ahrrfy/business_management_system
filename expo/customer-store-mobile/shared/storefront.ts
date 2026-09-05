import type MaterialIcons from "@expo/vector-icons/MaterialIcons";
import type { ComponentProps } from "react";

type MaterialIconName = ComponentProps<typeof MaterialIcons>["name"];

export type StorefrontUnitOption = {
  productUnitId: number;
  unitName: string;
  conversionFactor: string;
  price: string | null;
  salePrice: string | null;
  promotionName: string | null;
  inStock: boolean;
  stockLeft: number | null;
};

export type StorefrontVariantOption = {
  variantId: number;
  label: string;
  variantName: string | null;
  variantKind: "VARIANT" | "ALTERNATIVE";
  color: string | null;
  colorHex: string | null;
  size: string | null;
  inStock: boolean;
  imageUrls: string[];
  imageUrl: string | null;
  units: StorefrontUnitOption[];
};

export type StorefrontCustomizationField = {
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
};

export type StorefrontCustomizationTemplate = {
  id: number;
  kind: "PRINT" | "GIFT" | "GENERAL";
  title: string;
  description: string | null;
  fields: StorefrontCustomizationField[];
};

export type ProductSelectionDetails = {
  variantId: number;
  variantLabel: string;
  variantKind: "VARIANT" | "ALTERNATIVE";
  productUnitId: number;
  unitName: string;
  unitPrice: string | null;
  unitSalePrice: string | null;
  imageUrl: string | null;
  customization: null | {
    templateId: number;
    templateTitle: string;
    values: Array<{
      fieldKey: string;
      label: string;
      value: string;
      displayValue: string;
    }>;
  };
};

export type Product = {
  id: string;
  productId?: number;
  productUnitId?: number;
  variantId?: number;
  title: string;
  subtitle: string;
  categoryId: string;
  description: string;
  icon: MaterialIconName;
  accent: string;
  availability: "متوفر" | "متوفر قريباً";
  price?: string | null;
  salePrice?: string | null;
  imageUrl?: string | null;
  imageUrls?: string[];
  brand?: string | null;
  promotionName?: string | null;
  soldCount?: number;
  stockLeft?: number | null;
  isBundle?: boolean;
  bundleImageUrls?: string[];
  bundleItems?: { name: string; quantity: number }[];
  inStock?: boolean;
  isCustomizable?: boolean;
  customizationKind?: "PRINT" | "GIFT" | null;
  customizationTemplate?: StorefrontCustomizationTemplate | null;
  colors?: { name: string; hex: string; inStock: boolean }[];
  storeUnits?: StorefrontUnitOption[];
  variants?: StorefrontVariantOption[];
  hasAlternatives?: boolean;
};

export type CartLine = {
  lineId: string;
  product: Product;
  selectionDetails: ProductSelectionDetails;
  quantity: number;
  maxQuantity: number;
};
