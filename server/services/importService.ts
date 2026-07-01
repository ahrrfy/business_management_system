// خدمة الاستيراد بالجملة (بيانات أساسية فقط: عملاء/موردون/منتجات) — نقطة الدخول العامة.
//
// أُعيد تنظيم المنطق (كان ١٠٠٥ أسطراً في ملف واحد) إلى وحدات متماسكة تحت server/services/import/*
// **بلا أي تغيير سلوكي**: نفس الدوال والتواقيع. هذا الملف يعيد تصدير الواجهة العامة فقط كي تبقى
// كل المستدعيات (routers/imports.ts والاختبار) بلا أي تعديل.
//
// النمط: تحقّق كامل أولاً ⇒ إن وُجد أي فشل لا تُكتب أي بيانات (الكل أو لا شيء) ⇒ وإلا فالكتابة
// داخل withTx واحد. خيار skipFailed (§٥.٤): يكتب الصفوف/المجموعات الصالحة فقط في معاملة واحدة
// والفاشلة تبقى فاشلة في الملخّص. الأموال نصاً عبر toDbMoney (قاعدة §٥).
//
// خريطة الوحدات:
//   types            — عقد الاستيراد المشترك (Options/RowResult/Summary) — داخلية.
//   schemas          — مخططات zod لصفوف الاستيراد الثلاثة + سعر الصرف.
//   helpers          — تسجيل الدفعة/الملخّص/تعريب رسائل الفشل — داخلية عدا writeErrorMessage.
//   balanceSemantics — دلالات الرصيد الافتتاحي المشتركة (عملاء/موردون) + مفتاح تكرار الدفعة — داخلية.
//   customers        — استيراد العملاء.
//   suppliers        — استيراد الموردين.
//   products         — استيراد المنتجات (شجرة ٤ جداول).

export type { OnExisting, BalanceSign, ImportOptions, ImportRowResult, ImportSummary } from "./import/types";
export {
  usdRateStr,
  customerImportRow,
  supplierImportRow,
  productImportRow,
} from "./import/schemas";
export type { CustomerImportRow, SupplierImportRow, ProductImportRow } from "./import/schemas";
export { writeErrorMessage } from "./import/helpers";
export { importCustomers } from "./import/customers";
export { importSuppliers } from "./import/suppliers";
export { importProducts } from "./import/products";
