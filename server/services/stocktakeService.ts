// خدمة الجرد والتسوية (Stocktake) — نقطة الدخول العامة وفق عقد docs/stocktake-contract.md.
//
// أُعيد تنظيم المنطق (كان ٢٣٣٩ سطراً في ملف واحد) إلى وحدات متماسكة تحت server/services/stocktake/*
// **بلا أي تغيير سلوكي**: نفس الدوال والتواقيع والعقد. هذا الملف يعيد تصدير الواجهة العامة فقط كي
// تبقى كل المستدعيات (server/routers/stocktakeRouter.ts والاختبارات) بلا أي تعديل.
//
// اتفاقيات حاكمة (§٥ من CLAUDE.md) سارية في كل وحدة:
//   - كل عملية كتابة داخل withTx — أي throw ⇒ ROLLBACK كامل.
//   - تغيير المخزون حصراً عبر inventoryService (التسوية عبر setStock فقط).
//   - الأموال decimal.js عبر money.ts — ممنوع parseFloat/Number على الأموال.
//   - بوابة العدّ لا تستلم expectedQty/أسعاراً أبداً (الجرد الأعمى).
//
// خريطة الوحدات:
//   types         — StkActor المشترك.
//   internal      — أدوات مشتركة خاصة (chunk، ترويسة الجلسة، حارس الفرع، قفل الجلسة) — غير مُصدَّرة.
//   create        — إنشاء الجلسة واللقطة الذرّية والتكليفات والتوزيع.
//   queries       — القائمة/الترويسة/المتابعة الحية/العدّادات.
//   reviewCore    — محرّك المراجعة (إعادة الحساب والحدود والإجماليات والحواجز).
//   reviewActions — إعادة العدّ/فصل التعارض/القرار/التوقيع الأول.
//   finalize      — الاعتماد الذرّي/الإقفال/الإلغاء/إعادة توليد PIN.
//   intelligence  — الجرد الدوري ABC ومؤشر الدقة IRA.
//   report        — المحضر النهائي وقوائم العدّ.

export * from "./stocktake/types";
export * from "./stocktake/create";
export * from "./stocktake/queries";
export { computeStocktakeReview } from "./stocktake/reviewCore";
export type { ReviewRow } from "./stocktake/reviewCore";
export * from "./stocktake/reviewActions";
export * from "./stocktake/finalize";
export * from "./stocktake/intelligence";
export * from "./stocktake/report";
