// خدمة الأقساط والشيكات الآجلة — نقطة الدخول العامة.
//
// أُعيد تنظيم المنطق (كان ٧٧٦ سطراً في ملف واحد) إلى وحدات متماسكة تحت server/services/installment/*
// **بلا أي تغيير سلوكي**: نفس الدوال والتواقيع والمنطق المالي حرفياً. هذا الملف يعيد تصدير الواجهة
// العامة فقط كي تبقى كل المستدعيات (server/routers/installmentRouter.ts والاختبارات) بلا أي تعديل.
//
// الدلالة المالية (مختصر — التفصيل الكامل في تعليقي payLine/bounceCheck داخل الوحدات أدناه): الخطة
// **جدولة تحصيل** فوق ذمّة العميل القائمة — لا قيد محاسبي عند الإنشاء. سداد كل قسط يمرّ عبر سند قبض
// حقيقي (createVoucher) فيتحرّك AR والدفتر بالمسار الموحَّد القائم (postEntry + adjustCustomerBalance).
// Maker-Checker: createVoucher قد يُعيد PENDING_APPROVAL للمبالغ ≥ عتبة الاعتماد — عندها القسط يبقى
// PENDING حتى اعتماد السند، وإعادة استدعاء payLine بعده تُكمل الوسم PAID عبر نفس مفتاح idempotency.
//
// خريطة الوحدات:
//   types    — عقود المدخلات/المخرجات + حارس عزل الفرع المشترك (assertPlanBranch، داخليّ فقط — لا يُعاد تصديره).
//   plan     — createPlan (إنشاء خطة) و cancelPlan (إلغاء خطة بلا أي قسط مسدَّد) — دورة حياة الخطة.
//   payment  — payLine: سداد قسط عبر سند قبض حقيقي (idempotency `instpay-<lineId>` + Maker-Checker).
//   bounce   — bounceCheck: ارتجاع شيك (عكس محاسبي متماثل — AR-BOUNCE، حارس تحصيل مزدوج Codex P1).
//   queries  — listPlans/getPlan/dueSoon: قوائم واستعلامات القراءة.
export type {
  InstallmentKind,
  PlanStatus,
  LineStatus,
  InstallmentLineInput,
  CreatePlanInput,
  PayLineInput,
  PayLineResult,
  BranchRestriction,
  ListPlansFilter,
} from "./installment/types";
export { createPlan, cancelPlan } from "./installment/plan";
export { payLine } from "./installment/payment";
export { bounceCheck } from "./installment/bounce";
export { listPlans, getPlan, dueSoon } from "./installment/queries";
