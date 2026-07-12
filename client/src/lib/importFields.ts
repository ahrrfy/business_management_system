// تعريفات حقول الاستيراد للعملاء/الموردين/المنتجات.
// تُستهلَك بـ ImportDialog مع handler يستدعي trpc.imports.*
// الـlabels عربية مع aliases إنجليزية ⇒ المستخدمون يمكنهم استعمال قوالب من أي لغة.
// شريحة import-integration: الـaliases تطابق ترويسات ملفات النظام القديم حرفياً
// («الرقم»، «تليفون 1»، «الرصيد»، «حد الإئتمان»، «اخر تعامل»، «الكود»، «سعر البيع»…)
// كي يجد المالك كل عمود من ملفاته باسمه الحقيقي قابلاً للربط تلقائياً.
// ⚠️ «الرصيد» ترويسة واحدة بمعنيين: openingBalance عند العملاء/الموردين وopeningStock عند الأصناف —
// كل كيان له fields مستقلة فلا التباس، والـalias موجود في كلا التعريفين.
// ⚠️ maxLen مرآةُ حدود zod في الخادم (importService.ts): تجاوزها هنا = خطأ صفّي واضح،
// وإلا رفض الخادم دفعة tRPC كاملة بـBAD_REQUEST متجاوزاً skipFailed (النوع phone حدّه ٢٠ تلقائياً).

import type { ImportField, ImportMeta } from "./import";
import type { CustomerImportRow, SupplierImportRow, ProductImportRow } from "./importTypes";

/* ============================ عملاء ============================ */

export const CUSTOMER_FIELDS: ImportField<CustomerImportRow>[] = [
  {
    key: "name",
    label: "الاسم",
    type: "string",
    required: true,
    // «اسم الزبون» تخدم ملف مبيعات مُنظَّفاً ومُجمَّعاً مسبقاً فقط (الخام ٢٠٤ ألف صف — ممنوع تلقيمه مباشرة).
    aliases: ["customer", "customer name", "client", "اسم العميل", "اسم الزبون"],
    maxLen: 255,
    example: "أحمد الكاظمي",
  },
  {
    key: "phone",
    label: "الهاتف",
    type: "phone",
    aliases: ["phone", "mobile", "tel", "موبايل", "جوال", "تليفون 1", "تلفون", "هاتف الزبون"],
    example: "07701234567",
  },
  {
    key: "phone2",
    label: "هاتف 2",
    type: "phone",
    aliases: ["تليفون 2", "phone2", "phone 2"],
  },
  {
    key: "phone3",
    label: "هاتف 3",
    type: "phone",
    aliases: ["تليفون 3", "phone3", "phone 3"],
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
    aliases: ["address", "عنوان الزبون"],
    maxLen: 1000,
  },
  {
    key: "city",
    label: "المدينة",
    type: "string",
    aliases: ["city"],
    maxLen: 100,
  },
  {
    key: "district",
    label: "المنطقة",
    type: "string",
    aliases: ["district", "area", "حي"],
    maxLen: 100,
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
    // normHeader يوحّد الألف ⇒ «حد الإئتمان» (ترويسة الملف الفعلية) و«حد الائتمان» تتطابقان.
    aliases: ["credit limit", "credit", "حد الإئتمان", "حد الائتمان"],
    example: "500000",
  },
  {
    key: "openingBalance",
    label: "الرصيد الافتتاحي",
    type: "moneySigned",
    aliases: ["الرصيد", "balance", "opening balance"],
    example: "250000",
  },
  {
    key: "currency",
    label: "العملة",
    type: "enum",
    enumValues: ["IQD", "USD"],
    aliases: ["العملة", "currency"],
    enumMap: { "دينار": "IQD", "دولار": "USD", "iqd": "IQD", "usd": "USD" },
    example: "IQD",
  },
  {
    key: "legacyCode",
    label: "الرقم القديم",
    type: "string",
    aliases: ["الرقم", "رقم الحساب", "legacy", "old id"],
    maxLen: 40,
    example: "118",
  },
  {
    key: "isActive",
    label: "نشط",
    type: "boolean",
    aliases: ["نشط", "active"],
    example: "نعم",
  },
  {
    key: "lastDealtAt",
    label: "آخر تعامل",
    type: "date",
    // توحيد الألف يجعل «اخر تعامل» (ترويسة الملف) و«آخر تعامل» مفتاحاً واحداً.
    aliases: ["اخر تعامل", "آخر تعامل", "last transaction"],
    example: "2026-01-07",
  },
  {
    key: "notes",
    label: "ملاحظات",
    type: "string",
    aliases: ["notes", "comment"],
    maxLen: 2000,
  },
];

