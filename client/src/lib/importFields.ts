// تعريفات حقول الاستيراد للعملاء/الموردين/المنتجات.
// تُستهلَك بـ ImportDialog مع handler يستدعي trpc.imports.*
// الـlabels عربية مع aliases إنجليزية ⇒ المستخدمون يمكنهم استعمال قوالب من أي لغة.

import type { ImportField } from "./import";
import type { CustomerImportRow, SupplierImportRow, ProductImportRow } from "./importTypes";

/* ============================ عملاء ============================ */

export const CUSTOMER_FIELDS: ImportField<CustomerImportRow>[] = [
  {
    key: "name",
    label: "الاسم",
    type: "string",
    required: true,
    aliases: ["customer", "customer name", "client", "اسم العميل"],
    example: "أحمد الكاظمي",
  },
  {
    key: "phone",
    label: "الهاتف",
    type: "phone",
    aliases: ["phone", "mobile", "tel", "موبايل", "جوال"],
    example: "07701234567",
  },
  {
    key: "whatsapp",
    label: "واتساب",
    type: "phone",
    aliases: ["whatsapp", "wa"],
  },
  {
    key: "address",
    label: "العنوان",
    type: "string",
    aliases: ["address"],
  },
  {
    key: "city",
    label: "المدينة",
    type: "string",
    aliases: ["city"],
  },
  {
    key: "district",
    label: "المنطقة",
    type: "string",
    aliases: ["district", "area", "حي"],
  },
  {
    key: "customerType",
    label: "النوع",
    type: "enum",
    enumValues: ["فرد", "تاجر", "مؤسسة", "شركة", "حكومي"],
    aliases: ["type", "نوع العميل"],
    enumMap: {
      "individual": "فرد", "personal": "فرد",
      "trader": "تاجر", "merchant": "تاجر",
      "company": "شركة", "corp": "شركة",
      "government": "حكومي", "gov": "حكومي",
      "institution": "مؤسسة",
    },
  },
  {
    key: "defaultPriceTier",
    label: "فئة السعر",
    type: "enum",
    enumValues: ["RETAIL", "WHOLESALE", "GOVERNMENT"],
    aliases: ["price tier", "tier", "السعر الافتراضي"],
    enumMap: {
      "retail": "RETAIL", "مفرد": "RETAIL", "تجزئة": "RETAIL",
      "wholesale": "WHOLESALE", "جملة": "WHOLESALE",
      "government": "GOVERNMENT", "حكومي": "GOVERNMENT",
    },
  },
  {
    key: "creditLimit",
    label: "سقف الائتمان",
    type: "money",
    aliases: ["credit limit", "credit"],
    example: "500000",
  },
  {
    key: "notes",
    label: "ملاحظات",
    type: "string",
    aliases: ["notes", "comment"],
  },
];

/* ============================ موردون ============================ */

export const SUPPLIER_FIELDS: ImportField<SupplierImportRow>[] = [
  {
    key: "name",
    label: "الاسم",
    type: "string",
    required: true,
    aliases: ["supplier", "supplier name", "vendor", "اسم المورد"],
    example: "مكتبة الحكمة للجملة",
  },
  {
    key: "phone",
    label: "الهاتف",
    type: "phone",
    aliases: ["phone", "mobile", "tel"],
  },
  {
    key: "email",
    label: "البريد الإلكتروني",
    type: "string",
    aliases: ["email", "e-mail"],
    validate: (v) => {
      if (v == null || v === "") return null;
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v)) ? null : "بريد إلكتروني غير صالح";
    },
  },
  {
    key: "whatsapp",
    label: "واتساب",
    type: "phone",
    aliases: ["whatsapp", "wa"],
  },
  {
    key: "address",
    label: "العنوان",
    type: "string",
    aliases: ["address"],
  },
  {
    key: "city",
    label: "المدينة",
    type: "string",
    aliases: ["city"],
  },
  {
    key: "taxId",
    label: "الرقم الضريبي",
    type: "string",
    aliases: ["tax id", "tax number", "vat"],
  },
  {
    key: "productTypes",
    label: "أنواع المنتجات",
    type: "string",
    aliases: ["products", "categories", "تخصص"],
  },
  {
    key: "paymentTerms",
    label: "شروط الدفع",
    type: "string",
    aliases: ["payment terms", "terms"],
  },
  {
    key: "notes",
    label: "ملاحظات",
    type: "string",
    aliases: ["notes", "comment"],
  },
];

/* ============================ منتجات ============================ */

export const PRODUCT_FIELDS: ImportField<ProductImportRow>[] = [
  {
    key: "productName",
    label: "اسم المنتج",
    type: "string",
    required: true,
    aliases: ["product", "product name", "name"],
    example: "ورق A4 80غرام",
  },
  {
    key: "categoryName",
    label: "الفئة",
    type: "string",
    aliases: ["category"],
    example: "قرطاسية",
  },
  {
    key: "sku",
    label: "SKU",
    type: "string",
    required: true,
    aliases: ["sku", "code", "كود", "رمز"],
    example: "PAPER-A4-80",
  },
  {
    key: "variantName",
    label: "اسم المتغيّر",
    type: "string",
    aliases: ["variant", "variant name"],
  },
  {
    key: "color",
    label: "اللون",
    type: "string",
    aliases: ["color"],
  },
  {
    key: "size",
    label: "القياس",
    type: "string",
    aliases: ["size"],
  },
  {
    key: "costPrice",
    label: "كلفة الوحدة",
    type: "money",
    required: true,
    aliases: ["cost", "cost price", "تكلفة"],
    example: "12000",
  },
  {
    key: "unitName",
    label: "اسم الوحدة",
    type: "string",
    required: true,
    aliases: ["unit", "unit name", "وحدة"],
    example: "قطعة",
  },
  {
    key: "conversionFactor",
    label: "معامل التحويل",
    type: "string",
    required: true,
    aliases: ["factor", "conversion", "تحويل"],
    example: "1",
    validate: (v) => {
      if (v == null) return "حقل مطلوب";
      return /^\d+(\.\d{1,4})?$/.test(String(v)) ? null : "معامل تحويل غير صالح (رقم موجب، حتى ٤ أرقام عشرية)";
    },
  },
  {
    key: "isBaseUnit",
    label: "وحدة الأساس",
    type: "boolean",
    aliases: ["base unit", "base", "أساس"],
    example: "نعم",
  },
  {
    key: "barcode",
    label: "الباركود",
    type: "string",
    aliases: ["barcode", "ean"],
  },
  {
    key: "priceTier",
    label: "فئة السعر",
    type: "enum",
    enumValues: ["RETAIL", "WHOLESALE", "GOVERNMENT"],
    aliases: ["tier", "price tier"],
    enumMap: {
      "retail": "RETAIL", "مفرد": "RETAIL", "تجزئة": "RETAIL",
      "wholesale": "WHOLESALE", "جملة": "WHOLESALE",
      "government": "GOVERNMENT", "حكومي": "GOVERNMENT",
    },
  },
  {
    key: "price",
    label: "السعر",
    type: "money",
    aliases: ["price", "sale price", "سعر البيع"],
    example: "15000",
  },
];
