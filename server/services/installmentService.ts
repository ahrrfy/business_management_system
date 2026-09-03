// خدمة الأقساط والشيكات الآجلة — نقطة الدخول العامة.
//
// أُعيد تنظيم المنطق (كان ٧٧٦ سطراً في ملف واحد) إلى وحدات متماسكة تحت server/services/installment/*
// هذا الملف برميل الواجهة العامة فقط؛ منطق الحوكمة والذرّية في الوحدات المتخصصة أدناه.
//
// الدلالة المالية (مختصر — التفصيل الكامل في تعليقي payLine/bounceCheck داخل الوحدات أدناه): الخطة
// **جدولة تحصيل** فوق ذمّة العميل القائمة — لا قيد محاسبي عند الإنشاء. سداد كل قسط يمرّ عبر سند قبض
// حقيقي داخل المعاملة نفسها عبر createVoucherTx؛ تخصيص الفاتورة وAR والدفتر ووسم القسط
// تنجح معاً أو تتراجع معاً. UUID المحاولة يأتي من القناة ويعاد حرفياً عند retry.
//
// خريطة الوحدات:
//   types    — عقود المدخلات/المخرجات + حارس عزل الفرع المشترك (assertPlanBranch، داخليّ فقط — لا يُعاد تصديره).
//   plan     — createPlan (إنشاء خطة) و cancelPlan (إلغاء خطة بلا أي قسط مسدَّد) — دورة حياة الخطة.
//   payment  — payLine: سداد ذري وتخصيص فاتورة (idempotency `ip:<lineId>:<uuid>`).
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
