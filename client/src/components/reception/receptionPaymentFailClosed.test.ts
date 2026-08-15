import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { POS_EXTERNAL_PAYMENT_DISABLED_MESSAGE } from "@shared/posPaymentPolicy";

const readComponent = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
const readClient = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");

describe("reception external payment fail-closed UX", () => {
  it("disables external methods and clears stale checkout state to CASH", () => {
    const source = readComponent("PaymentPanel.tsx");
    const reception = readClient("../../pages/Reception.tsx");

    expect(source).toContain("isPosPaymentMethodEnabled(method)");
    expect(source).toContain('setMethod("CASH")');
    expect(source).toContain('setPaymentReference("")');
    expect(source).toContain('id="reception-external-payment-disabled"');
    expect(source).toContain("disabled={!isPosPaymentMethodEnabled(p.v)}");
    expect(source).toContain("POS_EXTERNAL_PAYMENT_DISABLED_MESSAGE");
    expect(reception).toContain("if (!isPosPaymentMethodEnabled(String(method)))");
    expect(reception.indexOf("if (!isPosPaymentMethodEnabled(String(method)))")).toBeLessThan(
      reception.indexOf("customerId = await ensureCustomerId()"),
    );
  });

  it("offers historical invoice collection controls as disabled except CASH", () => {
    const source = readComponent("ReceptionInvoiceQueue.tsx");

    expect(source).toContain('id="reception-collection-external-disabled"');
    expect(source).toContain("disabled={!isPosPaymentMethodEnabled(p.v)}");
    expect(source).toContain("if (!isPosPaymentMethodEnabled(p.v)) return");
    expect(POS_EXTERNAL_PAYMENT_DISABLED_MESSAGE).toMatch(/غير مفعّل.*إثبات مستقل.*المزوّد.*تسوية.*موثوقة/);
  });

  it("disables external payment on every reception/work-order/reservation UI", () => {
    const deposit = readComponent("DepositDialog.tsx");
    const pickup = readClient("../delivery/MarkPickedUpDialog.tsx");
    const workOrderNew = readClient("../../pages/WorkOrderNew.tsx");
    const workOrderDetail = readClient("../../pages/WorkOrderDetail.tsx");
    const workOrders = readClient("../../pages/WorkOrders.tsx");
    const reservations = readClient("../../pages/ReservationsHub.tsx");

    expect(deposit).toContain('id="reception-deposit-external-disabled"');
    expect(deposit).toContain("disabled={!isPosPaymentMethodEnabled(v)}");
    expect(pickup).toContain("disabled={!isPosPaymentMethodEnabled(m.v)}");
    expect(workOrderNew).toContain('aria-describedby="work-order-external-payment-disabled"');
    expect(workOrderDetail).toContain("disabled={!isPosPaymentMethodEnabled(m.v)}");
    expect(workOrders).toContain('<option value="CARD" disabled>');
    expect(reservations).toContain("!isPosPaymentMethodEnabled(value)");
  });

  it("keeps the advanced sales invoice CASH-only without changing the shared panel default", () => {
    const invoice = readClient("../../pages/SalesInvoiceNew.tsx");
    const totals = readClient("../invoice/TotalsPanel.tsx");

    expect(invoice).toContain("cashOnlyPayment");
    expect(invoice).toContain("isPosPaymentMethodEnabled(state.paymentMethod)");
    expect(totals).toContain("cashOnlyPayment = false");
    expect(totals).toContain("disabled={!enabled}");
    expect(totals).toContain('value: "CASH"');
  });

  it("keeps quotation conversion and invoice reissue CASH-only", () => {
    const quotation = readClient("../../pages/QuotationDetail.tsx");
    const reissue = readClient("../../pages/SalesInvoiceNew.tsx");

    expect(quotation).toContain('id="quotation-external-payment-disabled"');
    expect(quotation).toContain("disabled={!isPosPaymentMethodEnabled(m.v)}");
    expect(quotation).toContain('setPayMethod("CASH")');
    expect(reissue).toContain("cashOnlyPayment");
    expect(reissue).toContain("additionalPayment: { amount: round2(collect).toFixed(2), method: state.paymentMethod }");
  });
});