/** وصف سلوكي لاستيراد العملاء — تمرّره شاشة العملاء للحوار (مع تمرير ctx.options فعلياً للخادم). */
export const CUSTOMER_IMPORT_META: ImportMeta = {
  currencyKey: "currency",
  balanceKey: "openingBalance",
  balanceSignDefault: "asIs", // ملف العملاء: موجب = العميل مدين لنا (يطابق AR الجديد)
  supportsServerOptions: true,
  duplicateKeys: { legacy: "legacyCode", phone: "phone", name: "name" },
  balanceHints: { positive: "العميل مدين لنا", negative: "نحن ندين للعميل" },
};

/* ============================ موردون ============================ */
// ⚠️ عمود «حد الإئتمان» في ملف الموردين يُتجاهَل عمداً (كل قيمه 0 ولا حقل creditLimit هنا — لا يُضاف حقل).

export const SUPPLIER_FIELDS: ImportField<SupplierImportRow>[] = [
  {
    key: "name",
    label: "الاسم",
    type: "string",
    required: true,
    aliases: ["supplier", "supplier name", "vendor", "اسم المورد"],
    maxLen: 255,
    example: "مكتبة الحكمة للجملة",
  },
  {
    key: "phone",
    label: "الهاتف",
    type: "phone",
    aliases: ["phone", "mobile", "tel", "تليفون 1", "تلفون"],
    example: "07701234567",
  },
  {
    key: "phone2",
    label: "هاتف 2",
    type: "phone",
    aliases: ["تليفون 2", "phone2", "phone 2"],
  },
  {
    key: "phone3",
    label: "هاتف 3",
    type: "phone",
    aliases: ["تليفون 3", "phone3", "phone 3"],
  },
  {
    key: "email",
    label: "البريد الإلكتروني",
    type: "string",
    aliases: ["email", "e-mail"],
    maxLen: 320,
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
    maxLen: 1000,
  },
  {
    key: "city",
    label: "المدينة",
    type: "string",
    aliases: ["city"],
    maxLen: 100,
  },
  {
    key: "taxId",
    label: "الرقم الضريبي",
    type: "string",
    aliases: ["tax id", "tax number", "vat"],
    maxLen: 50,
  },
  {
    key: "productTypes",
    label: "أنواع المنتجات",
    type: "string",
    aliases: ["products", "categories", "تخصص"],
    maxLen: 1000,
  },
  {
    key: "paymentTerms",
    label: "شروط الدفع",
    type: "string",
    aliases: ["payment terms", "terms"],
    maxLen: 100,
  },
  {
    key: "openingBalance",
    label: "الرصيد الافتتاحي",
    type: "moneySigned",
    // ملف الموردين يعرض ما ندين به بأقواس مربعة «[27,749,996.]» = سالب، أو بسالب صريح.
    aliases: ["الرصيد", "balance", "opening balance"],
    example: "150000",
  },
  {
    key: "currency",
    label: "العملة",
    type: "enum",
    enumValues: ["IQD", "USD"],
    aliases: ["العملة", "currency"],
    enumMap: { "دينار": "IQD", "دولار": "USD", "iqd": "IQD", "usd": "USD" },
    example: "IQD",
  },
  {
    key: "legacyCode",
    label: "الرقم القديم",
    type: "string",
    aliases: ["الرقم", "رقم الحساب", "legacy", "old id"],
    maxLen: 40,
    example: "73",
  },
  {
    key: "isActive",
    label: "نشط",
    type: "boolean",
    aliases: ["نشط", "active"],
    example: "نعم",
  },
  {
    key: "lastDealtAt",
    label: "آخر تعامل",
    type: "date",
    aliases: ["اخر تعامل", "آخر تعامل", "last transaction"],
    example: "2026-05-12",
  },
  {
    key: "notes",
    label: "ملاحظات",
    type: "string",
    aliases: ["notes", "comment"],
    maxLen: 2000,
  },
];

