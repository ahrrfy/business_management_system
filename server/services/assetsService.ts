/* ============================================================================
 * خدمة الأصول الثابتة — منطق الأعمال وحساب الإهلاك — نقطة الدخول العامة.
 * ----------------------------------------------------------------------------
 * يتبع اتفاقيات النظام (§٥): كل عملية كتابة متعددة داخل withTx (ذرّية)، والمبالغ
 * المحفوظة عبر toDbMoney (نصّ decimal). الإهلاك قيمة تحليلية تُحسب عند القراءة ولا
 * تُخزَّن (تتغيّر بمرور الزمن) — منطقه مطابق ١:١ لنموذج التصميم (assets/data.js → computeDep).
 *
 * أُعيد تنظيم المنطق (كان ٧٥٥ سطراً في ملف واحد) إلى وحدات متماسكة تحت server/services/assets/*
 * **بلا أي تغيير سلوكي**: نفس الدوال والتواقيع. هذا الملف يعيد تصدير الواجهة العامة فقط كي تبقى
 * كل المستدعيات (assetsRouter.ts والاختبارات) بلا أي تعديل.
 *
 * خريطة الوحدات:
 *   depreciation         — حساب الإهلاك (sl/db) — نقي وقابل للاختبار وحده.
 *   helpers              — تحميل الأصل تحت قفل صفّ — داخلية.
 *   queries              — القائمة/أصل منفرد/خيارات النماذج.
 *   create                — إنشاء أصل (ترقيم + قيد اقتناء + عهدة ابتدائية).
 *   update               — تعديل بيانات أصل قائم.
 *   lifecycle            — تسليم عهدة + تسجيل/إنهاء صيانة.
 *   dispose              — إخراج/استبعاد مع ربح/خسارة.
 *   monthlyDepreciation  — FI-02 الإهلاك الشهري (catch-up + idempotent).
 *   reports              — لوحة المؤشّرات + تقرير العهد + سجلّ الاستبعاد.
 * ========================================================================== */

export type { DepRow, DepResult } from "./assets/depreciation";
export { computeDepreciation } from "./assets/depreciation";
export type { AssetFilters } from "./assets/queries";
export { listAssets, getAsset, formOptions } from "./assets/queries";
export type { CreateAssetInput } from "./assets/create";
export { createAsset } from "./assets/create";
export type { UpdateAssetInput } from "./assets/update";
export { updateAsset } from "./assets/update";
export type { MaintenanceInput } from "./assets/lifecycle";
export { handoverCustody, addMaintenance, returnFromMaintenance } from "./assets/lifecycle";
export type { DisposeInput } from "./assets/dispose";
export { disposeAsset } from "./assets/dispose";
export type { DepreciationRunResult } from "./assets/monthlyDepreciation";
export { postMonthlyDepreciation } from "./assets/monthlyDepreciation";
export { dashboard, custodyReport, disposalLog } from "./assets/reports";
