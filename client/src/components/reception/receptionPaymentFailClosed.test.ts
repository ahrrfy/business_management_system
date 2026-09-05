import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isPosPaymentMethodEnabled } from "@shared/posPaymentPolicy";

const readComponent = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
const readClient = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");

/**
 * كل شاشة قبضٍ في المحطة تشتقّ طرقها من `isPosPaymentMethodEnabled` — لا نصّ `!== "CASH"`
 * ولا سِمة `disabled` ثابتة. هذا ما يمنع تكرار انتكاسة #596 (إقفالٌ شاملٌ مبثوثٌ في الشاشات).
 */
describe("اشتقاق طرق القبض من السياسة في كل شاشات المحطة", () => {
  it("لوحة الدفع تُعيد الطريقة غير المدعومة إلى النقد ولا تُقفل المدعومة", () => {
    const source = readComponent("PaymentPanel.tsx");
    const reception = readClient("../../pages/Reception.tsx");

    expect(source).toContain("isPosPaymentMethodEnabled(method)");
    expect(source).toContain('setMethod("CASH")');
    expect(source).toContain("disabled={!isPosPaymentMethodEnabled(p.v)}");
    expect(reception).toContain("if (!isPosPaymentMethodEnabled(String(method)))",
    );
    expect(reception.indexOf("if (!isPosPaymentMethodEnabled(String(method)))"),
    ).toBeLessThan(
      reception.indexOf("customerId = await ensureCustomerId()"));
    // البطاقة مدعومة ⇒ الزرّ مفتوح فعلياً لا مُعطَّلاً.
    expect(isPosPaymentMethodEnabled("CARD")).toBe(true);
  });

  it("طابور التحصيل والعربون يستعملان دالّة السياسة نفسها", () => {
    const queue = readComponent("ReceptionInvoiceQueue.tsx");
    const deposit = readComponent("DepositDialog.tsx");

    expect(queue).toContain("disabled={!isPosPaymentMethodEnabled(p.v)}");
    expect(queue).toContain("if (!isPosPaymentMethodEnabled(p.v)) return");
    expect(deposit).toContain("disabled={!isPosPaymentMethodEnabled(v)}");
  });

  it("شاشات أوامر الشغل والحجوزات والتسليم بلا إقفالٍ مكتوبٍ يدوياً", () => {
    const pickup = readClient("../delivery/MarkPickedUpDialog.tsx");
    const workOrderNew = readClient("../../pages/WorkOrderNew.tsx");
    const workOrderDetail = readClient("../../pages/WorkOrderDetail.tsx");
    const workOrders = readClient("../../pages/WorkOrders.tsx");
    const reservations = readClient("../../pages/ReservationsHub.tsx");

    expect(pickup).toContain("disabled={!isPosPaymentMethodEnabled(m.v)}");
    expect(workOrderNew).toContain('onClick={() => setPaymentMethod("CARD")}');
    expect(workOrderDetail).toContain("disabled={!isPosPaymentMethodEnabled(m.v)}",
    );
    expect(workOrders).toContain('disabled={!isPosPaymentMethodEnabled("CARD")}',
    );
    expect(workOrders).not.toContain('<option value="CARD" disabled>');
    expect(reservations).toContain("!isPosPaymentMethodEnabled(value)");
    expect(isPosPaymentMethodEnabled("CHECK")).toBe(false);
  });

  // كل شاشةٍ فُتحت لغير النقد تملك الآن مسار إثباتها: محاولةٌ مؤكَّدة حيث يفرضها العقد،
  // ومرجعٌ نصّيّ حيث يكفي. لا شاشة تُرسل طريقةً لا يستطيع الخادم قبول حمولتها.
  it("فاتورة البيع المتقدّمة تحمل بوّابة الإثبات نفسها كالكاشير", () => {
    const invoice = readClient("../../pages/SalesInvoiceNew.tsx");

    expect(invoice).not.toContain("cashOnlyPayment");
    expect(invoice).toContain("PaymentReferenceField");
    expect(invoice).toContain("initiateExternalPayment");
    expect(invoice).toContain("confirmExternalPayment");
    expect(invoice).toContain("externalPaymentAttemptId: externalAttempt?.attemptId ?? undefined",
    );
    // جهاز المحاولة يُرسَل مع الإنشاء وإلا رُفض استهلاكها؛ وفرعُ المحاولة = فرع الفاتورة.
    expect(invoice).toContain("deviceId: externalAttempt.deviceId");
    expect(invoice).toContain("const branchId = state.branchId;");
    // مسار التصحيح يمرّ بعقد `reissue` الذي يحمل المرجع النصّي بنفسه.
    expect(invoice).toContain("reference: paymentRef.trim()");
  });

  it("تحويل عرض السعر يجمع المرجع ويُمرّره بدل قسر النقد", () => {
    const quotation = readClient("../../pages/QuotationDetail.tsx");

    expect(quotation).not.toContain('setPayMethod("CASH");');
    expect(quotation).toContain('inputId="quotation-pay-reference"');
    expect(quotation).toContain('reference: payMethod === "CASH" ? undefined : payReference.trim()',
    );
  });

  it("الشاشات ذات حقل المرجع تُرسله فعلاً بدل إسقاطه", () => {
    const workOrders = readClient("../../pages/WorkOrders.tsx");
    const invoiceDetail = readClient("../../pages/InvoiceDetail.tsx");
    const receptionQueue = readComponent("ReceptionInvoiceQueue.tsx");

    expect(workOrders).toContain('reference: methodV === "CASH" ? undefined : reference.trim()',
    );
    expect(workOrders).not.toContain("reference: undefined } : undefined)");
    expect(invoiceDetail).toContain('reference: payMethod === "CASH" ? undefined : payReference.trim()',
    );
    expect(invoiceDetail).toContain('inputId="invoice-pay-reference"');
    expect(receptionQueue).toContain('channel: "SALES_COLLECTION"');
    expect(receptionQueue).toContain("PaymentReferenceField");
    expect(receptionQueue).toMatch(
      /externalPaymentAttemptId:\s*externalAttempt\?\.attemptId\s*\?\?\s*undefined/,
    );
    expect(receptionQueue).toMatch(
      /externalPaymentDeviceId:\s*externalAttempt\?\.deviceId\s*\?\?\s*undefined/,
    );
  });
});