/** وصف سلوكي لاستيراد الموردين — الافتراض «اعكس الإشارة»: ملفهم يعرض ما ندين به بالسالب بينما AP الجديد موجب. */
export const SUPPLIER_IMPORT_META: ImportMeta = {
  currencyKey: "currency",
  balanceKey: "openingBalance",
  balanceSignDefault: "invert",
  supportsServerOptions: true,
  duplicateKeys: { legacy: "legacyCode", phone: "phone", name: "name" },
  balanceHints: { positive: "نحن ندين للمورد", negative: "المورد مدين لنا" },
};

/* ============================ منتجات ============================ */

export const PRODUCT_FIELDS: ImportField<ProductImportRow>[] = [
  {
    key: "productName",
    label: "اسم المنتج",
    type: "string",
    required: true,
    // «الاسم» هي ترويسة ملف الأصناف الفعلية (٩٤١٥ صفاً) — بدونها يُحظر زر الاستيراد بـ«حقول مطلوبة غير مربوطة».
    // «المنتج» = ترويسة تصدير شاشة المنتجات (ذهاب-إياب: الملف المُصدَّر يُربط تلقائياً).
    aliases: ["product", "product name", "name", "الاسم", "اسم الصنف", "المنتج"],
    maxLen: 255,
    example: "ورق A4 80غرام",
  },
  {
    key: "categoryName",
    label: "الفئة",
    type: "string",
    aliases: ["category", "المجموعة", "group"],
    maxLen: 255,
    example: "قرطاسية",
  },
  {
    key: "sku",
    label: "SKU",
    type: "string",
    // اختياري: إن غاب فالـfallback التلقائي = الباركود (يُنفَّذ في الخادم أيضاً)؛ غياب كليهما = خطأ صف.
    // "code" تبقى لهذا الحقل حصراً (لا تُضاف للباركود — تصادم alias = وجهة عمود غير حتمية).
    aliases: ["sku", "code", "كود", "رمز"],
    maxLen: 60,
    example: "PAPER-A4-80",
    validate: (v, row) => {
      const sku = v == null ? "" : String(v).trim();
      const barcode = row.barcode == null ? "" : String(row.barcode).trim();
      return sku === "" && barcode === "" ? "حدّد SKU أو الباركود — كلاهما غائب" : null;
    },
  },
  {
    key: "variantName",
    label: "اسم المتغيّر",
    type: "string",
    aliases: ["variant", "variant name"],
    maxLen: 255,
  },
  {
    key: "color",
    label: "اللون",
    type: "string",
    aliases: ["color"],
    maxLen: 60,
  },
  {
    key: "size",
    label: "القياس",
    type: "string",
    aliases: ["size"],
    maxLen: 60,
  },
  {
    key: "costPrice",
    label: "كلفة الوحدة",
    type: "money",
    // اختياري — افتراضه «0» في الخادم. «سعر الشراء» ترويسة ملف الأصناف الفعلية.
    aliases: ["cost", "cost price", "تكلفة", "سعر الشراء", "التكلفة"],
    example: "12000",
  },
  {
    key: "unitName",
    label: "اسم الوحدة",
    type: "string",
    // اختياري — افتراضه «قطعة». "each" (بأي حالة أحرف) تُطبَّع «قطعة» — واجهة عربية RTL، لا وحدات لاتينية في الفواتير.
    aliases: ["unit", "unit name", "وحدة", "الوحدة"],
    maxLen: 40,
    example: "قطعة",
    transform: (s) => (s.toLowerCase() === "each" ? "قطعة" : s),
  },
  {
    key: "conversionFactor",
    label: "معامل التحويل",
    type: "string",
    // اختياري — افتراضه «1» في الخادم.
    aliases: ["factor", "conversion", "تحويل"],
    example: "1",
    validate: (v) => {
      if (v == null || v === "") return null;
      return /^\d+(\.\d{1,4})?$/.test(String(v)) ? null : "معامل تحويل غير صالح (رقم موجب، حتى 4 أرقام عشرية)";
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
    // «الكود» هي ترويسة ملف الأصناف الفعلية (باركود فريد 100٪) — بلا "code" الإنجليزية (محجوزة لـsku).
    aliases: ["الكود", "الباركود", "barcode", "ean"],
    maxLen: 64,
    example: "6935403104236",
  },
  {
    key: "barcodeAliases",
    label: "بدائل الباركود",
    type: "string",
    // مفصولة بـ«،» أو «,» — مرآة عمود «بدائل الباركود» في تصدير شاشة المنتجات (ذهاب-إياب كامل).
    // على منتج موجود: تُدمَج البدائل الجديدة إضافياً (لا حذف)؛ على جديد: تُنشأ مع الوحدة.
    aliases: ["بدائل", "باركودات بديلة", "aliases", "barcode aliases", "alias"],
    maxLen: 2000,
    example: "6935403104243، 6935403104250",
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
    // قديم — يبقى للتوافق الإنجليزي؛ «سعر البيع» حُذفت من هنا عمداً (وجهتها retailPrice حصراً —
    // وإلا تنازعت الوجهةَ على عمود «سعر البيع» حسب ترتيب إدراج غير منصوص).
    aliases: ["price", "sale price"],
    example: "15000",
  },
  {
    key: "retailPrice",
    label: "سعر البيع",
    type: "money",
    // قيمة 0 أو فارغة ⇒ لا يُنشأ سعر لهذه الفئة (سلوك الخادم).
    // «السعر مفرد» = ترويسة تصدير شاشة المنتجات (ذهاب-إياب).
    aliases: ["سعر المفرد", "السعر مفرد", "retail", "retail price"],
    example: "3500",
  },
  {
    key: "wholesalePrice",
    label: "سعر الجملة",
    type: "money",
    aliases: ["wholesale", "wholesale price"],
    example: "2750",
  },
  {
    key: "governmentPrice",
    label: "سعر حكومي",
    type: "money",
    aliases: ["سعر الدوائر", "government price"],
    example: "3250",
  },
  {
    key: "openingStock",
    label: "المخزون الافتتاحي",
    type: "integer",
    // «الرصيد» هنا = مخزون افتتاحي (لا التباس مع رصيد العملاء/الموردين — مجموعات الحقول منفصلة).
    aliases: ["الرصيد", "المخزون", "stock", "qty"],
    example: "12",
    // سياسة القيم الشاذة (قرار المالك ١١/٦): الرصيد السالب **لا يُستورَد** — خطأ صفّي يُتجاوَز
    // الصفُّ به (مع «تجاوز الفاشلة» الافتراضي) ويبقى في سجلّ الأخطاء؛ الكسري الحقيقي يفشل
    // (يبتلع integer النقطةَ الزائدة «4.»).
    rejectNegative: true,
    negativeError: "رصيد سالب في النظام القديم — لم يُستورَد الصف؛ صحّح الرصيد ثم استورده وحده",
  },
];

/** وصف سلوكي لاستيراد المنتجات: تجميع الدفعات بالاسم + فحص تعارض sku — بلا خيارات خادمية
 *  (Products.tsx لا تمرّر ctx.options بعد — مفتاح يظهر بلا أثر خادمي = وعد كاذب). */
export const PRODUCT_IMPORT_META: ImportMeta = {
  batchGroupByKey: "productName",
  supportsServerOptions: false,
  // barcode/unit: فحص تكرار الباركود للملف كاملاً (مرآة كشف الخادم الذي يعمل داخل النداء الواحد فقط).
  skuConflictKeys: { sku: "sku", fallback: "barcode", owner: "productName", barcode: "barcode", unit: "unitName" },
};
