/* ============================================================================
 * خدمة الرواتب — وحدة الموارد البشرية (server/services/payrollService.ts)
 * مسيّر شهري بثلاث حالات (مسودة → معتمد → مدفوع) — وحدة مالية حسّاسة.
 *
 * أُعيد تنظيم المنطق (كان ٩٥٨ سطراً في ملف واحد) إلى وحدات متماسكة تحت server/services/payroll/*
 * **بلا أي تغيير سلوكي**: نفس الدوال والتواقيع والسياسة المالية. هذا الملف يعيد تصدير الواجهة
 * العامة فقط كي تبقى كل المستدعيات (server/routers/payrollRouter.ts والاختبارات) بلا أي تعديل.
 *
 * السياسة المالية المعتمدة:
 *  - generatePayroll(period): داخل withTx؛ يرفض إن وُجد مسيّر لنفس الشهر مسبقاً.
 *    لكل موظف غير منتهي الخدمة:
 *      gross    = شهري ? salary + allowances : مجموع amount حضور ذلك الشهر
 *      overtime = 0 (افتراضي، يُحرَّر عبر updateItem)
 *      deductions = 0 (افتراضي، يُحرَّر عبر updateItem)
 *      net      = gross + overtime − deductions
 *      hours    = شهري ? null : مجموع ساعات الحضور
 *    يُدرَج المسيّر (draft) + بنوده، وتُحسَب مجاميعه وتُخزَّن. كل المبالغ عبر money.ts.
 *  - updateItem: يعيد حساب صافي البند + مجاميع المسيّر — فقط أثناء الحالة draft.
 *  - approveRun: draft → approved (+approvedAt).
 *  - payRun: approved → paid (+paidAt) داخل withTx، ويقيّد لكل بند قيد PAYMENT_OUT واحداً
 *    (راتب من الخزينة، بلا shiftId) بمفتاح dedupe فريد PAYROLL:<runId>:<employeeId>.
 *  - cancelRun: draft ⇒ حذف البنود + المسيّر. paid ⇒ عكس القيود (قيود معاكسة سالبة بمفتاح
 *    dedupe جديد PAYROLL-REV:<runId>:<employeeId>) ثم إعادة الحالة إلى approved. approved ⇒
 *    إعادة الحالة إلى draft (بلا قيود). انظر cancelRun للتوثيق الكامل.
 *
 * خريطة الوحدات:
 *   types      — UpdateItemInput (عقد تحرير بند).
 *   helpers    — assertPeriod/periodEntryDate/computeNet/recomputeRunTotals/countDaysWithin/
 *                expandSpans (أدوات حساب مشتركة تستهلكها generate/update/lifecycle) + nextDay
 *                (خاصّة بـcountDaysWithin داخل نفس الملف). غير مُصدَّرة من هذا البرميل إلا
 *                countDaysWithin، جزءٌ من الواجهة العامة أصلاً.
 *   queries    — listRuns/getRun (قراءة).
 *   generate   — generatePayroll (التوليد الشهري الذرّي — الدالّة الرئيسية، أضخم وحدة).
 *   update     — updateItem (تحرير بند أثناء المسودة فقط).
 *   lifecycle  — approveRun/payRun/cancelRun (الاعتماد ثم الدفع ثم الإلغاء/العكس).
 * ========================================================================== */
export type { UpdateItemInput } from "./payroll/types";
export { countDaysWithin } from "./payroll/helpers";
export { listRuns, getRun } from "./payroll/queries";
export { generatePayroll } from "./payroll/generate";
export { updateItem } from "./payroll/update";
export { approveRun, payRun, cancelRun } from "./payroll/lifecycle";
