// أسعار بداية اليوم (ش٤) — نقطة الدخول العامة.
//
// أُعيد تنظيم المنطق (كان ١٠١٨ سطراً في ملف واحد) إلى وحدات متماسكة في نفس المجلّد
// **بلا أي تغيير سلوكي**: نفس الدوال والتواقيع. هذا الملف يعيد تصدير الواجهة العامة فقط كي يبقى
// `digitalCards/index.ts` (`export * as pricingService from "./pricingService"`) وكل مستوردٍ عبره
// (الراوتر + اختبارا digitalCardsPricing/digitalCardsBigChange) بلا أي تعديل.
//
// خريطة الوحدات:
//   pricingShared     — أنواع مشتركة (SheetScope/DraftLineInput) + أدوات أساس (activeOfferings،
//                        priceFor، lockBatch، assertScopeExists، auditLog).
//   pricingBigChange  — كشف «التغيير الكبير» (§٧.١): العتبة، المقارنة، الحصص النافذة.
//   pricingDraft      — دورة حياة المسودّة: الكشف، المعاينة، الإنشاء/النسخ، الحفظ، الاعتماد، الإلغاء.
//   pricingPublish    — النشر الذرّي (١١ خطوة، §٧.٤).
//   pricingMismatch   — بلاغ «السعر لدى الجهاز مختلف» (§٧.٥) واعتماده/رفضه.
export { BIG_CHANGE_THRESHOLD_PERCENT, type BigChangeLine } from "./pricingBigChange";
export type { SheetScope, DraftLineInput } from "./pricingShared";
export {
  getMorningSheet,
  previewPrices,
  createOrGetDraft,
  copyPrevious,
  approveBigChange,
  saveDraft,
  cancelDraft,
} from "./pricingDraft";
export { publish } from "./pricingPublish";
export {
  reportMismatch,
  listMismatchReports,
  rejectMismatch,
  approveMismatch,
  openMismatchCount,
} from "./pricingMismatch";
