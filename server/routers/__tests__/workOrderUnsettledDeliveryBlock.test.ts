/**
 * اختبارات حظر تسليم الطلبات ذات الفواتير غير المسددة دون اعتماد المدير
 *
 * القواعد الحاكمة:
 * 1. يُمنع تسليم أي طلب تسليم مباشر (pickup) إذا كان عليه متبقٍ مالي غير مستحصل إلا إذا حُوِّل لذمة العميل.
 * 2. تحويل المتبقي لذمة العميل يتطلب حصراً دور مدير/آدمن أو اعتماداً موثّقاً من مدير (managerOverrideByUserId).
 * 3. عند فحص الطلب عبر الباركود في الاستقبال، إذا كان الطلب مسلماً وفاتورته غير مسددة، يُوجَّه الكاشير لتحصيل الفاتورة في ورديته بدلاً من حظره برسالة "الطلب مُسلَّم مسبقاً".
 * 4. في نافذة الاستلام المباشر، يُدرج كامل المبلغ المستحق افتراضياً لمنع التسليم بـ 0 المقبوض سهواً.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const deliverServiceCode = readFileSync(
  new URL("../../services/workOrder/deliver.ts", import.meta.url),
  "utf8",
);
const routerCode = readFileSync(
  new URL("../workOrderRouter.ts", import.meta.url),
  "utf8",
);
const markPickedUpDialogCode = readFileSync(
  new URL("../../../client/src/components/delivery/MarkPickedUpDialog.tsx", import.meta.url),
  "utf8",
);
const receptionHandoverCode = readFileSync(
  new URL("../../../client/src/pages/reception/ReceptionHandoverPage.tsx", import.meta.url),
  "utf8",
);
const deliveryPaymentCardCode = readFileSync(
  new URL("../../../client/src/components/workOrders/WorkOrderDeliveryPaymentCard.tsx", import.meta.url),
  "utf8",
);

describe("حظر تسليم الطلبات غير المسددة واعتماد المدير — Work Order Delivery Financial Invariants", () => {
  it("الخادم: يمنع تسليم الطلب المباشر بمتبقٍ غير مستحصل إلا بتحديد addToCustomerDebt", () => {
    expect(deliverServiceCode).toContain("unpaidPortion.gt(0)");
    expect(deliverServiceCode).toContain("!input.addToCustomerDebt");
    expect(deliverServiceCode).toContain("لا يمكن تسليم الطلب بمتبقٍ مالي غير مستحصل");
  });

  it("الخادم: يتطلب اعتماد مدير (أو دور مدير/آدمن) لتحويل المتبقي لذمة العميل", () => {
    expect(deliverServiceCode).toContain("actor.role === \"manager\" || actor.role === \"admin\"");
    expect(deliverServiceCode).toContain("!isElevated && !input.managerOverrideByUserId");
    expect(deliverServiceCode).toContain("اعتماد المدير مطلوب لإضافة المتبقي لذمة العميل");
  });

  it("الموجّه (Router): يقبل بيانات اعتماد المدير ويسجّل حدث التدقيق workOrder.deliver.debtApproved", () => {
    expect(routerCode).toContain("addToCustomerDebt: z.boolean().optional()");
    expect(routerCode).toContain("managerApproval: z.object({ email: z.string().min(1), password: z.string().min(1) }).optional()");
    expect(routerCode).toContain("verifyManagerApproval(input.managerApproval");
    expect(routerCode).toContain("workOrder.deliver.debtApproved");
  });

  it("الموجّه (Router): جلب الطلب برقم الباركود يربط الفاتورة ويتحقق إن كانت غير مسددة isUnsettled", () => {
    expect(routerCode).toContain("linkedInvoice:");
    expect(routerCode).toContain("isUnsettled");
    expect(routerCode).toContain("workOrders.invoiceId");
  });

  it("شاشة التسليم في الاستقبال: توجّه الطلب المسلّم ذي الفاتورة العالقة للتحصيل بالوردية بدل القفل التام", () => {
    expect(receptionHandoverCode).toContain("wo.linkedInvoice?.isUnsettled");
    expect(receptionHandoverCode).toContain("kind: \"invoice\"");
    expect(receptionHandoverCode).toContain("collectInvoiceMut");
  });

  it("نافذة الاستلام MarkPickedUpDialog: تضع الرصيد المستحق كاملاً كافتراضي لمنع التسليم دون قبض", () => {
    expect(markPickedUpDialogCode).toContain("order.salePrice");
    expect(markPickedUpDialogCode).toContain("remainingDue.toFixed(2)");
    expect(markPickedUpDialogCode).toContain("ManagerApprovalDialog");
    expect(markPickedUpDialogCode).toContain("addToCustomerDebt");
  });

  it("مكوّن دفعة التسليم المستقل WorkOrderDeliveryPaymentCard: يوفّر تنبيهاً عند وجود متبقٍ غير مستحصل وزراً لطلب الاعتماد", () => {
    expect(deliveryPaymentCardCode).toContain("متبقٍ غير مستحصل:");
    expect(deliveryPaymentCardCode).toContain("طلب اعتماد المدير لإضافة المتبقي لذمة العميل");
    expect(deliveryPaymentCardCode).toContain("تم اعتماد إضافة المتبقي لذمة العميل");
  });
});
