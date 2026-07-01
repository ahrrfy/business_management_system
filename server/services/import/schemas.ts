// مخططات zod لصفوف الاستيراد الثلاثة + سعر الصرف.
import { z } from "zod";
import { money } from "../money";

const moneyStr = z.string().trim().regex(/^\d+(\.\d{1,2})?$/, "قيمة مالية غير صالحة");
// رصيد موقَّع (§٥.١): العميل يحوّل صيغ الأقواس [123]/(123) إلى سالب صريح قبل الإرسال — الخادم يقبل السالب الصريح فقط.
const moneySignedStr = z.string().trim().regex(/^-?\d+(\.\d{1,2})?$/, "قيمة مالية غير صالحة");
const dateStr = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "تاريخ غير صالح (الصيغة: YYYY-MM-DD)");
const currencyEnum = z.enum(["IQD", "USD"]);
const phoneStr = z.string().trim().max(20);
// تصدير داخلي للحزمة فقط (يستهلكه products.ts لـ z.infer) — لا يُعاد تصديره من البرميل importService.ts.
export const priceTier = z.enum(["RETAIL", "WHOLESALE", "GOVERNMENT"]);
const customerType = z.enum(["فرد", "تاجر", "مؤسسة", "شركة", "حكومي"]);

/** سعر صرف الدولار: موجب حصراً — الإنفاذ صريح في المخطط (§٥.١)؛ سعر صفري يكتب أرصدة صفرية بصمت لو نُسي.
 *  (حارس النمط داخل refine ضروري: zod v4 يشغّل كل الفحوص حتى بعد فشل regex، وmoney() يرمي على غير الرقمي.) */
const USD_RATE_RE = /^\d+(\.\d{1,2})?$/;
export const usdRateStr = z
  .string()
  .trim()
  .regex(USD_RATE_RE, "سعر صرف غير صالح")
  .refine((v) => !USD_RATE_RE.test(v) || money(v).gt(0), "سعر صرف غير صالح");

export const customerImportRow = z.object({
  rowNumber: z.number().int().positive(),
  name: z.string().trim().min(1).max(255),
  phone: phoneStr.optional(),
  phone2: phoneStr.optional(),
  phone3: phoneStr.optional(),
  whatsapp: phoneStr.optional(),
  address: z.string().trim().max(1000).optional(),
  city: z.string().trim().max(100).optional(),
  district: z.string().trim().max(100).optional(),
  customerType: customerType.optional(),
  defaultPriceTier: priceTier.optional(),
  creditLimit: moneyStr.optional(),
  // إضافات تكامل الاستيراد (§٥.١): رصيد افتتاحي موقَّع + عملته + المعرّف القديم + نشط + آخر تعامل.
  openingBalance: moneySignedStr.optional(),
  currency: currencyEnum.optional(),
  legacyCode: z.string().trim().max(40).optional(),
  isActive: z.boolean().optional(),
  lastDealtAt: dateStr.optional(),
  notes: z.string().trim().max(2000).optional(),
});
export type CustomerImportRow = z.infer<typeof customerImportRow>;

export const supplierImportRow = z.object({
  rowNumber: z.number().int().positive(),
  name: z.string().trim().min(1).max(255),
  phone: phoneStr.optional(),
  phone2: phoneStr.optional(),
  phone3: phoneStr.optional(),
  email: z.string().trim().email("بريد غير صالح").max(320).optional(),
  whatsapp: phoneStr.optional(),
  address: z.string().trim().max(1000).optional(),
  city: z.string().trim().max(100).optional(),
  taxId: z.string().trim().max(50).optional(),
  productTypes: z.string().trim().max(1000).optional(),
  paymentTerms: z.string().trim().max(100).optional(),
  // نفس إضافات العملاء — بلا creditLimit عمداً (عمود «حد الإئتمان» في ملف الموردين كله أصفار ويُتجاهَل، §٤.٢).
  openingBalance: moneySignedStr.optional(),
  currency: currencyEnum.optional(),
  legacyCode: z.string().trim().max(40).optional(),
  isActive: z.boolean().optional(),
  lastDealtAt: dateStr.optional(),
  notes: z.string().trim().max(2000).optional(),
});
export type SupplierImportRow = z.infer<typeof supplierImportRow>;

export const productImportRow = z.object({
  rowNumber: z.number().int().positive(),
  productName: z.string().trim().min(1).max(255),
  categoryName: z.string().trim().max(255).optional(),
  isCustomizable: z.boolean().optional(),
  // sku اختياري (§٥.١): إن غاب فالبديل التلقائي = الباركود؛ كلاهما غائب ⇒ فشل الصف (يُنفَّذ في importProducts).
  sku: z.string().trim().min(1).max(60).optional(),
  variantName: z.string().trim().max(255).optional(),
  color: z.string().trim().max(60).optional(),
  size: z.string().trim().max(60).optional(),
  costPrice: moneyStr.default("0"),
  unitName: z.string().trim().min(1).max(40).default("قطعة"),
  conversionFactor: z.string().trim().regex(/^\d+(\.\d{1,4})?$/, "معامل تحويل غير صالح").default("1"),
  // isBaseUnit بلا افتراض هنا: افتراضه المشروط يُنفَّذ في مرحلة التجميع (§٥.١ — التحقق الصفّي لا يرى سياق المجموعة).
  isBaseUnit: z.boolean().optional(),
  barcode: z.string().trim().max(64).optional(),
  priceTier: priceTier.optional(),
  price: moneyStr.optional(),
  // أسعار صريحة (§٤.٢/§٥.٣): قيمة 0 أو فارغة ⇒ لا يُنشأ سعر لهذه الفئة.
  retailPrice: moneyStr.optional(),
  wholesalePrice: moneyStr.optional(),
  governmentPrice: moneyStr.optional(),
  // مخزون افتتاحي بالوحدة الأساس: السالب يقصّه العميل صفراً بتحذير، والكسري يُرفض هنا.
  openingStock: z.number().int("المخزون الافتتاحي يجب أن يكون عدداً صحيحاً").min(0, "المخزون الافتتاحي لا يكون سالباً").optional(),
});
export type ProductImportRow = z.infer<typeof productImportRow>;
