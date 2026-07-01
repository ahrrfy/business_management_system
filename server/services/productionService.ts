/**
 * productionService — وحدة الإنتاج/التحويل: تستهلك مدخلات (ورق…) وتُنتج مخرجات (دفتر/كتاب/كيس) **ذرّياً**.
 *
 * مبادئ (§٥):
 *  - **لا قيد محاسبي**: التحويل أصل↔أصل محايد على الربح/الخسارة؛ القيمة محفوظة بحركتَي المخزون
 *    (OUT للمدخلات + IN للمخرجات) وتحديث `costPrice` للمخرَج بالمتوسّط المرجّح (WAVG).
 *  - **كلفة المخرَج المُمتصّة** = (كلفة المواد المُستهلَكة + عمالة اختيارية) موزّعةً على المخرجات،
 *    آخر سطر يمتصّ بقايا التقريب ⇒ Σ allocatedCost == totalCost تماماً.
 *  - WAVG على المخرَج بنفس صيغة استلام الشراء (purchaseService): SUM الرصيد العالمي **قبل** الإدخال.
 *  - ذرّية كاملة عبر withTx؛ نقص أي مدخل ⇒ applyMovement يرمي CONFLICT ⇒ ROLLBACK.
 *
 * أُعيد تنظيم المنطق (كان ٩١٤ سطراً في ملف واحد) إلى وحدات متماسكة تحت server/services/production/*
 * **بلا أي تغيير سلوكي**: نفس الدوال والتواقيع. هذا الملف يعيد تصدير الواجهة العامة فقط كي تبقى
 * كل المستدعيات (productionRouter.ts والاختبار) بلا أي تعديل.
 *
 * خريطة الوحدات:
 *   types    — عقد الإنتاج (عام + داخلي).
 *   calc     — حسابات نقية: تفريق الهدر + تكلفة تشغيل بوصفة (قابلة للاختبار وحدها).
 *   helpers  — تحليل الأسطر/ترقيم المستند/عزل الفرع/توسيع تشغيل بوصفة — داخلية.
 *   create   — إنشاء مستند إنتاج (استهلاك + إنتاج + WAVG + تحقّق حفظ القيمة).
 *   cancel   — إلغاء مستند إنتاج.
 *   queries  — قائمة المستندات + تفاصيل مستند.
 *   preview  — معاينة حيّة لتشغيل بوصفة.
 */

export type { ProductionLineInput, CreateProductionInput, CreateProductionResult, ListProductionFilters, RunPreviewResult } from "./production/types";
export { spoilageSplit, computeRunCosts } from "./production/calc";
export { createProduction } from "./production/create";
export { cancelProduction } from "./production/cancel";
export { listProductions, getProduction } from "./production/queries";
export { runPreview } from "./production/preview";
