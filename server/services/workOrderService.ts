// خدمة أوامر الشغل (طلب خدمة المطبعة) — نقطة الدخول العامة.
//
// أُعيد تنظيم المنطق (كان ٥٨٩ سطراً في ملف واحد) إلى وحدات متماسكة تحت server/services/workOrder/*
// **بلا أي تغيير سلوكي**: نفس الدوال والتواقيع. هذا الملف يعيد تصدير الواجهة العامة فقط كي تبقى
// كل المستدعيات (workOrderRouter.ts والاختبارات) بلا أي تعديل.
//
// خريطة الوحدات:
//   types      — عقد أوامر الشغل.
//   helpers    — ترقيم الأمر + تحميله تحت قفل + عزل الفرع/المحطة — داخلية.
//   create     — إنشاء أمر (RECEIVED) + عربون اختياري.
//   lifecycle  — سحب ذاتي (claim) ← بدء التنفيذ (يستهلك المواد) ← جاهز.
//   deliver    — READY → DELIVERED (فاتورة + دفعة + قيد SALE + ذمم).
//   cancel     — إلغاء (يُعيد المواد + يسترد العربون).
export type { WorkOrderMaterialInput, CreateWorkOrderInput } from "./workOrder/types";
export { createWorkOrder } from "./workOrder/create";
export { claimWorkOrder, startWorkOrder, markWorkOrderReady } from "./workOrder/lifecycle";
export type { DeliverWorkOrderInput } from "./workOrder/deliver";
export { deliverWorkOrder } from "./workOrder/deliver";
export { cancelWorkOrder } from "./workOrder/cancel";
