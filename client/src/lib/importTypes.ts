// أنواع صفوف الاستيراد — نسخة عميل خفيفة من server/services/importService.ts
// (لا يمكن استيراد types من الخادم مباشرة عبر حدود client/server في tRPC؛
// نُعرّف هنا الشكل المُتوقَّع للمدخلات بعد القسر).
// شريحة import-integration: حقول النظام القديم (رصيد افتتاحي موقَّع/عملة/رقم قديم/نشط/آخر تعامل/هواتف إضافية)
// + أسعار صريحة لكل فئة ومخزون افتتاحي للمنتجات. الأموال نصوص دائماً (قاعدة decimal.js).

export type CustomerImportRow = {
  name: string;
  phone?: string; // E.164 بعد التطبيع (07… → +9647…)
  phone2?: string;
  phone3?: string;
  whatsapp?: string;
  address?: string;
  city?: string;
  district?: string;
  customerType?: "فرد" | "تاجر" | "مؤسسة" | "شركة" | "حكومي";
  defaultPriceTier?: "RETAIL" | "WHOLESALE" | "GOVERNMENT";
  creditLimit?: string;
  openingBalance?: string; // مال موقَّع نصّاً («-123.45» بعد فكّ الأقواس) — موجب = العميل مدين لنا
  currency?: "IQD" | "USD"; // USD يُحوَّل في الخادم بسعر الصرف usdRate
  legacyCode?: string; // المعرّف الطبيعي من النظام القديم — مفتاح المطابقة الأول
  isActive?: boolean;
  lastDealtAt?: string; // YYYY-MM-DD — يُلحق بالملاحظات في الخادم
  notes?: string;
};

export type SupplierImportRow = {
  name: string;
  phone?: string;
  phone2?: string;
  phone3?: string;
  email?: string;
  whatsapp?: string;
  address?: string;
  city?: string;
  taxId?: string;
  productTypes?: string;
  paymentTerms?: string;
  openingBalance?: string; // موجب (بعد invert الافتراضي) = نحن ندين للمورد (AP)
  currency?: "IQD" | "USD";
  legacyCode?: string;
  isActive?: boolean;
  lastDealtAt?: string;
  notes?: string;
};

export type ProductImportRow = {
  productName: string;
  categoryName?: string;
  isCustomizable?: boolean;
  sku?: string; // اختياري — إن غاب: fallback تلقائي = الباركود (في الخادم)؛ غياب كليهما = خطأ صف
  variantName?: string;
  color?: string;
  size?: string;
  costPrice?: string; // اختياري — افتراضه «0» في الخادم
  unitName?: string; // اختياري — افتراضه «قطعة» ("each" تُطبَّع «قطعة» في العميل)
  conversionFactor?: string; // اختياري — افتراضه «1»
  isBaseUnit?: boolean; // افتراضه المشروط في مرحلة تجميع الخادم (صف وحيد بلا تحديد ⇒ أساس)
  barcode?: string;
  priceTier?: "RETAIL" | "WHOLESALE" | "GOVERNMENT"; // قديم — يبقى للتوافق
  price?: string; // قديم — يبقى للتوافق
  retailPrice?: string; // «سعر البيع» — 0 أو فارغ ⇒ لا يُنشأ سعر للفئة
  wholesalePrice?: string; // «سعر الجملة»
  governmentPrice?: string; // «سعر حكومي»
  openingStock?: number; // عدد صحيح ≥ 0 (السالب قُصّ صفراً في العميل مع تحذير)
};
