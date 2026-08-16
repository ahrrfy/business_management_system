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
    expect(reception).toContain("if (!isPosPaymentMethodEnabled(String(method)))");
    expect(reception.indexOf("if (!isPosPaymentMethodEnabled(String(method)))")).toBeLessThan(
      reception.indexOf("customerId = await ensureCustomerId()"),
    );
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
    expect(workOrderDetail).toContain("disabled={!isPosPaymentMethodEnabled(m.v)}");
    expect(workOrders).toContain('disabled={!isPosPaymentMethodEnabled("CARD")}');
    expect(workOrders).not.toContain('<option value="CARD" disabled>');
    expect(reservations).toContain("!isPosPaymentMethodEnabled(value)");
  });

  it("فاتورة البيع المتقدّمة تُطبّق السياسة عبر بوّابةٍ مُسمّاة بصدق", () => {
    const invoice = readClient("../../pages/SalesInvoiceNew.tsx");
    const totals = readClient("../invoice/TotalsPanel.tsx");

    expect(invoice).toContain("enforceInboundPaymentPolicy");
    expect(invoice).toContain("isPosPaymentMethodEnabled(state.paymentMethod)");
    expect(totals).toContain("enforceInboundPaymentPolicy = false");
    expect(totals).toContain("isPosPaymentMethodEnabled(m.value)");
    expect(totals).not.toContain("cashOnlyPayment");
  });

  it("تحويل عرض السعر يحفظ اختيار الموظّف بدل قسره نقداً", () => {
    const quotation = readClient("../../pages/QuotationDetail.tsx");

    expect(quotation).toContain("disabled={!isPosPaymentMethodEnabled(m.v)}");
    expect(quotation).toContain("setPayMethod(e.target.value as typeof payMethod)");
    expect(quotation).not.toContain('setPayMethod("CASH");');
  });
});
