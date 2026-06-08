// أنواع صفوف الاستيراد — نسخة عميل خفيفة من server/services/importService.ts
// (لا يمكن استيراد types من الخادم مباشرة عبر حدود client/server في tRPC؛
// نُعرّف هنا الشكل المُتوقَّع للمدخلات بعد القسر).

export type CustomerImportRow = {
  name: string;
  phone?: string;
  whatsapp?: string;
  address?: string;
  city?: string;
  district?: string;
  customerType?: "فرد" | "تاجر" | "مؤسسة" | "شركة" | "حكومي";
  defaultPriceTier?: "RETAIL" | "WHOLESALE" | "GOVERNMENT";
  creditLimit?: string;
  notes?: string;
};

export type SupplierImportRow = {
  name: string;
  phone?: string;
  email?: string;
  whatsapp?: string;
  address?: string;
  city?: string;
  taxId?: string;
  productTypes?: string;
  paymentTerms?: string;
  notes?: string;
};

export type ProductImportRow = {
  productName: string;
  categoryName?: string;
  isCustomizable?: boolean;
  sku: string;
  variantName?: string;
  color?: string;
  size?: string;
  costPrice: string;
  unitName: string;
  conversionFactor: string;
  isBaseUnit?: boolean;
  barcode?: string;
  priceTier?: "RETAIL" | "WHOLESALE" | "GOVERNMENT";
  price?: string;
};
